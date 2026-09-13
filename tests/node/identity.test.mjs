import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fixture } from "./helpers.mjs";
const deviceModule = new URL(
	`../../dist/${process.env.KEYZORI_TEST_FORMAT ?? "esm"}/core/DeviceManager.js`,
	import.meta.url,
).href;
const { DeviceManager } = await import(deviceModule);
function directory(t) {
	const path = mkdtempSync(join(tmpdir(), "keyzori-identity-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
test("identity survives client recreation without depending on MAC, hostname, or CPU count", async (t) => {
	const identityPath = join(directory(t), "identity");
	const f = await fixture(t);
	for (let i = 0; i < 2; i++) {
		const client = f.client({ deviceId: undefined, identityPath });
		await client.activate();
		await client.deactivate();
	}
	const activations = f.requests.filter((r) => r.path === "/sessions");
	assert.equal(activations[0].body.deviceId, activations[1].body.deviceId);
	assert.match(readFileSync(identityPath, "utf8"), /^[a-f0-9]{64}\n$/);
});
test("independent installations receive distinct random identities", (t) => {
	const path = directory(t);
	assert.notEqual(
		new DeviceManager(undefined, join(path, "a")).getDeviceId(),
		new DeviceManager(undefined, join(path, "b")).getDeviceId(),
	);
});
test("corrupt identities fail instead of silently changing a registered device", (t) => {
	const path = join(directory(t), "identity");
	for (const value of [
		"",
		"corrupt",
		`${"z".repeat(64)}\n`,
		"a".repeat(100000),
	]) {
		writeFileSync(path, value);
		assert.throws(
			() => new DeviceManager(undefined, path).getDeviceId(),
			/invalid/,
		);
		assert.equal(readFileSync(path, "utf8"), value);
	}
});
test("concurrent processes atomically agree on one installation identity", async (t) => {
	const path = join(directory(t), "identity");
	const module = deviceModule;
	const run = () =>
		new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [
				"--input-type=module",
				"-e",
				`import {DeviceManager} from ${JSON.stringify(module)}; console.log(new DeviceManager(undefined, process.argv[1]).getDeviceId())`,
				path,
			]);
			let out = "";
			let err = "";
			child.stdout.on("data", (v) => {
				out += v;
			});
			child.stderr.on("data", (v) => {
				err += v;
			});
			child.on("error", reject);
			child.on("close", (code) =>
				code === 0 ? resolve(out.trim()) : reject(new Error(err)),
			);
		});
	const values = await Promise.all(Array.from({ length: 8 }, run));
	assert.equal(new Set(values).size, 1);
	assert.match(values[0], /^[a-f0-9]{64}$/);
});
test("copying the file copies the identity: persistence does not claim anti-cloning", (t) => {
	const path = directory(t);
	const a = join(path, "a");
	const b = join(path, "b");
	const original = new DeviceManager(undefined, a).getDeviceId();
	writeFileSync(b, readFileSync(a));
	assert.equal(new DeviceManager(undefined, b).getDeviceId(), original);
});

test("a directory cannot be mistaken for a stored identity", (t) => {
	assert.throws(
		() => new DeviceManager(undefined, directory(t)).getDeviceId(),
		/invalid/,
	);
});

test("storage failures preserve an existing parent file", (t) => {
	const parent = join(directory(t), "parent");
	writeFileSync(parent, "keep this file");
	assert.throws(() =>
		new DeviceManager(undefined, join(parent, "identity")).getDeviceId(),
	);
	assert.equal(readFileSync(parent, "utf8"), "keep this file");
});

test("environment storage persists identity and explicit configuration takes priority", (t) => {
	const previous = process.env.KEYZORI_IDENTITY_PATH;
	t.after(() => {
		if (previous === undefined) delete process.env.KEYZORI_IDENTITY_PATH;
		else process.env.KEYZORI_IDENTITY_PATH = previous;
	});
	const path = directory(t);
	process.env.KEYZORI_IDENTITY_PATH = join(path, "environment");
	const identity = new DeviceManager().getDeviceId();
	assert.equal(new DeviceManager().getDeviceId(), identity);
	assert.notEqual(
		new DeviceManager(undefined, join(path, "explicit")).getDeviceId(),
		identity,
	);
	process.env.KEYZORI_IDENTITY_PATH = "relative/path";
	assert.throws(() => new DeviceManager().getDeviceId(), /absolute/);
	assert.doesNotThrow(() =>
		new DeviceManager("explicit identity").getDeviceId(),
	);
});
