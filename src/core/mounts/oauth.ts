// src/core/mounts/oauth.ts
//
// MCP OAuth for the mounts a pack declares with `auth: "oauth"`: the daemon
// is the OAuth client. Sign-in runs in the user's browser, started from the
// dashboard:
//
//   1. start(): discovery (protected-resource and authorization-server
//      metadata), dynamic client registration with the redirect
//      http://127.0.0.1:<port>/oauth/callback, PKCE, and an authorization URL
//      that carries a fresh `state`.
//   2. The user approves at the vendor, who redirects to /oauth/callback.
//   3. finish(): the state must be one start() handed out, not used before,
//      not expired; it names the mount. The code is exchanged for tokens.
//
// Everything is kept in the daemon's secret store (the Keychain, the OS
// keyring or the encrypted file), as JSON under four names per mount:
//
//   OAUTH_<ID>_<HASH>_TOKENS     access and refresh token
//   OAUTH_<ID>_<HASH>_CLIENT     the client registration (client_id, ...)
//   OAUTH_<ID>_<HASH>_VERIFIER   the PKCE verifier of the sign-in in flight
//   OAUTH_<ID>_<HASH>_DISCOVERY  the authorization server found at sign-in
//
// <ID> is the full mount id ("<pack>/<mount>") made readable (upper case,
// anything else turned into "_", at most 32 characters); <HASH> is the first
// 12 hex digits of the SHA-256 of the exact id. Two mounts whose readable
// parts agree ("my-app" and "my_app", or long ids with the same start) still
// get different names, and a mount whose names would collide with another
// one's anyway is refused (MountOAuth.claim, MountManager.resolvedMounts).
//
// The OAUTH_ prefix is denied to packs and user mounts (manifest.ts), so no
// pack can declare, read or overwrite these names, and /api/secrets does not
// list them. Each record names the mount id and url it belongs to: a record
// written for another mount or another server url is treated as absent.
//
// Token strings are registered with the store's redactor, so they never reach
// a log or an error message.
import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { loadMcpClient } from "../../lib/lazy-mcp-client.js";
import { isPrivateAddress, parseIPv4, parseIPv6 } from "../net/ip.js";
import type { LayeredSecretStore } from "../secrets/index.js";

/** The parts of a mount the OAuth flow needs. */
export interface OAuthMount {
  id: string;
  pack: string;
  prefix: string;
  url: string;
}

export type OAuthStore = Pick<LayeredSecretStore, "getStored" | "set" | "delete" | "redactor"> &
  Partial<Pick<LayeredSecretStore, "hasStored">>;

/** Two mounts whose OAuth secret names are the same: the second is refused. */
export class OAuthNameCollisionError extends Error {
  constructor(
    readonly mountId: string,
    readonly otherMountId: string,
  ) {
    super(`mount ${mountId}: its sign-in records would share names with mount ${otherMountId}`);
    this.name = "OAuthNameCollisionError";
  }
}

/**
 * The mount has no usable sign-in (none yet, or the vendor refused the
 * refresh token): the user has to sign in from the dashboard.
 */
export class OAuthSignInRequiredError extends Error {
  constructor() {
    super("no sign-in in progress");
    this.name = "OAuthSignInRequiredError";
  }
}

/** Path of the redirect endpoint on the daemon. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";
/** How long a sign-in started from the dashboard may take. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** At most this many sign-ins in flight (all mounts together). */
const MAX_PENDING = 32;

export interface OAuthSecretNames {
  tokens: string;
  client: string;
  verifier: string;
  discovery: string;
}

/**
 * The secret names that hold one mount's sign-in, from its full id
 * ("<pack>/<mount>"). The longest is 6 + 32 + 1 + 12 + 10 = 61 characters,
 * inside the store's 64.
 */
export function oauthSecretNames(mountId: string): OAuthSecretNames {
  const readable = mountId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .slice(0, 32);
  const hash = createHash("sha256")
    .update(mountId, "utf8")
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  const p = `${readable}_${hash}`;
  return {
    tokens: `OAUTH_${p}_TOKENS`,
    client: `OAUTH_${p}_CLIENT`,
    verifier: `OAUTH_${p}_VERIFIER`,
    discovery: `OAUTH_${p}_DISCOVERY`,
  };
}

