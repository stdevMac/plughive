// src/core/mounts/manager.ts
//
// One surface over every upstream MCP server the daemon can mount:
//   - pack mounts (declared in a pack.json, switched on by the user, http only),
//   - user mounts (`$PLUGHIVE_HOME/mounts.json`, http or stdio).
//
// listMounts() / setMountEnabled() cover both kinds; addUserMount() and
// removeUserMount() edit the user's file. Ids are `<pack>/<mount id>` for pack
// mounts and `user/<mount id>` for user mounts ("user" is a reserved pack id).
// An OAuth mount (auth "oauth") is signed in to with oauthStart(), which hands
// back the vendor's authorization URL for the user's browser; the callback
// route calls oauthFinish(), which switches the mount on. oauthSignOut()
// forgets the tokens (src/core/mounts/oauth.ts).
// The callers are the daemon's composition root, the authenticated
// /api/mounts routes and the system pack's mount tools
// (src/core/tools/builtin/mounts.ts), whose add_mount writes only after a
// person approved that exact mount in the approvals queue.
import type { MountStatus, PackLoader } from "../packs/loader.js";
import { SECRET_REF_PATTERN, isDeniedSecretName } from "../packs/manifest.js";
import {
  type ConnectableMount,
  type MountProvider,
  type PackMounts,
  urlWithoutQuery,
} from "../packs/mounts.js";
import type { LayeredSecretStore } from "../secrets/index.js";
import {
  type MountOAuth,
  type OAuthFinishResult,
  type OAuthMount,
  oauthSecretNames,
} from "./oauth.js";
import {
  USER_MOUNT_PACK,
  type UserMount,
  type UserMountStore,
  UserMountsError,
  plainHttpSecretProblem,
  userMountSecretRefs,
} from "./user-mounts.js";

export interface MountInfo extends MountStatus {
  /** "pack" for a mount a pack declares, "user" for one from mounts.json. */
  source: "pack" | "user";
  /** stdio only: the program that is started (arguments are not listed). */
  command: string | null;
  connected: boolean;
  /** Tools the upstream currently offers (0 when not connected). */
  tools: number;
  /** Why the last connect failed, or null. Redacted. */
  error: string | null;
  /**
   * OAuth pack mounts only (null otherwise): whether the daemon holds a
   * sign-in, and whether one started from the dashboard is still waiting for
   * the vendor's callback.
   */
  oauth: { signedIn: boolean; pending: boolean } | null;
}

/** Why an OAuth action on a mount was refused. */
export class MountOAuthError extends Error {
  constructor(
    readonly code: "UNKNOWN_MOUNT" | "NOT_OAUTH" | "OAUTH_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "MountOAuthError";
  }
}

interface ManagerLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface MountManagerOptions {
  loader: Pick<PackLoader, "listMounts" | "setMountEnabled" | "resolvedMounts">;
  user: UserMountStore;
  connections: PackMounts;
  secrets: Pick<LayeredSecretStore, "getStored" | "hasStored">;
  logger: ManagerLogger;
  /** Makes an error message safe to log (secrets redacted). */
  redact?: (text: string) => string;
  /** Sign-ins to OAuth mounts. Without it, OAuth actions are refused. */
  oauth?: MountOAuth;
}

/** An upstream error message, safe for the log: tokens and codes are redacted. */
const safeErr = (e: unknown, redact?: (text: string) => string): string => {
  const raw = String((e as Error)?.message ?? e).slice(0, 300);
  return redact ? redact(raw) : raw;
};

const userId = (id: string) => `${USER_MOUNT_PACK}/${id}`;

export class MountManager implements MountProvider {
  constructor(private readonly opts: MountManagerOptions) {}

  /** Connect to exactly the enabled mounts (pack and user). */
  sync(): Promise<void> {
    return this.opts.connections.sync(this);
  }

  stop(): Promise<void> {
    return this.opts.connections.stop();
  }

