import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
export const sdk =
	process.env.KEYZORI_TEST_FORMAT === "cjs"
		? require("../../dist/cjs/index.js")
		: await import("../../dist/esm/index.js");
export const key = `lic_${"a".repeat(43)}`;
export const token = `ses_${"b".repeat(43)}`;
export const id = "11111111-1111-4111-8111-111111111111";
export const meterId = "22222222-2222-4222-8222-222222222222";
export const activation = (extra = {}) => ({
	licenseId: id,
	type: "metered",
	metadata: { nested: { enabled: true } },
	expiresIn: 30,
	token,
	...extra,
});
export const heartbeat = (extra = {}) => ({
	licenseId: id,
	type: "metered",
	expiresIn: 30,
	...extra,
});
export const usage = (body, extra = {}) => ({
	id,
	licenseId: id,
	meterId,
	eventId: body.eventId,
	units: body.units,
	used: body.units,
	remaining: 10 - body.units,
	createdAt: "2026-01-01T00:00:00.000Z",
	...extra,
});
export const rejection = (code, status = 403) => ({
	status,
	body: { error: { code, message: `Rejected: ${code}` } },
});
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(check, timeout = 3000) {
	const end = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > end) throw new Error("Timed out waiting for condition");
		await delay(5);
	}
}
export async function fixture(t, handler, options = {}) {
	const requests = [];
	const clients = [];
	const server = createServer(async (req, res) => {
		try {
			let raw = "";
			for await (const chunk of req) raw += chunk;
			const request = {
				path: req.url,
				method: req.method,
				headers: req.headers,
				body: raw ? JSON.parse(raw) : undefined,
			};
			requests.push(request);
			const custom = await handler?.(request, res);
			if (res.writableEnded || res.destroyed || custom === null) return;
			const body =
				custom?.body ??
				(request.path === "/sessions"
					? activation()
					: request.path === "/sessions/heartbeat"
						? heartbeat()
						: request.path === "/usage"
							? usage(request.body)
							: { deactivated: true });
			res.writeHead(custom?.status ?? 200, {
				"content-type": "application/json",
				...custom?.headers,
			});
			res.end(JSON.stringify(body));
		} catch {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${server.address().port}`;
	function client(overrides = {}) {
		const instance = new sdk.LicenseClient({
			licenseKey: key,
			serverUrl: url,
			deviceId: "test-device",
			heartbeatIntervalMs: 1000,
			requestTimeoutMs: 500,
			...options,
			...overrides,
		});
		clients.push(instance);
		return instance;
	}
	t.after(async () => {
		await Promise.allSettled(clients.map((instance) => instance.deactivate()));
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	return { url, requests, client, server };
}
