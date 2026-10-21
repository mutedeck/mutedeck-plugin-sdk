/**
 * A programmable fake MuteDeck desktop for plugin tests.
 *
 * - WebSocket (default port 3492): `/v2` speaks protocol v2 (hello, welcome,
 *   approval, revocation, request ids); any other path speaks v1.
 * - HTTP (default port 3491): `/v1/*` with an optional Bearer token (invalid
 *   token → 401; no token → `legacyPolicy`), `/v1/pair`, `/v1/pair/{id}` and
 *   `/v1/whoami`.
 *
 * `mode: "v1"` simulates an old MuteDeck: `/v2` sockets are accepted but
 * `hello` is silently dropped, HTTP `/v1/pair` and `/v1/whoami` return 404
 * `{"error":"Invalid URL."}`, and `Authorization` is ignored.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

export type ServerMode = "v2" | "v1";
export type ApproveMode = "auto" | "manual" | "deny";
export type DenyReason = "user" | "expired" | "busy";
export type Role = "controller" | "status-source";

export interface ClientInfo {
  id: string;
  name: string;
  version?: string;
  host_app?: string;
  host_version?: string;
  os?: "mac" | "windows" | "linux";
}

export interface MeetingStatus {
  call?: string;
  control?: string;
  mute?: string;
  video?: string;
  share?: string;
  record?: string;
  [key: string]: unknown;
}

export interface CustomAction {
  name?: string;
  /** Meeting app (user-defined actions). */
  application?: string;
  /** Keyboard shortcut (user-defined actions). */
  shortcut?: string;
  type?: "builtin" | "custom";
  /** Meeting apps a built-in action supports. */
  app_types?: string[];
  [key: string]: unknown;
}

/** Custom actions the mock reports unless `customActions` is given. */
export const DEFAULT_CUSTOM_ACTIONS: CustomAction[] = [
  { name: "Wave", application: "teams", shortcut: "ctrl+shift+w", type: "custom" },
  { name: "Raise hand", type: "builtin", app_types: ["zoom", "teams", "google-meet"] },
];

export interface MockServerOptions {
  /** `v2` (current MuteDeck) or `v1` (old MuteDeck that drops hello). Default `v2`. */
  mode?: ServerMode;
  /** How approval prompts are answered. Default `auto`. */
  approve?: ApproveMode;
  /** Delay before an automatic approve/deny. Default 10 ms. */
  decisionDelayMs?: number;
  /** `retry_after` (seconds) sent with a user denial. Default 600 (`expired` sends 0, `busy` 30). */
  denyRetryAfter?: number;
  /** Reason sent with an automatic denial. Default `user`. */
  denyReason?: DenyReason;
  /** Bind address. Default `127.0.0.1`. */
  host?: string;
  /** WebSocket port; 0 picks a free port. Default 0. */
  wsPort?: number;
  /** HTTP port; 0 picks a free port. Default 0. */
  httpPort?: number;
  /** Set false to skip the HTTP server. Default true. */
  http?: boolean;
  /** Reported in `welcome` and `whoami`. Default `4.12.0`. */
  serverVersion?: string;
  /** Reported in `welcome`. Default true. */
  licensed?: boolean;
  /** Initial meeting status. */
  status?: MeetingStatus;
  /** Configured custom actions. */
  customActions?: CustomAction[];
  /** `poll_after` for HTTP pairing (seconds). Default 2. */
  pairPollAfter?: number;
  /** Pairing request lifetime (seconds). Default 120. */
  pairExpiresIn?: number;
  /** How long a decision is kept for an instance whose socket dropped (ms). Default 120000. */
  decisionMemoryMs?: number;
  /**
   * "Plugins without authentication" for HTTP requests without a token:
   * `allow` (default), `local` (this computer only; see `httpClientsAreRemote`)
   * or `block` (426).
   */
  legacyPolicy?: LegacyPolicy;
  /** Treat HTTP clients as remote, for testing `legacyPolicy: "local"`. Default false. */
  httpClientsAreRemote?: boolean;
  /** Optional log sink, e.g. `console.log`. */
  log?: (line: string) => void;
}

