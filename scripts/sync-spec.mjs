// Copies the authoritative spec from the MuteDeck desktop repo into spec/.
// Usage: npm run sync-spec [-- <path to openapi.yaml>]
import { copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, process.argv[2] ?? "../client/docs/plugin-api-v2/openapi.yaml");
const target = resolve(root, "spec/openapi.yaml");

if (!existsSync(source)) {
  console.error(`Spec not found at ${source}. Pass the path as an argument.`);
  process.exit(1);
}
copyFileSync(source, target);
console.log(`Copied ${source} -> ${target}`);
console.log("Run `npm run generate` to refresh packages/js/src/generated/schema.ts.");
