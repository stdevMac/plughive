// src/core/net/safe-fetch.ts
//
// SSRF-guarded fetch with host allow-lists.
//
// How the guard works (two layers, the second one is the enforcement point):
//
//   1. Pre-flight, per hop: the URL is parsed with the WHATWG parser (which
//      canonicalises decimal/octal/hex/short IPv4 forms, case, IDN and
//      brackets), checked against the policy, then resolved and every resolved
//      address is classified. This gives clear errors before any socket opens.
//
//   2. Connect time: requests go through a private undici Agent whose
//      connector function resolves the hostname AGAIN, validates every address
//      and then opens the socket to that exact validated IP literal (the
//      hostname is only kept as TLS servername / Host header). Node never does
//      its own DNS lookup for the connection, so a DNS answer cannot change
//      between "check" and "connect" (no rebinding window). Pooled keep-alive
//      sockets were validated when they were opened.
//
// Redirects are followed manually so each hop passes through both layers.
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { Response as UndiciResponse } from "undici";
import { ipVersion, isPrivateAddress } from "./ip.js";

export { isPrivateAddress } from "./ip.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LookupAddress {
  address: string;
  family?: number;
}

/**
 * DNS resolver used by the guard. Must return every address for the name.
 * `target` is the port being connected to, so a wrapper can refuse an answer
 * for one port (the daemon's own) and not another. It is called both at
 * pre-flight and at connect time, so a refusal here is rebinding-proof.
 */
export type SafeLookup = (hostname: string, target?: { port: number }) => Promise<LookupAddress[]>;

export type SafeProtocol = "https:" | "http:";

export interface SafeFetchPolicy {
  /**
   * Hosts the caller may reach. Entries are exact hostnames ("api.example.com",
   * optionally "api.example.com:8443" to pin a port), subdomain wildcards
   * ("*.example.com", which does not match the apex), or "*" for any PUBLIC
   * host. No entry here ever permits a private/loopback address.
   */
  allowHosts: string[];
  /**
   * Explicit "host:port" exceptions for loopback/LAN targets, for example
   * "127.0.0.1:11434" or "localhost:8188". The entry must match the URL's host
   * and port as written (after normalisation); a public-looking name that
   * merely resolves to an allowed IP does not match.
   */
  allowLocal?: string[];
  /** Maximum redirects to follow. Default 5. */
  maxRedirects?: number;
  /**
   * Cap on decoded response body bytes, enforced while streaming.
   * Default 256 MiB (DEFAULT_MAX_RESPONSE_BYTES).
   */
  maxResponseBytes?: number;
  /**
   * Cap on the request body, enforced while it is buffered.
   * Default 64 MiB (DEFAULT_MAX_REQUEST_BODY_BYTES).
   */
  maxRequestBodyBytes?: number;
  /**
   * Total time budget in ms covering request body buffering, DNS, connect,
   * headers and the response body. Default 60000. 0 disables.
   */
  timeoutMs?: number;
  /**
   * Default (omitted): https anywhere, http only for `allowLocal` entries.
   * When given explicitly the list applies to every target as written.
   */
  allowedProtocols?: SafeProtocol[];
  /** Injected DNS resolver (tests). Default: OS resolver, all addresses. */
  lookup?: SafeLookup;
  /**
   * Extra header names that are sensitive. Sensitive headers are dropped on
   * cross-origin redirects even when listed in `redirectHeaderAllowlist`.
   */
  sensitiveHeaders?: string[];
  /**
   * On a cross-origin redirect only a safelist of request headers is kept
   * (accept, accept-language, content-type, user-agent). Names listed here are
   * kept as well, unless they are sensitive (see `sensitiveHeaders`).
   */
  redirectHeaderAllowlist?: string[];
  /**
   * Allow a request body to be re-sent to a different origin when a redirect
   * keeps the method (307/308, or 301/302 for non-POST). Default false: such
   * a redirect fails with reason "cross_origin_body_replay".
   */
  allowCrossOriginBodyReplay?: boolean;
  /** Extra trust anchors for TLS (private CAs, tests). Verification is never disabled. */
  tls?: { ca?: string | Buffer | Array<string | Buffer> };
  /** Called once per opened socket with the validated address (audit, tests). */
  onConnect?: (info: { host: string; port: number; address: string }) => void;
}

