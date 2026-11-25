#!/usr/bin/env node
// app/scripts/build-payload.mjs
//
// Builds the daemon payload the menu-bar app bundles, from the repo's own
// build output (no re-bundling: the pack loader resolves the built-in packs
// and the dashboard relative to its compiled files, and every pack imports
// the one `plughive/pack` module instance through the package self-reference).
//
//   app/payload/                         -> <App>.app/Contents/Resources/daemon/
//     package.json                       name "plughive" + "exports" (so `plughive/pack` resolves)
//     dist/src/...                       tsc output of src/ (entry dist/src/server.js)
//     dist/packs/<id>/...                built-in packs: code, pack.json, skills, workflows
//     dist/web/dist/...                  the dashboard
//     app/launcher.mjs                   entry the app runs: orphan guard, then dist/src/server.js
//     app/clients.mjs                    "connect a client" bridge over dist/src/clients
//     node_modules/                      production dependencies at the lockfile's versions
//   app/src-tauri/binaries/node-<triple> official Node.js binary, sha256-verified
//                                        (node-<triple>.exe on Windows)
//
// Usage: node scripts/build-payload.mjs [--skip-daemon-build]
//
// It builds for the machine it runs on (macOS arm64/x64, Linux x64/arm64,
// Windows x64/arm64): the payload's native modules come from a production
// install on this machine, so a cross-OS payload would load the wrong addons.
// CI builds each OS's app on that OS.
//
// Playwright is shipped as JS only; browsers are NOT bundled
// (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appDir, "..");
const payload = join(appDir, "payload");
const cache = join(appDir, ".cache");

const NODE_VERSION = "v26.13.1";
/**
 * SHA-256 of each official archive, copied from nodejs.org/dist/<version>/SHASUMS256.txt
 * when NODE_VERSION was bumped. The download is checked against these, not
 * against a SHASUMS file fetched next to it, so a tampered mirror or cache
 * cannot hand over a matching pair. Update both together.
 */
const NODE_SHA256 = {
  "darwin-arm64": "aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735",
  "darwin-x64": "82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f",
  "linux-arm64": "80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d",
  "linux-x64": "518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778",
  "win-arm64": "181ebe431b90787113a9e4fc80d38ce86d37888a353a0386de44d2872e48cb97",
  "win-x64": "e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7",
};
const argv = process.argv.slice(2);
const PLATFORM = process.platform;
const ARCH = process.arch;

/** Rust target triple (Tauri's externalBin suffix) and Node dist name per host. */
const TARGETS = {
  "darwin-arm64": { triple: "aarch64-apple-darwin", dist: "darwin-arm64", archive: "tar.gz" },
  "darwin-x64": { triple: "x86_64-apple-darwin", dist: "darwin-x64", archive: "tar.gz" },
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", dist: "linux-x64", archive: "tar.gz" },
  "linux-arm64": { triple: "aarch64-unknown-linux-gnu", dist: "linux-arm64", archive: "tar.gz" },
  "win32-x64": { triple: "x86_64-pc-windows-msvc", dist: "win-x64", archive: "zip" },
  "win32-arm64": { triple: "aarch64-pc-windows-msvc", dist: "win-arm64", archive: "zip" },
};
const TARGET = TARGETS[`${PLATFORM}-${ARCH}`];
if (!TARGET) throw new Error(`no app build for ${PLATFORM}-${ARCH}`);
if (argv.includes("--arch"))
  throw new Error("--arch is gone: the payload is built for this machine");
const TRIPLE = TARGET.triple;
const EXE = PLATFORM === "win32" ? ".exe" : "";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
}

function du(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of readdirSync(path)) total += du(join(path, e));
  return total;
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Remove files matching `test` under `dir`, recursively. */
function prune(dir, test) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) prune(full, test);
    else if (test(d.name, full)) rmSync(full, { force: true });
  }
}

/** Every package folder of a flat (hoisted) node_modules, scoped ones included. */
function packageDirs(nm) {
  const out = [];
  for (const d of readdirSync(nm, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const full = join(nm, d.name);
    if (d.name.startsWith("@")) {
      for (const s of readdirSync(full, { withFileTypes: true }))
        if (s.isDirectory() && existsSync(join(full, s.name, "package.json")))
          out.push(join(full, s.name));
    } else if (existsSync(join(full, "package.json"))) out.push(full);
  }
  return out;
}

/** Fail on any symlink: the bundle must be self-contained regular files. */
function assertNoSymlinks(dir) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isSymbolicLink()) throw new Error(`payload contains a symlink: ${full}`);
    if (d.isDirectory()) assertNoSymlinks(full);
  }
}

