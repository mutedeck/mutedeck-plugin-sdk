import {
  HttpError,
  LegacyServerError,
  MuteDeckUnreachableError,
  NotAuthenticatedError,
  PairingDeniedError,
  PairingRequiredError,
} from "./errors";
import { clientHeader, Credentials, isValidToken, validateClientInfo } from "./identity";
import { defaultTimers, sleep } from "./timers";
import { memoryTokenStore } from "./token-store";
import type {
  ApiResponse,
  ClientInfo,
  CustomAction,
  DenyReason,
  HttpStatusResponse,
  Logger,
  PairPending,
  Reaction,
  Timers,
  ToggleState,
  TokenStore,
  WhoAmI,
} from "./types";

/** The `fetch` signature this client needs (global `fetch` by default). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface MuteDeckHttpClientOptions {
  client: ClientInfo;
  /**
   * Full base URL, e.g. `http://192.168.1.20:3491`. Overrides `scheme`, `host`
   * and `port`.
   */
  baseUrl?: string;
  /** Default `localhost`. */
  host?: string;
  /** Default 3491. */
  port?: number;
  /** Default `http`. */
  scheme?: "http" | "https";
  /** Token and instance id storage. Default: in memory. */
  tokenStore?: TokenStore;
  /** Default: global `fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout. Default 3000 ms. Exceeding it throws {@link MuteDeckUnreachableError}. */
  timeoutMs?: number;
  /**
   * After a denial, {@link MuteDeckHttpClient.ensurePaired} waits at least this
   * long (or the server's `retry_after`, if longer) before asking again. Default 30000 ms.
   */
  deniedRetryMinMs?: number;
  /**
   * When a call needs a token (MuteDeck refused it without one, or rejected the
   * stored one), pair with these options and retry the call once. Default off:
   * the call throws {@link PairingRequiredError} and you call
   * {@link MuteDeckHttpClient.ensurePaired} yourself.
   */
  autoPair?: boolean | PairOptions;
  /** Clock for the denial wait. Default `Date.now`. */
  now?: () => number;
  logger?: Logger;
  timers?: Timers;
  generateInstanceId?: () => string;
}

export interface PairOptions {
  signal?: AbortSignal;
  /** Called once the approval prompt is queued in MuteDeck. */
  onPending?: (pending: PairPending) => void;
}

/**
 * Result of {@link MuteDeckHttpClient.probe}: `v2` supports pairing and tokens,
 * `v1` is an old MuteDeck (no pairing; calls work without a token).
 */
export type ServerKind = "v2" | "v1" | "unreachable";

type Query = Record<string, string | undefined>;

/**
 * HTTP client for MuteDeck's `/v1` API (port 3491), for plugins that don't
 * keep a socket open (Raycast, scripts).
 *
 * A token is optional. When stored, it is sent as `Authorization: Bearer`.
 * Without one, MuteDeck's "Plugins without authentication" setting decides,
 * and may refuse the call ({@link PairingRequiredError}). Call
 * {@link ensurePaired} to get a token. Every call also sends
 * `?source=<client.id>` and `X-MuteDeck-Client`.
 *
 * Methods resolve with MuteDeck's JSON body. API outcomes such as
 * `{ status: 400, message: "Request invalid. Not in a call." }` arrive with
 * HTTP 200, so check `status` in the body.
 */
export class MuteDeckHttpClient {
  readonly client: Readonly<ClientInfo>;
  private readonly options: MuteDeckHttpClientOptions;
  private readonly credentials: Credentials;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private legacy = false;
  private pairing?: Promise<string | undefined>;
  private deniedUntil = 0;
  private lastDenial?: PairingDeniedError;

  constructor(options: MuteDeckHttpClientOptions) {
    this.options = options;
    this.client = validateClientInfo(options.client);
    this.credentials = new Credentials(options.tokenStore ?? memoryTokenStore(), options.generateInstanceId);
    this.timers = options.timers ?? defaultTimers;
    this.logger = options.logger ?? {};
  }

  /** True once MuteDeck turned out to be an old version without pairing. */
  get isLegacyServer(): boolean {
    return this.legacy;
  }

  /** Whether a token is stored. */
  async hasToken(): Promise<boolean> {
    return (await this.credentials.get()).token !== undefined;
  }

  /** Forget the token (and keep the instance id). */
  async clearToken(): Promise<void> {
    await this.credentials.clearToken();
  }

  /**
   * Find out what is listening, without side effects: `GET /v1/whoami`
   * without a token is 401 on a current MuteDeck and 404 on an old one.
   */
  async probe(): Promise<ServerKind> {
    try {
      const { status, body } = await this.raw("GET", "/v1/whoami", undefined, undefined, false);
      if (status === 404 && isLegacyNotFound(body)) {
        this.legacy = true;
        return "v1";
      }
      this.legacy = false;
      return "v2";
    } catch {
      return "unreachable";
    }
  }