export type LegacyPolicy = "allow" | "local" | "block";

/** One WebSocket connection as seen by the mock. */
export interface MockConnection {
  readonly id: number;
  readonly path: string;
  /** 2 for `/v2` sockets in v2 mode, 1 otherwise. */
  readonly protocol: 1 | 2;
  hello?: Record<string, unknown> & { client: ClientInfo; instance_id: string; role: Role; token?: string };
  authenticated: boolean;
  token?: string;
  /** v1 `source` from identify. */
  v1Source?: string;
  /** v1 `identifier` from identify. */
  v1Identifier?: string;
  /** Every message received on this socket, parsed. */
  readonly received: Record<string, unknown>[];
  readonly socket: WebSocket;
  /** Send a raw message to this client. */
  send(message: Record<string, unknown>): void;
}

export interface TokenRecord {
  token: string;
  instanceId: string;
  client: ClientInfo;
  created: string;
}

/** An HTTP request as seen by the mock. */
export interface MockHttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  body?: unknown;
}

interface PendingApproval {
  instanceId: string;
  client: ClientInfo;
  sockets: Set<MockConnection>;
  pairRequests: Set<string>;
  timer?: NodeJS.Timeout;
}

type PairState =
  | { state: "pending"; instanceId: string; expires: number }
  | { state: "approved"; instanceId: string; token: string }
  | { state: "denied"; instanceId: string; reason: DenyReason; retryAfter?: number };

type Decision =
  | { kind: "approved"; token: string; until: number }
  | { kind: "denied"; reason: DenyReason; retryAfter: number; until: number };

const CONTROL_ACTIONS = new Set([
  "toggle_mute",
  "toggle_video",
  "toggle_share",
  "toggle_record",
  "leave_meeting",
  "bring-to-front",
  "background-blur",
  "toggle-chat-window",
  "toggle-participants",
  "raise-hand",
  "react-applause",
  "react-laugh",
  "react-like",
  "react-love",
  "react-wow",
  "react-tada",
  "react-sad",
  "react-thinking",
  "react-dislike",
]);

const HTTP_CONTROL: Record<string, string> = {
  mute: "toggle_mute",
  video: "toggle_video",
  share: "toggle_share",
  record: "toggle_record",
  leave: "leave_meeting",
  "bring-to-front": "bring-to-front",
  "background-blur": "background-blur",
  "toggle-chat-window": "toggle-chat-window",
  "raise-hand": "raise-hand",
};

const V1_SOURCES = new Set(["plugin", "streamdeck-plugin", "browser-extension-plugin", "google-meet-plugin"]);
const CLIENT_ID = /^[a-z0-9-]{1,32}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const INSTANCE_ID = /^[A-Za-z0-9-]{8,64}$/;
const TOKEN = /^[0-9a-f]{64}$/;

/** Validates a `ClientInfo` against the spec limits; returns an error message or undefined. */
export function validateClientInfo(client: unknown): string | undefined {
  if (!client || typeof client !== "object") {
    return "client missing";
  }
  const c = client as Record<string, unknown>;
  if (typeof c.id !== "string" || !CLIENT_ID.test(c.id)) {
    return "client.id invalid";
  }
  if (typeof c.name !== "string" || c.name.length < 1 || c.name.length > 64) {
    return "client.name invalid";
  }
  for (const key of ["version", "host_version"]) {
    if (c[key] !== undefined && (typeof c[key] !== "string" || !VERSION.test(c[key] as string))) {
      return `client.${key} invalid`;
    }
  }
  if (c.host_app !== undefined && (typeof c.host_app !== "string" || !CLIENT_ID.test(c.host_app))) {
    return "client.host_app invalid";
  }
  if (c.os !== undefined && !["mac", "windows", "linux"].includes(c.os as string)) {
    return "client.os invalid";
  }
  const extra = Object.keys(c).filter((k) => !["id", "name", "version", "host_app", "host_version", "os"].includes(k));
  if (extra.length > 0) {
    return `client has unknown fields: ${extra.join(", ")}`;
  }
  return undefined;
}