// ---------------------------------------------------------------- 1. daemon build
if (!argv.includes("--skip-daemon-build")) {
  run("pnpm", ["build"], { cwd: repoRoot, shell: PLATFORM === "win32" });
}
for (const required of [
  "dist/src/server.js",
  "dist/src/clients/index.js",
  "dist/packs",
  "dist/web/dist/index.html",
]) {
  if (!existsSync(join(repoRoot, required))) {
    throw new Error(`${required} is missing: run \`pnpm build\` in the repo root`);
  }
}

// ---------------------------------------------------------------- 2. clean + copy
rmSync(payload, { recursive: true, force: true });
mkdirSync(join(payload, "app"), { recursive: true });
cpSync(join(repoRoot, "dist"), join(payload, "dist"), {
  recursive: true,
  filter: (src) => !src.endsWith(".map"),
});
for (const f of ["launcher.mjs", "clients.mjs"]) {
  copyFileSync(join(appDir, "scripts", f), join(payload, "app", f));
}

// ---------------------------------------------------------------- 3. package.json
const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const exportsOut = {};
for (const [sub, target] of Object.entries(rootPkg.exports ?? {})) {
  // Only the compiled target: the bundle has no TypeScript sources.
  exportsOut[sub] = typeof target === "string" ? target : target.default;
}
writeFileSync(
  join(payload, "package.json"),
  `${JSON.stringify(
    {
      name: rootPkg.name,
      version: rootPkg.version,
      private: true,
      type: "module",
      exports: exportsOut,
      dependencies: rootPkg.dependencies,
      // Kept so the copied lockfile's importer matches; never installed (--prod).
      devDependencies: rootPkg.devDependencies,
    },
    null,
    2,
  )}\n`,
);

// ---------------------------------------------------------------- 4. dependencies
// The repo lockfile pins every transitive version. pnpm keeps those versions
// for an unchanged importer; node-linker=hoisted gives a flat node_modules
// without the symlinks of pnpm's default layout.
copyFileSync(join(repoRoot, "pnpm-lock.yaml"), join(payload, "pnpm-lock.yaml"));
run(
  "pnpm",
  [
    "install",
    "--prod",
    "--ignore-workspace",
    "--frozen-lockfile",
    "--config.node-linker=hoisted",
    "--config.package-import-method=copy",
    "--reporter=append-only",
  ],
  {
    cwd: payload,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    // pnpm is pnpm.cmd on Windows, which only starts through a shell.
    shell: PLATFORM === "win32",
  },
);

const nm = join(payload, "node_modules");
rmSync(join(nm, ".bin"), { recursive: true, force: true });
rmSync(join(nm, ".pnpm"), { recursive: true, force: true });
rmSync(join(nm, ".modules.yaml"), { force: true });
rmSync(join(payload, "pnpm-lock.yaml"), { force: true });
// better-sqlite3: only the prebuilt addon of this platform and arch is ever loaded.
const bsq = join(nm, "better-sqlite3");
const addon = `${PLATFORM}-${ARCH}`;
if (existsSync(join(bsq, "prebuilds"))) {
  for (const f of readdirSync(join(bsq, "prebuilds"))) {
    if (f !== `${addon}.node` && f !== addon)
      rmSync(join(bsq, "prebuilds", f), { recursive: true, force: true });
  }
}
if (!existsSync(join(bsq, "prebuilds", `${addon}.node`))) {
  throw new Error(`better-sqlite3 has no prebuilt addon for ${addon}`);
}
for (const d of ["deps", "src", "binding.gyp"])
  rmSync(join(bsq, d), { recursive: true, force: true });
