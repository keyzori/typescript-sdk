/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: Check literal workflow expressions. */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
for (const repo of ["ts-sdk", "types"]) {
	test(`${repo} release gates and package identity are consistent`, async () => {
		const root = resolve(import.meta.dir, "../..", repo);
		const pkg = await Bun.file(resolve(root, "package.json")).json();
		const config = await Bun.file(
			resolve(root, "release-please-config.json"),
		).json();
		expect(config.packages["."]["package-name"]).toBe(pkg.name);
		const text = await Bun.file(
			resolve(root, ".github/workflows/release.yml"),
		).text();
		const release = Bun.YAML.parse(text) as {
			on: { workflow_run: { workflows: string[] } };
			jobs: {
				release: { steps: { id?: string; run?: string }[] };
				publish: {
					if: string;
					steps: { with?: { ref?: string }; run?: string }[];
				};
			};
		};
		expect(release.on.workflow_run.workflows).toEqual(["CI"]);
		const gate = release.jobs.release.steps.find((step) => step.id === "gate");
		expect(gate?.run).toContain("head_sha=${RELEASE_SHA}&event=push");
		expect(gate?.run).toContain('"${RELEASE_SHA}" != "${main_sha}"');
		expect(gate?.run).toContain("for workflow in CI CodeQL");
		expect(release.jobs.publish.if).toBe(
			"needs.release.outputs.release_created == 'true'",
		);
		expect(release.jobs.publish.steps[0]?.with?.ref).toBe(
			"${{ needs.release.outputs.sha }}",
		);
		expect(
			release.jobs.publish.steps.some(
				(step) => step.run === "node scripts/publish.mjs",
			),
		).toBe(true);
		expect(release.jobs.publish.steps.at(-1)?.run).toBe(
			"node scripts/verifyPublished.mjs",
		);
		const ci = Bun.YAML.parse(
			await Bun.file(resolve(root, ".github/workflows/ci.yml")).text(),
		) as { jobs: Record<string, { needs?: string[]; if?: string }> };
		expect(ci.jobs.required?.if).toBe("${{ always() }}");
		expect(ci.jobs.required?.needs?.sort()).toEqual(
			Object.keys(ci.jobs)
				.filter((name) => name !== "required")
				.sort(),
		);
	});
}
