import test from "node:test";
import assert from "node:assert/strict";
import { activation, fixture, id, key, sdk, usage } from "./helpers.mjs";

const config = {
	licenseKey: key,
	serverUrl: "https://licenses.example.com",
	deviceId: "device",
};
for (const invalid of [
	null,
	[],
	{},
	{ ...config, extra: true },
	{ ...config, licenseKey: "lic_invalid" },
	{ ...config, licenseKey: 10 },
	{ ...config, serverUrl: 1 },
	{ ...config, deviceId: " " },
	{ ...config, deviceId: "x".repeat(1025) },
	{ ...config, identityPath: "relative" },
	{ ...config, identityPath: process.cwd() },
	...[0, -1, Infinity, 1.5, 2 ** 31].flatMap((value) =>
		["maxRetries", "heartbeatIntervalMs", "requestTimeoutMs"].map((field) => ({
			...config,
			[field]: value,
		})),
	),
	{ ...config, logLevel: "toString" },
]) {
	test(`rejects invalid configuration ${JSON.stringify(invalid)}`, () => {
		assert.throws(() => new sdk.LicenseClient(invalid));
	});
}
for (const serverUrl of [
	"http://example.com",
	"ftp://example.com",
	"https://user:password@example.com",
	"https://example.com?secret=1",
	"https://example.com#x",
	"not a URL",
	"http://127.0.0.1.attacker.example",
]) {
	test(`rejects unsafe server URL ${serverUrl}`, () =>
		assert.throws(
			() => new sdk.LicenseClient({ ...config, serverUrl }),
			/HTTPS/,
		));
}
for (const serverUrl of [
	"https://example.com/base/",
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://[::1]:3000",
]) {
	test(`accepts supported server URL ${serverUrl}`, async () => {
		await new sdk.LicenseClient({ ...config, serverUrl }).deactivate();
	});
}

test("invalid usage inputs fail locally before network traffic", async (t) => {
	const f = await fixture(t);
	const client = f.client();
	await client.activate();
	const input = { meter: "exports", units: 1, eventId: "evt" };
	for (const invalid of [
		null,
		[],
		{},
		...["", "Exports", " export", "x".repeat(65), "a/b", "a.b"].map(
			(meter) => ({ ...input, meter }),
		),
		...[0, -1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(
			(units) => ({ ...input, units }),
		),
		...["", "x".repeat(129), 1].map((eventId) => ({ ...input, eventId })),
	])
		await assert.rejects(client.consume(invalid));
	assert.equal(f.requests.length, 1);
});

for (const payload of [
	null,
	{},
	[],
	{ success: true },
	activation({ token: "bad" }),
	activation({ licenseId: "bad" }),
	activation({ type: "unknown" }),
	activation({ metadata: [] }),
	activation({ metadata: null }),
	activation({ expiresIn: 0 }),
	activation({ expiresIn: 1.5 }),
	activation({ expiresIn: 86401 }),
]) {
	test(`rejects malformed activation ${JSON.stringify(payload)}`, async (t) => {
		const f = await fixture(t, (_r, res) => {
			res.end(JSON.stringify(payload));
			return null;
		});
		await assert.rejects(f.client().activate(), /invalid activation/);
	});
}

for (const change of [
	{ eventId: "wrong" },
	{ units: 2 },
	{ licenseId: "22222222-2222-4222-8222-222222222222" },
	{ meterId: "bad" },
	{ id: "bad" },
	{ remaining: -1 },
	{ remaining: 1.2 },
	{ used: -1 },
	{ units: 0 },
	{ createdAt: "bad" },
]) {
	test(`rejects invalid or mismatched usage ${JSON.stringify(change)}`, async (t) => {
		const f = await fixture(t, (r) =>
			r.path === "/usage" ? { body: usage(r.body, change) } : undefined,
		);
		const client = f.client();
		await client.activate();
		await assert.rejects(
			client.consume({ meter: "exports", units: 1, eventId: "evt" }),
			/usage response/,
		);
	});
}

test("supports safe-integer usage above the obsolete 32-bit limit", async (t) => {
	const f = await fixture(t, (r) =>
		r.path === "/usage"
			? {
					body: usage(r.body, {
						used: 3_000_000_000,
						remaining: Number.MAX_SAFE_INTEGER - 3_000_000_000,
					}),
				}
			: undefined,
	);
	const client = f.client();
	await client.activate();
	assert.equal(
		(
			await client.consume({
				meter: "exports",
				units: 3_000_000_000,
				eventId: "large",
			})
		).units,
		3_000_000_000,
	);
});

for (const status of [301, 302, 303, 307, 308]) {
	test(`refuses ${status} redirects without forwarding credentials`, async (t) => {
		let hits = 0;
		const target = await fixture(t, () => {
			hits++;
		});
		const origin = await fixture(t, () => ({
			status,
			body: {},
			headers: { location: target.url },
		}));
		await assert.rejects(origin.client().activate());
		assert.equal(hits, 0);
	});
}

test("enforces timeout while reading a stalled response body", async (t) => {
	const f = await fixture(t, (_r, res) => {
		res.writeHead(200);
		res.write('{"token":');
		return null;
	});
	const start = Date.now();
	await assert.rejects(f.client({ requestTimeoutMs: 40 }).activate());
	assert.ok(Date.now() - start < 1000);
});
for (const declared of [true, false]) {
	test(`rejects oversized ${declared ? "declared" : "streamed"} response bodies`, async (t) => {
		const f = await fixture(t, (_r, res) => {
			res.writeHead(200, declared ? { "content-length": "300000" } : {});
			res.end("x".repeat(300000));
			return null;
		});
		await assert.rejects(f.client().activate(), /safety limit/);
	});
}

test("malformed JSON and unstructured errors do not expose response contents", async (t) => {
	const f = await fixture(t, (_r, res) => {
		res.writeHead(502);
		res.end("secret proxy diagnostic");
		return null;
	});
	await assert.rejects(
		f.client().activate(),
		(e) => e.message === "HTTP 502" && e.status === 502,
	);
});

test("event listeners preserve once/remove semantics and contain thrown exceptions", async (t) => {
	const f = await fixture(t);
	const client = f.client({ heartbeatIntervalMs: 10 });
	let ready = 0;
	let removed = 0;
	client.events.on("ready", () => {
		throw new Error("listener failure");
	});
	client.events.once("ready", () => {
		ready++;
	});
	const listener = () => {
		removed++;
	};
	client.events.on("ready", listener);
	client.events.removeListener("ready", listener);
	assert.equal((await client.activate()).licenseId, id);
	await client.activate();
	assert.equal(ready, 1);
	assert.equal(removed, 0);
});
