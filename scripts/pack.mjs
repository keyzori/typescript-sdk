import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(process.execPath, ["scripts/build.mjs"], {
	cwd: root,
	stdio: "inherit",
});
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const types = JSON.parse(
	readFileSync(resolve(root, "../types/package.json"), "utf8"),
);
if (pkg.dependencies["@keyzori/types"] !== types.version)
	throw new Error(
		"The SDK dependency must match the checked-out shared types version",
	);
// Use sibling sources during development and ordinary npm dependencies in releases.
delete pkg.overrides;
delete pkg.scripts;
delete pkg.devDependencies;
const stage = resolve(root, ".package");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
mkdirSync(resolve(root, ".artifacts"), { recursive: true });
try {
	for (const file of ["dist", "README.md", "LICENSE", "NOTICE"])
		cpSync(resolve(root, file), resolve(stage, file), { recursive: true });
	writeFileSync(
		resolve(stage, "package.json"),
		`${JSON.stringify(pkg, null, "\t")}\n`,
	);
	execFileSync("bun", ["pm", "pack", "--destination", "../.artifacts"], {
		cwd: stage,
		stdio: "inherit",
	});
} finally {
	rmSync(stage, { recursive: true, force: true });
}
