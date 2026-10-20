import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "hosts/browser": "src/hosts/browser.ts",
    "hosts/streamdeck": "src/hosts/streamdeck.ts",
    "hosts/raycast": "src/hosts/raycast.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2020",
  platform: "neutral",
});
