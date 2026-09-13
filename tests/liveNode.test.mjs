import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { LicenseClient, LicenseRequestError } =
	process.env.KEYZORI_TEST_FORMAT === "cjs"
		? require("../dist/cjs/index.js")
		: await import("../dist/esm/index.js");
const url = process.env.KEYZORI_LIVE_URL;
const adminKey = process.env.KEYZORI_LIVE_ADMIN_KEY;
if (!url || !adminKey)
	throw new Error("Run through bun run test:live with isolated local services");
async function api(path, method = "GET", body) {
	const res = await fetch(`${url}${path}`, {
		method,
		headers: { "X-Admin-Key": adminKey, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const value = await res.json();
	assert.ok(res.ok, JSON.stringify(value));
	return value;
}
async function license(type = "lifetime", extra = {}) {
	const customer = await api("/admin/customers", "POST", {
		email: `${crypto.randomUUID()}@example.com`,
		name: "SDK integration",
	});
	const config =
		type === "trial"
			? { type, durationSeconds: 60 }
			: type === "subscription"
				? { type, expiresAt: new Date(Date.now() + 86400000).toISOString() }
				: { type };
	return api("/admin/licenses", "POST", {
		customerId: customer.id,
		config: { ...config, ...extra },
		metadata: { feature: true },
	});
}
function client(t, item, options = {}) {
	const result = new LicenseClient({
		serverUrl: url,
		licenseKey: item.key,
		deviceId: "node-live-device",
		heartbeatIntervalMs: 50,
		requestTimeoutMs: 2000,
		...options,
	});
	t.after(() => result.deactivate().catch(() => {}));
	return result;
}
for (const type of ["lifetime", "subscription", "trial", "metered"]) {
	test(`${type} activation, heartbeat, and deactivation match the real server`, async (t) => {
		const item = await license(type);
		const sdk = client(t, item);
		let refreshed;
		sdk.events.once("heartbeat:success", (value) => {
			refreshed = value;
		});
		const result = await sdk.activate();
		assert.equal(result.licenseType, type);
		assert.equal(result.licenseId, item.id);
		const deadline = Date.now() + 3000;
		while (!refreshed && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(refreshed, result);
		await sdk.deactivate();
		assert.equal(
			(await api(`/admin/sessions?licenseId=${item.id}`)).items.length,
			0,
		);
	});
}
test("meter events are idempotent, conflicts are rejected, and exhaustion is recoverable", async (t) => {
	const item = await license("metered");
	const sdk = client(t, item);
	const meter = await api("/admin/meters", "POST", {
		licenseId: item.id,
		name: "exports",
		limit: 5,
	});
	await sdk.activate();
	const input = { meter: "exports", units: 2, eventId: "same-event" };
	const [first, duplicate] = await Promise.all([
		sdk.consume(input),
		sdk.consume(input),
	]);
	assert.deepEqual(first, duplicate);
	assert.equal(first.remaining, 3);
	assert.equal(first.meterId, meter.id);
	await assert.rejects(
		sdk.consume({ ...input, units: 1 }),
		(e) => e instanceof LicenseRequestError && e.code === "EVENT_CONFLICT",
	);
	await assert.rejects(
		sdk.consume({ ...input, eventId: "too-much", units: 4 }),
		(e) => e.code === "METER_EXHAUSTED",
	);
	assert.equal(
		(await sdk.consume({ ...input, eventId: "last", units: 3 })).remaining,
		0,
	);
	assert.equal(
		(await api(`/admin/usage?licenseId=${item.id}`)).items.length,
		2,
	);
});
test("a replacement installation using the same identity file does not consume a second device", async (t) => {
	const item = await license();
	const directory = mkdtempSync(join(tmpdir(), "keyzori-live-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	for (let i = 0; i < 2; i++) {
		const sdk = client(t, item, {
			deviceId: undefined,
			identityPath: join(directory, "identity"),
		});
		await sdk.activate();
		await sdk.deactivate();
	}
	assert.equal((await api(`/admin/access/${item.id}/devices`)).items.length, 1);
});
test("different device IDs cannot bypass the registered-device limit", async (t) => {
	const item = await license();
	const first = client(t, item);
	await first.activate();
	await first.deactivate();
	await assert.rejects(
		client(t, item, { deviceId: "another-device" }).activate(),
		(e) => e.code === "DEVICE_LIMIT",
	);
});
test("concurrent clients cannot bypass the server session limit", async (t) => {
	const item = await license();
	const a = client(t, item);
	const b = client(t, item);
	const outcomes = await Promise.allSettled([a.activate(), b.activate()]);
	assert.equal(outcomes.filter((v) => v.status === "fulfilled").length, 1);
	assert.equal(outcomes.filter((v) => v.status === "rejected").length, 1);
});
test("policy changes invalidate active SDK sessions", async (t) => {
	const item = await license("metered");
	const sdk = client(t, item, { heartbeatIntervalMs: 30000 });
	await sdk.activate();
	await api(`/admin/licenses/${item.id}/revoke`, "POST", {
		reason: "integration",
	});
	await assert.rejects(
		sdk.consume({ meter: "exports", units: 1, eventId: "revoked" }),
		(e) => ["SESSION_STALE", "LICENSE_BLOCKED"].includes(e.code),
	);
});
test("invalid license keys fail through the SDK's structured error", async (t) => {
	await assert.rejects(
		client(t, { key: `lic_${"z".repeat(43)}` }).activate(),
		(e) => e.code === "LICENSE_INVALID" && e.status === 401,
	);
});
