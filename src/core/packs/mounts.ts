// src/core/packs/mounts.ts
//
// Connects upstream MCP servers and exposes their tools as `<prefix>__<tool>`.
// Two kinds of mount reach this module:
//   - http mounts that packs declare and the user switched on (the loader
//     fills in the pack's own secrets),
//   - the user's own mounts from `$PLUGHIVE_HOME/mounts.json`
//     (src/core/mounts), http or stdio.
// A stdio mount starts a process, so only the user's file can describe one:
// the pack loader never yields one, and an MCP tool (add_mount) only proposes
// one; it is written after a person approves it (src/core/tools/builtin/mounts.ts).
//
// Upstream servers are untrusted: the tool list, descriptions and results are
// size-capped, tool names are checked, input schemas are passed on for the
// registry to sanitise, and http requests go to the mount's own origin only
// (no redirects).
//
// Http mounts use the same guarded fetch as `ctx.fetch`: the address is
// classified and the connection is made to the address that was classified,
// link-local and metadata addresses are refused, and so is the daemon's own
// port. A mount a PACK declares can only be a public host. A loopback or LAN
// target is possible only for a mount the user wrote into mounts.json.
//
// A mount with `oauth` (an OAuth mount the user signed in to from the
// dashboard) takes its bearer token from the daemon's sign-in
// (src/core/mounts/oauth.ts). Its OAuth requests (metadata, token refresh)
// may go to the vendor's authorization server on another origin: https
// only, public addresses only, no redirects, small responses.
//
// A connection that drops is reconnected with backoff; a server that
// announces tools/list_changed has its tool list refreshed in place.
import { lookup as dnsLookup } from "node:dns/promises";
import type {
  Client,
  OAuthClientProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadMcpClient, loadMcpStdio, loadedMcpClient } from "../../lib/lazy-mcp-client.js";
import { packageVersion } from "../../lib/version.js";
import { OAuthSignInRequiredError } from "../mounts/oauth.js";
import { parseIPv4, parseIPv6 } from "../net/ip.js";
import {
  type LookupAddress,
  type SafeFetch,
  type SafeFetchPolicy,
  type SafeLookup,
  createSafeFetch,
  isPrivateAddress,
} from "../net/safe-fetch.js";
import type { MountedToolHints, MountedToolSource } from "../tools/registry.js";
import { PACK_MARKER_HEADER, isLinkLocalOrMetadataHost } from "./context.js";
import type { ResolvedMount } from "./loader.js";

/** A user-configured stdio mount, secrets already filled in. */
export interface StdioMount {
  id: string;
  prefix: string;
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type ConnectableMount = ResolvedMount | StdioMount;

function isStdio(m: ConnectableMount): m is StdioMount {
  return (m as StdioMount).transport === "stdio";
}

/** Whoever knows which mounts should be connected right now. */
export interface MountProvider {
  resolvedMounts(): Promise<ConnectableMount[]>;
}

export interface MountConnection {
  connected: boolean;
  tools: number;
  /** Why the last connect failed (redacted), or null. */
  error: string | null;
}

export const MOUNT_MAX_TOOLS = 200;
export const MOUNT_MAX_DESCRIPTION = 2000;
/** Largest upstream HTTP response body accepted (tool lists and results). */
export const MOUNT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** An upstream error message is cut to this many characters (after redaction). */
export const MOUNT_MAX_ERROR_CHARS = 2000;
/** A result nested deeper than this counts as too large. */
const MOUNT_MAX_RESULT_DEPTH = 64;
export const MOUNT_CONNECT_TIMEOUT_MS = 15_000;
export const MOUNT_CALL_TIMEOUT_MS = 5 * 60_000;
/** The status of an OAuth mount nobody has signed in to (or whose sign-in lapsed). */
export const MOUNT_NEEDS_SIGN_IN = "needs sign-in";
/** Largest response an authorization server may send (metadata, tokens). */
export const OAUTH_MAX_RESPONSE_BYTES = 1024 * 1024;
const OAUTH_TIMEOUT_MS = 30_000;
/** Reconnect after a dropped connection: first delay, cap, and attempts. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_ATTEMPTS = 10;

const UPSTREAM_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

interface MountLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface MountedTool {
  qualifiedName: string;
  mountId: string;
  prefix: string;
  upstreamName: string;
  description: string;
  /** Untrusted. The registry sanitises it before it is advertised. */
  inputSchema?: unknown;
  /** The upstream's boolean behaviour hints (untrusted; titles are dropped). */
  hints?: MountedToolHints;
}

