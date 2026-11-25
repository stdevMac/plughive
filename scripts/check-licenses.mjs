#!/usr/bin/env node
// scripts/check-licenses.mjs: `pnpm licenses`.
//
// Walks the production dependencies of the daemon (dependencies and
// optionalDependencies, recursively, as installed in node_modules) and prints
// each package with its license. Exits 1 when a license is missing or is not
// on the permissive list below, so CI can catch a new copyleft dependency.
//
//   node scripts/check-licenses.mjs           table, flagged packages last
//   node scripts/check-licenses.mjs --json    machine-readable list
//
// Offline: it reads package.json files only.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PERMISSIVE = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "Python-2.0",
  "Zlib",
  "CC-BY-4.0",
]);

/**
 * Packages whose license field is not a plain permissive SPDX id but whose
 * terms were checked by hand. Each entry says why it is accepted.
 */
const REVIEWED = {
  // libvips and its dependencies are LGPL-3.0, shipped as a separate shared
  // library that sharp loads dynamically; the LGPL allows that use.
  "@img/sharp-libvips-darwin-arm64": "LGPL-3.0 shared library, dynamically linked by sharp",
  "@img/sharp-libvips-darwin-x64": "LGPL-3.0 shared library, dynamically linked by sharp",
  "@img/sharp-libvips-linux-arm64": "LGPL-3.0 shared library, dynamically linked by sharp",
  "@img/sharp-libvips-linux-x64": "LGPL-3.0 shared library, dynamically linked by sharp",
  "@img/sharp-libvips-linuxmusl-arm64": "LGPL-3.0 shared library, dynamically linked by sharp",
  "@img/sharp-libvips-linuxmusl-x64": "LGPL-3.0 shared library, dynamically linked by sharp",
  // On Windows sharp ships libvips inside its own package (Apache-2.0 AND
  // LGPL-3.0-or-later): the same dynamically loaded DLLs as above.
  "@img/sharp-win32-arm64": "Apache-2.0 binding plus LGPL-3.0 libvips DLLs, dynamically linked",
  "@img/sharp-win32-ia32": "Apache-2.0 binding plus LGPL-3.0 libvips DLLs, dynamically linked",
  "@img/sharp-win32-x64": "Apache-2.0 binding plus LGPL-3.0 libvips DLLs, dynamically linked",
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** SPDX expression to ids: "(MIT OR Apache-2.0)" gives [["MIT"], ["Apache-2.0"]] as alternatives. */
function permissive(expr) {
  if (!expr) return false;
  const clean = expr.replace(/[()]/g, " ").trim();
  // OR: any alternative that is fully permissive is enough.
  return clean.split(/\s+OR\s+/i).some((alt) =>
    alt
      .split(/\s+AND\s+/i)
      .map((id) => id.trim())
      .every((id) => PERMISSIVE.has(id)),
  );
}

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l.type)).join(" OR ");
  }
  return "";
}

/** Find the installed folder of `name` as Node would resolve it from `fromDir`. */
function locate(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const seen = new Map();
const missing = [];

function visit(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  const isRoot = dir === root;
  if (!isRoot) seen.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg) });
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    const found = locate(name, dir);
    if (!found) {
      // Optional platform packages for other systems are not installed.
      if (!(pkg.optionalDependencies && name in pkg.optionalDependencies))
        missing.push(`${name} (needed by ${pkg.name})`);
      continue;
    }
    visit(found);
  }
}

visit(root);

const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const row of rows) {
  if (permissive(row.license)) row.status = "ok";
  else if (REVIEWED[row.name]) row.status = "reviewed";
  else row.status = "flagged";
}
const flagged = rows.filter((r) => r.status === "flagged");

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ packages: rows, missing }, null, 2)}\n`);
} else {
  const width = Math.max(...rows.map((r) => `${r.name}@${r.version}`.length), 10);
  for (const r of rows.filter((x) => x.status !== "flagged")) {
    const note = r.status === "reviewed" ? `  (${REVIEWED[r.name]})` : "";
    console.log(`${`${r.name}@${r.version}`.padEnd(width)}  ${r.license}${note}`);
  }
  console.log(`\n${rows.length} production packages, ${flagged.length} flagged.`);
  for (const r of flagged)
    console.log(`FLAGGED  ${r.name}@${r.version}  ${r.license || "(no license field)"}`);
  for (const m of missing) console.log(`MISSING  ${m}: run pnpm install`);
}
process.exitCode = flagged.length > 0 || missing.length > 0 ? 1 : 0;
