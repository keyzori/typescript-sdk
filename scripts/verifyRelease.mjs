import { readFileSync } from "node:fs";
const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version))
	throw new Error("Release version must be stable SemVer");
if (pkg.license !== "Apache-2.0")
	throw new Error("Package license must be Apache-2.0");
const tag = process.argv[2];
if (tag && tag !== `v${pkg.version}`)
	throw new Error("Release tag does not match the package version");
console.log(`Release metadata verified: ${pkg.name}@${pkg.version}`);
