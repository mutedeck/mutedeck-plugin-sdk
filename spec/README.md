# Spec copies

These files are **copies**. The MuteDeck desktop repository is the source of truth:

| Here | Desktop repo | Covers |
|---|---|---|
| `openapi.yaml` | `client/docs/plugin-api-v2/openapi.yaml` (internal) | WebSocket v2: hello/welcome/approval flow, roles, limits, every `Ws*` message |
| `mutedeck-api-spec.yaml` | `client/resources/mutedeck-api-spec.yaml` (public) | HTTP `/v1/*`, including the optional Bearer token, `/v1/pair` and `/v1/whoami` |

Do not edit them by hand. Update the desktop specs, then run:

```sh
npm run sync-spec   # copies both from ../client
npm run generate    # regenerates packages/js/src/generated/{schema,http-schema}.ts
```

The .NET message records (`packages/dotnet/src/MuteDeck.PluginClient/Messages.cs`)
are hand-written and must be updated alongside the spec. Their tests check the
shapes against the spec's examples.
