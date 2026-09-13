import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Persistent installation identity. This is not hardware attestation. */
export class DeviceManager {
	private cached?: string;
	constructor(
		private readonly deviceId?: string,
		private readonly identityPath?: string,
	) {}
	getDeviceId(): string {
		if (this.cached) return this.cached;
		const identity = this.deviceId?.trim() ?? this.loadIdentity();
		if (!identity || identity.length > 1024)
			throw new Error("Invalid device identity");
		this.cached = createHash("sha256").update(identity).digest("hex");
		return this.cached;
	}
	private loadIdentity(): string {
		const configuredPath =
			this.identityPath ?? process.env.KEYZORI_IDENTITY_PATH;
		if (
			!configuredPath &&
			(existsSync("/.dockerenv") || existsSync("/run/.containerenv"))
		)
			throw new Error(
				"Containers require identityPath or KEYZORI_IDENTITY_PATH on persistent storage",
			);
		const path = configuredPath ?? join(homedir(), ".keyzori", "identity");
		if (!isAbsolute(path))
			throw new Error("identityPath must be an absolute path");
		try {
			return this.read(path);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
		let failure: unknown;
		try {
			writeFileSync(temporary, `${randomBytes(32).toString("hex")}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			// Publish a complete file atomically without replacing a concurrent winner.
			try {
				linkSync(temporary, path);
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error;
			}
		} catch (error) {
			failure = error;
		} finally {
			try {
				unlinkSync(temporary);
			} catch (error) {
				if (!hasCode(error, "ENOENT")) failure ??= error;
			}
		}
		if (failure) throw failure;
		return this.read(path);
	}
	private read(path: string): string {
		const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const info = fstatSync(fd);
			if (!info.isFile() || info.size !== 65)
				throw new Error(
					"Stored device identity is invalid; restore the original file",
				);
			const identity = readFileSync(fd, "utf8");
			if (!/^[a-f0-9]{64}\n$/.test(identity))
				throw new Error(
					"Stored device identity is invalid; restore the original file",
				);
			return identity.trim();
		} finally {
			closeSync(fd);
		}
	}
}
function hasCode(error: unknown, code: string): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		error.code === code
	);
}
