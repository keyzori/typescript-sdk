import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const archive = new URL(
	`.artifacts/${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`,
	root,
);
execFileSync(
	"bun",
	[
		"publish",
		fileURLToPath(archive),
		"--access",
		"public",
		"--tolerate-republish",
	],
	{ cwd: fileURLToPath(root), stdio: "inherit" },
);