interface Session {
  signature: string;
  client: Client;
  tools: MountedTool[];
  /** Releases the mount's pooled connections. */
  dispose: () => Promise<void>;
  /** http only: the resolved url, kept to scrub it out of error messages. */
  url?: string;
}

/** `pack` value of the mounts the user wrote into mounts.json. */
const USER_PACK = "user";

export interface PackMountsOptions {
  logger: MountLogger;
  redact?: (s: string) => string;
  /** Test seam: replaces the guarded transport. The policy checks still run. */
  fetch?: typeof fetch;
  /** Ports the daemon listens on. No mount may point at them on a local address. */
  daemonPorts?: readonly number[];
  /** DNS resolver (tests). Default: the OS resolver, all addresses. */
  lookup?: SafeLookup;
  /** Working directory for stdio mounts. Default: the daemon's. */
  stdioCwd?: string;
  /** The daemon's sign-ins to OAuth mounts. Without it an OAuth mount needs sign-in. */
  oauth?: MountOAuthHooks;
  /** First reconnect delay after a dropped connection (tests). Default 1000 ms. */
  reconnectBaseMs?: number;
}

/** What the connection needs from the OAuth sign-in of a mount. */
export interface MountOAuthHooks {
  /** The provider of the background connection (never starts a sign-in). */
  provider(mount: ResolvedMount): OAuthClientProvider;
  /** True when the store holds tokens for the mount. */
  signedIn(mount: ResolvedMount): Promise<boolean>;
}

export class MountPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountPolicyError";
  }
}

const bareHost = (host: string): string =>
  host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

function isLocalLiteral(host: string): boolean {
  const h = bareHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return (parseIPv4(h) !== null || parseIPv6(h) !== null) && isPrivateAddress(h);
}

/**
 * The safe-fetch policy for one http mount. Throws MountPolicyError for a
 * target no mount may have. `local` is granted only to user-authored mounts.
 */
export function mountFetchPolicy(
  mount: Pick<ResolvedMount, "pack" | "url">,
  opts: { daemonPorts?: readonly number[]; lookup?: SafeLookup } = {},
): SafeFetchPolicy {
  let url: URL;
  try {
    url = new URL(mount.url);
  } catch {
    throw new MountPolicyError("the mount url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MountPolicyError("the mount url must be http(s)");
  }
  const host = bareHost(url.hostname);
  const port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
  const daemonPorts = opts.daemonPorts ?? [];
  const userAuthored = mount.pack === USER_PACK;
  if (isLinkLocalOrMetadataHost(host)) {
    throw new MountPolicyError("link-local and cloud metadata addresses are never reachable");
  }
  if (daemonPorts.includes(port) && isLocalLiteral(host)) {
    throw new MountPolicyError("a mount cannot point at the plughive daemon itself");
  }
  if (!userAuthored && isLocalLiteral(host)) {
    throw new MountPolicyError(
      "a pack's mount cannot point at this machine or the local network; add it as your own mount instead",
    );
  }
  const baseLookup: SafeLookup =
    opts.lookup ??
    (async (hostname: string): Promise<LookupAddress[]> =>
      (await dnsLookup(hostname, { all: true })) as LookupAddress[]);
  const authority = `${url.hostname.toLowerCase()}:${port}`;
  return {
    allowHosts: [authority],
    // What the user typed may be on this machine or the LAN. A pack's mount
    // never gets this, so a name that resolves to a private address fails.
    ...(userAuthored ? { allowLocal: [authority] } : {}),
    allowedProtocols: [url.protocol],
    maxRedirects: 0,
    maxResponseBytes: MOUNT_MAX_RESPONSE_BYTES,
    // MCP streams are long-lived; the MCP client carries its own timeouts.
    timeoutMs: 0,
    lookup: async (hostname) => {
      const addrs = await baseLookup(hostname);
      if (addrs.some((a) => isLinkLocalOrMetadataHost(a.address))) {
        throw new MountPolicyError("the mount host resolves to a link-local or metadata address");
      }
      if (daemonPorts.includes(port) && addrs.some((a) => isPrivateAddress(a.address))) {
        throw new MountPolicyError("a mount cannot point at the plughive daemon itself");
      }
      return addrs;
    },
  };
}

/**
 * Throws, naming the header but never its value (which may be a credential),
 * when a mount's configured headers are not valid HTTP headers.
 */
function checkMountHeaders(headers: Record<string, string> | undefined): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]]);
    } catch {
      const shown = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ? name : "<invalid name>";
      throw new MountPolicyError(`the mount header "${shown}" is not a valid HTTP header`);
    }
  }
}

