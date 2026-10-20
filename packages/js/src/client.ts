import { Backoff, type BackoffOptions } from "./backoff";
import { TypedEmitter } from "./emitter";
import {
  ConnectionClosedError,
  MuteDeckError,
  NotConnectedError,
  RequestFailedError,
  RequestTimeoutError,
} from "./errors";
import { Credentials, isValidToken, validateClientInfo } from "./identity";
import { defaultTimers } from "./timers";
import { memoryTokenStore } from "./token-store";
import type {
  ClientInfo,
  CloseInfo,
  ConnectionState,
  CustomAction,
  DenyReason,
  Logger,
  Reaction,
  RequestId,
  Role,
  StatusReport,
  Timers,
  ToggleState,
  TokenStore,
  WsBrowserControl,
  WsCustomActionList,
  WsHello,
  WsResponse,
  WsStatusUpdate,
  WsWelcome,
} from "./types";

/**
 * The subset of the WebSocket API the client uses. Both the browser
 * `WebSocket` and the `ws` package satisfy it. Handler parameters are `any`
 * so either implementation's event types fit.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onopen: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onclose: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onerror: ((event: any) => void) | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((event: any) => void) | null;
}

/** Creates a socket for `url`, e.g. `(url) => new WebSocket(url)`. */
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface MuteDeckClientOptions {
  /** Who this plugin is. Validated against the spec limits; throws `TypeError` when invalid. */
  client: ClientInfo;
  /** Socket implementation: `(url) => new WebSocket(url)` with `ws` in Node or the global in browsers. */
  webSocketFactory: WebSocketFactory;
  /** Default `controller`. The browser extension uses `status-source`. */
  role?: Role;
  /** Default `localhost`. */
  host?: string;
  /** Plain WebSocket port. Default 3492. */
  port?: number;
  /** TLS WebSocket port. Default 3493. */
  securePort?: number;
  /** Use `wss://host:securePort`. Default false. */
  secure?: boolean;
  /** Where the token and instance id live. Default: in memory (re-pairs on every start). */
  tokenStore?: TokenStore;
  /**
   * `source` used when talking to an old (v1-only) MuteDeck: `plugin` (default),
   * `streamdeck-plugin` or `browser-extension-plugin`.
   */
  v1Source?: string;
  /** Optional logger. Tokens are never logged. */
  logger?: Logger;
  /** Injectable timers. Default: the global `setTimeout`/`clearTimeout`. */
  timers?: Timers;
  /** Random source for reconnect jitter (0..1). Default `Math.random`. */
  random?: () => number;
  /** Instance id generator. Default `crypto.randomUUID()`. */
  generateInstanceId?: () => string;
  /** How long to wait for `welcome` before falling back to v1. Default 3000 ms. */
  welcomeTimeoutMs?: number;
  /** How long `send()` waits for the matching response. Default 5000 ms. */
  requestTimeoutMs?: number;
  /** Reconnect backoff. Default 1 s doubling up to 30 s, with jitter. */
  reconnect?: BackoffOptions;
  /** Minimum wait after `denied` before the next hello. Default 30000 ms. */
  deniedRetryMinMs?: number;
  /** Consecutive rejections of a stored token before backing off. Default 3. */
  maxTokenRejections?: number;
  /** Back-off once `maxTokenRejections` is reached. Default 60000 ms. */
  tokenRejectionBackoffMs?: number;
  /**
   * Send `keep-alive` this often while connected, including while waiting for
   * approval. Default 0 (off). An MV3 service worker should use about 20000 so
   * Chrome keeps it alive.
   */
  keepAliveIntervalMs?: number;
}

