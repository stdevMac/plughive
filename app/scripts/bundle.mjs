#!/usr/bin/env node
// app/scripts/bundle.mjs
//
// Runs `tauri build` with the installers that fit this OS:
//   macOS   -> PlugHive.app (ad-hoc signed)
//   Windows -> an NSIS per-user installer (no admin prompt)
//   Linux   -> a .deb and an AppImage
// Extra arguments go to `tauri build` (for example `--debug`).
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLES = { darwin: "app", win32: "nsis", linux: "deb,appimage" };
const bundles = BUNDLES[process.platform];
if (!bundles) throw new Error(`no app bundle for ${process.platform}`);
// Find the local @tauri-apps/cli even when this runs as plain `node scripts/bundle.mjs`.
const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin");
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const env = {
  ...process.env,
  [pathKey]: [bin, process.env[pathKey]].filter(Boolean).join(delimiter),
};
const r = spawnSync("tauri", ["build", "--bundles", bundles, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
  // tauri is tauri.cmd in node_modules/.bin on Windows.
  shell: process.platform === "win32",
});
if (r.error) console.error(`could not run tauri: ${r.error.message}`);
process.exit(r.status ?? 1);
