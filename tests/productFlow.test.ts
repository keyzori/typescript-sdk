import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sessionRoutes } from "../../server/src/sessions/routes.ts";
import type { SessionService } from "../../server/src/sessions/SessionService.ts";
import type { ClientIp } from "../../server/src/shared/ClientIp.ts";
import { LicenseClient } from "../dist/esm/index.js";
const key = `lic_${"a".repeat(43)}`;
const token = `ses_${"b".repeat(43)}`;
const licenseId = "11111111-1111-4111-8111-111111111111";
test("SDK transport works through current Elysia routes and ArkType schemas", async () => {
	const calls: unknown[] = [];
	const service = {
		activate: async (body: unknown) => {
			calls.push(body);
			return {
				token,
				licenseId,
				type: "lifetime",
				expiresIn: 60,
				metadata: {},
			};
		},
		heartbeat: async () => ({ licenseId, type: "lifetime", expiresIn: 60 }),
		deactivate: async (identity: unknown) => {
			calls.push(identity);
			return { deactivated: true };
		},
	} as unknown as SessionService;
	const ip = { resolve: () => "127.0.0.1" } as unknown as ClientIp;
	const app = new Elysia()
		.use(sessionRoutes(service, ip))
		.listen({ hostname: "127.0.0.1", port: 0 });
	const sdk = new LicenseClient({
		licenseKey: key,
		serverUrl: `http://127.0.0.1:${app.server?.port}`,
		deviceId: "contract",
	});
	try {
		expect((await sdk.activate()).licenseId).toBe(licenseId);
		await sdk.deactivate();
		expect(calls[0]).toMatchObject({ key });
		expect(calls[1]).toMatchObject({ token, ip: "127.0.0.1" });
	} finally {
		await sdk.deactivate().catch(() => {});
		await app.stop();
	}
});
