import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const archive = new URL(
	`.artifacts/${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`,
	root,
);
const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
for (let attempt = 0; attempt < 20; attempt++) {
	const response = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
		{ cache: "no-store", signal: AbortSignal.timeout(10000) },
	);
	if (response.ok) {
		const metadata = await response.json();
		if (metadata.dist?.integrity !== integrity)
			throw new Error("Published package does not match the verified archive");
		console.log(`Verified npm publication: ${pkg.name}@${pkg.version}`);
		break;
	}
	if (attempt === 19)
		throw new Error("Published package was not visible in npm after retries");
	await setTimeout(3000);
}
