// The daemon's /api, as one small client.
//
// - Same origin only, with the session cookie (`credentials: "same-origin"`).
//   The admin token is never stored by the page: it is exchanged for an
//   HttpOnly cookie through POST /api/session.
// - Every write carries `X-PlugHive-CSRF: 1`.
// - Every refusal becomes an ApiError with the daemon's code and message; a
//   401 also tells the app to show the sign-in screen.

import { t } from "../i18n";

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];
  /** Every other field of the daemon's error object (pack, secret, ...). */
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    issues: ApiIssue[] = [],
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Query parameters; undefined and empty values are left out. */
  query?: Record<string, string | number | boolean | undefined | null>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  request<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  get<T = unknown>(path: string, query?: RequestOptions["query"], signal?: AbortSignal): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  /** Called with every 401: the session ended or was never started. */
  onUnauthorized(listener: () => void): () => void;
}

export const CSRF_HEADER = "X-PlugHive-CSRF";

function withQuery(path: string, query: RequestOptions["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

function messageForStatus(status: number): string {
  if (status === 401) return t("common.api.signIn");
  if (status === 403) return t("common.api.refused");
  if (status === 404) return t("common.api.notFound");
  if (status === 413) return t("common.api.tooLarge");
  if (status === 429) return t("common.api.tooMany");
  if (status >= 500) return t("common.api.internal");
  return t("common.api.requestFailed", { status });
}

export function createApi(fetchImpl: FetchLike = (i, init) => fetch(i, init)): ApiClient {
  const listeners = new Set<() => void>();

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") headers[CSRF_HEADER] = "1";
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetchImpl(withQuery(path, opts.query), {
        method,
        headers,
        body,
        credentials: "same-origin",
        cache: "no-store",
        signal: opts.signal,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      throw new ApiError(0, "NETWORK", t("common.api.network"));
    }

    let data: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (res.status === 401) for (const l of listeners) l();

    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    if (!res.ok || obj?.ok === false) {
      const err =
        obj?.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : {};
      const { code, message, issues, ...details } = err;
      throw new ApiError(
        res.status,
        typeof code === "string"
          ? code
          : res.status === 401
            ? "UNAUTHORIZED"
            : `HTTP_${res.status}`,
        typeof message === "string" && message ? message : messageForStatus(res.status),
        Array.isArray(issues) ? (issues as ApiIssue[]) : [],
        details,
      );
    }
    if (obj === null && text) {
      throw new ApiError(res.status, "BAD_RESPONSE", t("common.api.badResponse"));
    }
    return data as T;
  }

  return {
    request,
    get: (path, query, signal) => request(path, { query, ...(signal ? { signal } : {}) }),
    post: (path, body) => request(path, { method: "POST", body: body ?? {} }),
    put: (path, body) => request(path, { method: "PUT", body: body ?? {} }),
    del: (path) => request(path, { method: "DELETE" }),
    onUnauthorized(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const api = createApi();

/** Plain wording for an error, for toasts and inline messages. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.issues.length > 0) {
      const first = e.issues[0];
      if (first) return `${e.message}: ${first.path ? `${first.path} ` : ""}${first.message}`;
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---- session ---------------------------------------------------------------

export type SessionState = { authenticated: boolean; supported: boolean };

/**
 * Whether this browser is signed in. A daemon without /api/session (older
 * builds) does not have dashboard sign-in, so it counts as signed in.
 */
export async function getSession(client: ApiClient = api): Promise<SessionState> {
  try {
    const s = await client.get<{ authenticated?: boolean }>("/api/session");
    return { authenticated: s.authenticated === true, supported: true };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
      return { authenticated: true, supported: false };
    }
    if (e instanceof ApiError && e.status === 401) return { authenticated: false, supported: true };
    throw e;
  }
}

export async function signIn(token: string, client: ApiClient = api): Promise<void> {
  await client.post("/api/session", { token });
}

export async function signOut(client: ApiClient = api): Promise<void> {
  await client.del("/api/session");
}

/**
 * The sign-in link the daemon prints is `<base>/#token=<token>`. Read the
 * token and remove the fragment at once, so it does not stay in the address
 * bar or the history.
 */
export function takeTokenFromLocation(
  loc: Pick<Location, "hash" | "pathname" | "search"> = window.location,
  replace: (url: string) => void = (url) => window.history.replaceState(null, "", url),
): string | null {
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = params.get("token");
  if (token === null) return null;
  params.delete("token");
  const rest = params.toString();
  replace(`${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`);
  return token.trim() || null;
}
