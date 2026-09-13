import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = readdirSync("tests/node")
	.filter((name) => name.endsWith(".test.mjs"))
	.map((name) => `tests/node/${name}`);
for (const format of ["esm", "cjs"]) {
	const child = spawnSync(
		process.execPath,
		[
			"--test",
			...(process.argv.includes("--coverage")
				? [
						"--experimental-test-coverage",
						"--test-coverage-include=dist/**",
						"--test-coverage-lines=95",
						"--test-coverage-branches=85",
						"--test-coverage-functions=95",
					]
				: []),
			...files,
		],
		{ stdio: "inherit", env: { ...process.env, KEYZORI_TEST_FORMAT: format } },
	);
	if (child.error) throw child.error;
	if (child.status !== 0) process.exit(child.status ?? 1);
}