  /**
   * Returns the stored token, or pairs to get one. Resolves `undefined` on an
   * old MuteDeck, which has no pairing (keep calling without a token there).
   * Concurrent calls share one pairing (the first caller's `onPending` and
   * `signal` apply). After a denial it throws {@link PairingDeniedError}
   * without contacting MuteDeck until `max(deniedRetryMinMs, retry_after)` has passed.
   */
  async ensurePaired(options: PairOptions = {}): Promise<string | undefined> {
    const { token } = await this.credentials.get();
    if (token) {
      return token;
    }
    if (this.legacy) {
      return undefined;
    }
    if (this.pairing) {
      return this.pairing;
    }
    const now = this.now();
    if (now < this.deniedUntil && this.lastDenial) {
      throw new PairingDeniedError(this.lastDenial.reason, Math.ceil((this.deniedUntil - now) / 1000));
    }
    this.pairing = this.pair(options)
      .catch((error: unknown) => {
        if (error instanceof LegacyServerError) {
          return undefined;
        }
        if (error instanceof PairingDeniedError) {
          const wait = Math.max(this.options.deniedRetryMinMs ?? 30000, (error.retryAfter ?? 0) * 1000);
          this.deniedUntil = this.now() + wait;
          this.lastDenial = error;
        }
        throw error;
      })
      .finally(() => {
        this.pairing = undefined;
      });
    return this.pairing;
  }

  /**
   * Ask the user to approve this client and wait for the answer. Stores and
   * returns the token. Throws {@link PairingDeniedError} when denied or
   * expired, {@link LegacyServerError} on an old MuteDeck. Prefer
   * {@link ensurePaired}.
   */
  async pair(options: PairOptions = {}): Promise<string> {
    const { instanceId } = await this.credentials.get();
    const start = await this.raw("POST", "/v1/pair", undefined, { client: this.client, instance_id: instanceId }, false, options.signal);
    if (start.status === 404 && isLegacyNotFound(start.body)) {
      this.legacy = true;
      throw new LegacyServerError("This MuteDeck version does not support pairing");
    }
    this.legacy = false;
    throwIfDenied(start.status, start.body);
    if (start.status !== 202) {
      throw new HttpError(start.status, start.body);
    }

    let pending = start.body as PairPending;
    options.onPending?.(pending);
    const requestId = pending.request_id;
    const deadline = Date.now() + (pending.expires_in ?? 120) * 1000 + 5000;

    for (;;) {
      await sleep(this.timers, Math.max(0.1, pending.poll_after ?? 2) * 1000, options.signal);
      const poll = await this.raw("GET", `/v1/pair/${encodeURIComponent(requestId)}`, undefined, undefined, false, options.signal);
      if (poll.status === 200) {
        const token = (poll.body as { token?: unknown }).token;
        if (!isValidToken(token)) {
          throw new HttpError(200, "Pairing answer without a valid token");
        }
        await this.credentials.setToken(token);
        this.logger.info?.("MuteDeck: paired");
        return token;
      }
      throwIfDenied(poll.status, poll.body);
      if (poll.status === 404) {
        throw new PairingDeniedError("expired");
      }
      if (poll.status !== 202) {
        throw new HttpError(poll.status, poll.body);
      }
      pending = { ...pending, ...(poll.body as Partial<PairPending>) };
      if (Date.now() > deadline) {
        throw new PairingDeniedError("expired");
      }
    }
  }

  /**
   * Check the stored token; returns the client record. Throws
   * {@link PairingRequiredError} without a token, and
   * {@link LegacyServerError} on an old MuteDeck.
   */
  async whoami(): Promise<WhoAmI> {
    const body = await this.call<WhoAmI | { error?: string }>("GET", "whoami");
    if (!("status" in body)) {
      this.legacy = true;
      throw new LegacyServerError("This MuteDeck version has no /v1/whoami");
    }
    return body as WhoAmI;
  }

  getStatus(): Promise<HttpStatusResponse> {
    return this.call<HttpStatusResponse>("GET", "status");
  }

  async listCustomActions(): Promise<CustomAction[]> {
    const body = await this.call<{ custom_actions?: CustomAction[] }>("GET", "list-custom-actions");
    return body.custom_actions ?? [];
  }

  customAction(name: string): Promise<ApiResponse> {
    return this.call("POST", "custom-action", { name });
  }

  mute(state?: ToggleState): Promise<ApiResponse> {
    return this.call("POST", "mute", { state });
  }

  video(state?: ToggleState): Promise<ApiResponse> {
    return this.call("POST", "video", { state });
  }

  share(state?: ToggleState): Promise<ApiResponse> {
    return this.call("POST", "share", { state });
  }

