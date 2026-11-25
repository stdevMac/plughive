// src/lib/config.ts
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AppConfig {
  port: number;
  /** $PLUGHIVE_HOME (PLUGHIVE_ROOT is the older name): state, artifacts, packs. */
  root: string;
  /** PLUGHIVE_IMPORT_ROOTS: the folders import_artifact may read from. */
  importRoots: string[];
  jobConcurrency: number;
  /** Bind address. A non-loopback address requires an access key (see assertSafeBind). */
  bindHost: string;
  /** When set, /mcp, /p, /api and /artifacts require it. */
  accessKey: string | null;
  /**
   * PLUGHIVE_PUBLIC_URL: the origin (scheme://host[:port]) users reach the
   * daemon on, e.g. behind a TLS proxy. Used for every absolute URL the daemon
   * emits and as the base of the Origin checks. Null: derived from the bind address.
   */
  publicUrl: string | null;
  /** PLUGHIVE_ALLOWED_ORIGINS: extra browser origins allowed to call /mcp, /p and /api. */
  allowedOrigins: string[];
  /** PLUGHIVE_MAX_QUEUED_JOBS: enqueueing fails once this many jobs wait. */
  jobMaxQueued: number;
  /** PLUGHIVE_CODE_MODE=1: register run_tool_script (off by default; see docs/configuration.md). */
  codeMode: boolean;
  /** PLUGHIVE_TRIGGERS=0 turns triggers off (cron schedules and /hooks). Default on. */
  triggers: boolean;
  /** PLUGHIVE_HOOK_RATE_LIMIT: inbound webhook requests per minute per hook. Default 30. */
  hookRateLimit: number;
}

export interface LoadConfigOpts {
  env?: NodeJS.ProcessEnv;
}

/**
 * Daemon settings from the environment. Provider keys are not configuration:
 * they live in the secret store and belong to the pack that declares them.
 */
export function loadConfig(opts: LoadConfigOpts = {}): AppConfig {
  const env = opts.env ?? process.env;
  const port = positiveInt("PLUGHIVE_PORT", env.PLUGHIVE_PORT || undefined, 7777);
  if (port > 65535) throw new Error("PLUGHIVE_PORT must be a port number");
  const root = expandHome(env.PLUGHIVE_ROOT?.trim() || env.PLUGHIVE_HOME?.trim() || "~/.plughive");
  const importRoots = (env.PLUGHIVE_IMPORT_ROOTS ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean)
    .map(expandHome);
  const jobConcurrency = positiveInt("PLUGHIVE_JOB_CONCURRENCY", env.PLUGHIVE_JOB_CONCURRENCY, 2);
  const bindHost = env.PLUGHIVE_BIND_HOST?.trim() || "127.0.0.1";
  const accessKey = env.PLUGHIVE_ACCESS_KEY?.trim() || env.PLUGHIVE_API_KEY?.trim() || null;
  const publicUrl = env.PLUGHIVE_PUBLIC_URL?.trim()
    ? parseOrigin("PLUGHIVE_PUBLIC_URL", env.PLUGHIVE_PUBLIC_URL.trim())
    : null;
  const allowedOrigins = (env.PLUGHIVE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => parseOrigin("PLUGHIVE_ALLOWED_ORIGINS", origin));
  const jobMaxQueued = positiveInt("PLUGHIVE_MAX_QUEUED_JOBS", env.PLUGHIVE_MAX_QUEUED_JOBS, 200);
  const codeMode = /^(1|true|yes|on)$/i.test(env.PLUGHIVE_CODE_MODE?.trim() ?? "");
  const triggers = !/^(0|false|no|off)$/i.test(env.PLUGHIVE_TRIGGERS?.trim() ?? "");
  const hookRateLimit = positiveInt("PLUGHIVE_HOOK_RATE_LIMIT", env.PLUGHIVE_HOOK_RATE_LIMIT, 30);

  return {
    port,
    root,
    importRoots,
    jobConcurrency,
    bindHost,
    accessKey,
    publicUrl,
    allowedOrigins,
    jobMaxQueued,
    codeMode,
    triggers,
    hookRateLimit,
  };
}

/**
 * A bare http(s) origin: no credentials, path, query or fragment. The value is
 * never echoed in the error (it may be a mistyped secret).
 */
export function parseOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) origin such as https://store.example.com`);
  }
  const bare = url.pathname === "/" || url.pathname === "";
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !bare ||
    url.hostname === ""
  ) {
    throw new Error(
      `${name} must be an http(s) origin (scheme, host and optional port only), without path, query or credentials`,
    );
  }
  return url.origin;
}

/**
 * The origin the daemon is reached on: PLUGHIVE_PUBLIC_URL when set, else
 * derived from the bind address. Never from a request's Host header.
 */
export function daemonOrigin(
  cfg: Pick<AppConfig, "publicUrl" | "bindHost" | "port">,
  port: number = cfg.port,
): string {
  if (cfg.publicUrl) return cfg.publicUrl;
  const host = cfg.bindHost.trim().toLowerCase();
  const name =
    host === "0.0.0.0" || host === "::" || host === "[::]" || host === ""
      ? "127.0.0.1"
      : host.includes(":") && !host.startsWith("[")
        ? `[${host}]`
        : host;
  return `http://${name}:${port}`;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function positiveInt(name: string, value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
