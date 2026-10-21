export { MuteDeckClient, redact } from "./client";
export type { MuteDeckClientEvents, MuteDeckClientOptions, WebSocketFactory, WebSocketLike } from "./client";
export { MuteDeckHttpClient } from "./http";
export type { FetchLike, MuteDeckHttpClientOptions, PairOptions, ServerKind } from "./http";
export { fromAsyncKeyValue, fromAsyncStringStorage, memoryTokenStore } from "./token-store";
export { clientHeader, osFromPlatform, randomUuid, sanitizeVersion, validateClientInfo } from "./identity";
export type { BackoffOptions } from "./backoff";
export {
  ConnectionClosedError,
  HttpError,
  LegacyServerError,
  MuteDeckError,
  MuteDeckUnreachableError,
  NotAuthenticatedError,
  NotConnectedError,
  PairingDeniedError,
  PairingRequiredError,
  RequestFailedError,
  RequestTimeoutError,
} from "./errors";
export type * from "./types";
export { browserHostInfo, detectBrowserHost } from "./hosts/browser";
export type { BrowserHostInput, BrowserName, HostInfo } from "./hosts/browser";
export { streamDeckHostInfo } from "./hosts/streamdeck";
export type { StreamDeckInfoLike } from "./hosts/streamdeck";
export { raycastHostInfo } from "./hosts/raycast";
export type { RaycastEnvironmentLike } from "./hosts/raycast";
export type { components as SpecComponents, paths as SpecPaths } from "./generated/schema";
export type { components as HttpSpecComponents, paths as HttpSpecPaths } from "./generated/http-schema";
