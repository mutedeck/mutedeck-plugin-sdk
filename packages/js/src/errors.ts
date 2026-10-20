import type { DenyReason } from "./types";

/** Base class for every error thrown by this package. */
export class MuteDeckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** `send()` was called while no session is open (not authenticated and not in v1 mode). */
export class NotConnectedError extends MuteDeckError {}

/** No response arrived for a request within the timeout. */
export class RequestTimeoutError extends MuteDeckError {}

/** The socket closed before the response arrived. */
export class ConnectionClosedError extends MuteDeckError {}

/** The HTTP token is missing, unknown or revoked. The stored token has been cleared. */
export class NotAuthenticatedError extends MuteDeckError {}

/** The desktop app is too old to speak v2 over HTTP (it answers `/v2/*` with 404). */
export class LegacyServerError extends MuteDeckError {}

/** MuteDeck could not be reached (connection refused, DNS failure or timeout). */
export class MuteDeckUnreachableError extends MuteDeckError {
  constructor(
    message: string,
    /** The underlying fetch error. */
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** The user denied pairing, or the request expired. */
export class PairingDeniedError extends MuteDeckError {
  constructor(
    readonly reason: DenyReason,
    /** Seconds to wait before asking again, when the server said so. */
    readonly retryAfter?: number,
  ) {
    super(`Pairing ${reason === "user" ? "denied by the user" : reason}`);
  }
}

/** An HTTP response that does not fit any of the cases above. */
export class HttpError extends MuteDeckError {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`MuteDeck HTTP ${status}`);
  }
}

/** MuteDeck answered a request with a failure status (for example `not_licensed`). */
export class RequestFailedError extends MuteDeckError {
  readonly status: number;
  readonly reason?: string;

  constructor(readonly response: { status: number; reason?: string; message?: string }) {
    super(`MuteDeck refused the request (${response.status}${response.reason ? ` ${response.reason}` : ""})`);
    this.status = response.status;
    this.reason = response.reason;
  }
}
