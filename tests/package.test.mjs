import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fixture, key } from "./node/helpers.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const types = JSON.parse(
	readFileSync(resolve(root, "../types/package.json"), "utf8"),
);
function command(file, args, cwd = root) {
	return execFileSync(file, args, { cwd, encoding: "utf8", stdio: "pipe" });
}
function node(args, cwd) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, { cwd });
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
			code === 0 ? resolvePromise(out) : reject(new Error(err || out)),
		);
	});
}
test("published tarballs work for Node ESM/CommonJS and TypeScript consumers", async (t) => {
	command(
		"bun",
		["pm", "pack", "--destination", ".artifacts"],
		resolve(root, "../types"),
	);
	command(process.execPath, ["scripts/pack.mjs"]);
	const sdkArchive = resolve(root, `.artifacts/keyzori-sdk-${pkg.version}.tgz`);
	const typesArchive = resolve(
		root,
		`../types/.artifacts/keyzori-types-${types.version}.tgz`,
	);
	const contents = command("tar", ["-tf", sdkArchive]).trim().split(/\r?\n/);
	assert.ok(contents.includes("package/dist/esm/index.js"));
	assert.ok(contents.includes("package/dist/cjs/index.js"));
	assert.ok(
		contents.every(
			(path) => !/node_modules|\/src\/|\/tests\/|\.env|\.map$/.test(path),
		),
	);
	const packed = JSON.parse(
		command("tar", ["-xOf", sdkArchive, "package/package.json"]),
	);
	assert.equal(packed.name, "@keyzori/sdk");
	assert.equal(packed.dependencies["@keyzori/types"], types.version);
	assert.equal(packed.engines.bun, undefined);
	assert.equal(packed.scripts, undefined);
	assert.equal(packed.overrides, undefined);
	const directory = mkdtempSync(join(tmpdir(), "keyzori-package-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({
			private: true,
			dependencies: {
				"@keyzori/sdk": `file:${sdkArchive}`,
				"@keyzori/types": `file:${typesArchive}`,
			},
			overrides: { "@keyzori/types": `file:${typesArchive}` },
		}),
	);
	command("bun", ["install", "--ignore-scripts"], directory);
	const f = await fixture(t);
	writeFileSync(
		join(directory, "mixed.cjs"),
		'const assert = require("node:assert/strict"); const cjs = require("@keyzori/sdk"); import("@keyzori/sdk").then(esm => { assert.equal(esm.LicenseClient, cjs.LicenseClient); assert.equal(esm.LicenseRequestError, cjs.LicenseRequestError); });',
	);
	await node(["mixed.cjs"], directory);
	for (const format of ["esm", "cjs"]) {
		const extension = format === "esm" ? "mjs" : "cjs";
		const imports =
			format === "esm"
				? 'import { LicenseClient, LicenseRequestError } from "@keyzori/sdk";'
				: 'const { LicenseClient, LicenseRequestError } = require("@keyzori/sdk");';
		const source = `${imports}
const assert = ${format === "esm" ? '(await import("node:assert/strict")).default' : 'require("node:assert/strict")'};
(async () => {
 const client = new LicenseClient({licenseKey:${JSON.stringify(key)}, serverUrl:${JSON.stringify(f.url)}, deviceId:"packed", heartbeatIntervalMs:10});
 const ready = await client.activate(); assert.equal(ready.licenseType,"metered");
 const usage = await client.consume({meter:"exports",units:1,eventId:"packed-${format}"}); assert.equal(usage.remaining,9);
 await client.deactivate(); assert.equal(new LicenseRequestError("x",401,"TEST").code,"TEST");
 console.log("passed");
})().catch(e => { console.error(e); process.exitCode=1; });`;
		writeFileSync(join(directory, `consumer.${extension}`), source);
		assert.match(await node([`consumer.${extension}`], directory), /passed/);
	}
	const declarations = `import { LicenseClient } from "@keyzori/sdk";
import type { ActivateRequest, ActivateResponse, HeartbeatResponse, LicenseConfig, Customer, Usage, ApiEndpoints } from "@keyzori/types";
const adminHeaders: ApiEndpoints["GET /admin/customers"]["headers"] = {"x-admin-key":"test"};
const config: LicenseConfig = {type:"trial",durationSeconds:60};
// @ts-expect-error subscription requires expiresAt
const invalid: LicenseConfig = {type:"subscription"};
declare const customer: Customer;
const date: string = customer.createdAt;
// @ts-expect-error JSON dates are not Date objects
const wrongDate: Date = customer.createdAt;
declare const heartbeat: HeartbeatResponse;
// @ts-expect-error heartbeats do not rotate tokens
heartbeat.token;
declare const activation: ActivateResponse;
const token: string = activation.token;
const request: ActivateRequest = {key:"key",deviceId:"device"};
declare const usage: Usage;
new LicenseClient({serverUrl:"https://example.com",licenseKey:"key"});
`;
	for (const extension of ["mts", "cts"])
		writeFileSync(join(directory, `consumer.${extension}`), declarations);
	for (const compilerName of ["typescript", "typescript-compat"]) {
		const compiler = resolve(
			dirname(require.resolve(`${compilerName}/package.json`)),
			"lib/tsc.js",
		);
		for (const mode of ["Node16", "NodeNext", "Bundler"]) {
			writeFileSync(
				join(directory, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						noEmit: true,
						strict: true,
						module: mode === "Bundler" ? "ESNext" : mode,
						moduleResolution: mode,
						target: "ES2022",
						types: [],
						skipLibCheck: false,
					},
					include: ["consumer.mts", "consumer.cts"],
				}),
			);
			command(process.execPath, [compiler, "-p", "tsconfig.json"], directory);
		}
	}
});
