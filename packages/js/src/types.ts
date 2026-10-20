/**
 * Friendly aliases for the generated spec types (`./generated/schema.ts`) plus
 * the client-side types that the spec cannot express.
 */
import type { components } from "./generated/schema";

type Schemas = components["schemas"];

/** Self-description sent in `hello` and in `X-MuteDeck-Client`. */
export type ClientInfo = Schemas["ClientInfo"];
export type ClientOs = NonNullable<ClientInfo["os"]>;
export type RequestId = Schemas["RequestId"];
export type ApiResponse = Schemas["ApiResponse"];
export type ApiReason = NonNullable<ApiResponse["reason"]>;
export type MeetingStatus = Schemas["MeetingStatus"];
export type CustomAction = Schemas["CustomAction"];
export type DenyReason = Schemas["DenyReason"];

export type PairRequest = Schemas["PairRequest"];
export type PairPending = Schemas["PairPending"];
export type PairApproved = Schemas["PairApproved"];
export type PairDenied = Schemas["PairDenied"];
export type WhoAmI = Schemas["WhoAmI"];
export type HttpStatusResponse = Schemas["HttpStatusResponse"];
export type CustomActionListResponse = Schemas["CustomActionListResponse"];

export type WsHello = Schemas["WsHello"];
export type WsWelcome = Schemas["WsWelcome"];
export type WsApproved = Schemas["WsApproved"];
export type WsDenied = Schemas["WsDenied"];
export type WsRevoked = Schemas["WsRevoked"];
export type WsError = Schemas["WsError"];
export type WsAction = Schemas["WsAction"];
export type WsBrowserStatusReport = Schemas["WsBrowserStatusReport"];
export type WsResponse = Schemas["WsResponse"];
export type WsStatusUpdate = Schemas["WsStatusUpdate"];
export type WsCustomActionList = Schemas["WsCustomActionList"];
export type WsBrowserControl = Schemas["WsBrowserControl"];

/** `controller` sends control actions; `status-source` reports a meeting site's status. */
export type Role = WsHello["role"];

/** Value of the optional `state` field on toggle actions. */
export type ToggleState = NonNullable<WsAction["state"]>;

/** Reaction names; `react("applause")` sends `react-applause`. */
export type Reaction =
  | "applause"
  | "laugh"
  | "like"
  | "love"
  | "wow"
  | "tada"
  | "sad"
  | "thinking"
  | "dislike";

/** Report sent by a `status-source` client, without the `action` field. */
export type StatusReport = Omit<WsBrowserStatusReport, "action">;

/**
 * Connection state of {@link MuteDeckClient}.
 *
 * - `connecting`: opening a socket or waiting for `welcome`.
 * - `pending`: waiting for the user to approve this client in MuteDeck.
 * - `authenticated`: v2 session is ready for actions.
 * - `denied`: the user denied this client; the client waits before asking again.
 * - `v1`: connected to an old MuteDeck that only speaks v1 (no authentication).
 * - `disconnected`: not connected; a reconnect may be scheduled.
 */
export type ConnectionState =
  | "connecting"
  | "pending"
  | "authenticated"
  | "denied"
  | "v1"
  | "disconnected";

/** What a {@link TokenStore} persists. */
export interface StoredCredentials {
  /** 64-hex token issued by MuteDeck. Treat it like a password. */
  token?: string;
  /** Per-install id, generated once and kept even when the token is dropped. */
  instanceId?: string;
}

/**
 * {@link StoredCredentials} as a type alias (not an interface), so it is
 * assignable to JSON object types such as `JsonObject` from `@elgato/utils`
 * (Stream Deck global settings).
 */
export type StoredCredentialsJson = {
  token?: string;
  instanceId?: string;
};

/** Why the last socket closed; see `MuteDeckClient.lastClose`. */
export interface CloseInfo {
  /** WebSocket close code from the server or network (1000, 1006, 4001, ...). Undefined when the client closed. */
  code?: number;
  /** Close reason, or what made the client close (`welcome-timeout`, `denied`, `revoked`, `token-rejected`, `disconnect`). */
  reason?: string;
  /** True when this client closed the socket itself. */
  byClient: boolean;
}

/**
 * Persistence for the token and instance id. Implement it on top of the host's
 * storage (Stream Deck global settings, `chrome.storage.local`, Raycast
 * `LocalStorage`, Companion config, ...).
 */
export interface TokenStore {
  load(): Promise<StoredCredentials>;
  /** Replace the stored credentials with `data` (a missing `token` means "no token"). */
  save(data: StoredCredentials): Promise<void>;
  /** Remove everything, including the instance id. */
  clear(): Promise<void>;
}

/** Optional logger. The client never passes tokens to it. */
export interface Logger {
  debug?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  warn?(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
}

/** Timer functions; injectable for tests and unusual hosts. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
