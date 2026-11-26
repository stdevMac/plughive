// scripts/check-pack.mjs
//
// Checks what `npm pack` would publish, without running any package script:
//   node scripts/check-pack.mjs        (or `pnpm check:pack`, after `pnpm build`)
//
// Fails when a bin or export target is missing from the tarball, or when the
// tarball carries something that must never ship: an .env file, an admin
// token, a secrets file, tests or fixtures, or a top-level dist/ entry the
// build does not produce (a stale or stray output). Prints the file count and
// the packed and unpacked sizes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Top-level entries the package may contain (npm always adds package.json). */
export const ALLOWED_TOP = new Set([
  "dist",
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  "CHANGELOG.md",
  "SECURITY.md",
]);

/**
 * What the build writes under dist/: tsc output for src and packs, the
 * declarations of the public pack API (tsconfig.types.json), and the dashboard.
 */
export const ALLOWED_DIST = new Set(["src", "packs", "types", "web"]);

/**
 * Export conditions that only resolve inside this repository (tsx runs the
 * TypeScript sources with --conditions=plughive-source); their targets are not
 * published.
 */
export const REPO_ONLY_CONDITIONS = new Set(["plughive-source"]);

const FORBIDDEN = [
  { test: (base) => /^\.env(\..*)?$/.test(base) && base !== ".env.example", why: "an .env file" },
  { test: (base) => base === "admin-token", why: "an admin token" },
  { test: (base) => base === "secrets.json" || /^\.secrets\./.test(base), why: "a secrets file" },
  { test: (base) => /\.(test|spec)\.[cm]?[jt]sx?(\.map)?$/.test(base), why: "a test file" },
  { test: (base) => base === ".npmrc", why: "an npm config file (it can hold a token)" },
  // Nothing runs with --enable-source-maps; maps only add weight and reveal
  // the sources.
  { test: (base) => base.endsWith(".map"), why: "a source map" },
  {
    test: (base) => /\.[cm]?tsx?$/.test(base) && !/\.d\.[cm]?ts$/.test(base),
    why: "TypeScript source (publish the compiled .js and .d.ts)",
  },
  {
    test: (base) => /\.(pem|key|p12|pfx)$/i.test(base),
    why: "a private key or certificate bundle",
  },
];

const FORBIDDEN_DIRS = new Set([
  "tests",
  "test",
  "__tests__",
  "fixtures",
  "__fixtures__",
  "coverage",
]);

/** Collect every target path a package.json field points to, as tarball-relative paths. */
export function targetsOf(pkg) {
  const out = [];
  const add = (where, value) => {
    if (typeof value === "string") out.push({ where, path: value.replace(/^\.\//, "") });
  };
  if (typeof pkg.bin === "string") add("bin", pkg.bin);
  else for (const [k, v] of Object.entries(pkg.bin ?? {})) add(`bin.${k}`, v);
  add("main", pkg.main);
  add("types", pkg.types);
  const walk = (where, node) => {
    if (typeof node === "string") add(where, node);
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node))
        if (!REPO_ONLY_CONDITIONS.has(k)) walk(`${where}[${JSON.stringify(k)}]`, v);
  };
  walk("exports", pkg.exports);
  return out;
}

/**
 * Pure check of an `npm pack --json` entry against package.json.
 * Returns the list of problems (empty when the package is fine).
 */
export function checkPack(pkg, packed) {
  const problems = [];
  const paths = packed.files.map((f) => f.path);
  const present = new Set(paths);

  for (const t of targetsOf(pkg)) {
    if (t.path.includes("*")) continue;
    if (!present.has(t.path))
      problems.push(`${t.where} points to ${t.path}, which is not in the package`);
  }

  for (const p of paths) {
    const parts = p.split("/");
    const base = parts[parts.length - 1];
    if (!ALLOWED_TOP.has(parts[0])) problems.push(`unexpected top-level entry: ${p}`);
    if (parts[0] === "dist" && parts.length > 1 && !ALLOWED_DIST.has(parts[1]))
      problems.push(
        `unexpected dist entry: ${p} (a stale or stray build output; rebuild from a clean dist)`,
      );
    if (parts[0] === "dist" && parts[1] === "web" && parts[2] !== "dist")
      problems.push(`unexpected dist/web entry: ${p}`);
    for (const rule of FORBIDDEN) if (rule.test(base)) problems.push(`${p} is ${rule.why}`);
    const dir = parts.slice(0, -1).find((d) => FORBIDDEN_DIRS.has(d));
    if (dir) problems.push(`${p} is inside a ${dir}/ directory`);
  }
  return problems;
}

function runNpmPack(cwd) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`npm pack failed (exit ${r.status}):\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  if (!Array.isArray(parsed) || !parsed[0]?.files)
    throw new Error("unexpected npm pack --json output");
  return parsed[0];
}

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
  const packed = runNpmPack(repoRoot);
  const problems = checkPack(pkg, packed);
  console.log(
    `${packed.name}@${packed.version}: ${packed.entryCount} files, ${kb(packed.size)} packed, ${kb(packed.unpackedSize)} unpacked`,
  );
  if (problems.length > 0) {
    console.error(`check-pack: ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("check-pack: ok");
}
