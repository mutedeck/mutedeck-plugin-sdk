# MuteDeck plugin SDK

Client libraries for the **MuteDeck plugin protocol v2**: authenticated WebSocket
and HTTP access to the MuteDeck desktop app, with automatic fallback to v1 for
older MuteDeck versions. Each plugin uses these packages instead of writing the handshake itself.

| Package | Path | For |
|---|---|---|
| `@mutedeck/plugin-client` | `packages/js` | Stream Deck, browser extension (Chrome/Edge/Brave/Firefox/Safari), Raycast, Bitfocus Companion. TypeScript, ESM + CJS, zero runtime dependencies. |
| `MuteDeck.PluginClient` | `packages/dotnet` | Loupedeck / Logi Options+, Macro Deck. .NET Standard 2.0. |
| `@mutedeck/mock-server` | `packages/mock-server` | A programmable fake MuteDeck for tests (any language). |

The protocol is defined by two specs that are copied from the desktop repo, **which is
the source of truth** (see [`spec/README.md`](spec/README.md)):

- [`spec/openapi.yaml`](spec/openapi.yaml) (internal, `client/docs/plugin-api-v2/openapi.yaml`) covers WebSocket v2.
- [`spec/mutedeck-api-spec.yaml`](spec/mutedeck-api-spec.yaml) (public, `client/resources/mutedeck-api-spec.yaml`)
  covers the HTTP API. It is `/v1/*` with an optional Bearer token, plus `/v1/pair` and `/v1/whoami`.

Run `npm run sync-spec` to copy both again from `../client`, then `npm run generate` to regenerate the TypeScript types.

## How it works

1. The client connects to `ws://localhost:3492/v2` and sends `hello` with its
   `client` info, a per-install `instance_id` and its stored token, if it has one.
2. MuteDeck answers `welcome ok` (token valid) or `welcome pending`. While it's
   pending, the user sees an approval prompt in MuteDeck. If they approve, the
   server sends `approved {token}` and the client stores the token through your
   `TokenStore`. If they deny, it sends `denied`, and the client waits for
   `retry_after` (at least 30 s) before it asks again.
3. If no `welcome` arrives within 3 s, the desktop is old. The client reconnects
   to `/` and speaks v1 (`identify` plus a `source` on every action) until the next disconnect.
4. Actions get an `id`, and `send()` resolves with the matching response or
   rejects after 5 s.
5. If the token is revoked, the client discards it and asks for approval again.
   If the server keeps rejecting freshly issued tokens (3 times in a row), the
   client backs off for 60 s instead of prompting in a loop.
6. Reconnects use exponential backoff (1 s → 30 s, with jitter), which resets after a successful connection.

Over HTTP (`MuteDeckHttpClient`), every endpoint is `/v1/*`. The token is optional:

- **With a token:** it is sent as `Authorization: Bearer`, and it must be valid, or MuteDeck answers HTTP 401.
- **Without a token:** MuteDeck's "Plugins without authentication" setting decides. The call is either allowed,
  or refused with 401 ("this computer only", for a remote client) or 426 ("block").
- **Normal answers** are HTTP 200, with the outcome in the body's `status` (for example `400` "not in a call").
- **Getting a token:** `POST /v1/pair` and polling `GET /v1/pair/{id}`, which works without a token under every policy.
- **Old MuteDeck versions** answer `/v1/pair` and `/v1/whoami` with 404 and ignore the token. There, the client
  keeps calling `/v1` without one. It always sends `?source=<client.id>`.

## JavaScript / TypeScript

```sh
npm install @mutedeck/plugin-client
```

```ts
import { MuteDeckClient, memoryTokenStore } from "@mutedeck/plugin-client";

const md = new MuteDeckClient({
  client: { id: "my-plugin", name: "My Plugin", version: "1.0.0" },
  webSocketFactory: (url) => new WebSocket(url), // browser / Node 22+; or `ws` (below)
  tokenStore: memoryTokenStore(),                // persist it in real plugins
});
md.on("state", (state) => console.log(state));   // connecting | pending | authenticated | denied | v1 | disconnected
md.on("status", (status) => console.log(status.mute));
md.connect();
await md.whenReady();
const res = await md.toggleMute();                // { status: 200, id: 1 } or { status: 400, reason: "not_in_call" }
```

Public API (all exported from `@mutedeck/plugin-client`):

