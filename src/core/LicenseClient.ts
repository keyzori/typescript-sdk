import { ResponseReader } from "./ResponseReader.js";
import { validateConfig, normalizeConsumeInput } from "./validation.js";
import { DeviceManager } from "./DeviceManager.js";
import { EventBroker } from "./EventBroker.js";
import { LicenseRequestError } from "./LicenseRequestError.js";
import { NetworkClient } from "./NetworkClient.js";
import type {
	ActivationResult,
	ConsumeInput,
	LicenseClientConfig,
	LicenseErrorCode,
	LicenseEvents,
	LogLevel,
	UsageResult,
} from "./types.js";

const MAX_TIMER_MS = 2_147_483_647;
const MIN_THROTTLED_RETRY_MS = 1_000;

type ClientState =
	| "idle"
	| "activating"
	| "active"
	| "deactivating"
	| "deactivated";

interface ServerRejection {
	message: string;
	code?: string;
}

const LOG_LEVELS: Record<LogLevel, number> = {
	none: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

/** Manages license activation, usage, session tracking, and heartbeats. */
export class LicenseClient {
	public readonly events: LicenseEvents;

	private readonly reader = new ResponseReader();
	private readonly device: DeviceManager;
	private readonly network: NetworkClient;
	private readonly eventBroker: EventBroker;
	private readonly requestedHeartbeatIntervalMs: number;
	private readonly requestTimeoutMs: number;
	private readonly maxRetries: number;
	private readonly logLevel: LogLevel;
	private readonly usageRequests = new Set<Promise<UsageResult>>();
	private heartbeatIntervalMs: number;
	private heartbeatTimer?: ReturnType<typeof setTimeout>;
	private heartbeatRequest?: Promise<void>;
	private activation?: Promise<ActivationResult>;
	private deactivation?: Promise<void>;
	private activationResult?: ActivationResult;
	private sessionToken?: string;
	private sessionExpiresAtMs?: number;
	private state: ClientState = "idle";
	private failureStrikes = 0;
	private throttleRetries = 0;
	private expiryProtectedThrottleRetryUsed = false;
	private fatalCleanupScheduled = false;

	constructor(config: LicenseClientConfig) {
		validateConfig(config);
		this.logLevel = config.logLevel ?? "none";
		this.eventBroker = new EventBroker(() => {
			this.log("warn", "A license event listener threw an error");
		});
		this.events = this.eventBroker;
		this.device = new DeviceManager(config.deviceId, config.identityPath);
		this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
		this.network = new NetworkClient(
			config.serverUrl,
			config.licenseKey.trim(),
			this.requestTimeoutMs,
		);
		this.requestedHeartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
		this.heartbeatIntervalMs = this.requestedHeartbeatIntervalMs;
		this.maxRetries = config.maxRetries ?? 2;
	}

	/** Activates the license once and starts automatic heartbeats. */
	public activate(): Promise<ActivationResult> {
		if (this.state === "deactivating" || this.state === "deactivated") {
			return Promise.reject(new Error("LicenseClient has been deactivated"));
		}
		if (this.state === "active" && this.activationResult) {
			if (this.expireSession())
				return Promise.reject(new Error("License session has expired"));
			return Promise.resolve(structuredClone(this.activationResult));
		}
		if (this.activation) return this.activation;

		this.state = "activating";
		const activation = this.activateOnce();
		this.activation = activation;
		void activation.catch(() => {
			if (this.activation === activation && this.state === "idle") {
				this.activation = undefined;
			}
		});
		return activation;
	}

	/** Consumes units from a named meter using a per-license idempotency ID. */
	public async consume(input: ConsumeInput): Promise<UsageResult> {
		if (this.state !== "active" || !this.sessionToken) {
			throw new Error("LicenseClient is not active; call activate() first");
		}
		if (this.expireSession()) {
			throw new Error("License session has expired");
		}
		const normalized = normalizeConsumeInput(input);
		const request = this.consumeOnce(this.sessionToken, normalized);
		this.usageRequests.add(request);
		try {
			return await request;
		} finally {
			this.usageRequests.delete(request);
		}
	}

	/** Stops heartbeats and releases the server-side session. Safe to call twice. */
	public deactivate(): Promise<void> {
		if (this.deactivation) return this.deactivation;
		this.state = "deactivating";
		this.clearHeartbeatTimer();
		this.deactivation = this.deactivateOnce();
		return this.deactivation;
	}

	private async activateOnce(): Promise<ActivationResult> {
		try {
			const requestStartedAtMs = Date.now();
			const response = await this.network.sendActivate(
				this.device.getDeviceId(),
			);
			if (!response.ok) {
				const rejection = await this.reader.error(response);
				this.emitLicenseRejection(rejection);
				throw this.toRequestError(response, rejection);
			}

			const payload = await this.reader.activation(response);
			this.sessionToken = payload.token;
			this.sessionExpiresAtMs = requestStartedAtMs + payload.expiresIn * 1_000;
			this.activationResult = {
				licenseId: payload.licenseId,
				licenseType: payload.type,
				metadata: payload.metadata,
			};
			this.heartbeatIntervalMs = this.clampHeartbeatInterval(payload.expiresIn);

			if (this.state !== "activating") {
				throw new Error("LicenseClient was deactivated during activation");
			}
			if (this.expireSession()) throw new Error("License session has expired");

			this.state = "active";
			this.eventBroker.emit("ready", structuredClone(this.activationResult));
			this.log("info", `License activated as ${payload.type}`);
			this.scheduleHeartbeat();
			return structuredClone(this.activationResult);
		} catch (error) {
			if (this.state === "activating") this.state = "idle";
			throw error;
		}
	}

	private async consumeOnce(
		sessionToken: string,
		input: ConsumeInput,
	): Promise<UsageResult> {
		const response = await this.network.sendUsage(
			sessionToken,
			this.device.getDeviceId(),
			input,
		);
		if (!response.ok) {
			const rejection = await this.reader.error(response);
			this.emitLicenseRejection(rejection);
			if (this.isFatalSessionRejection(rejection.code)) {
				this.handleFatalError(rejection.message);
			}
			throw this.toRequestError(response, rejection);
		}

		const payload = await this.reader.usage(response);
		if (
			payload.licenseId !== this.activationResult?.licenseId ||
			payload.units !== input.units ||
			payload.eventId !== input.eventId
		) {
			throw new Error("License server returned a mismatched usage response");
		}
		return { ...payload, meter: input.meter };
	}

	private async deactivateOnce(): Promise<void> {
		let failure: unknown;
		try {
			await this.activation?.catch(() => undefined);
			await this.heartbeatRequest;
			await Promise.allSettled([...this.usageRequests]);

			if (this.sessionToken) {
				const response = await this.network.sendDeactivate(
					this.sessionToken,
					this.device.getDeviceId(),
				);
				if (!response.ok) {
					const rejection = await this.reader.error(response);
					throw this.toRequestError(response, rejection);
				}
				await this.reader.deactivation(response);
			}
		} catch (error) {
			failure = error;
			this.log("warn", "Could not release the license session");
		} finally {
			this.sessionToken = undefined;
			this.sessionExpiresAtMs = undefined;
			this.state = "deactivated";
			this.eventBroker.removeAllListeners();
		}

		if (failure) throw failure;
	}

	private scheduleHeartbeat(delayMs = this.heartbeatIntervalMs): void {
		if (this.state !== "active") return;
		this.heartbeatTimer = setTimeout(() => {
			const request = this.runHeartbeat();
			this.heartbeatRequest = request;
			void request.finally(() => {
				if (this.heartbeatRequest === request) {
					this.heartbeatRequest = undefined;
				}
			});
		}, delayMs);
		this.heartbeatTimer.unref();
	}

	private async runHeartbeat(): Promise<void> {
		const activation = this.activationResult;
		if (this.state !== "active" || !this.sessionToken || !activation) return;
		if (this.expireSession()) return;
		let nextDelayMs = this.heartbeatIntervalMs;
		let retryBeforeSessionExpiry = false;
		try {
			const requestStartedAtMs = Date.now();
			const response = await this.network.sendHeartbeat(
				this.sessionToken,
				this.device.getDeviceId(),
			);
			if (!response.ok) {
				if (response.status === 429) {
					const requestedDelayMs = this.retryAfterMs(response);
					await response.body?.cancel();
					nextDelayMs = this.clampRetryBeforeSessionExpiry(requestedDelayMs);
					const expiryProtectionUsed = nextDelayMs < requestedDelayMs;
					this.throttleRetries++;
					if (
						this.throttleRetries > this.maxRetries ||
						(expiryProtectionUsed && this.expiryProtectedThrottleRetryUsed)
					) {
						const message =
							"Heartbeat remained rate limited beyond the current session lifetime";
						this.eventBroker.emit("network:offline", message);
						this.handleFatalError(message);
						return;
					}
					this.expiryProtectedThrottleRetryUsed ||= expiryProtectionUsed;
					this.eventBroker.emit("heartbeat:throttled", nextDelayMs);
					this.log("warn", `Heartbeat throttled; retrying in ${nextDelayMs}ms`);
					return;
				}

				const rejection = await this.reader.error(response);
				if (response.status >= 400 && response.status < 500) {
					this.emitLicenseRejection(rejection);
					this.handleFatalError(rejection.message);
					return;
				}
				this.recordHeartbeatFailure(rejection.message);
				retryBeforeSessionExpiry = true;
				return;
			}

			const payload = await this.reader.heartbeat(
				response,
				activation.licenseId,
			);
			this.sessionExpiresAtMs = requestStartedAtMs + payload.expiresIn * 1_000;
			if (this.expireSession()) return;
			this.activationResult = {
				licenseId: payload.licenseId,
				licenseType: payload.type,
				metadata: activation.metadata,
			};
			this.heartbeatIntervalMs = this.clampHeartbeatInterval(payload.expiresIn);
			nextDelayMs = this.heartbeatIntervalMs;
			this.failureStrikes = 0;
			this.throttleRetries = 0;
			this.expiryProtectedThrottleRetryUsed = false;
			if (this.state === "active") {
				this.eventBroker.emit(
					"heartbeat:success",
					structuredClone(this.activationResult),
				);
				this.log("debug", "Heartbeat succeeded");
			}
		} catch (error) {
			retryBeforeSessionExpiry = true;
			this.recordHeartbeatFailure(
				error instanceof Error ? error.message : "Network error",
			);
		} finally {
			if (!this.fatalCleanupScheduled) {
				this.scheduleHeartbeat(
					retryBeforeSessionExpiry
						? this.clampRetryBeforeSessionExpiry(nextDelayMs)
						: nextDelayMs,
				);
			}
		}
	}

	private emitLicenseRejection(rejection: ServerRejection): void {
		if (rejection.code === "LICENSE_EXPIRED") {
			this.eventBroker.emit("license:expired", rejection.message);
			return;
		}
		if (rejection.code === "LICENSE_BLOCKED") {
			this.eventBroker.emit("license:revoked", rejection.message);
			return;
		}
		if (rejection.code?.startsWith("SESSION_")) {
			this.eventBroker.emit("session:expired", rejection.message);
			return;
		}
		this.eventBroker.emit("license:rejected", rejection.message);
	}

	private toRequestError(
		response: Response,
		rejection: ServerRejection,
	): LicenseRequestError {
		return new LicenseRequestError(
			rejection.message,
			response.status,
			rejection.code as LicenseErrorCode | (string & {}) | undefined,
		);
	}

	private isFatalSessionRejection(code: string | undefined): boolean {
		return (
			code === "LICENSE_INVALID" ||
			code === "LICENSE_BLOCKED" ||
			code === "LICENSE_EXPIRED" ||
			code === "IP_NOT_ALLOWED" ||
			code === "DEVICE_NOT_ALLOWED" ||
			(code?.startsWith("SESSION_") ?? false) ||
			code === "ACCESS_BLOCKED"
		);
	}

	private clampHeartbeatInterval(sessionTtlSeconds: number): number {
		const sessionTtlMs = sessionTtlSeconds * 1_000;
		const twoThirdsMaximumMs = Math.max(1, Math.floor((sessionTtlMs * 2) / 3));
		const renewalSafetyMs = Math.min(
			1_000,
			Math.max(1, Math.floor(sessionTtlMs / 10)),
		);
		const fullRetryBudgetMs = this.requestTimeoutMs * 2 + renewalSafetyMs;
		const retryAwareMaximumMs = Math.max(
			1,
			Math.floor(
				sessionTtlMs > fullRetryBudgetMs
					? sessionTtlMs - fullRetryBudgetMs
					: sessionTtlMs / 3,
			),
		);
		return Math.min(
			this.requestedHeartbeatIntervalMs,
			twoThirdsMaximumMs,
			retryAwareMaximumMs,
		);
	}

	private retryAfterMs(response: Response): number {
		const value = response.headers.get("retry-after")?.trim();
		if (!value) {
			return Math.max(MIN_THROTTLED_RETRY_MS, this.heartbeatIntervalMs);
		}
		if (/^\d+$/.test(value)) {
			const seconds = Number(value);
			if (Number.isSafeInteger(seconds)) {
				return Math.min(
					MAX_TIMER_MS,
					Math.max(MIN_THROTTLED_RETRY_MS, seconds * 1_000),
				);
			}
		}
		const date = Date.parse(value);
		if (Number.isFinite(date)) {
			return Math.min(
				MAX_TIMER_MS,
				Math.max(MIN_THROTTLED_RETRY_MS, date - Date.now()),
			);
		}
		return Math.max(MIN_THROTTLED_RETRY_MS, this.heartbeatIntervalMs);
	}

	private clampRetryBeforeSessionExpiry(desiredDelayMs: number): number {
		if (this.sessionExpiresAtMs === undefined) return desiredDelayMs;
		const remainingMs = this.sessionExpiresAtMs - Date.now();
		const requestSafetyMs = Math.min(
			Math.max(0, remainingMs - 1),
			this.requestTimeoutMs + 1_000,
		);
		const latestSafeDelayMs = Math.max(
			1,
			Math.floor(remainingMs - requestSafetyMs),
		);
		return Math.min(desiredDelayMs, latestSafeDelayMs);
	}

	private recordHeartbeatFailure(message: string): void {
		if (this.state !== "active") return;
		this.failureStrikes++;
		this.eventBroker.emit("heartbeat:failed", message, this.failureStrikes);
		this.log("warn", `Heartbeat failed: ${message}`);
		if (this.failureStrikes >= this.maxRetries) {
			this.eventBroker.emit("network:offline", message);
			this.handleFatalError(message);
		}
	}

	private expireSession(): boolean {
		if (
			this.sessionExpiresAtMs === undefined ||
			Date.now() < this.sessionExpiresAtMs
		)
			return false;
		this.eventBroker.emit("session:expired", "License session has expired");
		this.handleFatalError("License session has expired");
		return true;
	}

	private handleFatalError(reason: string): void {
		if (this.fatalCleanupScheduled) return;
		this.fatalCleanupScheduled = true;
		this.log("error", `FATAL ERROR: ${reason}`);
		queueMicrotask(() => {
			void this.deactivate().catch(() => {
				this.log("warn", "Could not release the license session");
			});
		});
	}

	private clearHeartbeatTimer(): void {
		if (!this.heartbeatTimer) return;
		clearTimeout(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private log(level: Exclude<LogLevel, "none">, message: string): void {
		if (LOG_LEVELS[this.logLevel] < LOG_LEVELS[level]) return;
		const output = `[LicenseClient] ${message}`;
		if (level === "error") console.error(output);
		else if (level === "warn") console.warn(output);
		else console.info(output);
	}
}
