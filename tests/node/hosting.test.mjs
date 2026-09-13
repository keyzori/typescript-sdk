import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const moduleUrl = new URL(
	`../../dist/${process.env.KEYZORI_TEST_FORMAT ?? "esm"}/core/DeviceManager.js`,
	import.meta.url,
).href;

function directory(t) {
	const path = mkdtempSync(join(tmpdir(), "keyzori-hosting-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

function run(source, path, cwd) {
	const env = { ...process.env };
	delete env.KEYZORI_IDENTITY_PATH;
	return execFileSync(
		process.execPath,
		["--input-type=module", "-e", source, moduleUrl, path],
		{
			cwd,
			env,
			encoding: "utf8",
			timeout: 10000,
		},
	).trim();
}

test("ordinary-host default persists in the service user's home across processes", (t) => {
	const homeDirectory = directory(t);
	// Simulate absence of container markers even when this test runs inside CI Docker.
	// All identity file creation and reading still use the real filesystem.
	const source = `
import fs from "node:fs";
import os from "node:os";
import {syncBuiltinESMExports} from "node:module";
const exists = fs.existsSync;
fs.existsSync = path => ["/.dockerenv", "/run/.containerenv"].includes(path) ? false : exists(path);
os.homedir = () => process.argv[2];
syncBuiltinESMExports();
const {DeviceManager} = await import(process.argv[1]);
console.log(new DeviceManager().getDeviceId());`;
	const first = run(source, homeDirectory);
	assert.match(first, /^[a-f0-9]{64}$/);
	assert.equal(run(source, homeDirectory), first);
	assert.match(
		readFileSync(join(homeDirectory, ".keyzori", "identity"), "utf8"),
		/^[a-f0-9]{64}\n$/,
	);
});

test("retained application data survives replacement working directories without host probes", (t) => {
	const root = directory(t);
	const firstRelease = join(root, "release-one");
	const secondRelease = join(root, "release-two");
	mkdirSync(firstRelease);
	mkdirSync(secondRelease);
	const path = join(root, "retained-data", "identity");
	const source = `
import fs from "node:fs";
import os from "node:os";
import {syncBuiltinESMExports} from "node:module";
const unexpected = () => { throw new Error("Host probing is not required with explicit storage"); };
fs.existsSync = unexpected;
os.homedir = os.hostname = os.cpus = os.networkInterfaces = unexpected;
syncBuiltinESMExports();
const {DeviceManager} = await import(process.argv[1]);
console.log(new DeviceManager(undefined, process.argv[2]).getDeviceId());`;
	const first = run(source, path, firstRelease);
	assert.match(first, /^[a-f0-9]{64}$/);
	assert.equal(run(source, path, secondRelease), first);
});