- `new MuteDeckClient(options)`. Options: `client` (required), `webSocketFactory` (required),
  `role` (`"controller"` by default, or `"status-source"`), `host` (`localhost`), `port` (3492),
  `securePort` (3493), `secure`, `tokenStore`, `v1Source` (`"plugin"` by default),
  `logger`, `timers`, `random`, `generateInstanceId`, `welcomeTimeoutMs` (3000),
  `requestTimeoutMs` (5000), `reconnect: { initialDelayMs, maxDelayMs }`,
  `deniedRetryMinMs` (30000), `maxTokenRejections` (3), `tokenRejectionBackoffMs` (60000),
  `keepAliveIntervalMs` (0 = off).
  - Lifecycle: `connect()`, `disconnect()`, `whenReady(timeoutMs?)`, `resetPairing()`.
  - Properties: `state`, `isReady`, `isLegacyServer`, `serverVersion`, `licensed`, `lastStatus`, `customActions`,
    `lastClose` (`{ code?, reason?, byClient }`: the server's close code/reason, or why the client closed:
    `welcome-timeout`, `denied`, `revoked`, `token-rejected`, `disconnect`).
  - Events (`on`/`once`/`off`; `on` returns an unsubscribe function): `state`, `close`, `status`, `customActions`,
    `browserControl`, `welcome`, `approved`, `denied ({reason, retryAfter})`, `revoked`, `error`.
  - Requests: `send(action, fields)`, `notify(action, fields)`, `toggleMute(state?)`, `toggleVideo(state?)`,
    `toggleShare(state?)`, `toggleRecord(state?)`, `leaveMeeting()`, `bringToFront()`, `raiseHand()`,
    `backgroundBlur()`, `toggleChatWindow()`, `toggleParticipants()`, `react(name)`, `customAction(name)`,
    `listCustomActions()`, `keepAlive()` (also allowed while pending), and for `status-source`,
    `reportStatus(report)` (fire-and-forget; does nothing while not ready).
  - `keepAliveIntervalMs > 0` sends keep-alives while authenticated, in v1 mode **and while pending approval**.
- `new MuteDeckHttpClient({ client, baseUrl? | host? + port? = 3491 + scheme?, tokenStore?, fetch?, timeoutMs? = 3000,
  deniedRetryMinMs? = 30000, autoPair? = false | PairOptions })`:
  - `ensurePaired({ onPending, signal }): Promise<string | undefined>` returns the stored token or pairs.
    Concurrent calls share one pairing. It resolves `undefined` on an old MuteDeck (no pairing there; calls
    work without a token). After a denial it throws `PairingDeniedError` without contacting MuteDeck until
    `max(deniedRetryMinMs, retry_after)`.
  - Calls throw `PairingRequiredError` (`reason`: `not_authenticated` | `upgrade_required`) when MuteDeck
    requires a token. If the stored token was rejected, they throw its subclass `NotAuthenticatedError`
    and clear the token. Catch it, `await ensurePaired()`, and retry, or set `autoPair` to do that once automatically.
  - `pair({ onPending, signal })`, `probe()` (`GET /v1/whoami` without a token: 401 → `"v2"`, 404 → `"v1"`), `hasToken()`, `clearToken()`, `whoami()`, `getStatus()`, `mute(state?)`, `video()`, `share()`,
  `record()`, `leave()`, `bringToFront()`, `backgroundBlur()`, `raiseHand()`, `toggleChatWindow()`,
  `react(name)`, `listCustomActions()`, `customAction(name)`, `call(method, endpoint, query)`, `isLegacyServer`.
- Token stores: `memoryTokenStore()`, `fromAsyncKeyValue(get, set, remove, key?)`,
  `fromAsyncStringStorage(get, set, remove, key?)`. Or implement `TokenStore`
  (`load`, `save`, `clear`) yourself.