/** Adds the header that marks a request as made on behalf of a pack or mount. */
function withMarker(base: typeof fetch, pack: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    let headers: Headers;
    try {
      headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    } catch {
      // The platform message quotes the offending value.
      throw new TypeError("mount request has an invalid header");
    }
    headers.set(PACK_MARKER_HEADER, pack);
    return base(input, { ...init, headers });
  }) as typeof fetch;
}

function policyMessage(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 6; depth++) {
    if (cur instanceof MountPolicyError) return cur.message;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** A url without its query and fragment (a template or a resolved url). */
export function urlWithoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0] as string;
}

/**
 * Removes a remote mount's resolved url from a message, and the query and
 * fragment of any http(s) url in it: a mount may carry its API key in the
 * query string (Browserbase does), so errors, logs and status show the
 * origin and path at most.
 */
export function scrubMountUrls(message: string, url?: string): string {
  let out = message;
  if (url) {
    const variants = new Set<string>([url]);
    try {
      const u = new URL(url);
      variants.add(u.href);
      if (u.search) variants.add(u.search);
      if (u.search.length > 1) {
        variants.add(u.search.slice(1));
        for (const [, value] of u.searchParams) {
          if (value.length >= 4) {
            variants.add(value);
            variants.add(encodeURIComponent(value));
          }
        }
      }
    } catch {
      // Not a URL: the generic pass below still applies.
    }
    // Longest first, so a whole url goes before the query inside it.
    for (const v of [...variants].sort((a, b) => b.length - a.length)) {
      if (v)
        out = out
          .split(v)
          .join(v === url || v.startsWith("http") ? urlWithoutQuery(url) : "[redacted]");
    }
  }
  return out.replace(/\bhttps?:\/\/[^\s"'<>()]+/gi, (m) => urlWithoutQuery(m));
}

/** Fetch confined to one origin, no redirects, response body capped. */
export function confinedFetch(origin: string, base: typeof fetch = fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) {
      throw new Error(`mount request to another origin refused: ${url.origin}`);
    }
    return capResponse(await base(input, { ...init, redirect: "error" }), MOUNT_MAX_RESPONSE_BYTES);
  }) as typeof fetch;
}

