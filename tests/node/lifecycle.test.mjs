import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	activation,
	delay,
	fixture,
	heartbeat,
	id,
	key,
	rejection,
	sdk,
	token,
	until,
	usage,
} from "./helpers.mjs";

test("activation is deduplicated; subsequent requests use headers and never repeat the key", async (t) => {
	const f = await fixture(t);
	const client = f.client();
	const [a, b] = await Promise.all([client.activate(), client.activate()]);
	assert.deepEqual(a, b);
	assert.equal(a.licenseId, id);
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.requests[0].body, {
		key,
		deviceId: createHash("sha256").update("test-device").digest("hex"),
	});
	const input = { meter: "exports", units: 2, eventId: " event with spaces " };
	assert.deepEqual(await client.consume(input), {
		...usage(input),
		meter: input.meter,
	});
	await Promise.all([client.deactivate(), client.deactivate()]);
	assert.equal(f.requests.length, 3);
	assert.deepEqual(f.requests[1].body, input);
	assert.deepEqual(f.requests[2].body, {});
	for (const r of f.requests.slice(1)) {
		assert.equal(r.headers.authorization, `Bearer ${token}`);
		assert.equal(r.headers["x-device-id"], f.requests[0].body.deviceId);
		assert.ok(!JSON.stringify(r).includes(key));
	}
	await assert.rejects(client.activate(), /deactivated/);
	await assert.rejects(client.consume(input), /not active/);
});

test("heartbeat retains the activation token and metadata, and renews the TTL", async (t) => {
	const f = await fixture(t);
	const client = f.client({ heartbeatIntervalMs: 10 });
	let refreshed;
	client.events.once("heartbeat:success", (value) => {
		refreshed = value;
	});
	const first = await client.activate();
	await until(() => refreshed);
	assert.deepEqual(refreshed, first);
	await client.deactivate();
	assert.equal(f.requests.at(-1).headers.authorization, `Bearer ${token}`);
	assert.deepEqual(
		f.requests.find((r) => r.path === "/sessions/heartbeat").body,
		{},
	);
});

test("activation can retry after a network/server rejection", async (t) => {
	let tries = 0;
	const f = await fixture(t, (r) =>
		r.path === "/sessions" && ++tries === 1
			? rejection("UNAVAILABLE", 503)
			: undefined,
	);
	const client = f.client();
	await assert.rejects(
		client.activate(),
		(e) =>
			e instanceof sdk.LicenseRequestError &&
			e.status === 503 &&
			e.code === "UNAVAILABLE",
	);
	assert.equal((await client.activate()).licenseId, id);
});

test("deactivation waits for in-flight activation and releases its session", async (t) => {
	const f = await fixture(t, async (r) => {
		if (r.path === "/sessions") await delay(40);
	});
	const client = f.client();
	const pending = assert.rejects(
		client.activate(),
		/deactivated during activation/,
	);
	await client.deactivate();
	await pending;
	assert.deepEqual(
		f.requests.map((r) => r.path),
		["/sessions", "/sessions/deactivate"],
	);
});

test("deactivation waits for in-flight usage and heartbeat requests", async (t) => {
	const f = await fixture(t, async (r) => {
		if (r.path === "/usage" || r.path === "/sessions/heartbeat")
			await delay(40);
	});
	const client = f.client({ heartbeatIntervalMs: 10 });
	await client.activate();
	await until(() => f.requests.some((r) => r.path === "/sessions/heartbeat"));
	const pending = client.consume({
		meter: "exports",
		units: 1,
		eventId: "pending",
	});
	await client.deactivate();
	await pending;
	assert.equal(f.requests.at(-1).path, "/sessions/deactivate");
	const count = f.requests.length;
	await delay(30);
	assert.equal(f.requests.length, count);
});

for (const [code, event] of [
	["LICENSE_BLOCKED", "license:revoked"],
	["LICENSE_EXPIRED", "license:expired"],
	["SESSION_STALE", "session:expired"],
	["DEVICE_LIMIT", "license:rejected"],
]) {
	test(`activation exposes ${code} through the correct event and error`, async (t) => {
		const f = await fixture(t, (r) =>
			r.path === "/sessions" ? rejection(code) : undefined,
		);
		const client = f.client();
		let observed;
		client.events.once(event, (message) => {
			observed = message;
		});
		await assert.rejects(
			client.activate(),
			(e) => e.code === code && e.status === 403,
		);
		assert.equal(observed, `Rejected: ${code}`);
	});
}

for (const code of [
	"SESSION_INVALID",
	"SESSION_BINDING",
	"SESSION_STALE",
	"LICENSE_BLOCKED",
	"LICENSE_EXPIRED",
	"ACCESS_BLOCKED",
]) {
	test(`usage terminates the session on ${code}`, async (t) => {
		const f = await fixture(t, (r) =>
			r.path === "/usage" ? rejection(code) : undefined,
		);
		const client = f.client();
		await client.activate();
		await assert.rejects(
			client.consume({ meter: "exports", units: 1, eventId: "fatal" }),
			(e) => e.code === code,
		);
		await until(() =>
			f.requests.some((r) => r.path === "/sessions/deactivate"),
		);
		await assert.rejects(
			client.consume({ meter: "exports", units: 1, eventId: "next" }),
			/not active/,
		);
	});
}