export type BlockedReason =
  | "invalid_url"
  | "protocol_not_allowed"
  | "credentials_in_url"
  | "host_not_allowed"
  | "private_address"
  | "dns_failure"
  | "too_many_redirects"
  | "redirect_not_allowed"
  | "cross_origin_body_replay"
  | "request_too_large";

/** Default cap on decoded response bytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
/** Default cap on request body bytes. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

const REASON_TEXT: Record<BlockedReason, string> = {
  cross_origin_body_replay: "the redirect would re-send the request body to a different origin",
  request_too_large: "the request body exceeds the size limit",
  invalid_url: "the URL is not valid",
  protocol_not_allowed: "the protocol is not allowed",
  credentials_in_url: "URLs with embedded credentials are not allowed",
  host_not_allowed: "the host is not on the allow-list",
  private_address: "the host is or resolves to a private, loopback or reserved address",
  dns_failure: "the host could not be resolved",
  too_many_redirects: "too many redirects",
  redirect_not_allowed: "the response was a redirect and redirects are disabled",
};

/** Base class for every error this module raises on purpose. */
export class SafeFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/**
 * The request was refused by policy. The message carries only the reason and
 * the hostname: never the path, query string, headers or body.
 */
export class BlockedRequestError extends SafeFetchError {
  readonly reason: BlockedReason;
  readonly host: string;
  constructor(reason: BlockedReason, host: string) {
    const safeHost = sanitiseHostForMessage(host);
    super(
      safeHost
        ? `Request to ${safeHost} blocked: ${REASON_TEXT[reason]}`
        : `Request blocked: ${REASON_TEXT[reason]}`,
    );
    this.name = "BlockedRequestError";
    this.reason = reason;
    this.host = safeHost;
  }
}

export class ResponseTooLargeError extends SafeFetchError {
  readonly host: string;
  readonly limit: number;
  constructor(host: string, limit: number) {
    super(`Response from ${sanitiseHostForMessage(host)} exceeded the ${limit} byte limit`);
    this.name = "ResponseTooLargeError";
    this.host = sanitiseHostForMessage(host);
    this.limit = limit;
  }
}

export class SafeFetchTimeoutError extends SafeFetchError {
  readonly host: string;
  readonly timeoutMs: number;
  constructor(host: string, timeoutMs: number) {
    super(`Request to ${sanitiseHostForMessage(host)} timed out after ${timeoutMs} ms`);
    this.name = "TimeoutError";
    this.host = sanitiseHostForMessage(host);
    this.timeoutMs = timeoutMs;
  }
}

