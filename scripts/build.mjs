import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const compiler = resolve(
	dirname(require.resolve("typescript/package.json")),
	"lib/tsc.js",
);
const output = resolve(root, "dist");
rmSync(output, { recursive: true, force: true });
for (const format of ["esm", "cjs"]) {
	const args = [compiler, "-p", "tsconfig.json", "--outDir", `dist/${format}`];
	if (format === "cjs") {
		const stage = resolve(root, ".build-cjs");
		rmSync(stage, { recursive: true, force: true });
		mkdirSync(stage);
		cpSync(resolve(root, "src"), resolve(stage, "src"), { recursive: true });
		writeFileSync(
			resolve(stage, "package.json"),
			JSON.stringify({ type: "commonjs" }),
		);
		writeFileSync(
			resolve(stage, "tsconfig.json"),
			JSON.stringify({
				extends: "../tsconfig.json",
				compilerOptions: {
					rootDir: "src",
					outDir: "../dist/cjs",
					verbatimModuleSyntax: false,
				},
				include: ["src/**/*.ts"],
				exclude: ["src/test"],
			}),
		);
		args.splice(2, 1, ".build-cjs/tsconfig.json");
	}
	execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
	mkdirSync(resolve(output, format), { recursive: true });
	writeFileSync(
		resolve(output, format, "package.json"),
		JSON.stringify({ type: format === "esm" ? "module" : "commonjs" }),
	);
}
rmSync(resolve(root, ".build-cjs"), { recursive: true, force: true });
// Both entrypoints share constructor identity when a process mixes import/require.
writeFileSync(
	resolve(output, "esm/index.js"),
	'export { LicenseClient, LicenseRequestError } from "../cjs/index.js";\n',
);
writeFileSync(
	resolve(output, "esm/index.d.ts"),
	'export { LicenseClient, LicenseRequestError } from "../cjs/index.js";\nexport type * from "./core/types.js";\n',
);