rmSync(join(nm, "node-addon-api"), { recursive: true, force: true });
// Docs, type declarations and source maps are never loaded at runtime.
prune(
  nm,
  (name) => /\.(d\.ts|d\.mts|d\.cts|map|md|markdown)$/i.test(name) && !/^license/i.test(name),
);
// TypeScript sources (zod ships all of src/), tests, benchmarks and CI files
// of each package: nothing loads them, they only make the app bigger.
prune(nm, (name) => /\.(ts|mts|cts|tsx)$/i.test(name) && !/\.d\.[mc]?ts$/i.test(name));
const JUNK_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "benchmark",
  "benchmarks",
  ".github",
  "example",
  "examples",
]);
for (const pkgDir of packageDirs(nm)) {
  for (const d of readdirSync(pkgDir, { withFileTypes: true })) {
    if (d.isDirectory() && JUNK_DIRS.has(d.name))
      rmSync(join(pkgDir, d.name), { recursive: true, force: true });
  }
}
// Playwright: the daemon only does import("playwright") and drives Chromium.
// The `playwright` package's entry just re-exports playwright-core. What it
// adds is the test runner (babel transform, matchers, reporters: ~4.5 MB), and
// playwright-core ships the trace viewer, recorder and HTML report UIs
// (lib/vite, ~3.6 MB). Neither is loaded for launch, route and screenshot. A
// headless launch with this pruned layout is checked by hand
// (docs/performance.md).
const PLAYWRIGHT_KEEP = new Set([
  "index.js",
  "index.mjs",
  "package.json",
  "LICENSE",
  "NOTICE",
  "ThirdPartyNotices.txt",
]);
if (existsSync(join(nm, "playwright"))) {
  for (const f of readdirSync(join(nm, "playwright"))) {
    if (!PLAYWRIGHT_KEEP.has(f))
      rmSync(join(nm, "playwright", f), { recursive: true, force: true });
  }
}
rmSync(join(nm, "playwright-core", "lib", "vite"), { recursive: true, force: true });
// The dashboard's React comes along from the web/ workspace in the lockfile;
// the daemon serves the built dashboard and never imports it. Dropped unless a
// shipped package really depends on it.
const WEB_ONLY = ["react", "react-dom", "scheduler", "loose-envify", "js-tokens"];
for (const pkgDir of packageDirs(nm)) {
  const name = pkgDir.slice(nm.length + 1).replaceAll("\\", "/");
  if (WEB_ONLY.includes(name)) continue;
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const deps = { ...pj.dependencies, ...pj.optionalDependencies };
  const needed = WEB_ONLY.filter((w) => w in deps);
  if (needed.length)
    throw new Error(`${name} depends on ${needed.join(", ")}: keep them in the payload`);
}
for (const w of WEB_ONLY) rmSync(join(nm, w), { recursive: true, force: true });
assertNoSymlinks(payload);

// ---------------------------------------------------------------- 5. node binary
mkdirSync(cache, { recursive: true });
const base = `node-${NODE_VERSION}-${TARGET.dist}`;
const archive = join(cache, `${base}.${TARGET.archive}`);
const curl = PLATFORM === "win32" ? "curl.exe" : "curl";
if (!existsSync(archive))
  run(curl, [
    "-fsSL",
    "--proto",
    "=https",
    "-o",
    archive,
    `https://nodejs.org/dist/${NODE_VERSION}/${base}.${TARGET.archive}`,
  ]);
const want = NODE_SHA256[TARGET.dist];
const got = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (!want || want !== got) {
  // A bad cached download is removed so the next build fetches it again.
  rmSync(archive, { force: true });
  throw new Error(`sha256 mismatch for ${base}.${TARGET.archive} (got ${got})`);
}
// The Windows zip keeps node.exe at the top of its folder; the tarballs keep
// it under bin/. tar reads both (Windows 10+ ships bsdtar as tar.exe).
const member = PLATFORM === "win32" ? `${base}/node.exe` : `${base}/bin/node`;
run("tar", ["-xf", archive, "-C", cache, member]);
const binDir = join(appDir, "src-tauri", "binaries");
mkdirSync(binDir, { recursive: true });
const nodeOut = join(binDir, `node-${TRIPLE}${EXE}`);
copyFileSync(join(cache, member), nodeOut);
if (PLATFORM !== "win32") chmodSync(nodeOut, 0o755);
// macOS: the official binary keeps ~37 MB of local symbols that only a debugger
// reads. `strip -x` drops those and keeps every exported symbol (native addons
// link against them); the signature it breaks is replaced by an ad-hoc one
// (the app bundle is signed again when it is built), then the binary must
// still run and load an addon.
if (PLATFORM === "darwin") {
  run("strip", ["-x", nodeOut]);
  run("codesign", ["--force", "--sign", "-", nodeOut]);
  run(nodeOut, [
    "-e",
    `require(${JSON.stringify(join(bsq, "prebuilds", `${addon}.node`))}); process.stdout.write("node ok " + process.version + "\\n")`,
  ]);
}

// ---------------------------------------------------------------- 6. report
const packsDir = join(payload, "dist", "packs");
const packs = readdirSync(packsDir).filter((d) => existsSync(join(packsDir, d, "pack.json")));
console.log("\npayload ready:");
console.log(`  dist                   ${mb(du(join(payload, "dist")))}`);
console.log(`  built-in packs (${packs.length})   ${packs.join(", ")}`);
console.log(
  `  dashboard              ${existsSync(join(payload, "dist/web/dist/index.html")) ? "yes" : "MISSING"}`,
);
console.log(`  node_modules           ${mb(du(nm))}`);
console.log(`  payload total          ${mb(du(payload))}`);
console.log(
  `  node ${NODE_VERSION} (${PLATFORM}-${ARCH})  ${mb(statSync(nodeOut).size)}  sha256 ok`,
);