export type SafeFetch = ((
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>) & {
  /** Close pooled connections. The function must not be used afterwards. */
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Policy compilation
// ---------------------------------------------------------------------------

interface HostRule {
  host: string;
  port?: number;
}

interface CompiledPolicy {
  anyPublic: boolean;
  exact: HostRule[];
  wildcards: Array<{ suffix: string; port?: number }>;
  local: Set<string>;
  protocols: Set<SafeProtocol> | null;
  maxRedirects: number;
  maxResponseBytes: number;
  maxRequestBodyBytes: number;
  timeoutMs: number;
  lookup: SafeLookup;
  sensitiveHeaders: Set<string>;
  redirectHeaders: Set<string>;
  allowCrossOriginBodyReplay: boolean;
  raw: SafeFetchPolicy;
}

interface Target {
  /** Canonical host: lower case, no brackets, no trailing dot, punycode. */
  host: string;
  port: number;
  protocol: SafeProtocol;
  /** Matched an allowLocal entry: private addresses are permitted. */
  local: boolean;
  /** 0 when the host is a DNS name. */
  ipVersion: 0 | 4 | 6;
}

function sanitiseHostForMessage(host: string): string {
  // Hostnames only. Anything unexpected (should not happen) is dropped rather
  // than echoed, so a hostile URL cannot smuggle text into logs.
  if (typeof host !== "string") return "";
  const trimmed = host.slice(0, 255);
  return /^[A-Za-z0-9._:\-[\]]*$/.test(trimmed) ? trimmed : "";
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function stripTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** Canonicalise a bare host the same way the URL parser would. Null if invalid. */
function canonicalHost(host: string): string | null {
  if (host === "" || /[\s/@?#\\]/.test(host)) return null;
  const candidate = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    const parsed = new URL(`http://${candidate}/`);
    const out = stripTrailingDot(stripBrackets(parsed.hostname)).toLowerCase();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

function splitHostPort(entry: string): { host: string; port?: number } | null {
  let host = entry;
  let portText: string | undefined;
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end === -1) return null;
    host = entry.slice(0, end + 1);
    const rest = entry.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      portText = rest.slice(1);
    }
  } else {
    const first = entry.indexOf(":");
    if (first !== -1 && first === entry.lastIndexOf(":")) {
      host = entry.slice(0, first);
      portText = entry.slice(first + 1);
    }
  }
  if (portText === undefined) return { host };
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

/** Request headers kept on a cross-origin redirect by default. */
const REDIRECT_SAFE_HEADERS = ["accept", "accept-language", "content-type", "user-agent"];

function compilePolicy(policy: SafeFetchPolicy): CompiledPolicy {
  if (!policy || !Array.isArray(policy.allowHosts)) {
    throw new TypeError("safe-fetch policy requires an allowHosts array");
  }
  let anyPublic = false;
  const exact: HostRule[] = [];
  const wildcards: Array<{ suffix: string; port?: number }> = [];
  for (const entry of policy.allowHosts) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new TypeError("safe-fetch policy: allowHosts entries must be non-empty strings");
    }
    const text = entry.trim();
    if (text === "*") {
      anyPublic = true;
      continue;
    }
    const wildcard = text.startsWith("*.");
    const parts = splitHostPort(wildcard ? text.slice(2) : text);
    const host = parts ? canonicalHost(parts.host) : null;
    if (!parts || !host || host.includes("*")) {
      throw new TypeError(`safe-fetch policy: invalid allowHosts entry "${text}"`);
    }
    if (wildcard) {
      // "*.com" (a single-label suffix) would allow a whole TLD; refuse it.
      if (ipVersion(host) !== 0 || !host.includes(".")) {
        throw new TypeError(`safe-fetch policy: invalid allowHosts entry "${text}"`);
      }
      wildcards.push({ suffix: `.${host}`, port: parts.port });
    } else {
      exact.push({ host, port: parts.port });
    }
  }

  const local = new Set<string>();
  for (const entry of policy.allowLocal ?? []) {
    const parts = typeof entry === "string" ? splitHostPort(entry.trim()) : null;
    const host = parts ? canonicalHost(parts.host) : null;
    if (!parts || !host || parts.port === undefined) {
      throw new TypeError(
        `safe-fetch policy: invalid allowLocal entry "${String(entry)}" (expected "host:port")`,
      );
    }
    local.add(`${host}:${parts.port}`);
  }

  let protocols: Set<SafeProtocol> | null = null;
  if (policy.allowedProtocols !== undefined) {
    protocols = new Set();
    for (const protocol of policy.allowedProtocols) {
      if (protocol !== "https:" && protocol !== "http:") {
        throw new TypeError(`safe-fetch policy: unsupported protocol "${String(protocol)}"`);
      }
      protocols.add(protocol);
    }
  }

  const nonNegativeInt = (value: number | undefined, name: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`safe-fetch policy: ${name} must be a non-negative number`);
    }
    return Math.floor(value);
  };

  const sensitiveHeaders = new Set<string>();
  for (const name of policy.sensitiveHeaders ?? []) sensitiveHeaders.add(name.toLowerCase());
  const redirectHeaders = new Set(REDIRECT_SAFE_HEADERS);
  for (const name of policy.redirectHeaderAllowlist ?? []) {
    if (typeof name !== "string" || name === "") {
      throw new TypeError(
        "safe-fetch policy: redirectHeaderAllowlist entries must be non-empty strings",
      );
    }
    redirectHeaders.add(name.toLowerCase());
  }

  return {
    anyPublic,
    exact,
    wildcards,
    local,
    protocols,
    maxRedirects: nonNegativeInt(policy.maxRedirects, "maxRedirects") ?? 5,
    maxResponseBytes:
      nonNegativeInt(policy.maxResponseBytes, "maxResponseBytes") ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxRequestBodyBytes:
      nonNegativeInt(policy.maxRequestBodyBytes, "maxRequestBodyBytes") ??
      DEFAULT_MAX_REQUEST_BODY_BYTES,
    timeoutMs: nonNegativeInt(policy.timeoutMs, "timeoutMs") ?? 60_000,
    lookup: policy.lookup ?? defaultLookup,
    sensitiveHeaders,
    redirectHeaders,
    allowCrossOriginBodyReplay: policy.allowCrossOriginBodyReplay === true,
    raw: policy,
  };
}