/** The response with its body capped at `max` bytes. */
async function capResponse(res: Response, max: number): Promise<Response> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error("mount response too large");
  }
  if (!res.body) return res;
  let seen = 0;
  const capped = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > max) {
          ctl.error(new Error("mount response too large"));
          return;
        }
        ctl.enqueue(chunk);
      },
    }),
  );
  return new Response(capped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** An OAuth mount that cannot connect until the user signs in (again). */
class NeedsSignInError extends Error {
  constructor() {
    super(MOUNT_NEEDS_SIGN_IN);
    this.name = "NeedsSignInError";
  }
}

function needsSignIn(e: unknown): boolean {
  const sdk = loadedMcpClient();
  for (let cur: unknown = e, depth = 0; cur && depth < 6; depth++) {
    if (
      cur instanceof NeedsSignInError ||
      (sdk !== undefined && cur instanceof sdk.UnauthorizedError) ||
      // The vendor refused the refresh token and the SDK went for a new
      // sign-in, which only the dashboard can start.
      cur instanceof OAuthSignInRequiredError
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** C0/C1 controls except tab and newline, and the bidi/invisible formatting marks. */
const HIDDEN_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters stripped
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Keep what a client can show from an untrusted tool list. */
export function sanitizeUpstreamTools(
  mount: Pick<ResolvedMount, "id" | "prefix">,
  tools: readonly {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    annotations?: unknown;
  }[],
): MountedTool[] {
  const out: MountedTool[] = [];
  const seen = new Set<string>();
  for (const t of tools) {
    if (out.length >= MOUNT_MAX_TOOLS) break;
    const name = typeof t.name === "string" ? t.name : "";
    if (!UPSTREAM_TOOL_NAME.test(name) || name.includes("__") || seen.has(name)) continue;
    seen.add(name);
    // Control and bidirectional-override characters can hide or reorder text
    // a person reads in a client; they never belong in a description.
    const raw = typeof t.description === "string" ? t.description.replace(HIDDEN_CHARS, "") : "";
    out.push({
      qualifiedName: `${mount.prefix}__${name}`,
      mountId: mount.id,
      prefix: mount.prefix,
      upstreamName: name,
      description:
        raw.length > MOUNT_MAX_DESCRIPTION ? `${raw.slice(0, MOUNT_MAX_DESCRIPTION)}...` : raw,
      ...(t.inputSchema !== undefined ? { inputSchema: t.inputSchema } : {}),
      hints: upstreamHints(t.annotations),
    });
  }
  return out;
}

const HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** The boolean hints of an upstream tool's annotations; anything else is dropped. */
function upstreamHints(raw: unknown): MountedToolHints {
  const out: MountedToolHints = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of HINT_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export class PackMounts implements MountedToolSource {
  private sessions = new Map<string, Session>();
  private errors = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly redact: (s: string) => string;
  /** The provider of the last sync: what a reconnect syncs against. */
  private lastProvider: MountProvider | null = null;
  /** Mounts whose connection dropped and is being re-established. */
  private retries = new Map<string, { attempt: number; timer: NodeJS.Timeout | null }>();

  constructor(private readonly opts: PackMountsOptions) {
    this.redact = opts.redact ?? ((s) => s);
  }

  /**
   * Connect to exactly the provider's mounts. A mount whose settings did not
   * change keeps its session (a stdio process is not restarted for nothing);
   * a mount that failed last time is tried again. Calls run one at a time.
   */
  sync(provider: MountProvider): Promise<void> {
    const run = this.queue.then(() => this.syncNow(provider));
    this.queue = run.catch(() => {});
    return run;
  }

  private async syncNow(provider: MountProvider): Promise<void> {
    this.lastProvider = provider;
    const wanted = new Map<string, ConnectableMount>();
    // First mount wins a prefix, in the provider's order: two mounts sharing
    // a prefix would expose the same `<prefix>__<tool>` names and silently
    // shadow each other, so the later one is refused here, deterministically.
    const prefixes = new Map<string, string>();
    const skipped = new Map<string, string>();
    for (const m of await provider.resolvedMounts()) {
      if (wanted.has(m.id)) continue;
      const owner = prefixes.get(m.prefix);
      if (owner !== undefined && owner !== m.id) {
        this.opts.logger.warn(
          { mount: m.id, prefix: m.prefix, other: owner },
          "mount skipped: its prefix is used by another mount",
        );
        skipped.set(m.id, `the prefix "${m.prefix}" is used by another mount`);
        continue;
      }
      prefixes.set(m.prefix, m.id);
      wanted.set(m.id, m);
    }
    const closing: Promise<void>[] = [];
    for (const [id, s] of this.sessions) {
      const next = wanted.get(id);
      if (next && JSON.stringify(next) === s.signature) continue;
      this.sessions.delete(id);
      closing.push(closeSession(s));
    }
    await Promise.all(closing);
    for (const id of [...this.errors.keys()]) if (!wanted.has(id)) this.errors.delete(id);
    for (const id of [...this.retries.keys()]) if (!wanted.has(id)) this.clearRetry(id);
    for (const [id, reason] of skipped) this.errors.set(id, reason);
    await Promise.all(
      [...wanted.values()].filter((m) => !this.sessions.has(m.id)).map((m) => this.connect(m)),
    );
  }

  stop(): Promise<void> {
    for (const id of [...this.retries.keys()]) this.clearRetry(id);
    this.lastProvider = null;
    const run = this.queue.then(async () => {
      const all = [...this.sessions.values()];
      this.sessions.clear();
      this.errors.clear();
      await Promise.all(all.map(closeSession));
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Drop one mount's connection and status (after a sign-in or sign-out):
   * the next sync connects it afresh.
   */
  reset(mountId: string): Promise<void> {
    this.clearRetry(mountId);
    const run = this.queue.then(async () => {
      const s = this.sessions.get(mountId);
      this.sessions.delete(mountId);
      this.errors.delete(mountId);
      if (s) await closeSession(s);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Connection state of one mount id (pack mounts and user mounts alike). */
  connection(mountId: string): MountConnection {
    const s = this.sessions.get(mountId);
    return {
      connected: s !== undefined,
      tools: s?.tools.length ?? 0,
      error: this.errors.get(mountId) ?? null,
    };
  }

  list(): MountedTool[] {
    return [...this.sessions.values()].flatMap((s) => s.tools);
  }

  has(mountId: string): boolean {
    return this.sessions.has(mountId);
  }

  async call(
    mountId: string,
    upstreamName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const s = this.sessions.get(mountId);
    if (!s) throw new Error(`mount not connected: ${mountId}`);
    if (!s.tools.some((t) => t.upstreamName === upstreamName)) {
      throw new Error(`mount ${mountId} has no tool ${upstreamName}`);
    }
    let result: unknown;
    try {
      result = await s.client.callTool(
        { name: upstreamName, arguments: args },
        { timeout: MOUNT_CALL_TIMEOUT_MS },
      );
    } catch (e) {
      if (needsSignIn(e)) {
        // The sign-in lapsed (refresh refused): the mount is off until the
        // user signs in again.
        if (this.sessions.get(mountId) === s) {
          this.sessions.delete(mountId);
          this.errors.set(mountId, MOUNT_NEEDS_SIGN_IN);
          void closeSession(s);
        }
        throw new Error(`mount ${mountId}: ${MOUNT_NEEDS_SIGN_IN}`);
      }
      throw new Error(
        this.redact(scrubMountUrls(`mount ${mountId}: ${(e as Error).message}`, s.url)).slice(
          0,
          MOUNT_MAX_ERROR_CHARS,
        ),
      );
    }
    // The http transport caps the response body; a stdio server has no such
    // limit, so the result itself is measured, whatever the transport.
    if (resultBytes(result) > MOUNT_MAX_RESPONSE_BYTES) {
      throw new Error(`mount ${mountId}: the result is too large`);
    }
    return result;
  }

  /**
   * The fetch an OAuth mount uses, for its MCP requests and its OAuth ones.
   * Requests to the mount's own origin take the mount's guarded, confined
   * fetch. Requests elsewhere (the vendor's authorization server) must be
   * https to a public address, without redirects, with a small response.
   */
  oauthFetch(mount: Pick<ResolvedMount, "pack" | "url">): {
    fetch: typeof fetch;
    close(): Promise<void>;
  } {
    const policy = mountFetchPolicy(mount, {
      ...(this.opts.daemonPorts ? { daemonPorts: this.opts.daemonPorts } : {}),
      ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
    });
    const origin = new URL(mount.url).origin;
    let guarded: SafeFetch | null = null;
    let external: SafeFetch | null = null;
    if (!this.opts.fetch) {
      guarded = createSafeFetch(policy);
      external = createSafeFetch({
        allowHosts: ["*"],
        allowedProtocols: ["https:"],
        maxRedirects: 0,
        maxResponseBytes: OAUTH_MAX_RESPONSE_BYTES,
        timeoutMs: OAUTH_TIMEOUT_MS,
        lookup: policy.lookup as SafeLookup,
      });
    }
    const own = confinedFetch(
      origin,
      withMarker((this.opts.fetch ?? guarded) as typeof fetch, mount.pack),
    );
    const other = (this.opts.fetch ?? external) as typeof fetch;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin === origin) return own(input, init);
      if (target.protocol !== "https:") {
        throw new MountPolicyError("the authorization server must use https");
      }
      const host = bareHost(target.hostname);
      if (isLinkLocalOrMetadataHost(host) || isLocalLiteral(host)) {
        throw new MountPolicyError("the authorization server must be a public host");
      }
      return capResponse(
        await other(input, { ...init, redirect: "error" }),
        OAUTH_MAX_RESPONSE_BYTES,
      );
    }) as typeof fetch;
    return {
      fetch: f,
      close: async () => {
        await guarded?.close().catch(() => {});
        await external?.close().catch(() => {});
      },
    };
  }

  private async connect(mount: ConnectableMount): Promise<void> {
    const { Client, StreamableHTTPClientTransport } = await loadMcpClient();
    const client = new Client(
      { name: "plughive", version: packageVersion() },
      {
        versionNegotiation: { mode: "auto" },
        // Skipped by the SDK when the server does not announce list changes.
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error || !tools) return;
              const s = this.sessions.get(mount.id);
              if (!s || s.client !== client) return;
              s.tools = sanitizeUpstreamTools(mount, tools);
              this.opts.logger.info(
                { mount: mount.id, tools: s.tools.length },
                "mount tools changed",
              );
            },
          },
        },
      },
    );
    let closeFetch: (() => Promise<void>) | null = null;
    const dispose = async (): Promise<void> => {
      await closeFetch?.().catch(() => {});
    };
    try {
      let transport: StreamableHTTPClientTransport | StdioClientTransport;
      if (isStdio(mount)) {
        // The child gets a minimal environment plus what the user configured
        // for this mount: never the daemon's own environment.
        const { StdioClientTransport, getDefaultEnvironment } = await loadMcpStdio();
        transport = new StdioClientTransport({
          command: mount.command,
          args: mount.args,
          env: { ...getDefaultEnvironment(), ...mount.env },
          stderr: "ignore",
          ...(this.opts.stdioCwd ? { cwd: this.opts.stdioCwd } : {}),
        });
      } else if (mount.oauth) {
        const hooks = this.opts.oauth;
        if (!hooks || !(await hooks.signedIn(mount))) throw new NeedsSignInError();
        checkMountHeaders(mount.headers);
        const url = new URL(mount.url);
        const f = this.oauthFetch(mount);
        closeFetch = f.close;
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: mount.headers },
          fetch: f.fetch,
          authProvider: hooks.provider(mount),
        });
      } else {
        const policy = mountFetchPolicy(mount, {
          ...(this.opts.daemonPorts ? { daemonPorts: this.opts.daemonPorts } : {}),
          ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
        });
        checkMountHeaders(mount.headers);
        const url = new URL(mount.url);
        let guarded: SafeFetch | null = null;
        if (!this.opts.fetch) {
          guarded = createSafeFetch(policy);
          const g = guarded;
          closeFetch = () => g.close();
        }
        const base = this.opts.fetch ?? (guarded as SafeFetch);
        transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: mount.headers },
          fetch: confinedFetch(url.origin, withMarker(base as typeof fetch, mount.pack)),
        });
      }
      await client.connect(transport, { timeout: MOUNT_CONNECT_TIMEOUT_MS });
      const { tools } = await client.listTools(undefined, { timeout: MOUNT_CONNECT_TIMEOUT_MS });
      const mounted = sanitizeUpstreamTools(mount, Array.isArray(tools) ? tools : []);
      this.sessions.set(mount.id, {
        signature: JSON.stringify(mount),
        client,
        tools: mounted,
        dispose,
        ...(isStdio(mount) ? {} : { url: mount.url }),
      });
      this.errors.delete(mount.id);
      this.clearRetry(mount.id);
      client.onclose = () => this.onLost(mount.id, client);
      client.onerror = (err) => {
        this.opts.logger.warn(
          {
            mount: mount.id,
            err: this.redact(
              scrubMountUrls(String(err?.message ?? err), isStdio(mount) ? undefined : mount.url),
            ).slice(0, 500),
          },
          "mount connection error",
        );
      };
      this.opts.logger.info({ mount: mount.id, tools: mounted.length }, "mount connected");
    } catch (e) {
      await client.close().catch(() => {});
      await dispose();
      if (needsSignIn(e)) {
        this.errors.set(mount.id, MOUNT_NEEDS_SIGN_IN);
        this.clearRetry(mount.id);
        this.opts.logger.info({ mount: mount.id }, "mount needs sign-in");
        return;
      }
      const policy = policyMessage(e);
      const raw = policy ?? (e as Error).message;
      const err = this.redact(scrubMountUrls(raw, isStdio(mount) ? undefined : mount.url)).slice(
        0,
        500,
      );
      this.errors.set(mount.id, err);
      this.opts.logger.warn({ mount: mount.id, err }, "mount connect failed");
      // A reconnect that failed is tried again later; a policy refusal never.
      if (this.retries.has(mount.id)) {
        if (policy) this.clearRetry(mount.id);
        else this.scheduleReconnect(mount.id);
      }
    }
  }

  /** The connection of a live session closed without us closing it. */
  private onLost(mountId: string, client: Client): void {
    const s = this.sessions.get(mountId);
    if (!s || s.client !== client) return;
    this.sessions.delete(mountId);
    void s.dispose();
    this.errors.set(mountId, "connection lost; reconnecting");
    this.opts.logger.warn({ mount: mountId }, "mount connection lost");
    this.scheduleReconnect(mountId);
  }

  private scheduleReconnect(mountId: string): void {
    const r = this.retries.get(mountId) ?? { attempt: 0, timer: null };
    this.retries.set(mountId, r);
    if (r.timer) return;
    if (r.attempt >= RECONNECT_ATTEMPTS) {
      this.errors.set(
        mountId,
        `${this.errors.get(mountId) ?? "connection lost"} (gave up reconnecting; switch the mount off and on to retry)`.slice(
          0,
          500,
        ),
      );
      return;
    }
    const base = this.opts.reconnectBaseMs ?? RECONNECT_BASE_MS;
    const delay = Math.min(base * 2 ** r.attempt, RECONNECT_MAX_MS);
    r.attempt += 1;
    r.timer = setTimeout(() => {
      r.timer = null;
      const provider = this.lastProvider;
      if (provider) void this.sync(provider).catch(() => {});
    }, delay);
    r.timer.unref?.();
  }

  private clearRetry(mountId: string): void {
    const r = this.retries.get(mountId);
    if (r?.timer) clearTimeout(r.timer);
    this.retries.delete(mountId);
  }
}

