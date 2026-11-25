// src/cli/api.ts
//
// How the CLI reaches a running daemon: the same settings the daemon reads
// (PLUGHIVE_PUBLIC_URL, PLUGHIVE_BIND_HOST, PLUGHIVE_PORT, PLUGHIVE_HOME)
// give the base URL, and the admin token authenticates /api. The token is
// sent in a header only; it is never printed or put in an error.
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { isLoopbackHost } from "../lib/access-key.js";
import { ADMIN_TOKEN_ENV, ADMIN_TOKEN_FILE, loadOrCreateAdminToken } from "../lib/admin-token.js";
import { type AppConfig, daemonOrigin, loadConfig } from "../lib/config.js";
import { CliError, EXIT_USAGE } from "./args.js";

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

/** The most the CLI reads of one answer of the daemon. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * True when `host` is this computer: loopback, or an address of one of its
 * own network interfaces (a daemon bound to the machine's LAN address).
 * Traffic to such an address never leaves the machine.
 */
export function isThisMachine(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackHost(h)) return true;
  if (!isIP(h)) return false;
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.address.toLowerCase() === h) return true;
    }
  }
  return false;
}

/**
 * The admin token gives full control of the daemon. Over plain HTTP anyone on
 * the network path could read it, so it is only sent over https or to this
 * computer.
 */
export function assertTokenTransport(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (url.protocol === "https:" || isThisMachine(url.hostname)) return;
  throw new CliError(
    `refusing to send the admin token over plain HTTP to ${url.host}: anyone on the network could read it. Run the command on the daemon's computer, or reach the daemon through an SSH tunnel to 127.0.0.1.`,
  );
}

/**
 * The full URL of an /api path. The path is resolved first, so "/api/../mcp"
 * or an encoded "%2e%2e" cannot carry the admin token to another endpoint.
 */
export function apiUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const fail = () =>
    new CliError(`"${path}" is not a path under /api (no "..", "\\" or host)`, EXIT_USAGE);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw fail();
  let url: URL;
  try {
    url = new URL(path, base);
  } catch {
    throw fail();
  }
  if (url.origin !== base.origin) throw fail();
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) throw fail();
  return url.toString();
}

/** The body of an answer as text, refused when it is larger than MAX_RESPONSE_BYTES. */
export async function readBody(res: Response, max = MAX_RESPONSE_BYTES): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new CliError(`the daemon's answer is larger than ${max / 1024 / 1024} MiB`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}

/**
 * The daemon's validation issues ({path, message}, path a zod array or a
 * string) as "  a.b: message" lines.
 */
export function issueLines(issues: unknown): string[] {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 20).map((i: { path?: unknown; message?: unknown }) => {
    const path = Array.isArray(i?.path) ? i.path.join(".") : String(i?.path ?? "");
    return `  ${path || "(arguments)"}: ${String(i?.message ?? "not valid")}`;
  });
}

/** A client for /api/*. Writes carry the CSRF header the daemon requires. */
export function apiClient(baseUrl: string, token: string, timeoutMs = 10_000): ApiClient {
  assertTokenTransport(baseUrl);
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
    const url = apiUrl(baseUrl, path);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        // A redirect would send the admin token on to wherever it points.
        redirect: "error",
        ...(hasBody ? { body: JSON.stringify(body ?? {}) } : {}),
        ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new CliError(`${method} ${path} timed out after ${Math.round(timeout / 1000)} s`);
      }
      throw unreachable();
    }
    // JSON when it is JSON, else the text (an HTML error page, a proxy's
    // message), else null.
    let parsed: unknown = null;
    const text = await readBody(res);
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
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
      const issues = issueLines((error as { issues?: unknown } | undefined)?.issues);
      throw new ApiError(
        `${method} ${path} failed: ${String(message)}${code ? ` (${code})` : ""}${
          issues.length ? `\n${issues.join("\n")}` : ""
        }`,
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
      const url = apiUrl(baseUrl, path);
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
          redirect: "error",
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
          const b = JSON.parse(await readBody(res)) as { error?: { message?: string } };
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