/** Events emitted by {@link MuteDeckClient}. */
export interface MuteDeckClientEvents {
  state: [state: ConnectionState, previous: ConnectionState];
  /** The socket closed (see {@link MuteDeckClient.lastClose}). */
  close: [info: CloseInfo];
  /** A full meeting status push (controllers only). */
  status: [status: WsStatusUpdate];
  /** The custom actions list (pushed after `welcome ok`, or a `listCustomActions()` answer). */
  customActions: [actions: CustomAction[]];
  /** A control forward for the `status-source` role, to be performed on the page. */
  browserControl: [control: WsBrowserControl];
  /** The raw `welcome` message. */
  welcome: [welcome: WsWelcome];
  /** The user approved this client; the token has been stored. */
  approved: [];
  /** The user denied this client (or the prompt expired). */
  denied: [info: { reason: DenyReason; retryAfter?: number }];
  /** The token was revoked in MuteDeck and has been discarded. */
  revoked: [];
  /** A server `error` message without a request id, or a storage failure. */
  error: [error: Error];
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: unknown;
}

type SocketMode = "v1" | "v2";

const OPEN = 1;
const SERVER_MESSAGES = new Set([
  "welcome",
  "approved",
  "denied",
  "revoked",
  "error",
  "update-status",
  "list-custom-actions",
]);

/**
 * WebSocket client for the MuteDeck plugin protocol v2, with automatic
 * fallback to v1 for old MuteDeck versions.
 *
 * ```ts
 * const md = new MuteDeckClient({
 *   client: { id: "streamdeck", name: "Stream Deck", version: "13.1.0" },
 *   webSocketFactory: (url) => new WebSocket(url),
 *   tokenStore,
 * });
 * md.on("status", (s) => render(s));
 * md.connect();
 * await md.toggleMute();
 * ```
 */
export class MuteDeckClient extends TypedEmitter<MuteDeckClientEvents> {
  readonly role: Role;
  readonly client: Readonly<ClientInfo>;

  private readonly options: MuteDeckClientOptions;
  private readonly timers: Timers;
  private readonly logger: Logger;
  private readonly credentials: Credentials;
  private readonly backoff: Backoff;
  private readonly v1Source: string;

  private socket?: WebSocketLike;
  private generation = 0;
  private started = false;
  private _state: ConnectionState = "disconnected";
  private serverIsV1 = false;
  private helloHadToken = false;
  private tokenRejections = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private v1ListWaiters: PendingRequest[] = [];
  private welcomeTimer?: unknown;
  private reconnectTimer?: unknown;
  private keepAliveTimer?: unknown;
  private _serverVersion?: string;
  private _licensed?: boolean;
  private _lastStatus?: WsStatusUpdate;
  private _customActions?: CustomAction[];
  private _lastClose?: CloseInfo;