  record(state?: ToggleState): Promise<ApiResponse> {
    return this.call("POST", "record", { state });
  }

  leave(): Promise<ApiResponse> {
    return this.call("POST", "leave");
  }

  bringToFront(): Promise<ApiResponse> {
    return this.call("POST", "bring-to-front");
  }

  backgroundBlur(): Promise<ApiResponse> {
    return this.call("POST", "background-blur");
  }

  raiseHand(): Promise<ApiResponse> {
    return this.call("POST", "raise-hand");
  }

  toggleChatWindow(): Promise<ApiResponse> {
    return this.call("POST", "toggle-chat-window");
  }

  react(reaction: Reaction): Promise<ApiResponse> {
    return this.call("POST", `react-${reaction}`);
  }

  /**
   * Call `/v1/<endpoint>`, with the stored token when there is one.
   *
   * - HTTP 401 after sending a token: the token is cleared and
   *   {@link NotAuthenticatedError} (a {@link PairingRequiredError}) is thrown.
   * - HTTP 401 or 426 without a token: MuteDeck requires pairing, so
   *   {@link PairingRequiredError} is thrown.
   * - With `autoPair`, either case pairs and retries once.
   */
  async call<T = ApiResponse>(method: "GET" | "POST", endpoint: string, query: Query = {}): Promise<T> {
    try {
      return await this.callOnce<T>(method, endpoint, query);
    } catch (error) {
      const autoPair = this.options.autoPair;
      if (!autoPair || !(error instanceof PairingRequiredError)) {
        throw error;
      }
      const token = await this.ensurePaired(autoPair === true ? {} : autoPair);
      if (!token) {
        throw error;
      }
      return this.callOnce<T>(method, endpoint, query);
    }
  }

  private async callOnce<T>(method: "GET" | "POST", endpoint: string, query: Query): Promise<T> {
    const { token } = await this.credentials.get();
    const { status, body } = await this.raw(method, `/v1/${endpoint}`, { ...query, source: this.client.id }, undefined, true);
    if (status === 401) {
      if (token) {
        await this.credentials.clearToken();
        throw new NotAuthenticatedError("MuteDeck rejected the token; pair again");
      }
      throw new PairingRequiredError("not_authenticated", "MuteDeck requires pairing for this client");
    }
    if (status === 426) {
      throw new PairingRequiredError("upgrade_required", "MuteDeck only accepts paired clients");
    }
    if (status === 404 && isLegacyNotFound(body) && endpoint === "whoami") {
      return (body ?? {}) as T;
    }
    if (status !== 200 || body === undefined || typeof body !== "object") {
      throw new HttpError(status, body);
    }
    return body as T;
  }

  private async raw(
    method: string,
    path: string,
    query: Query | undefined,
    json: unknown,
    authenticated: boolean,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }> {
    const fetchImpl = this.options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!fetchImpl) {
      throw new TypeError("No fetch implementation available; pass options.fetch");
    }
    let url = `${this.baseUrl}${path}`;
    const params = Object.entries(query ?? {}).filter(([, v]) => v !== undefined) as [string, string][];
    if (params.length > 0) {
      url += `?${new URLSearchParams(params).toString()}`;
    }

    const headers: Record<string, string> = { Accept: "application/json", "X-MuteDeck-Client": clientHeader(this.client) };
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (authenticated) {
      const { token } = await this.credentials.get();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }
    this.logger.debug?.(`MuteDeck: ${method} ${path}`);

    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timeoutMs = this.options.timeoutMs ?? 3000;
    let timedOut = false;
    const timer = this.timers.setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, timeoutMs);
    const onAbort = () => controller?.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let text: string;
    let status: number;
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: controller?.signal ?? signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      throw new MuteDeckUnreachableError(
        timedOut ? `MuteDeck did not answer within ${timeoutMs} ms` : `MuteDeck is not reachable at ${this.baseUrl}`,
        error,
      );
    } finally {
      this.timers.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status, body };
  }

  private get baseUrl(): string {
    if (this.options.baseUrl) {
      return this.options.baseUrl.replace(/\/+$/, "");
    }
    return `${this.options.scheme ?? "http"}://${this.options.host ?? "localhost"}:${this.options.port ?? 3491}`;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

/** An old MuteDeck answers unknown paths with 404 `{ "error": "Invalid URL." }` (no `status` field). */
function isLegacyNotFound(body: unknown): boolean {
  return !(body && typeof body === "object" && "status" in body);
}

function throwIfDenied(status: number, body: unknown): void {
  if (status === 403 || status === 429) {
    const b = (body ?? {}) as { reason?: string; retry_after?: number };
    const reason: DenyReason = status === 429 ? "busy" : ((b.reason as DenyReason) ?? "user");
    throw new PairingDeniedError(reason, typeof b.retry_after === "number" ? b.retry_after : undefined);
  }
}
