// packs/cli-bridge/resolve.ts
//
// How a CLI is started. On macOS and Linux it is the binary of the same name
// on the daemon's PATH. On Windows, npm installs a CLI as a `<name>.cmd` shim
// in the npm prefix, and the daemon never runs .cmd or .bat files (cmd.exe
// re-parses their arguments, so a prompt could become a command). For those
// CLIs this finds the JavaScript entry the shim would have started, from the
// package's own package.json `bin` field, and the pack runs `node <entry>`
// instead. A CLI that is not an npm install (a native .exe on PATH, such as
// agy or Claude Code's native build) is run by name.

import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CliId } from "./clis.js";

/** npm package and bin name of each CLI that npm can install. */
export const NPM_PACKAGES: Partial<Record<CliId, { pkg: string; bin: string }>> = {
  claude: { pkg: "@anthropic-ai/claude-code", bin: "claude" },
  codex: { pkg: "@openai/codex", bin: "codex" },
  gemini: { pkg: "@google/gemini-cli", bin: "gemini" },
  copilot: { pkg: "@github/copilot", bin: "copilot" },
  opencode: { pkg: "opencode-ai", bin: "opencode" },
};

/** Where npm puts global installs on Windows when no prefix is configured. */
export function defaultWindowsNpmPrefix(home: string = homedir()): string {
  return join(home, "AppData", "Roaming", "npm");
}

/** File access the resolver needs, injectable for tests. */
export interface ResolverFs {
  isFile(path: string): boolean;
  readText(path: string, maxBytes: number): string | null;
  realpath(path: string): string;
}

export const nodeFs: ResolverFs = {
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readText: (p, maxBytes) => {
    let fd: number | undefined;
    try {
      fd = openSync(p, "r");
      const buf = Buffer.alloc(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
  realpath: (p) => realpathSync.native(p),
};

export type NpmEntry =
  /** Run `node <entry>`. */
  | { kind: "node"; entry: string }
  /** The package's bin is a native program, which the daemon only runs from PATH. */
  | { kind: "native"; path: string }
  /** Not an npm install in this prefix (run the CLI by name). */
  | { kind: "none"; reason: string };

const JS_EXT = /\.(c|m)?js$/i;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The JavaScript file npm's `<prefix>\<cli>.cmd` shim starts, read from the
 * package's package.json. Never runs anything.
 */
export function resolveNpmEntry(cli: CliId, prefix: string, fs: ResolverFs = nodeFs): NpmEntry {
  const known = NPM_PACKAGES[cli];
  if (!known) return { kind: "none", reason: `${cli} is not installed with npm` };
  if (!isAbsolute(prefix))
    return { kind: "none", reason: "the npm prefix must be an absolute path" };
  if (!fs.isFile(join(prefix, `${known.bin}.cmd`))) {
    return { kind: "none", reason: `no ${known.bin}.cmd in ${prefix}` };
  }
  const pkgDir = join(prefix, "node_modules", ...known.pkg.split("/"));
  const raw = fs.readText(join(pkgDir, "package.json"), 1024 * 1024);
  if (raw === null)
    return { kind: "none", reason: `${known.pkg} is not in ${prefix}\\node_modules` };
  let bin: unknown;
  try {
    const parsed = JSON.parse(raw) as { name?: unknown; bin?: unknown };
    if (parsed.name !== known.pkg) {
      return { kind: "none", reason: `${pkgDir} holds ${String(parsed.name)}, not ${known.pkg}` };
    }
    bin = parsed.bin;
  } catch {
    return { kind: "none", reason: `${known.pkg}'s package.json is not valid JSON` };
  }
  const rel =
    typeof bin === "string"
      ? bin
      : typeof bin === "object" && bin !== null
        ? (bin as Record<string, unknown>)[known.bin]
        : undefined;
  if (typeof rel !== "string" || rel.length === 0) {
    return { kind: "none", reason: `${known.pkg} declares no "${known.bin}" bin` };
  }
  const entry = resolve(pkgDir, rel);
  if (!inside(pkgDir, entry))
    return { kind: "none", reason: `${known.pkg}'s bin leaves the package` };
  if (!fs.isFile(entry)) return { kind: "none", reason: `${entry} does not exist` };
  // Symlinks or junctions must not lead out of the package either.
  let realEntry: string;
  let realPkg: string;
  try {
    realEntry = fs.realpath(entry);
    realPkg = fs.realpath(pkgDir);
  } catch {
    return { kind: "none", reason: `${entry} could not be resolved` };
  }
  if (!inside(realPkg, realEntry)) {
    return { kind: "none", reason: `${known.pkg}'s bin leaves the package` };
  }
  if (JS_EXT.test(realEntry)) return { kind: "node", entry: realEntry };
  if (/\.exe$/i.test(realEntry)) return { kind: "native", path: realEntry };
  // An extensionless launcher counts as JavaScript only with a node shebang.
  const head = fs.readText(realEntry, 256) ?? "";
  if (/^#!.*\bnode\b/.test(head)) return { kind: "node", entry: realEntry };
  return { kind: "native", path: realEntry };
}

export interface Invocation {
  /** Name in permissions.spawn. */
  binary: string;
  /** Arguments put before the CLI's own (the entry script for `node`). */
  prefixArgs: string[];
  /** Set when the CLI cannot be started this way, with what to do instead. */
  problem?: string;
}

/** How to start `cli` on this platform. */
export function invocationFor(
  cli: CliId,
  opts: { platform: NodeJS.Platform; npmPrefix?: string; home?: string; fs?: ResolverFs },
): Invocation {
  if (opts.platform !== "win32") return { binary: cli, prefixArgs: [] };
  const prefix = opts.npmPrefix?.trim() || defaultWindowsNpmPrefix(opts.home);
  const found = resolveNpmEntry(cli, prefix, opts.fs ?? nodeFs);
  if (found.kind === "node") return { binary: "node", prefixArgs: [found.entry] };
  if (found.kind === "native") {
    return {
      binary: cli,
      prefixArgs: [],
      problem:
        `${cli} is installed by npm as a native program (${found.path}), which plughive only ` +
        `starts from PATH. Install the vendor's native build so ${cli}.exe is on PATH.`,
    };
  }
  return { binary: cli, prefixArgs: [] };
}