/** The url a record is bound to: no query, no fragment. */
function boundUrl(url: string): string {
  return url.split(/[?#]/, 1)[0] as string;
}

interface StoredRecord<T> {
  v: 1;
  mount: string;
  url: string;
  data: T;
}

type Kind = keyof OAuthSecretNames;

/** Reads and writes one mount's OAuth records. */
class MountOAuthRecords {
  readonly names: OAuthSecretNames;
  constructor(
    private readonly mount: OAuthMount,
    private readonly store: OAuthStore,
  ) {
    this.names = oauthSecretNames(mount.id);
  }

  async read<T>(kind: Kind): Promise<T | undefined> {
    const raw = await this.store.getStored(this.names[kind]);
    if (!raw) return undefined;
    try {
      const rec = JSON.parse(raw) as StoredRecord<T>;
      if (
        rec?.v !== 1 ||
        rec.mount !== this.mount.id ||
        rec.url !== boundUrl(this.mount.url) ||
        rec.data === undefined
      ) {
        return undefined;
      }
      return rec.data;
    } catch {
      return undefined;
    }
  }

  async write<T>(kind: Kind, data: T): Promise<void> {
    const rec: StoredRecord<T> = {
      v: 1,
      mount: this.mount.id,
      url: boundUrl(this.mount.url),
      data,
    };
    await this.store.set(this.names[kind], JSON.stringify(rec));
  }

  async remove(kind: Kind): Promise<void> {
    await this.store.delete(this.names[kind]);
  }
}

/** Registers the secret strings inside a token or client record. */
function registerSecrets(store: OAuthStore, values: Record<string, unknown> | undefined): void {
  if (!values) return;
  for (const key of [
    "access_token",
    "refresh_token",
    "id_token",
    "client_secret",
    "registration_access_token",
  ]) {
    const v = values[key];
    if (typeof v === "string" && v.length >= 4) store.redactor.register(v);
  }
}

interface ClientRecord {
  info: StoredOAuthClientInformation;
  /** The redirect URL the client was registered with. */
  redirectUrl: string;
}

export interface MountOAuthProviderOptions {
  mount: OAuthMount;
  store: OAuthStore;
  redirectUrl: string;
  /**
   * true for a sign-in the user started (it may register a client and build
   * an authorization URL). false for the background connection: it uses what
   * the store holds, refreshes tokens, and never starts a sign-in.
   */
  interactive: boolean;
  /** The `state` the authorization URL carries (interactive only). */
  state?: string;
  /** Receives the authorization URL (interactive only). */
  onRedirect?: (url: URL) => void;
}

/**
 * The SDK's OAuthClientProvider over the daemon's secret store, for one
 * mount. A public client (PKCE, no client secret of its own; a secret the
 * server hands out at registration is kept and used).
 */
export class MountOAuthProvider implements OAuthClientProvider {
  private readonly records: MountOAuthRecords;

  constructor(private readonly opts: MountOAuthProviderOptions) {
    this.records = new MountOAuthRecords(opts.mount, opts.store);
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "plughive",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    if (!this.opts.state) throw new OAuthSignInRequiredError();
    return this.opts.state;
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const rec = await this.records.read<ClientRecord>("client");
    if (!rec?.info?.client_id) return undefined;
    // A sign-in needs a client registered for the redirect it will use (the
    // daemon's port may have changed): otherwise register a new one.
    if (this.opts.interactive && rec.redirectUrl !== this.opts.redirectUrl) return undefined;
    registerSecrets(this.opts.store, rec.info as unknown as Record<string, unknown>);
    return rec.info;
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    registerSecrets(this.opts.store, info as unknown as Record<string, unknown>);
    await this.records.write<ClientRecord>("client", { info, redirectUrl: this.opts.redirectUrl });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    const t = await this.records.read<StoredOAuthTokens>("tokens");
    if (!t?.access_token) return undefined;
    registerSecrets(this.opts.store, t as unknown as Record<string, unknown>);
    return t;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    registerSecrets(this.opts.store, tokens as unknown as Record<string, unknown>);
    // A refresh response may leave out the refresh token: keep the old one.
    let next = tokens;
    if (!tokens.refresh_token) {
      const prev = await this.records.read<StoredOAuthTokens>("tokens");
      if (prev?.refresh_token) next = { ...tokens, refresh_token: prev.refresh_token };
    }
    await this.records.write("tokens", next);
  }

  redirectToAuthorization(url: URL): void {
    if (this.opts.interactive) this.opts.onRedirect?.(url);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    // The background connection never starts a sign-in: it must not replace
    // the verifier of one the user has in flight.
    if (!this.opts.interactive) return;
    this.opts.store.redactor.register(verifier);
    await this.records.write("verifier", verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await this.records.read<string>("verifier");
    if (typeof v !== "string" || v === "") throw new OAuthSignInRequiredError();
    // Reloaded from the store (a restarted daemon): registered again, so it
    // never reaches a log or an error message.
    this.opts.store.redactor.register(v);
    return v;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.records.write("discovery", state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.records.read<OAuthDiscoveryState>("discovery");
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const kinds: Kind[] =
      scope === "all" ? ["tokens", "client", "verifier", "discovery"] : [scope as Kind];
    for (const k of kinds) await this.records.remove(k);
  }
}

/** A fetch for the OAuth requests of one mount, and how to release it. */
export interface OAuthFetch {
  fetch: typeof fetch;
  close(): Promise<void>;
}

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MountOAuthOptions {
  store: OAuthStore;
  /** The redirect URL handed to the authorization server. Settable later. */
  redirectUrl?: () => string;
  /** The guarded fetch for one mount's discovery, registration and tokens. */
  fetchFor: (mount: OAuthMount) => OAuthFetch;
  logger: Logger;
  /** Clock (tests). */
  now?: () => number;
  /** Lifetime of a sign-in's state. Default OAUTH_STATE_TTL_MS. */
  ttlMs?: number;
  /** Ports the daemon itself listens on; no authorization page may point at them. */
  daemonPorts?: readonly number[];
}

/** Why a callback did not complete a sign-in. Never carries upstream text. */
export type OAuthFinishFailure = "invalid_state" | "expired" | "denied" | "failed";

export type OAuthFinishResult =
  | { ok: true; mountId: string }
  | { ok: false; reason: OAuthFinishFailure; mountId?: string };

interface Pending {
  mount: OAuthMount;
  redirectUrl: string;
  expiresAt: number;
}

export class OAuthStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStartError";
  }
}

const isLoopbackHost = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
};

/** True for a literal loopback or private IP address (never a hostname). */
const isLocalAddressLiteral = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h)) return true;
  return (parseIPv4(h) !== null || parseIPv6(h) !== null) && isPrivateAddress(h);
};

