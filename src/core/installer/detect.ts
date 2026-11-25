// src/core/installer/detect.ts
//
// Is a program there, and which version: the probes the local pack's
// local_status runs (`<bin> -version` / `--help`, a local HTTP endpoint),
// shared by the installer, software_status and the setup advisor.
//
// A program is looked up in tools/bin first (what plughive installed), then on
// the daemon's PATH plus the usual per-user and package-manager folders, then
// at the fixed locations the catalog names. It is started by absolute path,
// without a shell, with a short timeout and only the OS variables it needs.
// A Windows .cmd/.bat is reported as present but never run.
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadExeca } from "../../lib/lazy-execa.js";
import {
  defaultSystemPath,
  exeCandidates,
  isBatchScript,
  isWindows,
  joinPath,
  splitPath,
  systemChildEnv,
  userHome,
} from "../../lib/platform.js";
import type { CatalogItem } from "./catalog.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 2000;
const MAX_OUTPUT = 64 * 1024;

export interface DetectResult {
  installed: boolean;
  /** Found in tools/bin (installed by plughive). */
  managed: boolean;
  path: string | null;
  version: string | null;
  /** The probe's HTTP endpoint answered (a service such as Ollama is running). */
  running?: boolean;
  error?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type ProbeRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<RunResult>;
export type HttpProbe = (url: string, timeoutMs: number) => Promise<boolean>;

export interface DetectOptions {
  /** tools/bin. Searched first. */
  managedBin?: string;
  /** Folders to search after tools/bin. Default: searchDirs(). */
  dirs?: readonly string[];
  run?: ProbeRunner;
  http?: HttpProbe;
  platform?: NodeJS.Platform;
}

/** The daemon's PATH plus the folders package managers and agent installers use. */
export function searchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = userHome();
  const extra = isWindows()
    ? [join(home, ".local", "bin"), join(home, "AppData", "Local", "Microsoft", "WinGet", "Links")]
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/snap/bin",
        join(home, ".local", "bin"),
        join(home, ".cargo", "bin"),
        join(home, ".bun", "bin"),
        join(home, ".opencode", "bin"),
        join(home, ".npm-global", "bin"),
      ];
  const out: string[] = [];
  for (const d of [...splitPath(env.PATH ?? env.Path ?? defaultSystemPath()), ...extra]) {
    if (isAbsolute(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** First executable `name` in `dirs`, symlinks resolved; null when none. */
export function findProgram(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    for (const file of exeCandidates(name)) {
      try {
        const real = realpathSync.native(join(dir, file));
        if (!statSync(real).isFile()) continue;
        if (!isWindows()) accessSync(real, fsConstants.X_OK);
        return join(dir, file);
      } catch {
        /* next */
      }
    }
  }
  return null;
}

const defaultRun: ProbeRunner = async (file, args, timeoutMs) => {
  const { execa } = await loadExeca();
  const r = await execa(file, [...args], {
    shell: false,
    reject: false,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    extendEnv: false,
    env: { ...systemChildEnv(), PATH: joinPath(searchDirs()) },
    stdin: "ignore",
  });
  return {
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
    exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
  };
};

/** GET a loopback URL; true on any 2xx. Only 127.0.0.1 URLs reach here (catalog schema). */
const defaultHttp: HttpProbe = async (url, timeoutMs) => {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(url)) return false;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
};

function readVersion(probe: NonNullable<CatalogItem["probe"]>, out: string): string | null {
  if (!probe.version) return null;
  const m = new RegExp(probe.version, "m").exec(out);
  return m?.[1]?.slice(0, 60) ?? null;
}

/** Run an item's probe. Never throws. */
export async function detect(item: CatalogItem, opts: DetectOptions = {}): Promise<DetectResult> {
  const probe = item.probe;
  if (!probe) return { installed: false, managed: false, path: null, version: null };
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const http = opts.http ?? defaultHttp;
  const result: DetectResult = { installed: false, managed: false, path: null, version: null };
  try {
    if (probe.bin) {
      const managed = opts.managedBin ? findProgram(probe.bin, [opts.managedBin]) : null;
      const path = managed ?? findProgram(probe.bin, opts.dirs ?? searchDirs());
      const fixed =
        path ??
        (probe.paths?.[platform as "darwin" | "win32" | "linux"] ?? []).find((p) => {
          try {
            return statSync(p).isFile();
          } catch {
            return false;
          }
        }) ??
        null;
      if (fixed) {
        result.path = fixed;
        result.managed = managed !== null;
        if (isBatchScript(fixed)) {
          result.installed = true;
        } else {
          const r = await run(
            fixed,
            probe.args ?? ["--version"],
            probe.timeout_ms ?? DEFAULT_PROBE_TIMEOUT_MS,
          );
          const out = `${r.stdout}\n${r.stderr}`;
          result.version = readVersion(probe, out);
          const expected = probe.expect ? new RegExp(probe.expect, "i").test(out) : false;
          result.installed = r.exitCode === 0 || result.version !== null || expected;
          if (!result.installed) result.error = `${probe.bin} did not answer its probe`;
        }
      }
    } else if (probe.paths) {
      const hit = (probe.paths[platform as "darwin" | "win32" | "linux"] ?? []).find((p) => {
        try {
          statSync(p);
          return true;
        } catch {
          return false;
        }
      });
      if (hit) {
        result.installed = true;
        result.path = hit;
      }
    }
    if (probe.http) {
      result.running = await http(probe.http, HTTP_TIMEOUT_MS);
      // A service with no program to find (Kokoro-FastAPI) counts as installed while it answers.
      if (!probe.bin && result.running) result.installed = true;
    }
  } catch (e) {
    result.error = ((e as Error)?.message ?? String(e)).slice(0, 200);
  }
  return result;
}
