// The Windows resolver: npm's <prefix>\<cli>.cmd shims are never run; the pack
// starts `node <entry>` from the package's own package.json. Tested against a
// fake npm prefix on disk, so it runs on every OS.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NPM_PACKAGES,
  defaultWindowsNpmPrefix,
  invocationFor,
  resolveNpmEntry,
} from "../../../packs/cli-bridge/resolve.js";
import { canSymlink } from "../../support/platform.js";

let prefix: string;

beforeEach(() => {
  prefix = realpathSync(mkdtempSync(join(tmpdir(), "cli-bridge-npm-")));
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Lay out an npm global install the way npm does on Windows. */
function install(
  pkg: string,
  bin: unknown,
  files: Record<string, string>,
  opts: { shim?: string | false; name?: string } = {},
) {
  const pkgDir = join(prefix, "node_modules", ...pkg.split("/"));
  put(join(pkgDir, "package.json"), JSON.stringify({ name: opts.name ?? pkg, bin }));
  for (const [rel, text] of Object.entries(files)) put(join(pkgDir, rel), text);
  if (opts.shim !== false) {
    put(join(prefix, `${opts.shim}.cmd`), '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\x" %*\r\n');
  }
  return pkgDir;
}

describe("resolveNpmEntry", () => {
  it("finds the entry of a map bin and of a string bin", () => {
    const claude = install(
      "@anthropic-ai/claude-code",
      { claude: "cli.js" },
      { "cli.js": "" },
      { shim: "claude" },
    );
    expect(resolveNpmEntry("claude", prefix)).toEqual({
      kind: "node",
      entry: join(claude, "cli.js"),
    });
    const codex = install(
      "@openai/codex",
      "bin/codex.mjs",
      { "bin/codex.mjs": "" },
      { shim: "codex" },
    );
    expect(resolveNpmEntry("codex", prefix)).toEqual({
      kind: "node",
      entry: join(codex, "bin", "codex.mjs"),
    });
  });

  it("an extensionless bin counts as JavaScript only with a node shebang", () => {
    const dir = install(
      "@google/gemini-cli",
      { gemini: "bin/gemini" },
      { "bin/gemini": "#!/usr/bin/env node\nrequire('../dist')\n" },
      { shim: "gemini" },
    );
    expect(resolveNpmEntry("gemini", prefix)).toEqual({
      kind: "node",
      entry: join(dir, "bin", "gemini"),
    });
    install(
      "opencode-ai",
      { opencode: "bin/opencode" },
      { "bin/opencode": "\x7fELF..." },
      { shim: "opencode" },
    );
    expect(resolveNpmEntry("opencode", prefix).kind).toBe("native");
  });

  it("a native .exe bin is reported, not run through node", () => {
    const dir = install(
      "@github/copilot",
      { copilot: "copilot.exe" },
      { "copilot.exe": "MZ" },
      { shim: "copilot" },
    );
    expect(resolveNpmEntry("copilot", prefix)).toEqual({
      kind: "native",
      path: join(dir, "copilot.exe"),
    });
  });

  it("refuses a bin that leaves the package", () => {
    install("@openai/codex", { codex: "../../evil.js" }, {}, { shim: "codex" });
    put(join(prefix, "evil.js"), "");
    expect(resolveNpmEntry("codex", prefix)).toMatchObject({
      kind: "none",
      reason: expect.stringMatching(/leaves the package/),
    });
  });

  it.runIf(process.platform !== "win32" && canSymlink())(
    "refuses a bin that is a symlink out of the package",
    () => {
      const dir = install("@openai/codex", { codex: "cli.js" }, {}, { shim: "codex" });
      put(join(prefix, "outside.js"), "");
      symlinkSync(join(prefix, "outside.js"), join(dir, "cli.js"));
      expect(resolveNpmEntry("codex", prefix)).toMatchObject({
        kind: "none",
        reason: expect.stringMatching(/leaves the package/),
      });
    },
  );

  it("refuses a package whose name does not match", () => {
    install(
      "@anthropic-ai/claude-code",
      { claude: "cli.js" },
      { "cli.js": "" },
      {
        shim: "claude",
        name: "claude-code-lookalike",
      },
    );
    expect(resolveNpmEntry("claude", prefix)).toMatchObject({
      kind: "none",
      reason: expect.stringMatching(/holds claude-code-lookalike/),
    });
  });

  it("needs the .cmd shim, a declared bin, an existing entry and an absolute prefix", () => {
    install("@anthropic-ai/claude-code", { claude: "cli.js" }, { "cli.js": "" }, { shim: false });
    expect(resolveNpmEntry("claude", prefix)).toMatchObject({
      kind: "none",
      reason: expect.stringMatching(/no claude\.cmd/),
    });
    install("@openai/codex", { other: "cli.js" }, { "cli.js": "" }, { shim: "codex" });
    expect(resolveNpmEntry("codex", prefix).kind).toBe("none");
    install("@google/gemini-cli", { gemini: "missing.js" }, {}, { shim: "gemini" });
    expect(resolveNpmEntry("gemini", prefix)).toMatchObject({
      kind: "none",
      reason: expect.stringMatching(/does not exist/),
    });
    expect(resolveNpmEntry("claude", "relative\\npm")).toMatchObject({ kind: "none" });
    put(join(prefix, "copilot.cmd"), "");
    put(join(prefix, "node_modules", "@github", "copilot", "package.json"), "{not json");
    expect(resolveNpmEntry("copilot", prefix)).toMatchObject({
      kind: "none",
      reason: expect.stringMatching(/not valid JSON/),
    });
  });

  it("agy is not an npm CLI", () => {
    expect(NPM_PACKAGES.agy).toBeUndefined();
    expect(resolveNpmEntry("agy", prefix).kind).toBe("none");
  });
});

describe("invocationFor", () => {
  it("runs the CLI by name outside Windows", () => {
    expect(invocationFor("claude", { platform: "darwin", npmPrefix: prefix })).toEqual({
      binary: "claude",
      prefixArgs: [],
    });
    expect(invocationFor("codex", { platform: "linux" })).toEqual({
      binary: "codex",
      prefixArgs: [],
    });
  });

  it("on Windows starts node <entry> for an npm install, never cmd", () => {
    const dir = install(
      "@anthropic-ai/claude-code",
      { claude: "cli.js" },
      { "cli.js": "" },
      { shim: "claude" },
    );
    const inv = invocationFor("claude", { platform: "win32", npmPrefix: prefix });
    expect(inv).toEqual({ binary: "node", prefixArgs: [join(dir, "cli.js")] });
    expect(inv.binary).not.toMatch(/^cmd/i);
    expect(inv.prefixArgs).not.toContain("/c");
  });

  it("on Windows uses %APPDATA%\\npm under home when no prefix is set", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "cli-bridge-home-")));
    try {
      const saved = prefix;
      prefix = defaultWindowsNpmPrefix(home);
      const dir = install(
        "@openai/codex",
        { codex: "bin/codex.js" },
        { "bin/codex.js": "" },
        { shim: "codex" },
      );
      prefix = saved;
      expect(invocationFor("codex", { platform: "win32", home, npmPrefix: "  " })).toEqual({
        binary: "node",
        prefixArgs: [join(dir, "bin", "codex.js")],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("on Windows reports a native npm bin and falls back to the name otherwise", () => {
    install(
      "@github/copilot",
      { copilot: "copilot.exe" },
      { "copilot.exe": "MZ" },
      { shim: "copilot" },
    );
    const inv = invocationFor("copilot", { platform: "win32", npmPrefix: prefix });
    expect(inv.binary).toBe("copilot");
    expect(inv.problem).toMatch(/native program/);
    expect(invocationFor("agy", { platform: "win32", npmPrefix: prefix })).toEqual({
      binary: "agy",
      prefixArgs: [],
    });
  });
});
