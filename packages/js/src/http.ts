import {
  HttpError,
  LegacyServerError,
  MuteDeckUnreachableError,
  NotAuthenticatedError,
  PairingDeniedError,
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
  /** Clock for the denial wait. Default `Date.now`. */
  now?: () => number;
  logger?: Logger;
  timers?: Timers;
  generateInstanceId?: () => string;
  /**
   * When MuteDeck turns out to be too old for `/v2`, send the calls to `/v1`
   * with `?source=<client.id>` instead of throwing. Default true.
   */
  legacyFallback?: boolean;
}

export interface PairOptions {
  signal?: AbortSignal;
  /** Called once the approval prompt is queued in MuteDeck. */
  onPending?: (pending: PairPending) => void;
}

/** Result of {@link MuteDeckHttpClient.probe}. */
export type ServerKind = "v2" | "v1" | "unreachable";

type Query = Record<string, string | undefined>;

/**
 * HTTP client for `/v2` (port 3491), for plugins that don't keep a socket open
 * (Raycast, scripts). Use {@link pair} once to obtain a token.
 *
 * Methods resolve with MuteDeck's JSON body for API-level outcomes, including
 * `400 not_in_call`; check `status`. They throw {@link NotAuthenticatedError}
 * on 401 (the stored token is then cleared), {@link LegacyServerError} for an
 * old MuteDeck when `legacyFallback` is off, {@link MuteDeckUnreachableError}
 * when nothing answers, and {@link HttpError} otherwise.
 */
export class MuteDeckHttpClient {
  readonly client: Readonly<ClientInfo>;
  private readonly options: MuteDeckHttpClientOptions;
  private readonly credentials: Credentials;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private legacy = false;
  private pairing?: Promise<string>;
  private deniedUntil = 0;
  private lastDenial?: PairingDeniedError;

  constructor(options: MuteDeckHttpClientOptions) {
    this.options = options;
    this.client = validateClientInfo(options.client);
    this.credentials = new Credentials(options.tokenStore ?? memoryTokenStore(), options.generateInstanceId);
    this.timers = options.timers ?? defaultTimers;
    this.logger = options.logger ?? {};
  }

  /** True once a `/v2` call got the old desktop's 404. */
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

  /** Find out what is listening: a v2 MuteDeck, an old one, or nothing. */
  async probe(): Promise<ServerKind> {
    try {
      const { status, body } = await this.raw("GET", "/v2/whoami", undefined, undefined, false);
      if (status === 404 && isLegacyNotFound(body)) {
        this.legacy = true;
        return "v1";
      }
      return "v2";
    } catch {
      return "unreachable";
    }
  }

  /**
   * Returns the stored token, or pairs to get one. Concurrent calls share one
   * pairing (the first caller's `onPending` and `signal` apply). After a
   * denial it throws {@link PairingDeniedError} without contacting MuteDeck
   * until `max(deniedRetryMinMs, retry_after)` has passed.
   */
  async ensurePaired(options: PairOptions = {}): Promise<string> {
    const { token } = await this.credentials.get();
    if (token) {
      return token;
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
   * expired, {@link LegacyServerError} on an old MuteDeck.
   */
  async pair(options: PairOptions = {}): Promise<string> {
    const { instanceId } = await this.credentials.get();
    const start = await this.raw("POST", "/v2/pair", undefined, { client: this.client, instance_id: instanceId }, false, options.signal);
    if (start.status === 404 && isLegacyNotFound(start.body)) {
      this.legacy = true;
      throw new LegacyServerError("This MuteDeck version does not support pairing");
    }
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
      const poll = await this.raw("GET", `/v2/pair/${encodeURIComponent(requestId)}`, undefined, undefined, false, options.signal);
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

  /** Check the token; returns the client record. */
  whoami(): Promise<WhoAmI> {
    return this.call<WhoAmI>("GET", "whoami");
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
   * Call `/v2/<endpoint>` with the stored token, or `/v1/<endpoint>?source=<client.id>`
   * on an old MuteDeck.
   */
  async call<T = ApiResponse>(method: "GET" | "POST", endpoint: string, query: Query = {}): Promise<T> {
    if (this.legacy) {
      return this.callV1<T>(method, endpoint, query);
    }
    const { token } = await this.credentials.get();
    const { status, body } = await this.raw(method, `/v2/${endpoint}`, query, undefined, true);
    if (status === 404 && isLegacyNotFound(body)) {
      this.legacy = true;
      if (this.options.legacyFallback === false) {
        throw new LegacyServerError("This MuteDeck version does not support API v2");
      }
      this.logger.info?.("MuteDeck: old version detected; using API v1");
      return this.callV1<T>(method, endpoint, query);
    }
    if (status === 401) {
      if (token) {
        await this.credentials.clearToken();
      }
      throw new NotAuthenticatedError(token ? "MuteDeck rejected the token; pair again" : "Not paired with MuteDeck");
    }
    if (status >= 500 || body === undefined) {
      throw new HttpError(status, body);
    }
    return body as T;
  }

  private async callV1<T>(method: "GET" | "POST", endpoint: string, query: Query): Promise<T> {
    const { status, body } = await this.raw(method, `/v1/${endpoint}`, { ...query, source: this.client.id }, undefined, false);
    if (status !== 200 || body === undefined) {
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

/** The old desktop answers unknown paths with 404 `{ "error": "Invalid URL." }` (no `status` field). */
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
