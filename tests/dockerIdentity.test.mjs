import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url));
const docker = (args) =>
	execFileSync("docker", args, {
		encoding: "utf8",
		stdio: "pipe",
		timeout: 120000,
	}).trim();
test("replacement Docker containers share a persisted identity and reject implicit ephemeral storage", () => {
	const volume = `keyzori-sdk-identity-${randomUUID()}`;
	docker(["volume", "create", volume]);
	try {
		const args = [
			"run",
			"--rm",
			"--mount",
			`type=bind,source=${root},target=/sdk,readonly`,
			"--mount",
			`type=volume,source=${volume},target=/identity`,
			"--workdir",
			"/sdk",
			"node:24",
			"node",
			"--input-type=module",
			"-e",
		];
		const code =
			'import {DeviceManager} from "./dist/esm/core/DeviceManager.js"; console.log(new DeviceManager(undefined,"/identity/device").getDeviceId());';
		const first = docker([...args, code]);
		assert.match(first, /^[a-f0-9]{64}$/);
		assert.equal(docker([...args, code]), first);
		assert.throws(
			() =>
				docker([
					...args,
					'import {DeviceManager} from "./dist/esm/core/DeviceManager.js"; new DeviceManager().getDeviceId();',
				]),
			/Containers require/,
		);
	} finally {
		docker(["volume", "rm", volume]);
	}
});

test("non-root Pterodactyl-style storage survives replacement and hostname changes", () => {
	const volume = `keyzori-sdk-hosting-${randomUUID()}`;
	docker(["volume", "create", volume]);
	const mount = `type=volume,source=${volume},target=/home/container`;
	try {
		docker([
			"run",
			"--rm",
			"--mount",
			mount,
			"node:24",
			"node",
			"-e",
			'const fs = require("node:fs"); fs.writeFileSync("/home/container/.volume-ready", "prepared"); fs.chownSync("/home/container", 1000, 1000); fs.chmodSync("/home/container", 0o700);',
		]);
		const run = (hostname) =>
			docker([
				"run",
				"--rm",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--user",
				"1000:1000",
				"--hostname",
				hostname,
				"--mount",
				mount,
				"--mount",
				`type=bind,source=${root},target=/sdk,readonly`,
				"--workdir",
				"/home/container",
				"--env",
				"KEYZORI_IDENTITY_PATH=/home/container/.keyzori/identity",
				"node:24",
				"node",
				"--input-type=module",
				"-e",
				'import {DeviceManager} from "/sdk/dist/esm/core/DeviceManager.js"; console.log(new DeviceManager().getDeviceId());',
			]);
		const first = run("original-host");
		assert.match(first, /^[a-f0-9]{64}$/);
		assert.equal(run("replacement-host"), first);
	} finally {
		docker(["volume", "rm", volume]);
	}
});