const portOf = (url: URL): number => Number(url.port || (url.protocol === "https:" ? 443 : 80));

/** Sign-in, callback and sign-out for every OAuth mount. */
export class MountOAuth {
  private readonly pending = new Map<string, Pending>();
  /** The mount each set of secret names was handed to. */
  private readonly owners = new Map<string, string>();
  private redirect: () => string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly daemonPorts: ReadonlySet<number>;

  constructor(private readonly opts: MountOAuthOptions) {
    this.redirect = opts.redirectUrl ?? (() => "http://127.0.0.1:7777/oauth/callback");
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? OAUTH_STATE_TTL_MS;
    this.daemonPorts = new Set(opts.daemonPorts ?? []);
  }

  /**
   * May the browser be sent to this authorization page? https anywhere, and a
   * local address only when the mount itself is on this machine — and never
   * on a port the daemon listens on, where the browser would land on the
   * daemon instead of the vendor.
   */
  private authorizationUrlAllowed(url: URL, mount: OAuthMount): boolean {
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (!isLocalAddressLiteral(url.hostname)) return url.protocol === "https:";
    let mountHost: string;
    try {
      mountHost = new URL(mount.url).hostname;
    } catch {
      return false;
    }
    if (!isLoopbackHost(mountHost)) return false;
    return !this.daemonPorts.has(portOf(url));
  }

  /** Where the authorization server sends the browser back to. */
  setRedirectUrl(fn: () => string): void {
    this.redirect = fn;
  }

  redirectUrl(): string {
    return this.redirect();
  }

  /**
   * Bind a mount's secret names to it. Throws OAuthNameCollisionError when
   * another mount already holds the same names (never expected: the names
   * carry a hash of the full id), so one mount can never read or overwrite
   * another's tokens.
   */
  claim(mount: OAuthMount): OAuthSecretNames {
    const names = oauthSecretNames(mount.id);
    const owner = this.owners.get(names.tokens);
    if (owner !== undefined && owner !== mount.id) {
      throw new OAuthNameCollisionError(mount.id, owner);
    }
    this.owners.set(names.tokens, mount.id);
    return names;
  }

  /** The provider the background connection of a mount uses. */
  provider(mount: OAuthMount): MountOAuthProvider {
    this.claim(mount);
    return new MountOAuthProvider({
      mount,
      store: this.opts.store,
      redirectUrl: this.redirect(),
      interactive: false,
    });
  }

  /** True when the store holds tokens for this mount. */
  async signedIn(mount: OAuthMount): Promise<boolean> {
    // Most mounts were never signed in: a presence check (cheap; the keychain
    // answers it from its index) skips the full read, which on macOS is one
    // `security` process per mount on every dashboard refresh.
    const { tokens } = this.claim(mount);
    if (this.opts.store.hasStored && !(await this.opts.store.hasStored(tokens))) return false;
    return (await this.provider(mount).tokens()) !== undefined;
  }