const defaultLookup: SafeLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family }));
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function hostAllowed(policy: CompiledPolicy, host: string, port: number, isIp: boolean): boolean {
  if (policy.anyPublic) return true;
  for (const rule of policy.exact) {
    if (rule.host === host && (rule.port === undefined || rule.port === port)) return true;
  }
  if (!isIp) {
    for (const rule of policy.wildcards) {
      if (
        host.length > rule.suffix.length &&
        host.endsWith(rule.suffix) &&
        (rule.port === undefined || rule.port === port)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Policy check for one (protocol, host, port). No DNS. Throws BlockedRequestError. */
function checkTarget(
  policy: CompiledPolicy,
  protocol: string,
  rawHost: string,
  port: number,
): Target {
  const host = stripTrailingDot(stripBrackets(rawHost)).toLowerCase();
  if (host === "") throw new BlockedRequestError("invalid_url", "");
  if (protocol !== "https:" && protocol !== "http:") {
    throw new BlockedRequestError("protocol_not_allowed", host);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BlockedRequestError("invalid_url", host);
  }
  const local = policy.local.has(`${host}:${port}`);
  const protocolOk =
    policy.protocols === null ? protocol === "https:" || local : policy.protocols.has(protocol);
  if (!protocolOk) throw new BlockedRequestError("protocol_not_allowed", host);

  const version = ipVersion(host);
  if (!local) {
    if (version !== 0 && isPrivateAddress(host)) {
      throw new BlockedRequestError("private_address", host);
    }
    if (!hostAllowed(policy, host, port, version !== 0)) {
      throw new BlockedRequestError("host_not_allowed", host);
    }
  }
  return { host, port, protocol, local, ipVersion: version };
}

function validateUrl(policy: CompiledPolicy, input: string | URL): { url: URL; target: Target } {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input.href);
  } catch {
    throw new BlockedRequestError("invalid_url", "");
  }
  const displayHost = stripTrailingDot(stripBrackets(url.hostname));
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedRequestError("protocol_not_allowed", displayHost);
  }
  if (url.username !== "" || url.password !== "") {
    throw new BlockedRequestError("credentials_in_url", displayHost);
  }
  if (url.hostname === "") throw new BlockedRequestError("invalid_url", "");
  // Drop a trailing root dot so "example.com." and "example.com" are one host
  // for the allow-list, the connection pool and the Host header.
  if (url.hostname.endsWith(".")) {
    const stripped = stripTrailingDot(url.hostname);
    if (stripped === "") throw new BlockedRequestError("invalid_url", "");
    url.hostname = stripped;
    if (url.hostname.endsWith(".")) throw new BlockedRequestError("invalid_url", displayHost);
  }
  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const target = checkTarget(policy, url.protocol, url.hostname, port);
  return { url, target };
}

/**
 * Resolve the target and return the addresses that are safe to connect to,
 * IPv4 first. Throws if resolution fails, returns junk, or (for non-local
 * targets) ANY address is not public.
 */
async function resolveValidated(policy: CompiledPolicy, target: Target): Promise<string[]> {
  if (target.ipVersion !== 0) {
    // checkTarget already classified the literal.
    return [target.host];
  }
  let results: LookupAddress[];
  try {
    results = await policy.lookup(target.host, { port: target.port });
  } catch {
    throw new BlockedRequestError("dns_failure", target.host);
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new BlockedRequestError("dns_failure", target.host);
  }
  const v4: string[] = [];
  const v6: string[] = [];
  for (const entry of results) {
    const address = typeof entry?.address === "string" ? entry.address : "";
    const version = ipVersion(address);
    if (version === 0) throw new BlockedRequestError("dns_failure", target.host);
    if (!target.local && isPrivateAddress(address)) {
      throw new BlockedRequestError("private_address", target.host);
    }
    // Zone ids are only meaningful for link-local, which is never public.
    const clean = stripBrackets(address);
    if (version === 4) v4.push(clean);
    else v6.push(clean);
  }
  return [...new Set([...v4, ...v6])];
}

/**
 * Validation only: parse `url`, apply the policy and resolve DNS, rejecting
 * anything that is or resolves to a non-public address (unless it is an
 * `allowLocal` entry). Returns the normalised URL.
 *
 * Use this for tools that hand the URL to something else (for example a
 * headless browser). It cannot pin the connection, so the consumer may still
 * be exposed to DNS rebinding and to redirects/subresources; prefer
 * `createSafeFetch` whenever the daemon itself makes the request.
 */
export async function assertPublicUrl(url: string | URL, policy: SafeFetchPolicy): Promise<URL> {
  const compiled = compilePolicy(policy);
  const validated = validateUrl(compiled, url);
  await resolveValidated(compiled, validated.target);
  return validated.url;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const ALWAYS_SENSITIVE = new Set(["authorization", "proxy-authorization", "cookie", "cookie2"]);
const SENSITIVE_PATTERN =
  /(api[-_]?key|token|secret|auth|signature|password|passwd|credential|session|csrf|xsrf)/i;
const BODY_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
];

function isSensitiveHeader(policy: CompiledPolicy, name: string): boolean {
  const lower = name.toLowerCase();
  return (
    ALWAYS_SENSITIVE.has(lower) ||
    policy.sensitiveHeaders.has(lower) ||
    SENSITIVE_PATTERN.test(lower)
  );
}

function findOwnError(err: unknown): SafeFetchError | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof SafeFetchError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function createSafeFetch(policy: SafeFetchPolicy): SafeFetch {
  const compiled = compilePolicy(policy);

  let closed = false;
  const baseConnect = buildConnector({
    timeout: 30_000,
    ...(policy.tls?.ca !== undefined ? { ca: policy.tls.ca } : {}),
  });

  // ENFORCEMENT POINT. undici calls this for every new socket. We resolve and
  // validate here and hand the base connector an IP literal, so net/tls never
  // perform a lookup of their own.
  const connector: buildConnector.connector = (options, callback) => {
    const protocol = options.protocol;
    const defaultPort = protocol === "https:" ? 443 : 80;
    const port = options.port ? Number(options.port) : defaultPort;
    let target: Target;
    try {
      target = checkTarget(compiled, protocol, options.hostname, port);
    } catch (err) {
      callback(err as Error, null);
      return;
    }
    const servername =
      protocol === "https:"
        ? (options.servername ?? (target.ipVersion === 0 ? target.host : undefined))
        : undefined;
    // undici gives the connector no abort signal, so the fallback loop over
    // the resolved addresses is bounded by the total time budget and by
    // close() instead: once either is exhausted no further address is dialled.
    const startedAt = Date.now();
    const budgetSpent = (): boolean =>
      compiled.timeoutMs > 0 && Date.now() - startedAt >= compiled.timeoutMs;
    resolveValidated(compiled, target).then(
      (addresses) => {
        const attempt = (index: number): void => {
          const address = addresses[index];
          if (address === undefined) {
            callback(new BlockedRequestError("dns_failure", target.host), null);
            return;
          }
          if (closed) {
            callback(new SafeFetchError("safe-fetch was closed"), null);
            return;
          }
          if (budgetSpent()) {
            callback(new SafeFetchTimeoutError(target.host, compiled.timeoutMs), null);
            return;
          }
          baseConnect({ ...options, hostname: address, servername }, (err, socket) => {
            if (err || !socket) {
              if (index + 1 < addresses.length && !closed && !budgetSpent()) {
                attempt(index + 1);
                return;
              }
              callback(err ?? new Error("connect failed"), null);
              return;
            }
            try {
              policy.onConnect?.({ host: target.host, port: target.port, address });
            } catch {
              // observers must not break the connection
            }
            callback(null, socket);
          });
        };
        attempt(0);
      },
      (err: unknown) => {
        callback(err instanceof Error ? err : new Error("resolve failed"), null);
      },
    );
  };

  const agent = new Agent({ connect: connector });

  const safeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const isRequest = typeof input === "object" && input !== null && !(input instanceof URL);
    const rawUrl = isRequest ? (input as Request).url : input instanceof URL ? input.href : input;
    if (typeof rawUrl !== "string") throw new BlockedRequestError("invalid_url", "");
    let current = validateUrl(compiled, rawUrl);

    // Normalise method / headers / body through the platform Request class so
    // every BodyInit type behaves as it does with fetch. The body is buffered,
    // which also lets 307/308 redirects replay it.
    const initForRequest: RequestInit & { duplex?: "half" } = { ...(init ?? {}) };
    if (initForRequest.body !== undefined && initForRequest.body !== null) {
      initForRequest.duplex = "half";
    }
    const request = buildRequest(isRequest ? (input as Request) : current.url.href, initForRequest);
    let method = request.method;
    const redirectMode = request.redirect;
    const callerSignal = request.signal;
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");

    // The time budget starts here, so it covers body buffering and DNS too.
    const internal = new AbortController();
    const signal = AbortSignal.any([callerSignal, internal.signal]);
    let timer: NodeJS.Timeout | undefined;
    if (compiled.timeoutMs > 0) {
      const firstHost = current.target.host;
      timer = setTimeout(() => {
        internal.abort(new SafeFetchTimeoutError(firstHost, compiled.timeoutMs));
      }, compiled.timeoutMs);
      timer.unref?.();
    }
    const finish = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    try {
      let body: Uint8Array | null =
        request.body === null
          ? null
          : await readRequestBody(
              request.body,
              compiled.maxRequestBodyBytes,
              signal,
              current.target.host,
            );

      let redirected = false;
      for (let hop = 0; ; hop++) {
        signal.throwIfAborted();
        await raceAbort(resolveValidated(compiled, current.target), signal);
        signal.throwIfAborted();

        let response: UndiciResponse;
        try {
          response = await undiciFetch(current.url.href, {
            method,
            headers: [...headers.entries()],
            body: body ?? undefined,
            redirect: "manual",
            signal,
            dispatcher: agent,
          });
        } catch (err) {
          throw findOwnError(err) ?? (signal.aborted ? (findOwnError(signal.reason) ?? err) : err);
        }

        const location = response.headers.get("location");
        if (
          REDIRECT_STATUS.has(response.status) &&
          location !== null &&
          redirectMode !== "manual"
        ) {
          await response.body?.cancel().catch(() => undefined);
          if (redirectMode === "error") {
            throw new BlockedRequestError("redirect_not_allowed", current.target.host);
          }
          if (hop >= compiled.maxRedirects) {
            throw new BlockedRequestError("too_many_redirects", current.target.host);
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, current.url);
          } catch {
            throw new BlockedRequestError("invalid_url", current.target.host);
          }
          const next = validateUrl(compiled, nextUrl);
          const crossOrigin = next.url.origin !== current.url.origin;
          if (crossOrigin) {
            // Safelist, not blocklist: only well-known harmless headers (and
            // the caller's explicit allow-list) follow to another origin.
            for (const name of [...headers.keys()]) {
              if (!compiled.redirectHeaders.has(name) || isSensitiveHeader(compiled, name)) {
                headers.delete(name);
              }
            }
          }
          const status = response.status;
          if (
            (status === 303 && method !== "GET" && method !== "HEAD") ||
            ((status === 301 || status === 302) && method === "POST")
          ) {
            method = "GET";
            body = null;
            for (const name of BODY_HEADERS) headers.delete(name);
          }
          if (
            crossOrigin &&
            body !== null &&
            body.byteLength > 0 &&
            !compiled.allowCrossOriginBodyReplay
          ) {
            throw new BlockedRequestError("cross_origin_body_replay", next.target.host);
          }
          current = next;
          redirected = true;
          continue;
        }

        return wrapResponse(response, {
          method,
          url: current.url.href,
          host: current.target.host,
          redirected,
          maxBytes: compiled.maxResponseBytes,
          abort: (reason) => internal.abort(reason),
          finish,
        });
      }
    } catch (err) {
      finish();
      internal.abort();
      throw err;
    }
  };

  return Object.assign(safeFetch, {
    close: async (): Promise<void> => {
      closed = true;
      await agent.close();
    },
  });
}

