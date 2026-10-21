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

/**
 * MuteDeck refused an HTTP call that had no (valid) token: its "Plugins without
 * authentication" setting requires pairing for this client. Call
 * `ensurePaired()` and retry (or set `autoPair`).
 *
 * `reason` is `not_authenticated` (HTTP 401: "this computer only" for a remote
 * client, or a rejected token) or `upgrade_required` (HTTP 426: "block").
 */
export class PairingRequiredError extends MuteDeckError {
  constructor(
    readonly reason: "not_authenticated" | "upgrade_required",
    message: string,
  ) {
    super(message);
  }
}

/**
 * MuteDeck rejected the stored token (HTTP 401 with a token: unknown or
 * revoked). The token has been cleared; pair again.
 */
export class NotAuthenticatedError extends PairingRequiredError {
  constructor(message: string) {
    super("not_authenticated", message);
  }
}

/** The desktop app is too old for pairing (it answers `/v1/pair` and `/v1/whoami` with 404). */
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
