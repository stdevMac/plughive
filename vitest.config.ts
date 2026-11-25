import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Packs import the public API by its published name; tests run the source.
    // The more specific entry goes first (aliases match by prefix, in order).
    alias: [
      {
        find: /^plughive\/pack\/testing$/,
        replacement: fileURLToPath(new URL("./src/core/packs/testing.ts", import.meta.url)),
      },
      {
        find: /^plughive\/pack$/,
        replacement: fileURLToPath(new URL("./src/core/pack-api.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    // Pack-loader tests import whole packs; under a full parallel run that can exceed 5 s.
    testTimeout: 20_000,
  },
});