- Helpers: `validateClientInfo` (returns a copy with `version`/`host_version` sanitized, and throws only
  for fields that can't be fixed, such as `id`), `sanitizeVersion` (`"6.8.1 (21045)"` → `"6.8.1"`, `"7.0 beta"` → `"7.0-beta"`), `osFromPlatform`, `clientHeader`, `randomUuid`, `redact`.
- Errors: `MuteDeckError`, `NotConnectedError`, `RequestTimeoutError`, `ConnectionClosedError`,
  `RequestFailedError`, `PairingRequiredError`, `NotAuthenticatedError`, `LegacyServerError`, `PairingDeniedError`, `HttpError`,
  `MuteDeckUnreachableError` (HTTP: connection refused, DNS failure or timeout; the fetch error is in `cause`).
- Host metadata, re-exported from the root and also available as separate entry points. None of them imports a host SDK.
  `typesVersions` makes the subpaths resolve under classic `node`/`commonjs` `moduleResolution` too:
  `@mutedeck/plugin-client/hosts/browser` (`browserHostInfo(input)`, `detectBrowserHost()`),
  `@mutedeck/plugin-client/hosts/streamdeck` (`streamDeckHostInfo(streamDeck.info)`),
  `@mutedeck/plugin-client/hosts/raycast` (`raycastHostInfo(environment, process.platform)`).
- Types: `ClientInfo`, `CustomAction` (`name`, `application`, `shortcut`, `type: "builtin" | "custom"`, `app_types`),
  `ConnectionState`, `CloseInfo`, `Role`, `ToggleState`, `Reaction`, `StatusReport`,
  `TokenStore`, `StoredCredentials`, `StoredCredentialsJson` (a type alias that is assignable to
  `JsonObject`, for Stream Deck global settings), `Logger`, `Timers`, `WebSocketLike`, every `Ws*` message type,
  and the raw generated `SpecComponents` / `SpecPaths`.

### Stream Deck (Node, `ws`)

```ts
import streamDeck from "@elgato/streamdeck";
import WebSocket from "ws";
import { MuteDeckClient, fromAsyncKeyValue, type StoredCredentialsJson, type WebSocketLike } from "@mutedeck/plugin-client";
import { streamDeckHostInfo } from "@mutedeck/plugin-client/hosts/streamdeck";

type Settings = { mutedeck?: StoredCredentialsJson }; // JsonObject-compatible
const tokenStore = fromAsyncKeyValue(
  async () => (await streamDeck.settings.getGlobalSettings<Settings>()).mutedeck,
  async (_k, value) => {
    const all = await streamDeck.settings.getGlobalSettings<Settings>();
    await streamDeck.settings.setGlobalSettings({ ...all, mutedeck: value });
  },
  async () => {
    const all = await streamDeck.settings.getGlobalSettings<Settings>();
    await streamDeck.settings.setGlobalSettings({ ...all, mutedeck: undefined });
  },
);

export const mutedeck = new MuteDeckClient({
  client: { id: "streamdeck", name: "Stream Deck", ...streamDeckHostInfo(streamDeck.info) },
  webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
  tokenStore,
  v1Source: "streamdeck-plugin",
  logger: { info: (m) => streamDeck.logger.info(m), warn: (m) => streamDeck.logger.warn(m), error: (m) => streamDeck.logger.error(m) },
});
mutedeck.connect();
```

### Browser extension (MV3 service worker)

```ts
import { MuteDeckClient, fromAsyncKeyValue } from "@mutedeck/plugin-client";
import { detectBrowserHost } from "@mutedeck/plugin-client/hosts/browser";

const md = new MuteDeckClient({
  client: { id: "browser-extension", name: "MuteDeck browser extension", version: chrome.runtime.getManifest().version, ...(await detectBrowserHost()) },
  role: "status-source",
  v1Source: "browser-extension-plugin",
  webSocketFactory: (url) => new WebSocket(url),
  tokenStore: fromAsyncKeyValue(
    async (k) => (await chrome.storage.local.get(k))[k],
    (k, v) => chrome.storage.local.set({ [k]: v }),
    (k) => chrome.storage.local.remove(k),
  ),
  keepAliveIntervalMs: 20_000, // socket traffic keeps the MV3 service worker alive (Chrome 116+)
});
md.on("browserControl", (control) => performOnMeetingTab(control)); // { action: "toggle_mute" | "send_reaction" | ... }
md.connect();
// from the content script's report:
md.reportStatus({ control: "google-meet", status: "call", mute: "muted", video: "started" });
```

Top-level `await` needs an ES module service worker (`"background": { "type": "module" }`).
Firefox MV2/MV3 and Safari work the same way. `detectBrowserHost()` uses
`browser.runtime.getBrowserInfo()` when it is available.

**Classic scripts (no bundler).** MV3 classic service workers (`importScripts()`) and
Firefox/Safari `background.scripts` can't load ES modules. Bundle the ESM build into
one IIFE that defines a global, as the extension's
`google-chrome-extension/scripts/vendor-mutedeck-client.sh` does:

```sh
npm run build -w @mutedeck/plugin-client
cat > /tmp/entry.js <<JS
export * from "$PWD/packages/js/dist/index.js";
export { browserHostInfo, detectBrowserHost } from "$PWD/packages/js/dist/hosts/browser.js";
JS
npx esbuild /tmp/entry.js --bundle --format=iife --global-name=MuteDeckPluginClient \
  --target=es2020 --platform=neutral --outfile=lib/mutedeck-plugin-client.js
```

```js
importScripts("lib/mutedeck-plugin-client.js"); // or list it first in background.scripts
const { MuteDeckClient, fromAsyncKeyValue, detectBrowserHost } = MuteDeckPluginClient;
```

`esbuild` is already installed in this repo as a dependency of tsup. Without top-level
`await`, call `detectBrowserHost().then(...)` before you construct the client.

### Raycast (HTTP, no socket)

```ts
import { environment, LocalStorage, showToast } from "@raycast/api";
import { MuteDeckHttpClient, PairingRequiredError, fromAsyncStringStorage } from "@mutedeck/plugin-client";
import { raycastHostInfo } from "@mutedeck/plugin-client/hosts/raycast";

const md = new MuteDeckHttpClient({
  client: { id: "raycast", name: "Raycast", version: "1.3.0", ...raycastHostInfo(environment, process.platform) },
  tokenStore: fromAsyncStringStorage((k) => LocalStorage.getItem<string>(k), (k, v) => LocalStorage.setItem(k, v), (k) => LocalStorage.removeItem(k)),
});

const onPending = () => showToast({ title: "Approve Raycast in MuteDeck" });
try {
  await md.mute();                  // works without a token unless MuteDeck requires one
} catch (error) {
  if (!(error instanceof PairingRequiredError)) throw error;
  await md.ensurePaired({ onPending }); // dedupes concurrent commands; backs off after a denial
  await md.mute();
}
// or: new MuteDeckHttpClient({ ..., autoPair: { onPending } }) and just `await md.mute()`
// To pair up front: `await md.ensurePaired({ onPending })` (resolves undefined on an old MuteDeck).
```

You can also use `MuteDeckClient` with Node 22's global `WebSocket` (or with `ws`) if a command keeps a socket open.

### Bitfocus Companion (Node module)

Keep the token in the module's **secrets**, not its plain config. Companion stores
secrets separately and doesn't export them with the config. They arrive in
`init(config, isFirstInit, secrets)` and `configUpdated(config, secrets)`, and are
saved with `saveConfig(config, secrets)`.

```ts
import WebSocket from "ws";
import { MuteDeckClient, fromAsyncKeyValue, type WebSocketLike } from "@mutedeck/plugin-client";

// inside the InstanceBase subclass; this.config / this.secrets are kept from init()/configUpdated()
const md = new MuteDeckClient({
  client: { id: "companion", name: "Bitfocus Companion", version: moduleVersion, host_app: "companion", host_version: companionVersion },
  host: this.config.host,
  webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
  tokenStore: fromAsyncKeyValue(
    async () => this.secrets?.mutedeck,
    async (_k, v) => {
      this.secrets = { ...this.secrets, mutedeck: v };
      this.saveConfig(this.config, this.secrets);
    },
    async () => {
      this.secrets = { ...this.secrets, mutedeck: undefined };
      this.saveConfig(this.config, this.secrets);
    },
  ),
});
md.on("state", (s) => this.updateStatus(s === "authenticated" || s === "v1" ? "ok" : s === "pending" ? "connecting" : "disconnected"));
md.on("status", (s) => this.setVariableValues({ mute: s.mute, video: s.video }));
md.connect();
```

## .NET (Loupedeck / Logi Options+, Macro Deck)

```csharp
using MuteDeck.PluginClient;

var client = new MuteDeckClient(new MuteDeckClientOptions
{
    Client = new ClientInfo { Id = "loupedeck", Name = "Loupedeck", Version = "2.0.0", HostApp = "logi-options-plus", HostVersion = hostVersion, Os = "windows" },
    TokenStore = new FileTokenStore(Path.Combine(this.GetPluginDataDirectory(), "mutedeck.json")),
    Log = (level, message) => PluginLog.Info(message),
});
client.StateChanged += (_, e) => UpdateConnectionIcon(e.State);
client.StatusReceived += (_, status) => UpdateButtons(status);   // raised on a background thread
client.Start();

var response = await client.ToggleMuteAsync();                     // response.Status / response.Reason
await client.StopAsync();
```

Macro Deck is the same, with `Id = "macro-deck"`, `HostApp = "macro-deck"`, and a `FileTokenStore` in the plugin's config folder.

`Version` and `HostVersion` are sanitized for you (`"2.14.1 (build 5)"` → `"2.14.1"`), and
`ClientInfo.SanitizeVersion(string?)` is public if you need it yourself. Only fields that can't be fixed throw `ArgumentException`.

**Targets and dependencies.** The package targets `netstandard2.0` and `net8.0`. Only the
`netstandard2.0` build depends on the `System.Text.Json` package (8.0.5). On .NET 8+ the in-box
copy is used, so nothing extra is copied next to your plugin. On .NET Framework or
netstandard hosts (e.g. older Loupedeck), ship `System.Text.Json.dll` and its dependencies with the plugin.

**Referencing the project instead of the package.** If your plugin's solution has custom
configurations or platforms (for example the Loupedeck templates' `x64` platform) and you add
`MuteDeck.PluginClient.csproj` as a `ProjectReference`, solution builds can fail to resolve it.
Pass the parent configuration through:

```xml
<ProjectReference Include="..\mutedeck-plugin-sdk\packages\dotnet\src\MuteDeck.PluginClient\MuteDeck.PluginClient.csproj">
  <ShouldUnsetParentConfigurationAndPlatform>false</ShouldUnsetParentConfigurationAndPlatform>
</ProjectReference>
```

Public API: `MuteDeckClient` (`Start`, `StopAsync`, `Dispose`, `WaitUntilReadyAsync`,
`ResetPairingAsync`, `SendAsync`, `NotifyAsync`, `ToggleMuteAsync`/`ToggleVideoAsync`/`ToggleShareAsync`/
`ToggleRecordAsync(ToggleState?)`, `LeaveMeetingAsync`, `BringToFrontAsync`, `RaiseHandAsync`,
`BackgroundBlurAsync`, `ToggleChatWindowAsync`, `ToggleParticipantsAsync`, `ReactAsync(Reaction)`,
`CustomActionAsync(name)`, `ListCustomActionsAsync`, `KeepAliveAsync`, `ReportStatusAsync(StatusReport)`;
events `StateChanged`, `StatusReceived`, `CustomActionsReceived`, `BrowserControlReceived`,
`WelcomeReceived`, `Approved`, `Denied`, `Revoked`, `Error`), `MuteDeckClientOptions`, `ITokenStore`,
`InMemoryTokenStore`, `FileTokenStore`, `StoredCredentials`, `CustomAction` (`Name`, `Application`,
`Shortcut`, `Type`, `AppTypes`, `Extra`), the message classes (`WsHello`, `WsWelcome`,
`WsResponse`, `WsStatusUpdate`, ...), `ConnectionState`, `ToggleState`, `Reaction`.

## Mock server

```sh
npx mutedeck-mock-server --mode v2 --approve auto     # current MuteDeck, approves after 500 ms
npx mutedeck-mock-server --approve manual             # type "approve" / "deny" / "revoke" / "status mute=active"
npx mutedeck-mock-server --legacy-policy block        # HTTP without a token → 426 (also: local [--remote] → 401)
npx mutedeck-mock-server --mode v1                    # old MuteDeck: drops hello, /v1/pair + /v1/whoami → 404
```

It listens on 3492 (WebSocket) and 3491 (HTTP) by default (`--ws-port`, `--http-port`).
In tests, use it programmatically:

```ts
import { MockMuteDeck } from "@mutedeck/mock-server";
const mock = await MockMuteDeck.start({ approve: "manual" }); // random ports: mock.wsPort, mock.httpPort
mock.approve(); mock.deny(); mock.revoke(); mock.pushStatus({ mute: "active" });
mock.pushBrowserControl({ action: "toggle_mute" }); mock.issueToken(instanceId);
mock.actionResponses.set("toggle_mute", { status: 400, reason: "not_in_call" });
mock.legacyPolicy = "local"; mock.httpClientsAreRemote = true; // HTTP without a token → 401
// default custom actions: DEFAULT_CUSTOM_ACTIONS (one "custom", one "builtin"); override with { customActions }
await mock.close();
```

## Implementing the protocol in another language

For example, the Python Touch Portal plugin:

1. Read `spec/openapi.yaml`. Its `info.description` defines the WebSocket flow,
   roles, limits and fallback rules, and `components/schemas/Ws*` define every message.
   For HTTP, read `spec/mutedeck-api-spec.yaml` (the `/v1` endpoints, the optional token and pairing).
2. Follow the behaviour described under "How it works" above. The TypeScript client
   (`packages/js/src/client.ts`) is the reference implementation and is about 600 lines.
3. Test against the mock server in each mode: `--mode v2 --approve auto|manual|deny`
   and `--mode v1`. In manual mode, type `revoke` to check that the client
   discards its token and asks again.

## Development

```sh
npm install
npm run build        # mock server + JS client
npm test             # JS client tests (vitest, against the mock server)
dotnet test packages/dotnet/MuteDeck.PluginClient.sln
npm run sync-spec && npm run generate   # after the desktop spec changes
```