  /** MountProvider: what should be connected right now, secrets filled in. */
  async resolvedMounts(): Promise<ConnectableMount[]> {
    const fromPacks = refuseOAuthNameClashes(
      await this.opts.loader.resolvedMounts(),
      this.opts.logger,
    );
    const taken = new Set(fromPacks.map((m) => m.prefix));
    const out: ConnectableMount[] = [...fromPacks];
    for (const m of this.opts.user.read().mounts) {
      if (!m.enabled) continue;
      const id = userId(m.id);
      if (taken.has(m.prefix)) {
        this.opts.logger.warn({ mount: id, prefix: m.prefix }, "mount skipped: prefix in use");
        continue;
      }
      if (plainHttpSecretProblem(m)) {
        // Written into mounts.json by hand: /api/mounts refuses it.
        this.opts.logger.warn(
          { mount: id },
          "mount skipped: it would send a secret over plain http",
        );
        continue;
      }
      const values = await this.secretValues(m);
      if (typeof values === "string") {
        this.opts.logger.warn({ mount: id, secret: values }, "mount skipped: secret not set");
        continue;
      }
      const fill = (s: string) =>
        s.replace(SECRET_REF_PATTERN, (_, name: string) => values.get(name) ?? "");
      const fillAll = (rec: Record<string, string> | undefined) =>
        Object.fromEntries(Object.entries(rec ?? {}).map(([k, v]) => [k, fill(v)]));
      taken.add(m.prefix);
      if (m.transport === "stdio") {
        out.push({
          id,
          prefix: m.prefix,
          transport: "stdio",
          command: m.command as string,
          args: (m.args ?? []).map(fill),
          env: fillAll(m.env),
        });
      } else {
        out.push({
          id,
          pack: USER_MOUNT_PACK,
          prefix: m.prefix,
          url: (m.url as string).replace(SECRET_REF_PATTERN, (_, name: string) =>
            encodeURIComponent(values.get(name) ?? ""),
          ),
          headers: fillAll(m.headers),
        });
      }
    }
    return out;
  }

  /** The values a mount needs, or the name of the first one that is missing. */
  private async secretValues(m: UserMount): Promise<Map<string, string> | string> {
    const names = userMountSecretRefs(m);
    const usable = names.filter((n) => !isDeniedSecretName(n));
    // Only what the user stored: a mount never reads the daemon's environment
    // (mounts.json can be written through the API; the shell's variables are
    // not its to hand to a child process or a remote server).
    const values = new Map<string, string>();
    for (const name of names) {
      const value = usable.includes(name) ? await this.opts.secrets.getStored(name) : null;
      if (value === null || value === "") return name;
      values.set(name, value);
    }
    return values;
  }

  async listMounts(): Promise<MountInfo[]> {
    const conn = this.opts.connections;
    const out: MountInfo[] = [];
    for (const m of await this.opts.loader.listMounts()) {
      out.push({
        ...m,
        // Origin and path only: a query string may carry a key.
        url: m.url === null ? null : urlWithoutQuery(m.url),
        source: "pack" as const,
        command: null,
        ...conn.connection(m.id),
        oauth: await this.oauthStatus(m),
      });
    }
    const prefixes = new Set(out.filter((m) => m.enabled).map((m) => m.prefix));
    const state = this.opts.user.read();
    for (const m of state.mounts) {
      const id = userId(m.id);
      const refs = userMountSecretRefs(m);
      const usable = refs.filter((n) => !isDeniedSecretName(n));
      const secrets: { name: string; present: boolean }[] = [];
      for (const name of refs) {
        let present = false;
        try {
          present = usable.includes(name) && (await this.opts.secrets.hasStored(name));
        } catch {
          present = false;
        }
        secrets.push({ name, present });
      }
      const missing = secrets.find((s) => !s.present);
      const clash = prefixes.has(m.prefix);
      const insecure = plainHttpSecretProblem(m);
      out.push({
        id,
        pack: USER_MOUNT_PACK,
        mountId: m.id,
        name: m.name ?? m.id,
        description: m.description ?? null,
        url: m.url ? urlWithoutQuery(m.url) : null,
        transport: m.transport,
        prefix: m.prefix,
        auth: m.transport === "http" ? (m.headers ? "header" : "none") : "none",
        docsUrl: null,
        enabled: m.enabled,
        mountable: !clash && !insecure,
        note: clash
          ? `the prefix "${m.prefix}" is used by another mount`
          : insecure
            ? `not connected: ${insecure.message}`
            : missing
              ? `the secret ${missing.name} is not set`
              : null,
        secrets,
        source: "user",
        command: m.transport === "stdio" ? (m.command ?? null) : null,
        ...conn.connection(id),
        oauth: null,
      });
    }
    return out;
  }

  private async oauthStatus(m: MountStatus): Promise<MountInfo["oauth"]> {
    if (m.auth !== "oauth" || m.transport !== "http" || !m.url) return null;
    const oauth = this.opts.oauth;
    if (!oauth) return { signedIn: false, pending: false };
    let signedIn = false;
    try {
      signedIn = await oauth.signedIn(oauthMountOf(m));
    } catch {
      signedIn = false;
    }
    return { signedIn, pending: oauth.pendingFor(m.id) };
  }

  /** The OAuth pack mount `id`, or a MountOAuthError. */
  private async oauthMount(id: string): Promise<{ oauth: MountOAuth; mount: OAuthMount }> {
    const oauth = this.opts.oauth;
    if (!oauth) throw new MountOAuthError("OAUTH_FAILED", "this daemon cannot sign in to mounts");
    const m = (await this.opts.loader.listMounts()).find((x) => x.id === id);
    if (!m) throw new MountOAuthError("UNKNOWN_MOUNT", `unknown mount: ${id}`);
    if (m.auth !== "oauth" || m.transport !== "http" || !m.url) {
      throw new MountOAuthError("NOT_OAUTH", "this mount does not use OAuth sign-in");
    }
    return { oauth, mount: oauthMountOf(m) };
  }

