import type {
	ActivateResponse,
	HeartbeatResponse,
	Usage,
} from "@keyzori/types";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
export const isUuid = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
		value,
	);
const safeInteger = (value: unknown, min = 0): value is number =>
	Number.isSafeInteger(value) && (value as number) >= min;
const licenseType = (value: unknown) =>
	["lifetime", "trial", "subscription", "metered"].includes(value as string);

/** Bounded JSON parsing and validation of public runtime responses. */
export class ResponseReader {
	async json(response: Response): Promise<unknown> {
		const limit = 262_144;
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > limit) {
			await response.body?.cancel();
			throw new Error("License server response exceeded the safety limit");
		}
		if (!response.body) return undefined;
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > limit) {
					await reader.cancel();
					throw new Error("License server response exceeded the safety limit");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		try {
			return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		} catch {
			return undefined;
		}
	}
	async activation(response: Response): Promise<ActivateResponse> {
		const value = await this.json(response);
		if (
			!this.isHeartbeat(value) ||
			!isRecord(value) ||
			!isRecord(value.metadata) ||
			typeof value.token !== "string" ||
			!/^ses_[A-Za-z0-9_-]{43}$/.test(value.token)
		)
			throw new Error("License server returned an invalid activation response");
		return value as unknown as ActivateResponse;
	}
	async heartbeat(
		response: Response,
		licenseId: string,
	): Promise<HeartbeatResponse> {
		const value = await this.json(response);
		if (!this.isHeartbeat(value) || value.licenseId !== licenseId)
			throw new Error("License server returned an invalid heartbeat response");
		return value;
	}
	private isHeartbeat(value: unknown): value is HeartbeatResponse {
		return (
			isRecord(value) &&
			isUuid(value.licenseId) &&
			licenseType(value.type) &&
			safeInteger(value.expiresIn, 1) &&
			value.expiresIn <= 86_400
		);
	}
	async usage(response: Response): Promise<Usage> {
		const value = await this.json(response);
		if (
			!isRecord(value) ||
			!isUuid(value.id) ||
			!isUuid(value.licenseId) ||
			!isUuid(value.meterId) ||
			typeof value.eventId !== "string" ||
			value.eventId.length < 1 ||
			value.eventId.length > 128 ||
			!safeInteger(value.units, 1) ||
			!safeInteger(value.used) ||
			!safeInteger(value.remaining) ||
			typeof value.createdAt !== "string" ||
			!Number.isFinite(Date.parse(value.createdAt))
		)
			throw new Error("License server returned an invalid usage response");
		return value as unknown as Usage;
	}
	async deactivation(response: Response): Promise<void> {
		const value = await this.json(response);
		if (!isRecord(value) || value.deactivated !== true)
			throw new Error(
				"License server returned an invalid deactivation response",
			);
	}
	async error(response: Response): Promise<{ message: string; code?: string }> {
		const value = await this.json(response);
		if (
			isRecord(value) &&
			isRecord(value.error) &&
			typeof value.error.message === "string" &&
			typeof value.error.code === "string"
		)
			return { message: value.error.message, code: value.error.code };
		return { message: `HTTP ${response.status}` };
	}
}