test("meter policy failures remain recoverable and preserve the event ID", async (t) => {
	let calls = 0;
	const f = await fixture(t, (r) =>
		r.path === "/usage" && ++calls === 1
			? rejection("METER_EXHAUSTED", 409)
			: undefined,
	);
	const client = f.client();
	await client.activate();
	const input = { meter: "exports", units: 1, eventId: "same-id" };
	await assert.rejects(
		client.consume(input),
		(e) => e.code === "METER_EXHAUSTED",
	);
	assert.equal((await client.consume(input)).eventId, "same-id");
});

test("transient heartbeat failures recover and reset failure strikes", async (t) => {
	let calls = 0;
	let failures = 0;
	const strikesSeen = [];
	let successes = 0;
	const f = await fixture(t, (r) =>
		r.path === "/sessions/heartbeat" && ++calls % 2 === 1
			? rejection("UNAVAILABLE", 503)
			: undefined,
	);
	const client = f.client({ heartbeatIntervalMs: 10, maxRetries: 2 });
	client.events.on("heartbeat:failed", (_message, strikes) => {
		strikesSeen.push(strikes);
		failures++;
	});
	client.events.on("heartbeat:success", () => {
		successes++;
	});
	await client.activate();
	await until(() => successes >= 2);
	assert.equal(failures, 2);
	assert.deepEqual(strikesSeen, [1, 1]);
});

test("repeated transient failures emit offline and stop heartbeats", async (t) => {
	let offline = 0;
	const f = await fixture(t, (r) =>
		r.path === "/sessions/heartbeat"
			? rejection("UNAVAILABLE", 503)
			: undefined,
	);
	const client = f.client({ heartbeatIntervalMs: 10, maxRetries: 2 });
	client.events.on("network:offline", () => {
		offline++;
	});
	await client.activate();
	await until(() => offline === 1);
	await client.deactivate();
	assert.equal(
		f.requests.filter((r) => r.path === "/sessions/heartbeat").length,
		2,
	);
});

test("fatal heartbeat emits the session event and releases the session", async (t) => {
	let expired = 0;
	const f = await fixture(t, (r) =>
		r.path === "/sessions/heartbeat"
			? rejection("SESSION_INVALID", 401)
			: undefined,
	);
	const client = f.client({ heartbeatIntervalMs: 10 });
	client.events.on("session:expired", () => {
		expired++;
	});
	await client.activate();
	await until(() => expired);
	await client.deactivate();
	assert.equal(
		f.requests.filter((r) => r.path === "/sessions/heartbeat").length,
		1,
	);
});

test("rate limits use bounded retry delays and cannot create a retry storm", async (t) => {
	let throttles = 0;
	const delays = [];
	let offline = 0;
	const f = await fixture(t, (r) =>
		r.path === "/sessions"
			? { body: activation({ expiresIn: 1 }) }
			: r.path === "/sessions/heartbeat"
				? { status: 429, body: {}, headers: { "retry-after": "3600" } }
				: undefined,
	);
	const client = f.client({
		heartbeatIntervalMs: 10,
		requestTimeoutMs: 100,
		maxRetries: 10,
	});
	client.events.on("heartbeat:throttled", (ms) => {
		delays.push(ms);
		throttles++;
	});
	client.events.on("network:offline", () => {
		offline++;
	});
	await client.activate();
	await until(() => offline);
	await client.deactivate();
	assert.equal(throttles, 1);
	assert.ok(delays.every((ms) => ms > 0 && ms < 1000));
	assert.equal(
		f.requests.filter((r) => r.path === "/sessions/heartbeat").length,
		2,
	);
});

test("malformed or cross-license heartbeats never become successful renewals", async (t) => {
	const f = await fixture(t, (r) =>
		r.path === "/sessions/heartbeat"
			? {
					body: heartbeat({
						licenseId: "33333333-3333-4333-8333-333333333333",
					}),
				}
			: undefined,
	);
	const client = f.client({ heartbeatIntervalMs: 10, maxRetries: 1 });
	let offline = false;
	let successes = 0;
	client.events.on("heartbeat:success", () => {
		successes++;
	});
	client.events.on("network:offline", () => {
		offline = true;
	});
	await client.activate();
	await until(() => offline);
	assert.equal(successes, 0);
});

test("explicit deactivation surfaces server errors and remains idempotent", async (t) => {
	const f = await fixture(t, (r) =>
		r.path === "/sessions/deactivate"
			? rejection("SESSION_INVALID", 401)
			: undefined,
	);
	const client = f.client();
	await client.activate();
	await assert.rejects(
		client.deactivate(),
		(e) => e.code === "SESSION_INVALID",
	);
	await assert.rejects(client.deactivate());
	assert.equal(
		f.requests.filter((r) => r.path === "/sessions/deactivate").length,
		1,
	);
});
