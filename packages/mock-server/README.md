# @mutedeck/mock-server

A programmable fake [MuteDeck](https://mutedeck.com) desktop for testing
MuteDeck plugins, in any language: the WebSocket protocol (v2 with approval,
and v1) and the HTTP API (`/v1` with optional bearer tokens and pairing).

```sh
npx @mutedeck/mock-server --mode v2 --approve auto   # approves after 500 ms
npx @mutedeck/mock-server --approve manual           # type approve / deny / revoke / status mute=active
npx @mutedeck/mock-server --legacy-policy block      # HTTP without a token → 426
npx @mutedeck/mock-server --mode v1                  # an old MuteDeck
```

It listens on 3492 (WebSocket) and 3491 (HTTP) by default (`--ws-port`,
`--http-port`). In tests, use it programmatically:

```ts
import { MockMuteDeck } from "@mutedeck/mock-server";

const mock = await MockMuteDeck.start({ approve: "manual" }); // random ports: mock.wsPort, mock.httpPort
mock.approve();
mock.pushStatus({ mute: "active" });
await mock.close();
```

More in the [repository README](https://github.com/mutedeck/mutedeck-plugin-sdk#mock-server).
MIT licensed.