  constructor(options: MuteDeckClientOptions) {
    super();
    this.options = options;
    this.client = validateClientInfo(options.client);
    this.role = options.role ?? "controller";
    this.timers = options.timers ?? defaultTimers;
    this.logger = options.logger ?? {};
    this.v1Source = options.v1Source ?? "plugin";
    this.credentials = new Credentials(
      options.tokenStore ?? memoryTokenStore(),
      options.generateInstanceId,
    );
    this.backoff = new Backoff(options.reconnect, options.random);
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /** True once actions can be sent (`authenticated` or `v1`). */
  get isReady(): boolean {
    return this._state === "authenticated" || this._state === "v1";
  }

  /** True while the connected MuteDeck only speaks v1. */
  get isLegacyServer(): boolean {
    return this.serverIsV1;
  }

  /** MuteDeck version from `welcome`, when known. */
  get serverVersion(): string | undefined {
    return this._serverVersion;
  }

  /** Whether MuteDeck is licensed, from `welcome`, when known. */
  get licensed(): boolean | undefined {
    return this._licensed;
  }

  /** The most recent status push. */
  get lastStatus(): WsStatusUpdate | undefined {
    return this._lastStatus;
  }

  /** Why the most recent socket closed, if one has. */
  get lastClose(): CloseInfo | undefined {
    return this._lastClose;
  }

  /** The most recent custom actions list. */
  get customActions(): CustomAction[] | undefined {
    return this._customActions;
  }

  /** Start connecting (and keep reconnecting until {@link disconnect}). Idempotent. */
  connect(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.backoff.reset();
    this.open();
  }

  /** Close the connection and stop reconnecting. */
  disconnect(): void {
    this.started = false;
    this.clearTimer("reconnectTimer");
    if (this.socket) {
      this.recordClose({ reason: "disconnect", byClient: true });
    }
    this.teardown();
    this.setState("disconnected");
  }

  /**
   * Resolves when the client is ready to send actions (`authenticated` or
   * `v1`). Rejects with {@link RequestTimeoutError} after `timeoutMs`, if given.
   */
  whenReady(timeoutMs?: number): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer: unknown;
      const off = this.on("state", () => {
        if (this.isReady) {
          off();
          if (timer !== undefined) {
            this.timers.clearTimeout(timer);
          }
          resolve();
        }
      });
      if (timeoutMs !== undefined) {
        timer = this.timers.setTimeout(() => {
          off();
          reject(new RequestTimeoutError("MuteDeck connection not ready in time"));
        }, timeoutMs);
      }
    });
  }

  /** Forget the token and instance id, then reconnect as a new install (asks the user again). */
  async resetPairing(): Promise<void> {
    await this.credentials.reset();
    if (this.started) {
      this.teardown();
      this.clearTimer("reconnectTimer");
      this.open();
    }
  }

  // ------------------------------------------------------------- requests

  /**
   * Send an action and wait for its response (matched by `id`).
   *
   * In v1 mode the old server sends no correlated responses, so this resolves
   * at once with `{ status: 202 }` ("sent, not confirmed").
   *
   * Rejects with {@link NotConnectedError} when not ready,
   * {@link RequestTimeoutError} after `requestTimeoutMs`, or
   * {@link ConnectionClosedError} when the socket drops first. API-level
   * failures (`not_in_call`, `not_licensed`, ...) resolve with that response.
   */
  send<T extends { status: number } = WsResponse>(
    action: string,
    fields: Record<string, unknown> = {},
  ): Promise<T> {
    if (this._state === "v1") {
      try {
        this.sendRaw({ ...fields, action, source: this.v1Source });
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve({ status: 202 } as T);
    }
    const allowed = this._state === "authenticated" || (this._state === "pending" && action === "keep-alive");
    if (!allowed) {
      return Promise.reject(new NotConnectedError(`Cannot send "${action}" while ${this._state}`));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(String(id));
        reject(new RequestTimeoutError(`No response to "${action}" within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(String(id), { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.sendRaw({ ...fields, action, id });
      } catch (error) {
        this.timers.clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  /** Send an action without waiting for a response. Throws {@link NotConnectedError} when not ready. */
  notify(action: string, fields: Record<string, unknown> = {}): void {
    if (this._state === "v1") {
      this.sendRaw({ ...fields, action, source: this.v1Source });
      return;
    }
    if (this._state !== "authenticated") {
      throw new NotConnectedError(`Cannot send "${action}" while ${this._state}`);
    }
    this.sendRaw({ ...fields, action });
  }

  /** Toggle (default) or set mute. Outside a call MuteDeck toggles the system microphone. */
  toggleMute(state?: ToggleState): Promise<WsResponse> {
    return this.send("toggle_mute", state ? { state } : {});
  }

  toggleVideo(state?: ToggleState): Promise<WsResponse> {
    return this.send("toggle_video", state ? { state } : {});
  }

  toggleShare(state?: ToggleState): Promise<WsResponse> {
    return this.send("toggle_share", state ? { state } : {});
  }

  toggleRecord(state?: ToggleState): Promise<WsResponse> {
    return this.send("toggle_record", state ? { state } : {});
  }

  leaveMeeting(): Promise<WsResponse> {
    return this.send("leave_meeting");
  }

  bringToFront(): Promise<WsResponse> {
    return this.send("bring-to-front");
  }

  raiseHand(): Promise<WsResponse> {
    return this.send("raise-hand");
  }

  backgroundBlur(): Promise<WsResponse> {
    return this.send("background-blur");
  }

  toggleChatWindow(): Promise<WsResponse> {
    return this.send("toggle-chat-window");
  }

  toggleParticipants(): Promise<WsResponse> {
    return this.send("toggle-participants");
  }

  /** Send a reaction, e.g. `react("applause")` → `react-applause`. */
  react(reaction: Reaction): Promise<WsResponse> {
    return this.send(`react-${reaction}`);
  }

  /** Trigger a custom action by its name in MuteDeck. */
  customAction(name: string): Promise<WsResponse> {
    return this.send("custom-action", { name });
  }

  /**
   * Fetch the configured custom actions. Rejects with
   * {@link RequestFailedError} when MuteDeck refuses (for example `not_licensed`).
   */
  async listCustomActions(): Promise<CustomAction[]> {
    if (this._state === "v1") {
      const waiter = new Promise<WsCustomActionList>((resolve, reject) => {
        const entry: PendingRequest = {
          resolve: resolve as (v: unknown) => void,
          reject,
          timer: this.timers.setTimeout(() => {
            this.v1ListWaiters = this.v1ListWaiters.filter((w) => w !== entry);
            reject(new RequestTimeoutError("No custom actions list from MuteDeck"));
          }, this.requestTimeoutMs),
        };
        this.v1ListWaiters.push(entry);
      });
      this.notify("list-custom-actions");
      return (await waiter).custom_actions ?? [];
    }
    const response = await this.send<WsCustomActionList | WsResponse>("list-custom-actions");
    if (response.status !== 200 || !("custom_actions" in response)) {
      throw new RequestFailedError(response as WsResponse);
    }
    return response.custom_actions;
  }

  /** Ping MuteDeck (also allowed while pending). In v2 resolves with the server's answer. */
  keepAlive(): Promise<WsResponse> {
    return this.send("keep-alive");
  }

  /**
   * `status-source` only: report the meeting site's status. Fire-and-forget
   * (MuteDeck never answers `update-status`). Does nothing while not ready;
   * report again once the `state` event says `authenticated` or `v1`.
   */
  reportStatus(report: StatusReport): void {
    if (!this.isReady) {
      this.logger.debug?.(`MuteDeck: not reporting status while ${this._state}`);
      return;
    }
    this.trySend(() => this.notify("update-status", { ...report }));
  }

  // ------------------------------------------------------------- connection

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? 5000;
  }

  private url(mode: SocketMode): string {
    const host = this.options.host ?? "localhost";
    const secure = this.options.secure ?? false;
    const port = secure ? (this.options.securePort ?? 3493) : (this.options.port ?? 3492);
    return `${secure ? "wss" : "ws"}://${host}:${port}${mode === "v2" ? "/v2" : "/"}`;
  }

  private open(): void {
    this.reconnectTimer = undefined;
    const generation = ++this.generation;
    const mode: SocketMode = this.serverIsV1 ? "v1" : "v2";
    this.setState("connecting");
    const url = this.url(mode);
    this.logger.debug?.(`MuteDeck: connecting to ${url}`);

    let socket: WebSocketLike;
    try {
      socket = this.options.webSocketFactory(url);
    } catch (error) {
      this.logger.warn?.("MuteDeck: could not create WebSocket", error);
      this.handleDisconnect(mode);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (generation === this.generation) {
        void this.onOpen(generation, mode);
      }
    };
    socket.onmessage = (event: { data?: unknown }) => {
      if (generation === this.generation) {
        this.onMessage(event?.data);
      }
    };
    socket.onerror = () => {
      if (generation === this.generation) {
        this.logger.debug?.("MuteDeck: socket error");
      }
    };
    socket.onclose = (event: { code?: number; reason?: string } | undefined) => {
      if (generation === this.generation) {
        const info: CloseInfo = { byClient: false };
        if (typeof event?.code === "number") {
          info.code = event.code;
        }
        if (event?.reason) {
          info.reason = String(event.reason);
        }
        this.logger.debug?.(`MuteDeck: socket closed (${mode}, code ${info.code ?? "?"})`);
        this.recordClose(info);
        this.handleDisconnect(mode);
      }
    };
  }

  private async onOpen(generation: number, mode: SocketMode): Promise<void> {
    if (mode === "v1") {
      this.sendRaw({ source: this.v1Source, action: "identify", identifier: this.client.name });
      this.backoff.reset();
      this.setState("v1");
      this.startKeepAlive();
      return;
    }

    let credentials: { instanceId: string; token?: string };
    try {
      credentials = await this.credentials.get();
    } catch (error) {
      this.reportError(error, "could not load credentials");
      if (generation === this.generation) {
        this.handleDisconnect(mode);
      }
      return;
    }
    if (generation !== this.generation || this.socket?.readyState !== OPEN) {
      return;
    }

    const hello: WsHello = {
      action: "hello",
      protocol: 2,
      client: { ...this.client },
      instance_id: credentials.instanceId,
      role: this.role,
    };
    if (credentials.token) {
      hello.token = credentials.token;
    }
    this.helloHadToken = credentials.token !== undefined;
    this.sendRaw(hello);
    this.welcomeTimer = this.timers.setTimeout(() => this.onWelcomeTimeout(), this.options.welcomeTimeoutMs ?? 3000);
  }

  private onWelcomeTimeout(): void {
    this.welcomeTimer = undefined;
    this.logger.info?.("MuteDeck: no welcome within the timeout; falling back to protocol v1");
    this.serverIsV1 = true;
    this.recordClose({ reason: "welcome-timeout", byClient: true });
    this.handleDisconnect("v2", 0);
  }

  /** Drop the current socket and schedule the next attempt. */
  private handleDisconnect(mode: SocketMode, delayMs?: number): void {
    this.teardown();
    if (mode === "v1") {
      // Re-check for v2 on the next connection (the user may have updated MuteDeck).
      this.serverIsV1 = false;
    }
    if (!this.started) {
      this.setState("disconnected");
      return;
    }
    const delay = delayMs ?? this.backoff.next();
    if (this._state !== "denied" && delay > 0) {
      this.setState("disconnected");
    }
    this.clearTimer("reconnectTimer");
    this.reconnectTimer = this.timers.setTimeout(() => this.open(), delay);
  }

  /** Detach and close the socket, and fail anything waiting on it. */
  private teardown(): void {
    this.generation++;
    this.clearTimer("welcomeTimer");
    this.clearTimer("keepAliveTimer");
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      // Keep an error handler: `ws` emits one when closing a socket that is still connecting.
      socket.onerror = () => undefined;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    const closed = new ConnectionClosedError("Connection to MuteDeck closed");
    for (const request of this.pending.values()) {
      this.timers.clearTimeout(request.timer);
      request.reject(closed);
    }
    this.pending.clear();
    for (const waiter of this.v1ListWaiters) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(closed);
    }
    this.v1ListWaiters = [];
  }

  private startKeepAlive(): void {
    const interval = this.options.keepAliveIntervalMs ?? 0;
    if (interval <= 0) {
      return;
    }
    this.clearTimer("keepAliveTimer");
    this.keepAliveTimer = this.timers.setTimeout(() => {
      this.keepAliveTimer = undefined;
      if (this._state === "v1") {
        this.trySend(() => this.notify("keep-alive"));
      } else if (this._state === "authenticated" || this._state === "pending") {
        this.keepAlive().catch(() => undefined);
      }
      if (this.isReady || this._state === "pending") {
        this.startKeepAlive();
      }
    }, interval);
  }

  // ------------------------------------------------------------- messages

  private onMessage(raw: unknown): void {
    const text = decode(raw);
    if (text === undefined) {
      return;
    }
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      this.logger.warn?.("MuteDeck: ignoring a message that is not JSON");
      return;
    }

    const action = typeof message.action === "string" ? message.action : undefined;
    if (action !== "update-status") {
      // Status pushes are frequent; they're not logged.
      this.logger.debug?.("MuteDeck: received", redact(message));
    }

    if (message.id !== undefined && message.id !== null) {
      const request = this.pending.get(String(message.id as RequestId));
      if (request) {
        this.pending.delete(String(message.id));
        this.timers.clearTimeout(request.timer);
        if (action === "list-custom-actions") {
          this.onCustomActions(message as unknown as WsCustomActionList, false);
        }
        request.resolve(message);
        return;
      }
    }

    switch (action) {
      case "welcome":
        this.onWelcome(message as unknown as WsWelcome);
        break;
      case "approved":
        void this.onApproved(message.token);
        break;
      case "denied":
        this.onDenied(message as { reason?: DenyReason; retry_after?: number });
        break;
      case "revoked":
        this.onRevoked();
        break;
      case "error":
        this.onServerError(message);
        break;
      case "update-status":
        this._lastStatus = message as unknown as WsStatusUpdate;
        this.emit("status", this._lastStatus);
        break;
      case "list-custom-actions":
        this.onCustomActions(message as unknown as WsCustomActionList, true);
        break;
      default:
        if (action === undefined) {
          // A v1 `{status: 200}` acknowledgement or a v1 rejection.
          if (typeof message.status === "number" && message.status >= 400) {
            this.logger.warn?.(`MuteDeck: request rejected (${message.status} ${String(message.reason ?? message.message ?? "")})`);
          }
        } else if (this.role === "status-source" && !SERVER_MESSAGES.has(action)) {
          this.emit("browserControl", message as unknown as WsBrowserControl);
        } else {
          this.logger.debug?.(`MuteDeck: ignoring message "${action}"`);
        }
    }
  }

  private onWelcome(welcome: WsWelcome): void {
    this.clearTimer("welcomeTimer");
    if (welcome.server_version !== undefined) {
      this._serverVersion = welcome.server_version;
    }
    if (welcome.licensed !== undefined) {
      this._licensed = welcome.licensed;
    }
    this.backoff.reset();
    this.emit("welcome", welcome);

    if (welcome.status === "ok") {
      if (this.helloHadToken) {
        this.tokenRejections = 0;
      }
      this.setState("authenticated");
      this.startKeepAlive();
      return;
    }

    // pending
    if (this.helloHadToken) {
      // The stored token is unknown or revoked.
      this.helloHadToken = false;
      this.tokenRejections++;
      this.logger.warn?.(
        `MuteDeck: stored token was rejected (${this.tokenRejections}/${this.maxTokenRejections}); discarding it`,
      );
      void this.clearTokenSafely();
      if (this.tokenRejections >= this.maxTokenRejections) {
        this.tokenRejections = 0;
        const backoff = this.options.tokenRejectionBackoffMs ?? 60000;
        this.logger.error?.(`MuteDeck: tokens keep being rejected; waiting ${backoff} ms before enrolling again`);
        this.recordClose({ reason: "token-rejected", byClient: true });
        this.handleDisconnect("v2", backoff);
        return;
      }
    }
    this.setState("pending");
    if (this.keepAliveTimer === undefined) {
      this.startKeepAlive();
    }
  }

  private async onApproved(token: unknown): Promise<void> {
    if (!isValidToken(token)) {
      this.logger.error?.("MuteDeck: received 'approved' without a valid token");
      return;
    }
    this.logger.info?.("MuteDeck: approved by the user; storing token");
    try {
      await this.credentials.setToken(token);
    } catch (error) {
      this.reportError(error, "could not store token");
    }
    this.emit("approved");
  }

  private onDenied(message: { reason?: DenyReason; retry_after?: number }): void {
    const reason = message.reason ?? "user";
    const retryAfter = typeof message.retry_after === "number" ? message.retry_after : undefined;
    const delay = Math.max(this.options.deniedRetryMinMs ?? 30000, (retryAfter ?? 0) * 1000);
    this.logger.warn?.(`MuteDeck: access denied (${reason}); asking again in ${Math.round(delay / 1000)} s`);
    this.setState("denied");
    this.emit("denied", retryAfter === undefined ? { reason } : { reason, retryAfter });
    this.recordClose({ reason: "denied", byClient: true });
    this.handleDisconnect("v2", delay);
  }

  private onRevoked(): void {
    this.logger.warn?.("MuteDeck: access was revoked; discarding the token");
    this.helloHadToken = false;
    void this.clearTokenSafely();
    this.emit("revoked");
    this.recordClose({ reason: "revoked", byClient: true });
    this.handleDisconnect("v2");
  }

  private onServerError(message: Record<string, unknown>): void {
    const description = `${String(message.status ?? "")} ${String(message.reason ?? "")} ${String(message.message ?? "")}`.trim();
    this.logger.warn?.(`MuteDeck: server error: ${description}`);
    this.emit("error", new MuteDeckError(`MuteDeck error: ${description}`));
  }

  private onCustomActions(list: WsCustomActionList, resolveV1Waiters: boolean): void {
    if (!Array.isArray(list.custom_actions)) {
      return;
    }
    this._customActions = list.custom_actions;
    this.emit("customActions", list.custom_actions);
    if (resolveV1Waiters) {
      const waiters = this.v1ListWaiters;
      this.v1ListWaiters = [];
      for (const waiter of waiters) {
        this.timers.clearTimeout(waiter.timer);
        waiter.resolve(list);
      }
    }
  }

  // ------------------------------------------------------------- helpers

  private get maxTokenRejections(): number {
    return this.options.maxTokenRejections ?? 3;
  }

  private sendRaw(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      throw new NotConnectedError("WebSocket is not open");
    }
    this.logger.debug?.("MuteDeck: sending", redact(message));
    socket.send(JSON.stringify(message));
  }

  private trySend(fn: () => void): void {
    try {
      fn();
    } catch {
      // the close handler takes care of reconnecting
    }
  }

  private async clearTokenSafely(): Promise<void> {
    try {
      await this.credentials.clearToken();
    } catch (error) {
      this.reportError(error, "could not clear token");
    }
  }

  private reportError(error: unknown, context: string): void {
    this.logger.error?.(`MuteDeck: ${context}`, error instanceof Error ? error.message : String(error));
    this.emit("error", error instanceof Error ? error : new MuteDeckError(String(error)));
  }

  private recordClose(info: CloseInfo): void {
    this._lastClose = info;
    this.emit("close", info);
  }

  private setState(next: ConnectionState): void {
    const previous = this._state;
    if (previous === next) {
      return;
    }
    this._state = next;
    this.logger.debug?.(`MuteDeck: state ${previous} -> ${next}`);
    this.emit("state", next, previous);
  }

  private clearTimer(name: "welcomeTimer" | "reconnectTimer" | "keepAliveTimer"): void {
    const handle = this[name];
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this[name] = undefined;
    }
  }

  protected override onListenerError(error: unknown): void {
    this.logger.error?.("MuteDeck: event listener threw", error instanceof Error ? error.message : String(error));
  }
}

/** Copy of `message` with any `token` field masked, safe to log. */
export function redact(message: Record<string, unknown>): Record<string, unknown> {
  if (!("token" in message)) {
    return message;
  }
  return { ...message, token: "<redacted>" };
}

function decode(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(raw as ArrayBufferView);
  }
  return undefined;
}
