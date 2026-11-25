import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Packs in this repo may reach the daemon only through "plughive/pack". No exceptions.
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PACKS = join(REPO, "packs");
const EXEMPT = new Set<string>();
// playwright and sharp: the web pack's screenshot_url needs a browser and image conversion.
// better-sqlite3 and sqlite-vec: the memory pack's local vector store.
const ALLOWED_BARE = new Set([
  "plughive/pack",
  "zod",
  "playwright",
  "sharp",
  "better-sqlite3",
  "sqlite-vec",
]);
const CODE_FILE = /\.(c|m)?(t|j)sx?$/;

// import ... from "x" | export ... from "x" | import("x") | require("x") | import "x"
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'`])([^"'`]+)\1/gm;
const ENV_ACCESS = /\bprocess\s*(?:\.\s*env\b|\[\s*["'`]env["'`]\s*\])|\bimport\.meta\.env\b/;

function boundaryProblems(file: string, packDir: string, source: string): string[] {
  const problems: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[2] ?? "";
    if (spec.startsWith("node:")) continue;
    if (ALLOWED_BARE.has(spec)) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = resolve(dirname(file), spec);
      if (target !== packDir && !target.startsWith(packDir + sep)) {
        problems.push(`imports "${spec}", which leaves the pack folder`);
      }
      continue;
    }
    problems.push(
      `imports "${spec}"; packs may import only plughive/pack, zod, node:* and their own files`,
    );
  }
  if (ENV_ACCESS.test(source)) problems.push("reads process.env; use ctx.secrets or ctx.settings");
  return problems;
}

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...codeFiles(p));
    else if (CODE_FILE.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

describe("pack boundary", () => {
  it("the checker catches violations", () => {
    const dir = "/repo/packs/demo";
    const file = `${dir}/index.ts`;
    const bad = [
      'import { Library } from "../../src/lib/library.js";',
      'import x from "execa";',
      'await import("../other/index.js");',
    ].join("\n");
    expect(boundaryProblems(file, dir, bad)).toHaveLength(3);
    expect(boundaryProblems(file, dir, "const k = process.env.SECRET;")).toEqual([
      expect.stringContaining("process.env"),
    ]);
    expect(boundaryProblems(file, dir, 'const j = process["env"];')).toHaveLength(1);
    const good = [
      'import { definePack, z } from "plughive/pack";',
      'import { readFile } from "node:fs/promises";',
      'import { helper } from "./lib/helper.js";',
      'export { other } from "./other.js";',
    ].join("\n");
    expect(boundaryProblems(file, dir, good)).toEqual([]);
  });

  it("packs/* import src/ only via plughive/pack and never read process.env", () => {
    const packs = readdirSync(PACKS).filter(
      (n) => !EXEMPT.has(n) && statSync(join(PACKS, n)).isDirectory(),
    );
    expect(packs.length).toBeGreaterThan(0);
    const violations: string[] = [];
    let scanned = 0;
    for (const pack of packs) {
      const packDir = join(PACKS, pack);
      for (const file of codeFiles(packDir)) {
        scanned++;
        for (const p of boundaryProblems(file, packDir, readFileSync(file, "utf8"))) {
          violations.push(`${relative(REPO, file)}: ${p}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