/**
 * Events: `connection` (MockConnection), `hello` (MockConnection), `identify`
 * (MockConnection), `message` (MockConnection, message), `pending`
 * (instanceId, ClientInfo), `approved` (instanceId, token), `denied`
 * (instanceId), `browser-status` (report), `http` (MockHttpRequest).
 */
export class MockMuteDeck extends EventEmitter {
  mode: ServerMode;
  approveMode: ApproveMode;
  /** See {@link MockServerOptions.legacyPolicy}. */
  legacyPolicy: LegacyPolicy;
  /** See {@link MockServerOptions.httpClientsAreRemote}. */
  httpClientsAreRemote: boolean;
  status: MeetingStatus;
  customActions: CustomAction[];
  /** Last `update-status` report from a status-source. */
  browserStatus?: Record<string, unknown>;
  readonly tokens = new Map<string, TokenRecord>();
  readonly connections: MockConnection[] = [];
  readonly httpRequests: MockHttpRequest[] = [];
  /** Responses for specific actions (default `{status: 200}`), e.g. `{ toggle_mute: { status: 400, reason: "not_in_call" } }`. */
  readonly actionResponses = new Map<string, Record<string, unknown>>();
  /** Actions the mock receives but never answers (to test client timeouts). */
  readonly silentActions = new Set<string>();

  private readonly options: Required<Omit<MockServerOptions, "log" | "status" | "customActions" | "mode" | "approve" | "legacyPolicy" | "httpClientsAreRemote">> & {
    log?: (line: string) => void;
  };
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pairRequests = new Map<string, PairState>();
  private readonly decisions = new Map<string, Decision>();
  private wsServer?: WebSocketServer;
  private wsHttp?: Server;
  private httpServer?: Server;
  private nextConnectionId = 1;

  private constructor(options: MockServerOptions) {
    super();
    this.mode = options.mode ?? "v2";
    this.approveMode = options.approve ?? "auto";
    this.legacyPolicy = options.legacyPolicy ?? "allow";
    this.httpClientsAreRemote = options.httpClientsAreRemote ?? false;
    this.status = options.status ?? {
      call: "active",
      control: "zoom",
      mute: "inactive",
      video: "active",
      share: "inactive",
      record: "inactive",
    };
    this.customActions = options.customActions ?? DEFAULT_CUSTOM_ACTIONS.map((a) => ({ ...a }));
    this.options = {
      decisionDelayMs: options.decisionDelayMs ?? 10,
      denyRetryAfter: options.denyRetryAfter ?? 600,
      denyReason: options.denyReason ?? "user",
      host: options.host ?? "127.0.0.1",
      wsPort: options.wsPort ?? 0,
      httpPort: options.httpPort ?? 0,
      http: options.http ?? true,
      serverVersion: options.serverVersion ?? "4.12.0",
      licensed: options.licensed ?? true,
      pairPollAfter: options.pairPollAfter ?? 2,
      pairExpiresIn: options.pairExpiresIn ?? 120,
      decisionMemoryMs: options.decisionMemoryMs ?? 120000,
      log: options.log,
    };
  }

  /** Start a mock server and wait until it listens. */
  static async start(options: MockServerOptions = {}): Promise<MockMuteDeck> {
    const server = new MockMuteDeck(options);
    await server.listen();
    return server;
  }

  get wsPort(): number {
    return (this.wsHttp?.address() as AddressInfo | null)?.port ?? 0;
  }

  get httpPort(): number {
    return (this.httpServer?.address() as AddressInfo | null)?.port ?? 0;
  }

  get host(): string {
    return this.options.host;
  }

  /** Base WebSocket URL, e.g. `ws://127.0.0.1:3492`. */
  get wsUrl(): string {
    return `ws://${this.options.host}:${this.wsPort}`;
  }

  /** Base HTTP URL, e.g. `http://127.0.0.1:3491`. */
  get httpUrl(): string {
    return `http://${this.options.host}:${this.httpPort}`;
  }

  /** Open sockets only. */
  get openConnections(): MockConnection[] {
    return this.connections.filter((c) => c.socket.readyState === WebSocket.OPEN);
  }

  /** Instance ids waiting for a decision. */
  get pendingInstances(): string[] {
    return [...this.pendingApprovals.keys()];
  }

