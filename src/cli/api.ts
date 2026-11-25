// src/cli/api.ts
//
// How the CLI reaches a running daemon: the same settings the daemon reads
// (PLUGHIVE_PUBLIC_URL, PLUGHIVE_BIND_HOST, PLUGHIVE_PORT, PLUGHIVE_HOME)
// give the base URL, and the admin token authenticates /api. The token is
// sent in a header only; it is never printed or put in an error.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_TOKEN_ENV, ADMIN_TOKEN_FILE, loadOrCreateAdminToken } from "../lib/admin-token.js";
import { type AppConfig, daemonOrigin, loadConfig } from "../lib/config.js";
import { CliError } from "./args.js";

export interface DaemonTarget {
  config: AppConfig;
  /** The origin people reach the daemon on; used in links the CLI prints. */
  baseUrl: string;
  /**
   * Where the CLI itself connects: the bind address and port, ignoring
   * PLUGHIVE_PUBLIC_URL. Inside a container, or behind a proxy, the public
   * origin is often not reachable from the daemon's own machine.
   */
  localUrl: string;
}

export function daemonTarget(env: NodeJS.ProcessEnv): DaemonTarget {
  let config: AppConfig;
  try {
    config = loadConfig({ env });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  return {
    config,
    baseUrl: daemonOrigin(config),
    localUrl: daemonOrigin({ ...config, publicUrl: null }),
  };
}

/**
 * The admin token of this install without creating one: a CLI command that
 * only reads must not set up a home. Null when there is none yet.
 */
export function readAdminToken(home: string, env: NodeJS.ProcessEnv): string | null {
  if (!env[ADMIN_TOKEN_ENV]?.trim() && !existsSync(join(home, ADMIN_TOKEN_FILE))) return null;
  try {
    return loadOrCreateAdminToken(home, env).token;
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
}

/** True when an plughive daemon answers /health on this base URL. */
export async function daemonUp(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

/** A client for /api/*. Writes carry the CSRF header the daemon requires. */
export function apiClient(baseUrl: string, token: string, timeoutMs = 10_000): ApiClient {
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (method !== "GET") {
      headers["x-plughive-csrf"] = "1";
      headers["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CliError(
        `no plughive daemon answers on ${baseUrl}; start one with "plughive start"`,
      );
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // Not JSON: reported below with the status.
    }
    if (res.status === 401) {
      throw new CliError(
        `the daemon on ${baseUrl} rejected the admin token; is PLUGHIVE_HOME (or PLUGHIVE_ADMIN_TOKEN) the one the daemon uses?`,
      );
    }
    if (!res.ok) {
      const message =
        (parsed as { error?: { message?: unknown } } | null)?.error?.message ??
        `HTTP ${res.status}`;
      throw new CliError(`${method} ${path} failed: ${String(message)}`);
    }
    return parsed as T;
  };
  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
  };
}

/** The client for the daemon of this environment, or an error that says why there is none. */
export function connect(env: NodeJS.ProcessEnv): { target: DaemonTarget; api: ApiClient } {
  const target = daemonTarget(env);
  const token = readAdminToken(target.config.root, env);
  if (!token) {
    throw new CliError(
      `no admin token in ${target.config.root}; start the daemon once with "plughive start" (or set ${ADMIN_TOKEN_ENV})`,
    );
  }
  return { target, api: apiClient(target.localUrl, token) };
}
