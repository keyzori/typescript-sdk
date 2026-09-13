import {
	TestContext,
	integrationAvailable,
	adminKey,
} from "../../server/tests/helpers/TestContext.ts";
if (!integrationAvailable)
	throw new Error(
		"Set KEYZORI_TEST_DATABASE_URL and KEYZORI_TEST_REDIS_URL to isolated local services",
	);
const context = new TestContext();
try {
	await context.start();
	for (const format of ["esm", "cjs"]) {
		const child = Bun.spawn(
			[
				process.env.KEYZORI_NODE_BINARY ?? "node",
				"--test",
				"tests/liveNode.test.mjs",
			],
			{
				cwd: `${import.meta.dir}/..`,
				stdout: "inherit",
				stderr: "inherit",
				env: {
					...process.env,
					KEYZORI_LIVE_URL: context.url,
					KEYZORI_LIVE_ADMIN_KEY: adminKey,
					KEYZORI_TEST_FORMAT: format,
				},
			},
		);
		if ((await child.exited) !== 0)
			throw new Error(`Node ${format} live integration failed`);
	}
} finally {
	await context.close();
}
