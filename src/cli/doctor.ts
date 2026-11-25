// src/cli/doctor.ts
//
//   plughive doctor [--port N] [--host H] [--home DIR]
//
// Offline readiness check. It needs no running daemon and makes no network
// call beyond a loopback /health probe when the port is taken. It never
// prints a secret: only names, paths, kinds and versions.
import { execFile } from "node:child_process";
import { constants, accessSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { UserMountStore } from "../core/mounts/user-mounts.js";
import { buildBackend } from "../core/secrets/store.js";
import { assertNoMultiKeyConfig, assertSafeBind, isLoopbackHost } from "../lib/access-key.js";
import { type AppConfig, daemonOrigin, loadConfig } from "../lib/config.js";
import { daemonUp } from "./api.js";
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK, parse, parsePort } from "./args.js";

export const DOCTOR_HELP = `Usage: plughive doctor [options]

Check that this machine can run the daemon: Node version, native modules,
ffmpeg, the Playwright browser, the data directory, the port, the secrets
backend and the daemon settings. Exits 1 when a check fails. Warnings are
features that will not work until fixed; the daemon still starts.

Options:
  --port N      port to check (PLUGHIVE_PORT, default 7777)
  --host H      bind address to check (PLUGHIVE_BIND_HOST)
  --home DIR    data directory to check (PLUGHIVE_HOME)
  -h, --help    show this help`;

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

export const MIN_NODE_MAJOR = 22;

const require = createRequire(import.meta.url);

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
}

export function checkNode(version: string = process.versions.node): Check {
  const major = Number(version.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", level: "ok", detail: `v${version}` }
    : {
        name: "node",
        level: "fail",
        detail: `v${version}; plughive needs Node ${MIN_NODE_MAJOR} or newer`,
      };
}

function checkSqlite(): Check {
  try {
    const Database = require("better-sqlite3") as new (
      path: string,
    ) => {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
    const db = new Database(":memory:");
    db.prepare("select 1").get();
    db.close();
    return { name: "better-sqlite3", level: "ok", detail: "native module loads" };
  } catch (e) {
    return {
      name: "better-sqlite3",
      level: "fail",
      detail: `native module does not load (${message(e)}); reinstall so it is rebuilt for this Node`,
    };
  }
}

async function checkSharp(): Promise<Check> {
  try {
    await import("sharp");
    return { name: "sharp", level: "ok", detail: "native module loads" };
  } catch (e) {
    return {
      name: "sharp",
      level: "warn",
      detail: `does not load (${message(e)}); image resizing and screenshots will fail`,
    };
  }
}

function checkFfmpeg(): Promise<Check> {
  return new Promise((done) => {
    execFile("ffmpeg", ["-version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        done({
          name: "ffmpeg",
          level: "warn",
          detail:
            "not found on PATH; media tools (convert, mix, concat) will fail. Install ffmpeg.",
        });
        return;
      }
      const first = String(stdout).split("\n")[0] ?? "";
      const version = first.match(/ffmpeg version (\S+)/)?.[1] ?? "found";
      done({ name: "ffmpeg", level: "ok", detail: version });
    });
  });
}

async function checkPlaywright(): Promise<Check> {
  try {
    const { chromium } = (await import("playwright")) as { chromium: { executablePath(): string } };
    const path = chromium.executablePath();
    if (path && existsSync(path))
      return { name: "browser", level: "ok", detail: "Playwright Chromium installed" };
    return {
      name: "browser",
      level: "warn",
      detail:
        'Playwright Chromium is not installed; web screenshots will fail. Run "npx playwright install chromium".',
    };
  } catch (e) {
    return { name: "browser", level: "warn", detail: `playwright does not load (${message(e)})` };
  }
}

export function checkHome(root: string): Check {
  if (!existsSync(root))
    return { name: "home", level: "ok", detail: `${root} (created on first start)` };
  try {
    const st = statSync(root);
    if (!st.isDirectory())
      return { name: "home", level: "fail", detail: `${root} is not a directory` };
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      return {
        name: "home",
        level: "warn",
        detail: `${root} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run chmod 700 on it`,
      };
    }
    return { name: "home", level: "ok", detail: `${root} (writable, owner only)` };
  } catch {
    return { name: "home", level: "fail", detail: `${root} is not writable by this user` };
  }
}

/** Free, taken by an plughive daemon (warn), or taken by something else (fail). */
export async function checkPort(
  cfg: Pick<AppConfig, "bindHost" | "port" | "publicUrl">,
): Promise<Check> {
  const free = await new Promise<boolean | string>((done) => {
    const srv = createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => done(err.code ?? "error"));
    srv.listen(cfg.port, cfg.bindHost, () => srv.close(() => done(true)));
  });
  if (free === true)
    return { name: "port", level: "ok", detail: `${cfg.bindHost}:${cfg.port} is free` };
  if (free === "EADDRINUSE") {
    const base = daemonOrigin({ ...cfg, publicUrl: null });
    if (await daemonUp(base)) {
      return { name: "port", level: "warn", detail: `an plughive daemon already runs on ${base}` };
    }
    return {
      name: "port",
      level: "fail",
      detail: `${cfg.bindHost}:${cfg.port} is used by another program; pick --port`,
    };
  }
  return {
    name: "port",
    level: "fail",
    detail: `cannot listen on ${cfg.bindHost}:${cfg.port} (${free})`,
  };
}