/** Header names are tokens (RFC 9110); anything else is not echoed. */
function safeHeaderName(name: unknown): string {
  const text = typeof name === "string" ? name : "";
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(text) ? text : "<invalid name>";
}

function headerPairs(init: unknown): Array<[unknown, unknown]> {
  if (init === undefined || init === null) return [];
  if (typeof (init as Iterable<unknown>)[Symbol.iterator] === "function") {
    return [...(init as Iterable<unknown>)].map((pair) =>
      Array.isArray(pair) ? [pair[0], pair[1]] : [undefined, undefined],
    );
  }
  if (typeof init === "object") return Object.entries(init as Record<string, unknown>);
  return [];
}

/**
 * `new Request()` with errors that never include a header value: the platform
 * messages quote the offending value, which may be a credential.
 */
function buildRequest(input: Request | string, init: RequestInit): Request {
  try {
    return new Request(input, init);
  } catch {
    // Find the header that failed, by name only.
    let pairs: Array<[unknown, unknown]> = [];
    try {
      pairs = headerPairs(init.headers);
    } catch {
      pairs = [];
    }
    for (const [name, value] of pairs) {
      try {
        new Headers([[String(name), String(value)]]);
      } catch {
        throw new TypeError(`safe-fetch: invalid request header "${safeHeaderName(name)}"`);
      }
    }
    throw new TypeError("safe-fetch: invalid request (method, headers or body)");
  }
}

