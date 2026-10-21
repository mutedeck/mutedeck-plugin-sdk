# @mutedeck/plugin-client

Client for [MuteDeck](https://mutedeck.com)'s plugin API, for plugins and
integrations that control meetings through the MuteDeck desktop app.

- **WebSocket** (`MuteDeckClient`): plugin protocol v2. The plugin is approved
  once in MuteDeck and gets a token it reuses. Older MuteDeck versions are
  detected after 3 s and handled through the v1 protocol automatically.
- **HTTP** (`MuteDeckHttpClient`): the `/v1` API with an optional bearer
  token, pairing through MuteDeck's approval prompt, and the same fallback.
- TypeScript, ESM + CJS, zero runtime dependencies. Works in Node (with `ws`),
  browsers and MV3 service workers.

```sh
npm install @mutedeck/plugin-client
```

```ts
import { MuteDeckClient, memoryTokenStore } from "@mutedeck/plugin-client";

const md = new MuteDeckClient({
  client: { id: "my-plugin", name: "My Plugin", version: "1.0.0" },
  webSocketFactory: (url) => new WebSocket(url), // or `ws` in Node < 22
  tokenStore: memoryTokenStore(),                // persist it in real plugins
});
md.on("state", (state) => console.log(state)); // connecting | pending | authenticated | denied | v1 | disconnected
md.on("status", (status) => console.log(status.mute));
md.connect();
await md.whenReady();
await md.toggleMute();
```

Per-host setup (Stream Deck, browser extensions, Raycast, Bitfocus
Companion), the full API, and the protocol are documented in the
[repository README](https://github.com/mutedeck/mutedeck-plugin-sdk#readme).
For tests, see [`@mutedeck/mock-server`](https://www.npmjs.com/package/@mutedeck/mock-server).

MIT licensed.