async function closeSession(s: Session): Promise<void> {
  await s.client.close().catch(() => {});
  await s.dispose();
}

/**
 * Serialized size of a tool result, stopping early once it is clearly too
 * large. A result nested too deep counts as too large (no deep recursion).
 */
function resultBytes(value: unknown): number {
  let total = 0;
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (total > MOUNT_MAX_RESPONSE_BYTES) return;
    if (typeof v === "string") total += Buffer.byteLength(v);
    else if (v === null || typeof v !== "object") total += 8;
    else if (depth > MOUNT_MAX_RESULT_DEPTH) total = Number.POSITIVE_INFINITY;
    else if (!seen.has(v)) {
      seen.add(v);
      if (Array.isArray(v)) for (const item of v) walk(item, depth + 1);
      else {
        for (const [k, item] of Object.entries(v)) {
          total += k.length;
          walk(item, depth + 1);
        }
      }
    }
  };
  walk(value, 0);
  return total;
}

/** One MountedToolSource over several. */
export function combineMountSources(...sources: (MountedToolSource | null)[]): MountedToolSource {
  const live = sources.filter((s): s is MountedToolSource => s !== null);
  return {
    list: () => {
      const seen = new Set<string>();
      return live.flatMap((s) =>
        s.list().filter((t) => {
          if (seen.has(t.qualifiedName)) return false;
          seen.add(t.qualifiedName);
          return true;
        }),
      );
    },
    call: (mountId, upstream, args) => {
      const owner = live.find((s) => s.list().some((t) => t.mountId === mountId));
      if (!owner) return Promise.reject(new Error(`mount not connected: ${mountId}`));
      return owner.call(mountId, upstream, args);
    },
  };
}