/** Reject with the signal's reason as soon as it aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/** Buffer the request body with a hard cap, honouring the abort signal. */
async function readRequestBody(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  host: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await raceAbort(reader.read(), signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new BlockedRequestError("request_too_large", host);
      chunks.push(chunk.value);
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const DECODED_CODINGS = new Set(["gzip", "x-gzip", "deflate", "br"]);

/**
 * Mirrors undici 6's fetch: it decodes the body only when every listed coding
 * is one it knows, and never for HEAD/CONNECT or null-body statuses.
 */
function bodyWasDecoded(method: string, status: number, contentEncoding: string | null): boolean {
  if (contentEncoding === null || contentEncoding.trim() === "") return false;
  if (method === "HEAD" || method === "CONNECT" || NULL_BODY_STATUS.has(status)) return false;
  const codings = contentEncoding.toLowerCase().split(",");
  if (codings.length > 5) return false;
  return codings.every((coding) => DECODED_CODINGS.has(coding.trim()));
}

interface WrapOptions {
  method: string;
  url: string;
  host: string;
  redirected: boolean;
  maxBytes: number;
  abort: (reason: unknown) => void;
  finish: () => void;
}

function wrapResponse(response: UndiciResponse, options: WrapOptions): Response {
  const { maxBytes, host } = options;
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);

  const encoded = bodyWasDecoded(options.method, response.status, headers.get("content-encoding"));
  if (encoded) {
    // undici decoded the body; the original framing headers would lie. An
    // encoding it did not decode is left in place, with its length.
    headers.delete("content-encoding");
    headers.delete("content-length");
  }

  const fail = (err: SafeFetchError): never => {
    options.abort(err);
    options.finish();
    void response.body?.cancel().catch(() => undefined);
    throw err;
  };

  if (!encoded) {
    const declared = Number(headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes && response.body !== null) {
      fail(new ResponseTooLargeError(host, maxBytes));
    }
  }

  let body: ReadableStream<Uint8Array> | null = null;
  if (response.body === null || NULL_BODY_STATUS.has(response.status)) {
    void response.body?.cancel().catch(() => undefined);
    options.finish();
  } else {
    const reader = response.body.getReader();
    let total = 0;
    body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              options.finish();
              controller.close();
              return;
            }
            const value = chunk.value as Uint8Array;
            total += value.byteLength;
            if (total > maxBytes) {
              const err = new ResponseTooLargeError(host, maxBytes);
              options.abort(err);
              options.finish();
              void reader.cancel(err).catch(() => undefined);
              controller.error(err);
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            options.finish();
            controller.error(findOwnError(err) ?? err);
          }
        },
        async cancel(reason) {
          options.finish();
          await reader.cancel(reason).catch(() => undefined);
        },
      },
      { highWaterMark: 0 },
    );
  }

  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  Object.defineProperties(wrapped, {
    url: { value: options.url, enumerable: true },
    redirected: { value: options.redirected, enumerable: true },
  });
  return wrapped;
}
