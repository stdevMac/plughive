import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants, brotliCompressSync, gzipSync } from "node:zlib";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Write a .br and a .gz next to every fingerprinted script, stylesheet and
// SVG worth compressing. The daemon serves them when the browser accepts the
// encoding (src/core/http/dashboard.ts), so pages load about 3x fewer bytes
// and the daemon does no compression work per request.
function precompress(): Plugin {
  return {
    name: "plughive-precompress",
    apply: "build",
    writeBundle(options) {
      const dir = join(options.dir ?? "dist", "assets");
      for (const name of readdirSync(dir)) {
        if (!/\.(js|css|svg)$/.test(name)) continue;
        const path = join(dir, name);
        if (statSync(path).size < 1024) continue;
        const raw = readFileSync(path);
        writeFileSync(
          `${path}.br`,
          brotliCompressSync(raw, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: 11,
              [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          }),
        );
        writeFileSync(`${path}.gz`, gzipSync(raw, { level: 9 }));
      }
    },
  };
}

// The daemon serves the build with a strict CSP (no inline script), so the
// module-preload polyfill, which Vite inlines, is turned off.
const daemon = process.env.PLUGHIVE_URL ?? "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [react(), precompress()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: daemon, changeOrigin: false },
      "/artifacts": { target: daemon, changeOrigin: false },
      "/health": { target: daemon, changeOrigin: false },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
