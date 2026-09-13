import type { LicenseErrorCode } from "./types.js";

/** A structured non-success response from the Keyzori server. */
export class LicenseRequestError extends Error {
	public override readonly name = "LicenseRequestError";

	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: LicenseErrorCode | (string & {}),
	) {
		super(message);
	}
}
