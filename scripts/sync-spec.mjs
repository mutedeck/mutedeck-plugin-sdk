// Copies the authoritative specs from the MuteDeck desktop repo into spec/.
// Usage: npm run sync-spec [-- <path to the desktop repo>]
//   docs/plugin-api-v2/openapi.yaml   -> spec/openapi.yaml            (internal: WebSocket v2 messages)
//   resources/mutedeck-api-spec.yaml  -> spec/mutedeck-api-spec.yaml  (public: HTTP /v1 incl. pairing)
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = resolve(root, process.argv[2] ?? "../client");
const files = [
  ["docs/plugin-api-v2/openapi.yaml", "spec/openapi.yaml"],
  ["resources/mutedeck-api-spec.yaml", "spec/mutedeck-api-spec.yaml"],
];

for (const [from, to] of files) {
  const source = resolve(desktop, from);
  if (!existsSync(source)) {
    console.error(`Spec not found at ${source}. Pass the desktop repo path as an argument.`);
    process.exit(1);
  }
  copyFileSync(source, resolve(root, to));
  console.log(`Copied ${source} -> ${to}`);
}
console.log("Run `npm run generate` to refresh packages/js/src/generated/.");