  /** True while a sign-in started for this mount may still complete. */
  pendingFor(mountId: string): boolean {
    this.prune();
    for (const p of this.pending.values()) if (p.mount.id === mountId) return true;
    return false;
  }

  /**
   * Begin a sign-in: discovery, client registration when needed, PKCE. Returns
   * the URL to open in the user's browser.
   */
  async start(mount: OAuthMount): Promise<{ authorizationUrl: string }> {
    this.claim(mount);
    this.prune();
    for (const [s, p] of this.pending) if (p.mount.id === mount.id) this.pending.delete(s);
    if (this.pending.size >= MAX_PENDING) {
      throw new OAuthStartError("too many sign-ins in progress; finish or retry later");
    }
    const state = randomBytes(32).toString("base64url");
    const redirectUrl = this.redirect();
    let captured: URL | null = null;
    const provider = new MountOAuthProvider({
      mount,
      store: this.opts.store,
      redirectUrl,
      interactive: true,
      state,
      onRedirect: (u) => {
        captured = u;
      },
    });
    const f = this.opts.fetchFor(mount);
    try {
      const { auth } = await loadMcpClient();
      const result = await auth(provider, {
        serverUrl: mount.url,
        fetchFn: f.fetch,
        forceReauthorization: true,
      });
      const url = captured as URL | null;
      if (result !== "REDIRECT" || !url) {
        throw new OAuthStartError("the server did not ask for a sign-in");
      }
      if (!this.authorizationUrlAllowed(url, mount)) {
        throw new OAuthStartError(
          "the authorization server's sign-in page is not allowed: it must be https, and a local address only for a local mount on a port the daemon does not use",
        );
      }
      if (url.searchParams.get("state") !== state) {
        throw new OAuthStartError("the authorization URL does not carry the sign-in state");
      }
      this.pending.set(state, { mount, redirectUrl, expiresAt: this.now() + this.ttlMs });
      this.opts.logger.info({ mount: mount.id }, "mount sign-in started");
      return { authorizationUrl: url.href };
    } finally {
      await f.close().catch(() => {});
    }
  }

  /**
   * Complete a sign-in from the callback's query. The state is single-use: it
   * is consumed whatever the outcome.
   */
  async finish(params: URLSearchParams): Promise<OAuthFinishResult> {
    const state = params.get("state") ?? "";
    const entry = state ? this.pending.get(state) : undefined;
    if (!entry) return { ok: false, reason: "invalid_state" };
    this.pending.delete(state);
    const mountId = entry.mount.id;
    if (this.now() > entry.expiresAt) return { ok: false, reason: "expired", mountId };
    const records = new MountOAuthRecords(entry.mount, this.opts.store);
    if (params.has("error")) {
      await records.remove("verifier").catch(() => {});
      this.opts.logger.info({ mount: mountId }, "mount sign-in declined");
      return { ok: false, reason: "denied", mountId };
    }
    const code = params.get("code");
    if (!code) return { ok: false, reason: "failed", mountId };
    this.opts.store.redactor.register(code);
    const provider = new MountOAuthProvider({
      mount: entry.mount,
      store: this.opts.store,
      redirectUrl: entry.redirectUrl,
      interactive: true,
    });
    const f = this.opts.fetchFor(entry.mount);
    try {
      const iss = params.get("iss");
      const { auth } = await loadMcpClient();
      const result = await auth(provider, {
        serverUrl: entry.mount.url,
        authorizationCode: code,
        ...(iss ? { iss } : {}),
        fetchFn: f.fetch,
      });
      if (result !== "AUTHORIZED") return { ok: false, reason: "failed", mountId };
      return { ok: true, mountId };
    } catch (e) {
      const err = this.opts.store.redactor.redact(String((e as Error)?.message ?? e)).slice(0, 300);
      this.opts.logger.warn({ mount: mountId, err }, "mount sign-in failed");
      return { ok: false, reason: "failed", mountId };
    } finally {
      await records.remove("verifier").catch(() => {});
      await f.close().catch(() => {});
    }
  }

  /** Forget the mount's tokens, client registration and any sign-in in flight. */
  async signOut(mount: OAuthMount): Promise<void> {
    this.claim(mount);
    for (const [s, p] of this.pending) if (p.mount.id === mount.id) this.pending.delete(s);
    const records = new MountOAuthRecords(mount, this.opts.store);
    for (const k of ["tokens", "client", "verifier", "discovery"] as const) {
      await records.remove(k);
    }
    this.opts.logger.info({ mount: mount.id }, "mount signed out");
  }

  private prune(): void {
    const t = this.now();
    for (const [s, p] of this.pending) if (t > p.expiresAt) this.pending.delete(s);
  }
}
