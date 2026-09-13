import type {
	ConsumeRequest,
	Usage,
	LicenseType,
	Metadata,
} from "@keyzori/types";
export type * from "@keyzori/types";
export type LogLevel = "none" | "error" | "warn" | "info" | "debug";
export type LicenseErrorCode = string;
export type LicenseErrorResponse = import("@keyzori/types").ErrorResponse;
export type ConsumeInput = ConsumeRequest;
export type UsageResponse = Usage;
export interface ActivationResult {
	licenseId: string;
	licenseType: LicenseType;
	metadata: Metadata;
}
export interface UsageResult extends Usage {
	meter: string;
}
/** Configuration for a {@link LicenseClient}. */
export interface LicenseClientConfig {
	/** Full license secret returned once by the instance operator. */
	licenseKey: string;

	/** Fully qualified URL of the Keyzori server. */
	serverUrl: string;

	/**
	 * Optional application-specific device identifier. Its trimmed value must
	 * contain 1-1024 characters and is transmitted only as a SHA-256 digest.
	 * When omitted, a random installation identity is persisted to identityPath. This is not hardware attestation.
	 */
	deviceId?: string;

	/**
	 * Absolute path on persistent application storage, on any host or guest.
	 * Defaults to ~/.keyzori/identity on ordinary hosts. Detected Docker/Podman
	 * environments require this path, KEYZORI_IDENTITY_PATH, or deviceId.
	 */
	identityPath?: string;

	/**
	 * Maximum interval between automatic heartbeats.
	 * @default 30000
	 */
	heartbeatIntervalMs?: number;

	/**
	 * Consecutive transient heartbeat failures allowed before going offline.
	 * @default 2
	 */
	maxRetries?: number;

	/**
	 * Maximum duration of an HTTP request in milliseconds.
	 * @default 10000
	 */
	requestTimeoutMs?: number;

	/** Internal logging level. */
	logLevel?: LogLevel;
}

/** Lifecycle events emitted by {@link LicenseClient}. */
export interface LicenseEventMap {
	/** Initial activation completed and automatic heartbeats started. */
	ready: (activation: ActivationResult) => void;

	/** A recurring heartbeat refreshed the session. */
	"heartbeat:success": (activation: ActivationResult) => void;

	/** A transient heartbeat failed but has not exhausted `maxRetries`. */
	"heartbeat:failed": (error: string, strikes: number) => void;

	/** A rate-limited heartbeat was rescheduled without a failure strike. */
	"heartbeat:throttled": (retryAfterMs: number) => void;

	/** The server reports that the license was revoked. */
	"license:revoked": (reason: string) => void;

	/** The server reports that the license has expired. */
	"license:expired": (reason: string) => void;

	/** The current server-issued session is no longer valid. */
	"session:expired": (reason: string) => void;

	/** Another license or usage policy rejected the request. */
	"license:rejected": (reason: string) => void;

	/** Consecutive transient heartbeat failures exhausted `maxRetries`. */
	"network:offline": (error: string) => void;
}

/** Typed event subscriptions exposed by {@link LicenseClient}. */
export interface LicenseEvents {
	on<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void;
	once<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void;
	removeListener<K extends keyof LicenseEventMap>(
		event: K,
		listener: LicenseEventMap[K],
	): void;
}
