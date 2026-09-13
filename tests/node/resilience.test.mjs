import test from "node:test";
import assert from "node:assert/strict";
import { activation, delay, fixture, id, until } from "./helpers.mjs";

test("public results and event listeners cannot mutate internal session identity or metadata", async (t) => {
	const f = await fixture(t);
	const client = f.client();
	client.events.on("ready", (value) => {
		value.licenseId = "changed";
		value.metadata.nested.enabled = false;
	});
	const result = await client.activate();
	assert.equal(result.licenseId, id);
	assert.equal(result.metadata.nested.enabled, true);
	result.licenseId = "also-changed";
	result.metadata.nested.enabled = false;
	assert.equal((await client.activate()).metadata.nested.enabled, true);
	await client.consume({ meter: "exports", units: 1, eventId: "immutable" });
});
test("rejected async event listeners do not cause unhandled rejections", async (t) => {
	const f = await fixture(t);
	const client = f.client();
	client.events.once("ready", async () => {
		throw new Error("async listener");
	});
	assert.equal((await client.activate()).licenseId, id);
	await delay(20);
});
for (const operation of ["activate", "consume"]) {
	test(`${operation} rejects locally expired sessions and emits the expiry event`, async (t) => {
		const f = await fixture(t);
		const client = f.client();
		let expired = 0;
		client.events.on("session:expired", () => {
			expired++;
		});
		await client.activate();
		const original = Date.now;
		try {
			Date.now = () => original() + 120000;
			await assert.rejects(
				operation === "activate"
					? client.activate()
					: client.consume({ meter: "exports", units: 1, eventId: "expired" }),
				/expired/,
			);
		} finally {
			Date.now = original;
		}
		assert.equal(expired, 1);
		assert.equal(f.requests.filter((r) => r.path === "/usage").length, 0);
	});
}
for (const retryAfter of [
	undefined,
	"",
	"invalid",
	"0",
	"999999999999999999999999",
	new Date(Date.now() + 10000).toUTCString(),
]) {
	test(`Retry-After ${String(retryAfter)} remains bounded by session lifetime`, async (t) => {
		let offline = false;
		const delays = [];
		const f = await fixture(t, (r) =>
			r.path === "/sessions"
				? { body: activation({ expiresIn: 1 }) }
				: r.path === "/sessions/heartbeat"
					? {
							status: 429,
							body: {},
							headers:
								retryAfter === undefined ? {} : { "retry-after": retryAfter },
						}
					: undefined,
		);
		const client = f.client({ heartbeatIntervalMs: 10, requestTimeoutMs: 500 });
		client.events.on("heartbeat:throttled", (ms) => {
			delays.push(ms);
		});
		client.events.on("network:offline", () => {
			offline = true;
		});
		await client.activate();
		await until(() => offline);
		assert.ok(delays.length > 0 && delays.every((ms) => ms > 0 && ms < 1000));
	});
}
test("a hung heartbeat times out, retries, and eventually goes offline", async (t) => {
	let offline = false;
	const f = await fixture(t, (r, res) => {
		if (r.path === "/sessions/heartbeat") {
			res.writeHead(200);
			res.write("{");
			return null;
		}
	});
	const client = f.client({
		heartbeatIntervalMs: 10,
		requestTimeoutMs: 30,
		maxRetries: 2,
	});
	client.events.on("network:offline", () => {
		offline = true;
	});
	await client.activate();
	await until(() => offline);
	assert.equal(
		f.requests.filter((r) => r.path === "/sessions/heartbeat").length,
		2,
	);
});