  /**
   * Begin signing in to an OAuth mount. Returns the vendor's authorization
   * URL, to open in the user's browser.
   */
  async oauthStart(id: string): Promise<string> {
    const { oauth, mount } = await this.oauthMount(id);
    try {
      return (await oauth.start(mount)).authorizationUrl;
    } catch (e) {
      this.opts.logger.warn(
        { mount: id, err: safeErr(e, this.opts.redact) },
        "mount sign-in could not start",
      );
      throw new MountOAuthError(
        "OAUTH_FAILED",
        "the server's sign-in could not be started (no OAuth metadata, or it refused to register plughive)",
      );
    }
  }

  /**
   * The callback leg of a sign-in. On success the mount is switched on and
   * connected with the new tokens.
   */
  async oauthFinish(params: URLSearchParams): Promise<OAuthFinishResult> {
    const oauth = this.opts.oauth;
    if (!oauth) return { ok: false, reason: "invalid_state" };
    const result = await oauth.finish(params);
    if (!result.ok) return result;
    await this.opts.connections.reset(result.mountId);
    try {
      // Persists the switch and calls back into sync().
      await this.opts.loader.setMountEnabled(result.mountId, true);
    } catch (e) {
      this.opts.logger.warn(
        { mount: result.mountId, err: safeErr(e, this.opts.redact) },
        "signed in, but the mount could not be switched on",
      );
      await this.sync();
    }
    return result;
  }

  /** Forget the sign-in of an OAuth mount; it disconnects (the switch stays as it is). */
  async oauthSignOut(id: string): Promise<void> {
    const { oauth, mount } = await this.oauthMount(id);
    await oauth.signOut(mount);
    await this.opts.connections.reset(id);
    await this.sync();
  }

  /** Why mounts.json is not used, or null. */
  userFileError(): string | null {
    return this.opts.user.read().error;
  }

  /** Switch a pack mount or a user mount on or off, then reconnect. */
  async setMountEnabled(id: string, on: boolean): Promise<void> {
    if (id.startsWith(`${USER_MOUNT_PACK}/`)) {
      if (!this.opts.user.setEnabled(id.slice(USER_MOUNT_PACK.length + 1), on)) {
        throw new UserMountsError("UNKNOWN_MOUNT", `unknown mount: ${id}`);
      }
      await this.sync();
      return;
    }
    // The loader persists the switch and calls back into sync().
    await this.opts.loader.setMountEnabled(id, on);
  }

  /** Add a mount to mounts.json. Returns its id (`user/<id>`). */
  async addUserMount(input: unknown): Promise<string> {
    const candidate = (input ?? {}) as { prefix?: unknown };
    if (typeof candidate.prefix === "string") {
      const packMounts = await this.opts.loader.listMounts();
      if (packMounts.some((m) => m.prefix === candidate.prefix)) {
        throw new UserMountsError(
          "MOUNT_EXISTS",
          `the prefix "${candidate.prefix.slice(0, 32)}" is used by a pack mount`,
        );
      }
    }
    const mount = this.opts.user.add(input);
    await this.sync();
    return userId(mount.id);
  }

  /** Remove a mount from mounts.json (`user/<id>` or the bare id). */
  async removeUserMount(id: string): Promise<boolean> {
    const bare = id.startsWith(`${USER_MOUNT_PACK}/`) ? id.slice(USER_MOUNT_PACK.length + 1) : id;
    const removed = this.opts.user.remove(bare);
    if (removed) await this.sync();
    return removed;
  }
}

/**
 * Leave out an OAuth mount whose secret names are the same as an earlier
 * one's: it could read or overwrite that mount's tokens. The names carry a
 * hash of the full mount id, so this is a second line of defence only.
 */
export function refuseOAuthNameClashes<T extends { id: string; oauth?: true }>(
  mounts: T[],
  logger: { warn(obj: Record<string, unknown>, msg: string): void },
  nameOf: (mountId: string) => string = (id) => oauthSecretNames(id).tokens,
): T[] {
  const owners = new Map<string, string>();
  return mounts.filter((m) => {
    if (!m.oauth) return true;
    const name = nameOf(m.id);
    const other = owners.get(name);
    if (other !== undefined && other !== m.id) {
      logger.warn(
        { mount: m.id, other },
        "mount skipped: its sign-in records clash with another mount's",
      );
      return false;
    }
    owners.set(name, m.id);
    return true;
  });
}

function oauthMountOf(m: MountStatus): OAuthMount {
  return { id: m.id, pack: m.pack, prefix: m.prefix, url: m.url as string };
}
