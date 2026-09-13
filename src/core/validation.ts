import { isAbsolute } from "node:path";
import type { ConsumeInput, LicenseClientConfig } from "./types.js";
const maxTimer = 2_147_483_647;
export function validateConfig(config: LicenseClientConfig): void {
	const fields = new Set([
		"licenseKey",
		"serverUrl",
		"deviceId",
		"identityPath",
		"heartbeatIntervalMs",
		"maxRetries",
		"requestTimeoutMs",
		"logLevel",
	]);
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("LicenseClient configuration must be an object");
	if (Object.keys(config).some((field) => !fields.has(field)))
		throw new Error("LicenseClient configuration contains unknown fields");
	if (
		typeof config.licenseKey !== "string" ||
		!/^lic_[A-Za-z0-9_-]{43}$/.test(config.licenseKey.trim())
	)
		throw new Error("licenseKey must be a valid lic_ secret");
	if (typeof config.serverUrl !== "string")
		throw new Error("serverUrl must be a string");
	if (
		config.deviceId !== undefined &&
		(typeof config.deviceId !== "string" ||
			!config.deviceId.trim() ||
			config.deviceId.trim().length > 1024)
	)
		throw new Error(
			"deviceId must contain between 1 and 1024 trimmed characters",
		);
	if (
		config.identityPath !== undefined &&
		(typeof config.identityPath !== "string" ||
			!isAbsolute(config.identityPath))
	)
		throw new Error("identityPath must be an absolute path");
	if (config.deviceId !== undefined && config.identityPath !== undefined)
		throw new Error("Choose deviceId or identityPath, not both");
	for (const [name, value] of [
		["heartbeatIntervalMs", config.heartbeatIntervalMs],
		["maxRetries", config.maxRetries],
		["requestTimeoutMs", config.requestTimeoutMs],
	] as const) {
		if (
			value !== undefined &&
			(!Number.isSafeInteger(value) || value < 1 || value > maxTimer)
		)
			throw new Error(
				`${name} must be a positive safe integer no greater than ${maxTimer}`,
			);
	}
	if (
		config.logLevel !== undefined &&
		!["none", "error", "warn", "info", "debug"].includes(config.logLevel)
	)
		throw new Error("logLevel must be none, error, warn, info, or debug");
}
export function normalizeConsumeInput(input: ConsumeInput): ConsumeInput {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("consume input must be an object");
	if (
		typeof input.meter !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(input.meter)
	)
		throw new Error(
			"meter must start with a lowercase letter and contain at most 64 lowercase letters, digits, underscores, or hyphens",
		);
	if (!Number.isSafeInteger(input.units) || input.units < 1)
		throw new Error("units must be a positive safe integer");
	if (
		typeof input.eventId !== "string" ||
		input.eventId.length < 1 ||
		input.eventId.length > 128
	)
		throw new Error("eventId must contain between 1 and 128 characters");
	return { meter: input.meter, units: input.units, eventId: input.eventId };
}