  /** Create a token as if the user had approved `instanceId` earlier. */
  issueToken(instanceId: string, client: ClientInfo = { id: "test", name: "Test" }): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.set(token, { token, instanceId, client, created: new Date().toISOString() });
    return token;
  }

  /** Approve pending prompts (all, or for one instance). Returns how many were approved. */
  approve(instanceId?: string): number {
    let count = 0;
    for (const pending of this.selectPending(instanceId)) {
      count++;
      this.clearPending(pending);
      const token = this.issueToken(pending.instanceId, pending.client);
      this.log(`approve ${pending.instanceId}`);
      let delivered = false;
      for (const conn of pending.sockets) {
        if (conn.socket.readyState === WebSocket.OPEN) {
          delivered = true;
          conn.send({ action: "approved", token });
          this.authenticate(conn, token);
        }
      }
      for (const requestId of pending.pairRequests) {
        delivered = true;
        this.pairRequests.set(requestId, { state: "approved", instanceId: pending.instanceId, token });
      }
      if (!delivered) {
        this.decisions.set(pending.instanceId, { kind: "approved", token, until: Date.now() + this.options.decisionMemoryMs });
      }
      this.emit("approved", pending.instanceId, token);
    }
    return count;
  }

  /** Deny pending prompts (all, or for one instance). Returns how many were denied. */
  deny(instanceId?: string, options: { reason?: DenyReason; retryAfter?: number } = {}): number {
    const reason = options.reason ?? this.options.denyReason;
    const retryAfter = options.retryAfter ?? (reason === "user" ? this.options.denyRetryAfter : reason === "busy" ? 30 : 0);
    let count = 0;
    for (const pending of this.selectPending(instanceId)) {
      count++;
      this.clearPending(pending);
      this.log(`deny ${pending.instanceId} (${reason})`);
      for (const conn of pending.sockets) {
        if (conn.socket.readyState === WebSocket.OPEN) {
          this.sendDenied(conn, reason, retryAfter);
        }
      }
      for (const requestId of pending.pairRequests) {
        this.pairRequests.set(requestId, { state: "denied", instanceId: pending.instanceId, reason, retryAfter });
      }
      if (reason === "user") {
        this.decisions.set(pending.instanceId, { kind: "denied", reason, retryAfter, until: Date.now() + retryAfter * 1000 });
      }
      this.emit("denied", pending.instanceId);
    }
    return count;
  }

  /**
   * Revoke tokens (all, or those of one instance / one token). Live sockets
   * using them get `revoked` and are closed. Returns how many were revoked.
   */
  revoke(match: { instanceId?: string; token?: string } = {}): number {
    let count = 0;
    for (const [token, record] of [...this.tokens]) {
      if ((match.token && match.token !== token) || (match.instanceId && match.instanceId !== record.instanceId)) {
        continue;
      }
      count++;
      this.tokens.delete(token);
      for (const conn of this.connections) {
        if (conn.token === token && conn.socket.readyState === WebSocket.OPEN) {
          conn.send({ action: "revoked" });
          conn.authenticated = false;
          conn.socket.close(4001, "revoked");
        }
      }
    }
    return count;
  }

  /** Merge `status` into the current status and push it to every controller. */
  pushStatus(status: MeetingStatus = {}): void {
    this.status = { ...this.status, ...status };
    for (const conn of this.openConnections) {
      if (this.isStatusReceiver(conn)) {
        conn.send({ action: "update-status", ...this.status });
      }
    }
  }

  /** Forward a control message to every status-source (browser extension) client. */
  pushBrowserControl(message: { action: string; [key: string]: unknown }): number {
    let count = 0;
    for (const conn of this.openConnections) {
      const isV2 = conn.protocol === 2 && conn.authenticated && conn.hello?.role === "status-source";
      const isV1 = conn.protocol === 1 && (conn.v1Source === "browser-extension-plugin" || conn.v1Source === "google-meet-plugin");
      if (isV2 || isV1) {
        conn.send(message);
        count++;
      }
    }
    return count;
  }

  /** Abruptly close every socket (simulates MuteDeck quitting). */
  dropConnections(): void {
    for (const conn of this.openConnections) {
      conn.socket.terminate();
    }
  }

  /** Wait for an event, optionally matching a predicate. */
  waitFor<T extends unknown[]>(event: string, predicate: (...args: T) => boolean = () => true, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, listener);
        reject(new Error(`Timed out waiting for mock event "${event}"`));
      }, timeoutMs);
      const listener = (...args: unknown[]) => {
        if (predicate(...(args as T))) {
          clearTimeout(timer);
          this.off(event, listener);
          resolve(args as T);
        }
      };
      this.on(event, listener);
    });
  }

  /** Stop listening and close every socket. */
  async close(): Promise<void> {
    for (const pending of this.pendingApprovals.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingApprovals.clear();
    for (const conn of this.connections) {
      conn.socket.terminate();
    }
    await new Promise<void>((resolve) => (this.wsServer ? this.wsServer.close(() => resolve()) : resolve()));
    await Promise.all(
      [this.wsHttp, this.httpServer].map(
        (server) => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
      ),
    );
  }

  // ------------------------------------------------------------- WebSocket

  private async listen(): Promise<void> {
    this.wsHttp = createServer((_req, res) => {
      res.writeHead(426).end();
    });
    this.wsServer = new WebSocketServer({ server: this.wsHttp, maxPayload: 1024 * 1024 });
    this.wsServer.on("connection", (socket, request) => this.onConnection(socket, request));
    await listen(this.wsHttp, this.options.wsPort, this.options.host);

    if (this.options.http) {
      this.httpServer = createServer((req, res) => {
        void this.onHttp(req, res).catch((error) => {
          this.log(`http error ${String(error)}`);
          json(res, 500, { status: 500, reason: "internal_error" });
        });
      });
      await listen(this.httpServer, this.options.httpPort, this.options.host);
    }
    this.log(`listening ws=${this.wsUrl} http=${this.options.http ? this.httpUrl : "off"} mode=${this.mode} approve=${this.approveMode}`);
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const protocol: 1 | 2 = path === "/v2" && this.mode === "v2" ? 2 : 1;
    const conn: MockConnection = {
      id: this.nextConnectionId++,
      path,
      protocol,
      authenticated: false,
      received: [],
      socket,
      send: (message) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
    };
    this.connections.push(conn);
    this.log(`#${conn.id} connected path=${path} protocol=${protocol}`);
    this.emit("connection", conn);

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return;
      }
      const msg = message as Record<string, unknown>;
      conn.received.push(msg);
      this.log(`#${conn.id} <- ${JSON.stringify(redact(msg))}`);
      this.emit("message", conn, msg);
      if (conn.protocol === 2) {
        this.onV2Message(conn, msg);
      } else {
        this.onV1Message(conn, msg);
      }
    });
    socket.on("close", () => {
      this.log(`#${conn.id} closed`);
      for (const pending of this.pendingApprovals.values()) {
        pending.sockets.delete(conn);
      }
    });
  }

  private onV2Message(conn: MockConnection, msg: Record<string, unknown>): void {
    const id = msg.id;
    if (!conn.hello) {
      if (msg.action !== "hello") {
        conn.send(withId({ action: "error", status: 401, reason: "not_authenticated", message: "Authentication required." }, id));
        return;
      }
      this.onHello(conn, msg);
      return;
    }
    if (msg.action === "hello") {
      conn.send(withId({ action: "error", status: 400, reason: "bad_request", message: "Already said hello." }, id));
      return;
    }
    if (!conn.authenticated) {
      if (msg.action === "keep-alive") {
        // Accepted while pending (keeps MV3 service workers alive); answered only with an id.
        if (id !== undefined) {
          conn.send({ status: 200, id });
        }
        return;
      }
      conn.send(withId({ action: "error", status: 401, reason: "not_authenticated", message: "Authentication required." }, id));
      return;
    }
    this.dispatch(conn, msg, true);
  }

  private onHello(conn: MockConnection, msg: Record<string, unknown>): void {
    const problem =
      msg.protocol !== 2
        ? "protocol must be 2"
        : (validateClientInfo(msg.client) ??
          (typeof msg.instance_id !== "string" || !INSTANCE_ID.test(msg.instance_id)
            ? "instance_id invalid"
            : msg.role !== "controller" && msg.role !== "status-source"
              ? "role invalid"
              : msg.token !== undefined && (typeof msg.token !== "string" || !TOKEN.test(msg.token))
                ? "token invalid"
                : undefined));
    if (problem) {
      conn.send({ action: "error", status: 400, reason: "bad_hello", message: problem });
      conn.socket.close();
      return;
    }
    conn.hello = msg as MockConnection["hello"];
    const hello = conn.hello!;
    this.emit("hello", conn);

    const record = hello.token ? this.tokens.get(hello.token) : undefined;
    if (record && record.instanceId === hello.instance_id) {
      this.authenticate(conn, record.token);
      return;
    }

    // Every hello is answered with a welcome first (so clients can tell v2 from an old server).
    conn.send(withId({ action: "welcome", protocol: 2, status: "pending", server_version: this.options.serverVersion }, hello.id));

    const decision = this.decisions.get(hello.instance_id);
    if (decision && decision.until > Date.now()) {
      if (decision.kind === "approved") {
        this.decisions.delete(hello.instance_id);
        conn.send({ action: "approved", token: decision.token });
        this.authenticate(conn, decision.token);
      } else {
        this.sendDenied(conn, decision.reason, Math.ceil((decision.until - Date.now()) / 1000));
      }
      return;
    }
    this.decisions.delete(hello.instance_id);
    this.addPending(hello.instance_id, hello.client, conn);
  }

  /** Send `denied`; the socket then accepts a new hello. */
  private sendDenied(conn: MockConnection, reason: DenyReason, retryAfter: number): void {
    conn.send({ action: "denied", reason, retry_after: retryAfter });
    conn.hello = undefined;
  }

  private authenticate(conn: MockConnection, token: string): void {
    conn.authenticated = true;
    conn.token = token;
    conn.send(
      withId(
        { action: "welcome", protocol: 2, status: "ok", server_version: this.options.serverVersion, licensed: this.options.licensed },
        conn.hello?.id,
      ),
    );
    if (conn.hello?.role !== "status-source") {
      conn.send({ action: "update-status", ...this.status });
      conn.send({ action: "list-custom-actions", status: 200, custom_actions: this.customActions });
    }
  }

  private onV1Message(conn: MockConnection, msg: Record<string, unknown>): void {
    const source = msg.source;
    if (typeof source !== "string" || !V1_SOURCES.has(source)) {
      // Old MuteDeck: unknown source (including a v2 hello) is silently ignored.
      return;
    }
    if (msg.action === "identify") {
      conn.v1Source = source;
      conn.v1Identifier = typeof msg.identifier === "string" ? msg.identifier : undefined;
      this.emit("identify", conn);
      if (source === "plugin" || source === "streamdeck-plugin") {
        conn.send({ action: "update-status", ...this.status });
      }
      return;
    }
    this.dispatch(conn, msg, false);
  }

  /** Shared action handling. v2 echoes `id` and answers unknown actions; v1 does not. */
  private dispatch(conn: MockConnection, msg: Record<string, unknown>, v2: boolean): void {
    const action = String(msg.action ?? "");
    const reply = (body: Record<string, unknown>) => conn.send(v2 ? withId(body, msg.id) : body);
    if (this.silentActions.has(action)) {
      return;
    }

    if (action === "keep-alive") {
      if (v2 && msg.id !== undefined) {
        reply({ status: 200 });
      }
      return;
    }
    if (action === "update-status") {
      this.browserStatus = msg;
      this.emit("browser-status", msg);
      // update-status reports are never answered.
      return;
    }
    if (action === "list-custom-actions") {
      reply({ action: "list-custom-actions", status: 200, custom_actions: this.customActions });
      return;
    }
    if (action === "custom-action") {
      if (typeof msg.name !== "string") {
        reply({ status: 400, reason: "bad_request", message: "Missing name." });
      } else if (!this.customActions.some((a) => a.name === msg.name)) {
        reply({ status: 404, reason: "not_found", message: "Custom action name not found." });
      } else {
        reply(this.actionResponses.get(action) ?? { status: 200 });
      }
      return;
    }
    if (CONTROL_ACTIONS.has(action)) {
      reply(this.actionResponses.get(action) ?? { status: 200 });
      return;
    }
    if (v2) {
      reply({ status: 404, reason: "unknown_action", message: `Unknown action ${action}.` });
    }
  }

  private isStatusReceiver(conn: MockConnection): boolean {
    if (conn.protocol === 2) {
      return conn.authenticated && conn.hello?.role === "controller";
    }
    return conn.v1Source === "plugin" || conn.v1Source === "streamdeck-plugin";
  }

  // ------------------------------------------------------------- approvals

  private addPending(instanceId: string, client: ClientInfo, conn?: MockConnection, pairRequestId?: string): void {
    let pending = this.pendingApprovals.get(instanceId);
    const isNew = !pending;
    if (!pending) {
      pending = { instanceId, client, sockets: new Set(), pairRequests: new Set() };
      this.pendingApprovals.set(instanceId, pending);
    }
    if (conn) {
      pending.sockets.add(conn);
    }
    if (pairRequestId) {
      pending.pairRequests.add(pairRequestId);
    }
    if (!isNew) {
      return;
    }
    this.log(`prompt for ${client.name} (${instanceId}), approve=${this.approveMode}`);
    this.emit("pending", instanceId, client);
    if (this.approveMode === "auto") {
      pending.timer = setTimeout(() => this.approve(instanceId), this.options.decisionDelayMs);
    } else if (this.approveMode === "deny") {
      pending.timer = setTimeout(() => this.deny(instanceId), this.options.decisionDelayMs);
    }
  }

  private selectPending(instanceId?: string): PendingApproval[] {
    if (instanceId === undefined) {
      return [...this.pendingApprovals.values()];
    }
    const pending = this.pendingApprovals.get(instanceId);
    return pending ? [pending] : [];
  }

  private clearPending(pending: PendingApproval): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingApprovals.delete(pending.instanceId);
  }

  // ------------------------------------------------------------- HTTP

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = req.method === "POST" ? await readJson(req) : undefined;
    const record: MockHttpRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    };
    this.httpRequests.push(record);
    this.emit("http", record);
    this.log(`http ${record.method} ${req.url}`);

    const path = url.pathname;
    if (!path.startsWith("/v1/")) {
      json(res, 404, { error: "Invalid URL." });
      return;
    }
    const endpoint = path.slice(4);
    const isPair = endpoint === "pair" || endpoint.startsWith("pair/");

    if (this.mode === "v1") {
      // Old MuteDeck: no pairing or whoami, Authorization ignored.
      if (isPair || endpoint === "whoami") {
        json(res, 404, { error: "Invalid URL." });
        return;
      }
      this.onHttpAction(endpoint, req.method ?? "GET", url, res);
      return;
    }

    // Pairing is reachable without a token under every policy.
    if (endpoint === "pair" && req.method === "POST") {
      this.onPair(body, res);
      return;
    }
    if (endpoint.startsWith("pair/") && req.method === "GET") {
      this.onPairPoll(decodeURIComponent(endpoint.slice(5)), res);
      return;
    }

    const auth = req.headers.authorization;
    let tokenRecord: TokenRecord | undefined;
    if (auth !== undefined) {
      // A token is optional, but when sent it must be valid.
      const token = /^Bearer ([0-9a-f]{64})$/.exec(auth)?.[1];
      tokenRecord = token ? this.tokens.get(token) : undefined;
      if (!tokenRecord) {
        unauthorized(res);
        return;
      }
    } else if (endpoint === "whoami") {
      unauthorized(res);
      return;
    } else if (this.legacyPolicy === "block") {
      json(res, 426, { status: 426, reason: "upgrade_required", message: "Pair this client with MuteDeck." });
      return;
    } else if (this.legacyPolicy === "local" && this.httpClientsAreRemote) {
      unauthorized(res);
      return;
    }

    if (endpoint === "whoami" && req.method === "GET" && tokenRecord) {
      json(res, 200, {
        status: 200,
        client_id: tokenRecord.client.id,
        name: tokenRecord.client.name,
        created: tokenRecord.created,
        server_version: this.options.serverVersion,
      });
      return;
    }
    this.onHttpAction(endpoint, req.method ?? "GET", url, res);
  }

  /** v1 semantics: HTTP 200 with the outcome in the body's `status`. */
  private onHttpAction(endpoint: string, method: string, url: URL, res: ServerResponse): void {
    if (endpoint === "status" && method === "GET") {
      json(res, 200, { ...this.status, status: 200, version: this.options.serverVersion });
    } else if (endpoint === "list-custom-actions" && method === "GET") {
      json(res, 200, { status: 200, custom_actions: this.customActions });
    } else if (endpoint === "custom-action" && method === "POST") {
      const name = url.searchParams.get("name");
      json(res, 200, this.customActions.some((a) => a.name === name) ? { status: 200 } : { status: 404, message: "Custom action name not found." });
    } else if ((HTTP_CONTROL[endpoint] || CONTROL_ACTIONS.has(endpoint)) && method === "POST") {
      const action = HTTP_CONTROL[endpoint] ?? endpoint;
      json(res, 200, this.actionResponses.get(action) ?? { status: 200 });
    } else {
      json(res, 404, { error: "Invalid URL." });
    }
  }

  private onPair(body: unknown, res: ServerResponse): void {
    const b = (body ?? {}) as Record<string, unknown>;
    const problem =
      validateClientInfo(b.client) ??
      (typeof b.instance_id !== "string" || !INSTANCE_ID.test(b.instance_id) ? "instance_id invalid" : undefined);
    if (problem) {
      json(res, 400, { status: 400, reason: "bad_request", message: problem });
      return;
    }
    const instanceId = b.instance_id as string;
    const decision = this.decisions.get(instanceId);
    if (decision?.kind === "denied" && decision.until > Date.now()) {
      json(res, 403, { status: "denied", reason: decision.reason, retry_after: Math.ceil((decision.until - Date.now()) / 1000) });
      return;
    }
    const requestId = randomBytes(18).toString("base64url");
    this.pairRequests.set(requestId, { state: "pending", instanceId, expires: Date.now() + this.options.pairExpiresIn * 1000 });
    this.addPending(instanceId, b.client as ClientInfo, undefined, requestId);
    json(res, 202, this.pairPending(requestId));
  }

  private onPairPoll(requestId: string, res: ServerResponse): void {
    const state = this.pairRequests.get(requestId);
    if (!state) {
      json(res, 404, { status: 404, reason: "not_found" });
      return;
    }
    if (state.state === "pending") {
      if (Date.now() > state.expires) {
        this.pairRequests.delete(requestId);
        const pending = this.pendingApprovals.get(state.instanceId);
        pending?.pairRequests.delete(requestId);
        json(res, 403, { status: "denied", reason: "expired" });
        return;
      }
      json(res, 202, this.pairPending(requestId));
      return;
    }
    this.pairRequests.delete(requestId);
    if (state.state === "approved") {
      json(res, 200, { status: "approved", token: state.token });
    } else {
      json(res, 403, { status: "denied", reason: state.reason, retry_after: state.retryAfter });
    }
  }

  private pairPending(requestId: string): Record<string, unknown> {
    const state = this.pairRequests.get(requestId);
    const expires = state?.state === "pending" ? Math.max(0, Math.ceil((state.expires - Date.now()) / 1000)) : 0;
    return { status: "pending", request_id: requestId, poll_after: this.options.pairPollAfter, expires_in: expires };
  }

  private log(line: string): void {
    this.options.log?.(`[mock-mutedeck] ${line}`);
  }
}

function withId(body: Record<string, unknown>, id: unknown): Record<string, unknown> {
  return id === undefined ? body : { ...body, id };
}

function redact(message: Record<string, unknown>): Record<string, unknown> {
  return "token" in message ? { ...message, token: "<redacted>" } : message;
}

function unauthorized(res: ServerResponse): void {
  res.setHeader("WWW-Authenticate", "Bearer");
  json(res, 401, { status: 401, reason: "not_authenticated", message: "Authentication required." });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
