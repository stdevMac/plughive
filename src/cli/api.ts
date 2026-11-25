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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequestOptions {
  /** Extra request headers (for example Idempotency-Key). */
  headers?: Record<string, string>;
  /** Overrides the client's timeout for this call; 0 waits as long as it takes. */
  timeoutMs?: number;
}

export interface ApiClient {
  get<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: ApiRequestOptions): Promise<T>;
  delete<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
  /** Any method; the parsed body and status are returned even when the status is an error. */
  raw(
    method: HttpMethod,
    path: string,
    body?: unknown,
    opts?: ApiRequestOptions,
  ): Promise<{ status: number; body: unknown }>;
  /** An open streaming GET (Server-Sent Events). The caller reads and cancels the body. */
  stream(path: string, signal?: AbortSignal): Promise<Response>;
}

/** A refusal from the daemon, with its error code (UNKNOWN_JOB, APPROVAL_REQUIRED, ...). */
export class ApiError extends CliError {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A client for /api/*. Writes carry the CSRF header the daemon requires. */
export function apiClient(baseUrl: string, token: string, timeoutMs = 10_000): ApiClient {
  const unreachable = () =>
    new CliError(`no plughive daemon answers on ${baseUrl}; start one with "plughive start"`);
  const send = async (
    method: HttpMethod,
    path: string,
    body: unknown,
    opts: ApiRequestOptions = {},
  ): Promise<{ status: number; body: unknown }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...opts.headers };
    const hasBody = method !== "GET" && method !== "DELETE";
    if (method !== "GET") headers["x-plughive-csrf"] = "1";
    if (hasBody) headers["content-type"] = "application/json";
    const timeout = opts.timeoutMs ?? timeoutMs;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify(body ?? {}) } : {}),
        ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new CliError(`${method} ${path} timed out after ${Math.round(timeout / 1000)} s`);
      }
      throw unreachable();
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // Not JSON: reported with the status.
    }
    if (res.status === 401) {
      throw new CliError(
        `the daemon on ${baseUrl} rejected the admin token; is PLUGHIVE_HOME (or PLUGHIVE_ADMIN_TOKEN) the one the daemon uses?`,
      );
    }
    return { status: res.status, body: parsed };
  };
  const call = async <T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    opts?: ApiRequestOptions,
  ): Promise<T> => {
    const res = await send(method, path, body, opts);
    if (res.status >= 400) {
      const error = (res.body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
      const message = error?.message ?? `HTTP ${res.status}`;
      const code = typeof error?.code === "string" ? error.code : null;
      throw new ApiError(
        `${method} ${path} failed: ${String(message)}${code ? ` (${code})` : ""}`,
        res.status,
        code,
        res.body,
      );
    }
    return res.body as T;
  };
  return {
    get: (path, opts) => call("GET", path, undefined, opts),
    post: (path, body, opts) => call("POST", path, body, opts),
    put: (path, body, opts) => call("PUT", path, body, opts),
    patch: (path, body, opts) => call("PATCH", path, body, opts),
    delete: (path, opts) => call("DELETE", path, undefined, opts),
    raw: (method, path, body, opts) => send(method, path, body, opts),
    stream: async (path, signal) => {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw unreachable();
      }
      if (res.status === 401) {
        throw new CliError(`the daemon on ${baseUrl} rejected the admin token`);
      }
      if (!res.ok || !res.body) {
        let message = `HTTP ${res.status}`;
        try {
          const b = (await res.json()) as { error?: { message?: string } };
          if (b.error?.message) message = b.error.message;
        } catch {
          // Keep the status.
        }
        throw new CliError(`GET ${path} failed: ${message}`);
      }
      return res;
    },
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
