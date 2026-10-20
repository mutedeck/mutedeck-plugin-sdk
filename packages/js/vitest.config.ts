import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against the mock server's source, so no build step is needed first.
    alias: {
      "@mutedeck/mock-server": fileURLToPath(new URL("../mock-server/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
  },
});