function checkSecrets(cfg: AppConfig, env: NodeJS.ProcessEnv): Promise<Check> {
  let kind: string;
  let backend: ReturnType<typeof buildBackend>;
  try {
    backend = buildBackend({ home: cfg.root, env });
    kind = backend.kind;
  } catch (e) {
    return Promise.resolve({ name: "secrets", level: "fail", detail: message(e) });
  }
  if (kind === "keyring") {
    const where =
      process.platform === "win32"
        ? "Windows Credential Manager"
        : "system keyring (Secret Service)";
    // Listing reads names only (never values) and proves the keyring answers.
    return backend.list().then(
      () => ({ name: "secrets", level: "ok", detail: where }) as Check,
      (e: unknown) =>
        ({ name: "secrets", level: "fail", detail: `${where}: ${message(e)}` }) as Check,
    );
  }
  if (kind === "memory") {
    return Promise.resolve({
      name: "secrets",
      level: "warn",
      detail: "memory: stored keys are lost on restart",
    });
  }
  if (kind === "file") {
    const pass = env.PLUGHIVE_SECRETS_PASSPHRASE;
    return Promise.resolve(
      pass
        ? {
            name: "secrets",
            level: "ok",
            detail: "file, encrypted with PLUGHIVE_SECRETS_PASSPHRASE",
          }
        : {
            name: "secrets",
            level: "warn",
            detail:
              "file, not encrypted (plain JSON, mode 0600); set PLUGHIVE_SECRETS_PASSPHRASE to encrypt it",
          },
    );
  }
  return new Promise((done) => {
    execFile("security", ["help"], { timeout: 5000 }, (err) => {
      // `security help` exits non-zero on some versions; only a missing binary matters.
      const missing = (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
      done(
        missing
          ? {
              name: "secrets",
              level: "fail",
              detail: "keychain backend needs the macOS security tool, not found",
            }
          : { name: "secrets", level: "ok", detail: "macOS keychain" },
      );
    });
  });
}

export async function runChecks(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const checks: Check[] = [checkNode(), checkSqlite()];
  let cfg: AppConfig;
  try {
    cfg = loadConfig({ env });
  } catch (e) {
    checks.push({ name: "config", level: "fail", detail: message(e) });
    return checks;
  }
  checks.push({ name: "config", level: "ok", detail: `port ${cfg.port}, bind ${cfg.bindHost}` });
  try {
    assertNoMultiKeyConfig(env);
    assertSafeBind(cfg.bindHost, cfg.accessKey);
    checks.push({
      name: "auth",
      level: "ok",
      detail: cfg.accessKey
        ? "access key required"
        : isLoopbackHost(cfg.bindHost)
          ? "loopback only, no access key needed"
          : "ok",
    });
  } catch (e) {
    checks.push({ name: "auth", level: "fail", detail: message(e) });
  }
  checks.push(checkHome(cfg.root));
  checks.push(await checkPort(cfg));
  checks.push(await checkSecrets(cfg, env));
  checks.push(await checkSharp());
  checks.push(await checkFfmpeg());
  checks.push(await checkPlaywright());
  checks.push({
    name: "import_roots",
    level: cfg.importRoots.every((root) => existsSync(root)) ? "ok" : "fail",
    detail:
      cfg.importRoots.length === 0
        ? "none (import_artifact is off until PLUGHIVE_IMPORT_ROOTS is set)"
        : cfg.importRoots
            .map((root) => `${root}${existsSync(root) ? "" : " (missing)"}`)
            .join(", "),
  });
  try {
    const state = new UserMountStore(cfg.root).read();
    if (state.error) throw new Error(state.error);
    checks.push({
      name: "mounts",
      level: "ok",
      detail: `${state.mounts.length} user mount(s) in mounts.json`,
    });
  } catch (e) {
    checks.push({ name: "mounts", level: "fail", detail: message(e) });
  }
  return checks;
}

export async function runDoctor(argv: string[], io: CliIo): Promise<number> {
  const { values } = parse("doctor", argv, {
    port: { type: "string" },
    host: { type: "string" },
    home: { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) {
    io.out(DOCTOR_HELP);
    return EXIT_OK;
  }
  const env = { ...io.env };
  if (values.port !== undefined) env.PLUGHIVE_PORT = String(parsePort(values.port));
  if (values.host !== undefined) env.PLUGHIVE_BIND_HOST = values.host;
  if (values.home !== undefined) {
    if (!values.home.trim()) throw new CliError("--home must not be empty", 2);
    env.PLUGHIVE_HOME = resolve(values.home);
    env.PLUGHIVE_ROOT = env.PLUGHIVE_HOME;
  }
  const checks = await runChecks(env);
  io.out("plughive doctor");
  io.out("");
  const label = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;
  for (const c of checks) io.out(`${label[c.level]} ${c.name}: ${c.detail}`);
  const failed = checks.some((c) => c.level === "fail");
  io.out("");
  io.out(failed ? "Fix the failures above first." : "Ready to start: plughive start");
  return failed ? EXIT_FAIL : EXIT_OK;
}
