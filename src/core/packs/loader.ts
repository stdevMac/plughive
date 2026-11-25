// src/core/packs/loader.ts
//
// Discovers packs, validates their manifests, builds each pack's scoped
// context, runs the entry module and registers what it contributes.
//
// Sources, in load order (earlier wins nothing: a later duplicate FAILS):
//   1. built-in packs: <repo>/packs/<id>/pack.json, enabled by default
//   2. user packs: $PLUGHIVE_HOME/packs/<id>/pack.json, DISABLED until enabled
// The user's choices live in $PLUGHIVE_HOME/packs.json (mode 0600).
//
// TRUST MODEL, stated plainly: permissions in pack.json are least privilege at
// the API level (what the PackContext lets a pack do). They are NOT an OS
// sandbox. A code pack runs inside the daemon process and could import
// node:fs or node:child_process itself. Built-in packs are reviewed code and
// get the secrets they declare. A user pack stays disabled until the user has
// seen what it declares (`describeConsent`) and enabled it, naming the secrets
// it may read (`enable(id, { grants })`). That consent is pinned to a hash of
// the whole manifest and of every file in the pack folder (size-capped; a
// symlink anywhere in the folder refuses the pack): when either changes the
// pack is NOT loaded ("needs-review") until the user enables it again.
// A user pack never runs from its own folder: the folder is copied to
// $PLUGHIVE_HOME/pack-snapshots/<id>/<hash>, the COPY is hashed and compared
// with the consent, and the copy is what gets imported. So the code that runs
// is the code that was hashed, and every helper module is fresh per hash.
//
// Packs may also serve capability providers (definePack({ providers })).
// They are registered with the capability router next to the pack's tools
// and run with the pack's own context.
//
// A pack that throws, or hangs past the deadline, while loading is marked
// failed and the daemon keeps running.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { atomicReplaceSync, writeFileAtomicSync } from "../../lib/platform.js";
import type { CapabilityRouter, ProviderBinding } from "../capabilities/router.js";
import { UnsafePathError, resolveInside } from "../fs/safe-path.js";
import {
  type AnyProviderDefinition,
  type AnyToolDefinition,
  type PackContext,
  type PackDefinition,
  type PackFactory,
  type PackServices,
  packApi,
} from "../pack-api.js";
import { MissingSecretError } from "../secrets/index.js";
import {
  type RegisteredTool,
  ReservedToolNameError,
  type ToolRegistry,
  isReservedToolName,
  toolInputJsonSchema,
} from "../tools/registry.js";
import { loadWorkflows } from "../workflows/index.js";
import {
  type PackHost,
  PackPermissionError,
  type ScopedPackContext,
  createPackContext,
  isLinkLocalOrMetadataHost,
  localEndpointEntry,
  spawnRootEntry,
} from "./context.js";
import {
  ManifestError,
  type MountDecl,
  PACK_API_VERSION,
  type PackManifest,
  type PackSource,
  SECRET_REF_PATTERN,
  SETTING_LIST_ITEM_MAX_CHARS,
  SETTING_LIST_MAX_ITEMS,
  isBundledOnlySecretName,
  isDeniedSecretName,
  isHighRiskBinary,
  parseManifestText,
  secretNameAllowed,
  toolNameProblem,
} from "./manifest.js";

/** Secret names a mount references through `${secret:NAME}`. */
export function mountSecretRefs(mount: MountDecl): string[] {
  const values = [
    mount.url ?? "",
    ...Object.values(mount.headers ?? {}),
    ...Object.values(mount.env ?? {}),
    ...(mount.args ?? []),
  ];
  const out = new Set<string>();
  for (const v of values) for (const m of v.matchAll(SECRET_REF_PATTERN)) out.add(m[1] ?? "");
  return [...out];
}

/** An enabled http mount with its `${secret:...}` references filled in. Host-only. */
export interface ResolvedMount {
  /** `<pack>/<mount id>`. */
  id: string;
  pack: string;
  prefix: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Present (true) on a mount that signs in with MCP OAuth: the connection
   * takes its token from the daemon's sign-in (src/core/mounts/oauth.ts).
   */
  oauth?: true;
}

export type { PackSource };
export type PackState = "disabled" | "loaded" | "failed" | "invalid" | "needs-review";

export interface PackSecretStatus {
  name: string;
  label?: string;
  helpUrl?: string;
  required: boolean;
  /** Whether this pack may read the secret (built-in: declared; user pack: granted). */
  granted: boolean;
  /** Whether a value is configured. Only reported for granted names; never the value. */
  present: boolean;
}

export interface PackReview {
  /** What the user consented to last time. Empty when the pack was never reviewed. */
  previous: string[];
  /** What the pack declares now. */
  current: string[];
  /** The manifest's security-relevant parts changed. */
  manifestChanged: boolean;
  /** The entry file changed. */
  entryChanged: boolean;
}

export interface PackStatus {
  id: string;
  name: string | null;
  version: string | null;
  /** The manifest's one-line description. */
  description: string | null;
  /** Terms or caveats to read before turning the pack on (manifest `notice`). */
  notice: string | null;
  source: PackSource;
  enabled: boolean;
  state: PackState;
  error: string | null;
  tools: string[];
  /** Capability providers the pack serves, `<capability>:<id>`. */
  providers: string[];
  secrets: PackSecretStatus[];
  permissions: PackManifest["permissions"] | null;
  skills: string[];
  workflows: string[];
  /** Recipes of the workflows folder that did not load (the others did). */
  workflowErrors: { name: string; error: string }[];
  mounts: string[];
  /** Set while state is "needs-review". */
  review: PackReview | null;
}

export type ConsentRisk = "normal" | "high";

export interface ConsentItem {
  kind:
    | "entry"
    | "secret"
    | "network"
    | "localNetwork"
    | "endpoint"
    | "folders"
    | "spawn"
    | "library"
    | "llm"
    | "userHome"
    | "tools"
    | "mount";
  /** One human-readable line. */
  text: string;
  risk: ConsentRisk;
}

/** One secret a pack asks for, with what granting it would hand over. */
export interface ConsentSecret {
  name: string;
  label?: string;
  required: boolean;
  granted: boolean;
  /** False when a pack of this source can never be granted this name. */
  grantable: boolean;
  /** A value of this name is already stored: granting it hands that value to this pack. */
  stored: boolean;
  /** Other packs that declare the same name (the value is theirs too). */
  declaredBy: string[];
  /** The name is a well-known credential of another tool or provider. */
  wellKnown: boolean;
  /** Plain sentences for the consent screen; empty when nothing stands out. */
  warnings: string[];
}

export interface PackConsent {
  id: string;
  name: string;
  version: string;
  source: PackSource;
  /** Everything the pack asks for, one line each, high-risk items flagged. */
  items: ConsentItem[];
  /** `items` as plain lines ("[high-risk] ..." prefix where flagged); stored with the consent. */
  summary: string[];
  highRisk: boolean;
  /**
   * The pack ships code (an `entry`). That code runs inside the daemon with
   * the user's full rights: `items` describe what the daemon mediates
   * (ctx.fetch, ctx.spawn, ctx.files, secrets), not a sandbox.
   */
  runsCode: boolean;
  /** Secrets the user may grant by name. */
  secrets: ConsentSecret[];
  manifestHash: string;
  entryHash: string;
  /** Present when an earlier consent exists and no longer matches. */
  review: PackReview | null;
}

export interface PackSkill {
  pack: string;
  name: string;
  path: string;
}

export interface PackMount {
  pack: string;
  source: PackSource;
  mount: MountDecl;
}

/** One declared mount with the user's switch (listMounts). */
export interface MountStatus {
  /** `<pack>/<mount id>`: what setMountEnabled takes. */
  id: string;
  pack: string;
  mountId: string;
  name: string;
  description: string | null;
  url: string | null;
  transport: MountDecl["transport"];
  prefix: string;
  auth: NonNullable<MountDecl["auth"]> | "unknown";
  docsUrl: string | null;
  enabled: boolean;
  /** False for mounts that cannot be connected (not http, or the pack is not loaded). */
  mountable: boolean;
  /** Why the mount cannot be switched on, when it cannot. */
  note: string | null;
  /** Secret names the mount uses (never values) and whether each is set. */
  secrets: { name: string; present: boolean }[];
}

export interface PackLoaderOptions {
  /** $PLUGHIVE_HOME: holds packs.json, packs/ and pack-data/. */
  home: string;
  registry: ToolRegistry;
  /** Daemon services. `host.daemonPorts` carries the daemon's own port(s). */
  host: PackHost;
  /** Default: <repo>/packs (dist/packs when built). */
  builtinDir?: string;
  /** Default: $PLUGHIVE_HOME/packs. */
  userDir?: string;
  /**
   * Daemon-supplied setting values per pack id, applied over packs.json
   * (compatibility for settings that used to come from env vars).
   */
  settingsOverrides?: Record<string, Record<string, unknown>>;
  /** Deadline for one pack's import + setup() + tools(). Default 10000 ms. */
  loadTimeoutMs?: number;
  /** How long in-flight calls of an unloading pack may finish before they are aborted. Default 5000 ms. */
  unloadGraceMs?: number;
  /** Test seam for module loading. */
  importModule?: (href: string) => Promise<unknown>;
  /** Capability router: pack providers are registered here. Without it, providers are ignored. */
  capabilities?: CapabilityRouter;
  /** Called after a mount is switched on or off (the host reconnects mounts). */
  onMountsChanged?: () => void | Promise<void>;
}

export interface EnableOptions {
  /** Secret names (declared by the pack) the user lets it read. User packs only. */
  grants?: readonly string[];
  /**
   * The hashes the user reviewed (from describeConsent). When given, a user
   * pack is enabled only if what is on disk at the moment the consent is
   * recorded still has these hashes; otherwise PackChangedError.
   */
  expected?: { manifestHash: string; entryHash: string };
}

/** The pack on disk is not the one the user reviewed. */
export class PackChangedError extends Error {
  constructor(id: string) {
    super(`pack "${id}" changed since it was reviewed; review it again`);
    this.name = "PackChangedError";
  }
}

interface PersistedConsent {
  manifestHash: string;
  entryHash: string;
  summary: string[];
  at: string;
}

interface PersistedPackState {
  enabled?: boolean;
  settings?: Record<string, unknown>;
  grants?: string[];
  consent?: PersistedConsent;
}

interface PersistedState {
  version: 1;
  packs: Record<string, PersistedPackState>;
  /** `<pack>/<mount id>` -> switched on. Absent: the mount's enabledByDefault. */
  mounts?: Record<string, boolean>;
}

interface Candidate {
  id: string;
  source: PackSource;
  dir: string;
  manifest: PackManifest | null;
  error: string | null;
}

interface Inflight {
  count: number;
  waiters: (() => void)[];
}

interface LoadedPack {
  scoped: ScopedPackContext | null;
  definition: PackDefinition | null;
  registered: RegisteredTool[];
  tools: string[];
  /** Capability providers, `<capability>:<id>`. */
  providers: string[];
  providerBindings: ProviderBinding[];
  skills: PackSkill[];
  workflows: string[];
  workflowErrors: { name: string; error: string }[];
  inflight: Inflight;
  /** User packs: the snapshot folder this instance was imported from. */
  runDir?: string;
}

interface Entry extends Candidate {
  enabled: boolean;
  state: PackState;
  loaded: LoadedPack | null;
  review: PackReview | null;
  /** User packs: the verified snapshot the pack is imported from. */
  runDir?: string;
}

/** <repo>/packs in dev (src/core/packs -> ../../../packs), dist/packs when built. */
export function defaultBuiltinPacksDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../packs");
}

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;
const DEFAULT_UNLOAD_GRACE_MS = 5_000;
/** Entry file -> hash of the content first imported under its plain URL. */
const IMPORTED_ENTRY_HASH = new Map<string, string>();

const CTX_KEYS = new Set([
  "pack",
  "secrets",
  "settings",
  "fetch",
  "spawn",
  "library",
  "llm",
  "tools",
  "capabilities",
  "logger",
  "signal",
  "progress",
]);

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const PACK_HASH_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const PACK_HASH_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const PACK_HASH_MAX_FILES = 2000;

/** Thrown when a pack folder cannot be hashed (symlink, too big, unreadable). */
export class PackHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackHashError";
  }
}

/** Never part of a pack: version control data and Finder's folder metadata. */
const NOT_PACK_CONTENT = new Set([".git", ".DS_Store"]);

/**
 * Every file under `dir` (relative, sorted), `pack.json` at the top excluded:
 * the manifest has its own hash. A symlink or any other non-regular file is
 * refused: what it points to could change without the folder changing.
 */
function packFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const d of readdirSync(current, { withFileTypes: true })) {
      if (NOT_PACK_CONTENT.has(d.name)) continue;
      const full = join(current, d.name);
      const rel = relative(dir, full).split("\\").join("/");
      if (d.isSymbolicLink())
        throw new PackHashError(`the pack folder contains a symlink (${rel})`);
      if (d.isDirectory()) {
        walk(full);
        continue;
      }
      if (!d.isFile()) throw new PackHashError(`${rel} is not a regular file`);
      if (rel === "pack.json") continue;
      files.push(rel);
      if (files.length > PACK_HASH_MAX_FILES) {
        throw new PackHashError(
          `the pack folder has more than ${PACK_HASH_MAX_FILES} files; a pack this large cannot be reviewed`,
        );
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** Size checks shared by hashing and copying. Returns the running total. */
function checkedSize(dir: string, rel: string, total: number): number {
  const st = lstatSync(join(dir, rel));
  if (st.isSymbolicLink() || !st.isFile()) throw new PackHashError(`${rel} is not a regular file`);
  if (st.size > PACK_HASH_MAX_FILE_BYTES) {
    throw new PackHashError(`${rel} is larger than ${PACK_HASH_MAX_FILE_BYTES} bytes`);
  }
  const next = total + st.size;
  if (next > PACK_HASH_MAX_TOTAL_BYTES) {
    throw new PackHashError(`the pack folder is larger than ${PACK_HASH_MAX_TOTAL_BYTES} bytes`);
  }
  return next;
}

/**
 * sha256 over every file under `dir` (relative path + content, sorted): code,
 * skills, workflows, native addons, data. Bounded in file count and size.
 */
export function packFolderHash(dir: string): string {
  const h = createHash("sha256");
  let total = 0;
  for (const rel of packFiles(dir)) {
    total = checkedSize(dir, rel, total);
    const content = readFileSync(join(dir, rel));
    if (content.length > PACK_HASH_MAX_FILE_BYTES) {
      throw new PackHashError(`${rel} is larger than ${PACK_HASH_MAX_FILE_BYTES} bytes`);
    }
    h.update(`${rel}\0${content.length}\0`);
    h.update(content);
  }
  return h.digest("hex");
}

/** Copy what packFolderHash covers (plus pack.json) from `src` into the new folder `dest`. */
export function copyPackFolder(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  let total = 0;
  const files = packFiles(src);
  if (existsSync(join(src, "pack.json"))) files.push("pack.json");
  for (const rel of files) {
    total = checkedSize(src, rel, total);
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(join(src, rel), to);
    // Keep the executable bit, drop everything group and world.
    chmodSync(to, lstatSync(join(src, rel)).mode & 0o700);
  }
}

/** Setting keys declared with `format: "local-endpoint"`. */
export function endpointSettings(m: PackManifest): string[] {
  return Object.entries(m.settings?.properties ?? {})
    .filter(([, p]) => p.format === "local-endpoint")
    .map(([k]) => k)
    .sort();
}

/** Setting keys declared with `format: "folder-list"`. */
export function folderListSettings(m: PackManifest): string[] {
  return Object.entries(m.settings?.properties ?? {})
    .filter(([, p]) => p.format === "folder-list")
    .map(([k]) => k)
    .sort();
}

/**
 * The folders a pack's children may work in, from its folder-list settings.
 * Pass the values the user saved (not settings with manifest defaults
 * applied); the manifest schema also refuses a non-empty folder-list default.
 * An entry that fails the checks is skipped (and reported through `warn`),
 * so a folder deleted later does not stop the pack from loading.
 */
export function spawnRootsFromSettings(
  m: PackManifest,
  settings: Readonly<Record<string, unknown>>,
  plugHiveHome: string,
  warn: (key: string, message: string) => void,
): string[] {
  const roots: string[] = [];
  for (const key of folderListSettings(m)) {
    const value = settings[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "string" || item.trim() === "") continue;
      try {
        const root = spawnRootEntry(item, plugHiveHome);
        if (!roots.includes(root)) roots.push(root);
      } catch (e) {
        warn(key, (e as Error).message);
      }
    }
  }
  return roots;
}

/** JSON with object keys sorted at every level (arrays keep their order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/**
 * Hash of the manifest the user consents to: all of it, since the consent
 * screen shows its words too (name, description, secret labels and links).
 * Lists that are sets (hosts, binaries) are sorted, so only a real change counts.
 */
export function manifestConsentHash(m: PackManifest): string {
  const p = m.permissions;
  return sha256(
    JSON.stringify({
      whole: canonicalJson({ ...m, permissions: undefined }),
      apiVersion: m.apiVersion,
      entry: m.entry ?? null,
      secrets: m.secrets.map((s) => [s.name, s.required]).sort(),
      permissions: {
        network: [...p.network].sort(),
        localNetwork: [...p.localNetwork].sort(),
        spawn: [...p.spawn].sort(),
        library: p.library,
        llm: p.llm,
        // Only when asked for, so manifests reviewed before this permission
        // existed keep their hash.
        ...(p.userHome ? { userHome: true } : {}),
        tools: [...p.tools].sort(),
      },
      mounts: m.mounts
        .map((x) => ({
          id: x.id,
          transport: x.transport,
          url: x.url ?? null,
          command: x.command ?? null,
          args: x.args ?? [],
          headers: Object.entries(x.headers ?? {}).sort(),
          env: Object.entries(x.env ?? {}).sort(),
          prefix: x.prefix,
          enabledByDefault: x.enabledByDefault,
          auth: x.auth ?? null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      // Settings that widen localNetwork are part of what the user consents to.
      endpoints: endpointSettings(m),
      // So are folders the pack's programs may work in (only when declared,
      // so existing manifests keep their hash).
      ...(folderListSettings(m).length > 0 ? { folders: folderListSettings(m) } : {}),
    }),
  );
}

/** Everything a pack asks for, as lines a person can review. */
export function consentItems(m: PackManifest): ConsentItem[] {
  const items: ConsentItem[] = [];
  const p = m.permissions;
  if (m.entry !== undefined) {
    items.push({
      kind: "entry",
      text: `runs its own code (${m.entry}) inside the daemon process; the permissions below are not an OS sandbox`,
      risk: "high",
    });
  }
  for (const s of m.secrets) {
    items.push({
      kind: "secret",
      text: `may read the secret ${s.name}${s.label ? ` (${s.label})` : ""} if you grant it`,
      risk: "normal",
    });
  }
  for (const h of p.network) {
    items.push({
      kind: "network",
      text: h === "*" ? "may call ANY public host" : `may call ${h}`,
      risk: h === "*" ? "high" : "normal",
    });
  }
  for (const h of p.localNetwork) {
    const host = h.slice(0, Math.max(0, h.lastIndexOf(":")));
    items.push({
      kind: "localNetwork",
      text: isLinkLocalOrMetadataHost(host)
        ? `asks for ${h} on your machine or LAN (link-local/metadata: always refused)`
        : `may call ${h} on your machine or LAN`,
      risk: "high",
    });
  }
  for (const key of endpointSettings(m)) {
    items.push({
      kind: "endpoint",
      text: `may call the local service you set in the setting "${key}" (loopback or LAN only; never the daemon's port, link-local or metadata addresses)`,
      risk: "high",
    });
  }
  for (const key of folderListSettings(m)) {
    items.push({
      kind: "folders",
      text: `may run its programs inside the folders you list in the setting "${key}" (they can read and change files there)`,
      risk: "high",
    });
  }
  for (const b of p.spawn) {
    const high = isHighRiskBinary(b);
    items.push({
      kind: "spawn",
      text: high
        ? `may run "${b}", a shell, interpreter or remote-access tool: this amounts to running arbitrary programs`
        : `may run the program "${b}"`,
      risk: high ? "high" : "normal",
    });
  }
  if (p.library !== "none") {
    const what: Record<string, string> = {
      read: "may read artifacts it created",
      "read-all": "may read EVERY artifact in the library",
      write: "may save artifacts and read the ones it created",
      full: "may save artifacts and read EVERY artifact in the library",
    };
    items.push({
      kind: "library",
      text: what[p.library] ?? `library: ${p.library}`,
      risk: p.library === "read-all" || p.library === "full" ? "high" : "normal",
    });
  }
  if (p.llm) {
    items.push({ kind: "llm", text: "may use your LLM provider (costs money)", risk: "normal" });
  }
  if (p.userHome && p.spawn.length > 0) {
    items.push({
      kind: "userHome",
      text: "the programs it runs see your real home folder (your dotfiles, such as ~/.ssh), not a private one",
      risk: "high",
    });
  }
  for (const t of p.tools) {
    items.push({
      kind: "tools",
      text: t.startsWith("pack:")
        ? `may call every tool of the pack "${t.slice(5)}"`
        : t.startsWith("cap:")
          ? `may call whichever tool provides the capability "${t.slice(4)}"`
          : `may call the tool "${t}"`,
      risk: "normal",
    });
  }
  for (const mount of m.mounts) {
    // Header names only: the values may hold ${secret:...} references.
    const headerNames = Object.keys(mount.headers ?? {}).sort();
    const headersNote =
      headerNames.length > 0 ? `, sending the headers ${headerNames.join(", ")}` : "";
    items.push({
      kind: "mount",
      text:
        mount.transport === "stdio"
          ? `declares the MCP server "${mount.id}" that RUNS the program "${mount.command}" on this machine (started only when you switch the mount on)`
          : mount.auth === "oauth"
            ? `declares the MCP server "${mount.id}" at ${mount.url} (OAuth: connected only after you sign in to it from the dashboard)`
            : `declares the MCP server "${mount.id}" at ${mount.url}${headersNote} (connected only when you switch the mount on)`,
      risk: mount.transport === "stdio" ? "high" : "normal",
    });
  }
  return items;
}

const summaryLines = (items: readonly ConsentItem[]) =>
  items.map((i) => (i.risk === "high" ? `[high-risk] ${i.text}` : i.text));

/** A settings value the pack's schema does not accept. */
export class PackSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackSettingsError";
  }
}

class LoadTimeoutError extends Error {
  constructor(ms: number) {
    super(`loading took longer than ${ms} ms (import, setup() or tools())`);
    this.name = "LoadTimeoutError";
  }
}

export class PackLoader {
  private readonly entries = new Map<string, Entry>();
  private readonly builtinDir: string;
  private readonly userDir: string;
  private readonly statePath: string;
  private readonly loadTimeoutMs: number;
  private readonly unloadGraceMs: number;
  private readonly retiring = new Set<Promise<void>>();
  // Process-wide, like the module cache it works around.
  private readonly importedHash = IMPORTED_ENTRY_HASH;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: PackLoaderOptions) {
    this.builtinDir = opts.builtinDir ?? defaultBuiltinPacksDir();
    this.userDir = opts.userDir ?? join(opts.home, "packs");
    this.statePath = join(opts.home, "packs.json");
    const t = opts.loadTimeoutMs;
    this.loadTimeoutMs =
      typeof t === "number" && Number.isFinite(t) && t > 0 ? t : DEFAULT_LOAD_TIMEOUT_MS;
    const g = opts.unloadGraceMs;
    this.unloadGraceMs =
      typeof g === "number" && Number.isFinite(g) && g >= 0 ? g : DEFAULT_UNLOAD_GRACE_MS;
  }

  /** Discover and load every pack. Safe to call again (reloads everything). */
  loadAll(): Promise<void> {
    return this.serial(() => this.doLoadAll());
  }

  /**
   * What enabling this pack means: every permission as a readable line, with
   * shells, interpreters, stdio mounts and library-wide access flagged
   * high-risk. Reads pack.json fresh from disk.
   */
  describeConsent(id: string): Promise<PackConsent> {
    return this.serial(async () => {
      const entry = this.refresh(id);
      if (!entry.manifest) throw new Error(`pack "${id}" has an invalid manifest: ${entry.error}`);
      const m = entry.manifest;
      const persisted = this.readState().packs[id];
      const items = consentItems(m);
      const grants = new Set(persisted?.grants ?? []);
      const hashes = this.hashes(entry);
      const secrets: ConsentSecret[] = [];
      for (const s of m.secrets) {
        const grantable = secretNameAllowed(s.name, entry.source);
        let stored = false;
        try {
          stored = await this.opts.host.store.hasStored(s.name);
        } catch {
          stored = false;
        }
        const declaredBy = [...this.entries.values()]
          .filter((e) => e.id !== id && e.manifest?.secrets.some((o) => o.name === s.name))
          .map((e) => e.id)
          .sort();
        const wellKnown = isBundledOnlySecretName(s.name);
        const warnings: string[] = [];
        if (entry.source === "user") {
          if (!grantable) {
            warnings.push(
              `${s.name} is a well-known credential of another tool; a user pack cannot be granted it.`,
            );
          }
          if (declaredBy.length > 0) {
            warnings.push(
              `${s.name} is also the key of: ${declaredBy.join(", ")}. Granting it lets this pack use that key.`,
            );
          }
          if (stored) {
            warnings.push(
              `A value for ${s.name} is already stored. Granting it hands that existing value to this pack.`,
            );
          }
        }
        secrets.push({
          name: s.name,
          ...(s.label !== undefined ? { label: s.label } : {}),
          required: s.required,
          granted: grantable && (entry.source === "builtin" || grants.has(s.name)),
          grantable,
          stored,
          declaredBy,
          wellKnown,
          warnings,
        });
      }
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        source: entry.source,
        items,
        summary: summaryLines(items),
        highRisk: items.some((i) => i.risk === "high"),
        runsCode: m.entry !== undefined,
        secrets,
        manifestHash: hashes.manifestHash,
        entryHash: hashes.entryHash,
        review: entry.source === "user" ? this.reviewOf(entry, persisted, hashes, items) : null,
      };
    });
  }

  /**
   * Enable one pack. For a user pack this records the user's consent to what
   * the pack declares RIGHT NOW (manifest + folder hash) and the secrets it
   * may read; with `expected`, only if that is still what the user reviewed.
   * Only this pack is (re)loaded.
   */
  enable(id: string, options: EnableOptions = {}): Promise<void> {
    return this.serial(async () => {
      const entry = this.refresh(id);
      const state = this.readState();
      const next: PersistedPackState = { ...state.packs[id], enabled: true };
      if (entry.source === "user") {
        if (!entry.manifest)
          throw new Error(`pack "${id}" has an invalid manifest: ${entry.error}`);
        const declared = new Set(entry.manifest.secrets.map((s) => s.name));
        const grants = [...new Set(options.grants ?? [])];
        for (const g of grants) {
          if (typeof g !== "string" || !declared.has(g) || isDeniedSecretName(g)) {
            throw new Error(
              `cannot grant a secret the pack "${id}" does not declare (grants must be names from its pack.json)`,
            );
          }
          if (!secretNameAllowed(g, entry.source)) {
            throw new Error(
              `cannot grant ${g} to the pack "${id}": it is a well-known credential of another tool, which a user pack may not read`,
            );
          }
        }
        const hashes = this.hashes(entry);
        if (!/^[0-9a-f]{64}$/.test(hashes.entryHash)) {
          // "unhashable:..." names the problem (a symlink, a folder too large);
          // anything else means the folder could not be hashed at all. Either
          // way there is no verified copy to consent to, so the pack stays off.
          throw new Error(
            `pack "${id}" cannot be enabled: ${
              hashes.entryHash.startsWith("unhashable:")
                ? hashes.entryHash.slice(11)
                : "the pack folder could not be hashed"
            }`,
          );
        }
        // Compared here, inside the serial section, against the very hashes
        // that are recorded below: nothing can change in between.
        const expected = options.expected;
        if (
          expected &&
          (expected.manifestHash !== hashes.manifestHash || expected.entryHash !== hashes.entryHash)
        ) {
          throw new PackChangedError(id);
        }
        next.grants = grants;
        next.consent = {
          ...hashes,
          summary: summaryLines(consentItems(entry.manifest)),
          at: new Date().toISOString(),
        };
      }
      state.packs[id] = next;
      this.writeState(state);
      entry.enabled = true;
      await this.reloadEntry(entry, state);
    });
  }

  /** Disable one pack. Only this pack is unloaded; consent and grants are kept. */
  disable(id: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`unknown pack: ${id}`);
      const state = this.readState();
      state.packs[id] = { ...state.packs[id], enabled: false };
      this.writeState(state);
      entry.enabled = false;
      this.unloadEntry(entry);
      if (entry.manifest) {
        entry.state = "disabled";
        entry.error = null;
        entry.review = null;
      }
    });
  }

  /** Reload one pack from disk (new code is built before the old one is swapped out). */
  reload(id: string): Promise<void> {
    return this.serial(async () => {
      const entry = this.refresh(id);
      await this.reloadEntry(entry, this.readState(), true);
    });
  }

  /**
   * The settings schema a pack declares and the values in effect (defaults,
   * then what the user stored). Settings are not secrets.
   */
  getSettings(id: string): {
    schema: PackManifest["settings"] | null;
    values: Record<string, unknown>;
  } {
    const entry = this.entries.get(id);
    if (!entry?.manifest) throw new Error(`unknown pack: ${id}`);
    const stored = this.readState().packs[id]?.settings ?? {};
    const values: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(entry.manifest.settings?.properties ?? {})) {
      if (prop.default !== undefined) values[key] = prop.default;
      if (!(key in stored)) continue;
      values[key] = stored[key];
      if (prop.type === "array") {
        // A list stored as one comma-separated string (before lists existed)
        // is shown as the list the pack receives.
        try {
          values[key] = settingList(key, stored[key]);
        } catch {
          // Shown as stored; the pack's load error names the problem.
        }
      }
    }
    return { schema: entry.manifest.settings ?? null, values };
  }

  /**
   * Store settings for one pack (merged over what is stored; `null` clears a
   * key) and reload it when it is loaded. Unknown keys and values of the
   * wrong type are refused before anything is written.
   */
  setSettings(id: string, values: Record<string, unknown>): Promise<void> {
    return this.serial(async () => {
      const entry = this.refresh(id);
      if (!entry.manifest) throw new Error(`unknown pack: ${id}`);
      const props = entry.manifest.settings?.properties ?? {};
      const state = this.readState();
      const next: Record<string, unknown> = { ...(state.packs[id]?.settings ?? {}) };
      for (const [key, value] of Object.entries(values)) {
        const prop = Object.hasOwn(props, key) ? props[key] : undefined;
        if (!prop) throw new PackSettingsError(`unknown setting "${key}"`);
        if (value === null) delete next[key];
        else if (prop.type === "array") {
          // Stored as a list, also when it was sent as comma-separated text.
          try {
            next[key] = settingList(key, value);
          } catch (e) {
            throw new PackSettingsError(e instanceof Error ? e.message : "invalid settings");
          }
        } else next[key] = value;
      }
      for (const key of Object.keys(next)) {
        if (!Object.hasOwn(props, key)) delete next[key];
      }
      try {
        resolveSettings(
          {
            ...entry.manifest,
            settings: { ...entry.manifest.settings, required: [] },
          } as PackManifest,
          next,
        );
      } catch (e) {
        throw new PackSettingsError(e instanceof Error ? e.message : "invalid settings");
      }
      state.packs[id] = { ...(state.packs[id] ?? {}), settings: next };
      this.writeState(state);
      if (entry.enabled && entry.state !== "needs-review") {
        await this.reloadEntry(entry, state, true);
      }
    });
  }

  /** Unload every pack (shutdown) and wait for retiring ones. */
  async close(): Promise<void> {
    await this.serial(async () => {
      for (const e of this.entries.values()) {
        this.unloadEntry(e);
        if (e.state === "loaded") e.state = "disabled";
      }
    });
    await this.settled();
  }

  /** Resolves when every unloaded pack instance has finished disposing. */
  async settled(): Promise<void> {
    while (this.retiring.size > 0) await Promise.all([...this.retiring]);
  }

  /** Whether a pack of this source would get a value: the environment counts only for bundled packs. */
  private hasSecret(source: PackSource, name: string): Promise<boolean> {
    return source === "builtin"
      ? this.opts.host.store.has(name)
      : this.opts.host.store.hasStored(name);
  }

  async listPacks(): Promise<PackStatus[]> {
    const state = this.readState();
    const out: PackStatus[] = [];
    for (const e of this.entries.values()) {
      const grants = new Set(state.packs[e.id]?.grants ?? []);
      const secrets: PackSecretStatus[] = [];
      for (const s of e.manifest?.secrets ?? []) {
        const granted =
          secretNameAllowed(s.name, e.source) && (e.source === "builtin" || grants.has(s.name));
        let present = false;
        if (granted) {
          try {
            present = await this.hasSecret(e.source, s.name);
          } catch {
            present = false;
          }
        }
        secrets.push({
          name: s.name,
          ...(s.label !== undefined ? { label: s.label } : {}),
          ...(s.helpUrl !== undefined ? { helpUrl: s.helpUrl } : {}),
          required: s.required,
          granted,
          present,
        });
      }
      out.push({
        id: e.id,
        name: e.manifest?.name ?? null,
        version: e.manifest?.version ?? null,
        description: e.manifest?.description ?? null,
        notice: e.manifest?.notice ?? null,
        source: e.source,
        enabled: e.enabled,
        state: e.state,
        error: e.error,
        tools: e.loaded?.tools ?? [],
        providers: e.loaded?.providers ?? [],
        secrets,
        permissions: e.manifest?.permissions ?? null,
        skills: e.loaded?.skills.map((s) => s.name) ?? [],
        workflows: e.loaded?.workflows ?? [],
        workflowErrors: e.loaded?.workflowErrors ?? [],
        mounts: e.manifest?.mounts.map((m) => m.id) ?? [],
        review: e.review,
      });
    }
    return out;
  }

  /** Counts for /health. */
  summary(): {
    total: number;
    enabled: number;
    loaded: number;
    failed: number;
    needsReview: number;
  } {
    let enabled = 0;
    let loaded = 0;
    let failed = 0;
    let needsReview = 0;
    for (const e of this.entries.values()) {
      if (e.enabled) enabled++;
      if (e.state === "loaded") loaded++;
      if (e.state === "failed" || e.state === "invalid") failed++;
      if (e.state === "needs-review") needsReview++;
    }
    return { total: this.entries.size, enabled, loaded, failed, needsReview };
  }

  /** SKILL.md files contributed by loaded packs. */
  skills(): PackSkill[] {
    return [...this.entries.values()].flatMap((e) => e.loaded?.skills ?? []);
  }

  /**
   * Mount declarations of LOADED packs (so, for user packs, consented ones).
   * Nothing here starts a mount: a host that wires these up must only start
   * those with `mount.enabledByDefault` (never true for user packs) or ones the
   * user switched on.
   */
  mounts(): PackMount[] {
    return [...this.entries.values()]
      .filter((e) => e.state === "loaded" && e.manifest)
      .flatMap((e) =>
        (e.manifest as PackManifest).mounts.map((mount) => ({
          pack: e.id,
          source: e.source,
          mount,
        })),
      );
  }

  /** Every mount declared by a known pack, with the user's switch and secret presence. */
  async listMounts(): Promise<MountStatus[]> {
    const state = this.readState();
    const out: MountStatus[] = [];
    for (const e of this.entries.values()) {
      if (!e.manifest || e.id !== e.manifest.id) continue;
      const grants = new Set(state.packs[e.id]?.grants ?? []);
      for (const mount of e.manifest.mounts) {
        const id = `${e.id}/${mount.id}`;
        const why = this.mountBlocker(e, mount);
        const secrets: { name: string; present: boolean }[] = [];
        for (const name of mountSecretRefs(mount)) {
          let present = false;
          if (secretNameAllowed(name, e.source) && (e.source === "builtin" || grants.has(name))) {
            try {
              present = await this.hasSecret(e.source, name);
            } catch {
              present = false;
            }
          }
          secrets.push({ name, present });
        }
        out.push({
          id,
          pack: e.id,
          mountId: mount.id,
          name: mount.name,
          description: mount.description ?? null,
          url: mount.url ?? null,
          transport: mount.transport,
          prefix: mount.prefix,
          auth: mount.auth ?? "unknown",
          docsUrl: mount.docsUrl ?? null,
          enabled: why === null && (state.mounts?.[id] ?? mount.enabledByDefault),
          mountable: why === null,
          note: why,
          secrets,
        });
      }
    }
    return out;
  }

  /**
   * Switch one mount on or off (`<pack>/<mount id>`), persisted in packs.json.
   * OAuth-only servers, stdio mounts and mounts of packs that are not loaded
   * cannot be switched on.
   */
  setMountEnabled(id: string, on: boolean): Promise<void> {
    return this.serial(async () => {
      const slash = id.indexOf("/");
      const entry = slash > 0 ? this.entries.get(id.slice(0, slash)) : undefined;
      const mount = entry?.manifest?.mounts.find((m) => m.id === id.slice(slash + 1));
      if (!entry || !mount) throw new Error(`unknown mount: ${id}`);
      if (on) {
        const why = this.mountBlocker(entry, mount);
        if (why) throw new Error(`mount ${id} cannot be switched on: ${why}`);
      }
      const state = this.readState();
      state.mounts = { ...(state.mounts ?? {}), [id]: on };
      this.writeState(state);
    }).then(async () => {
      await this.opts.onMountsChanged?.();
    });
  }

  /**
   * Host-only: the enabled http mounts with their secret references filled
   * in from the mount's OWN pack secrets. A mount with a missing secret is
   * left out (and logged by name).
   */
  async resolvedMounts(): Promise<ResolvedMount[]> {
    const state = this.readState();
    const out: ResolvedMount[] = [];
    for (const e of this.entries.values()) {
      if (!e.manifest || e.state !== "loaded" || e.id !== e.manifest.id) continue;
      const declared = new Set(e.manifest.secrets.map((s) => s.name));
      const grants = new Set(state.packs[e.id]?.grants ?? []);
      for (const mount of e.manifest.mounts) {
        const id = `${e.id}/${mount.id}`;
        if (this.mountBlocker(e, mount) !== null) continue;
        if (!(state.mounts?.[id] ?? mount.enabledByDefault)) continue;
        const values = new Map<string, string>();
        let missing: string | null = null;
        for (const name of mountSecretRefs(mount)) {
          const allowed =
            declared.has(name) &&
            secretNameAllowed(name, e.source) &&
            (e.source === "builtin" || grants.has(name));
          // As in the pack's own context: the environment only for a bundled pack.
          const value = !allowed
            ? null
            : e.source === "builtin"
              ? await this.opts.host.store.get(name)
              : await this.opts.host.store.getStored(name);
          if (value === null || value === "") {
            missing = name;
            break;
          }
          values.set(name, value);
        }
        if (missing !== null) {
          this.opts.host.logger.warn(
            { mount: id, secret: missing },
            "mount skipped: secret not set",
          );
          continue;
        }
        const fill = (s: string) =>
          s.replace(SECRET_REF_PATTERN, (_, name: string) => values.get(name) ?? "");
        const fillUrl = (s: string) =>
          s.replace(SECRET_REF_PATTERN, (_, name: string) =>
            encodeURIComponent(values.get(name) ?? ""),
          );
        out.push({
          id,
          pack: e.id,
          prefix: mount.prefix,
          url: fillUrl(mount.url as string),
          headers: Object.fromEntries(
            Object.entries(mount.headers ?? {}).map(([k, v]) => [k, fill(v)]),
          ),
          ...(mount.auth === "oauth" ? { oauth: true as const } : {}),
        });
      }
    }
    return out;
  }

  private mountBlocker(e: Entry, mount: MountDecl): string | null {
    if (mount.transport !== "http" || !mount.url) return "only http mounts are supported";
    if (e.state !== "loaded") return `the pack "${e.id}" is not loaded`;
    return null;
  }

  /** Host-only: the folder of a pack (never part of listPacks()). */
  packDir(id: string): string | null {
    const e = this.entries.get(id);
    return e ? e.dir : null;
  }

  // -------------------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async doLoadAll(): Promise<void> {
    for (const e of this.entries.values()) this.unloadEntry(e);
    await this.settled();
    this.entries.clear();
    const state = this.readState();
    for (const c of this.discover()) {
      const first = this.entries.get(c.id);
      if (first) {
        // Never let one pack replace another: the later duplicate is invalid.
        this.entries.set(`${c.id}@${c.source}:${c.dir}`, {
          ...c,
          enabled: false,
          state: "invalid",
          loaded: null,
          review: null,
          error: `pack id "${c.id}" is already used by a ${first.source} pack`,
        });
        continue;
      }
      const entry: Entry = {
        ...c,
        // The user's choice wins. Otherwise a bundled pack is on unless its
        // manifest ships it off; a user pack is off until reviewed.
        enabled:
          state.packs[c.id]?.enabled ??
          (c.source === "builtin" && c.manifest?.enabledByDefault !== false),
        state: c.manifest ? "disabled" : "invalid",
        loaded: null,
        review: null,
      };
      this.entries.set(c.id, entry);
      await this.reloadEntry(entry, state);
    }
  }

  private discover(): Candidate[] {
    const out: Candidate[] = [];
    out.push(...this.scan(this.builtinDir, "builtin"));
    out.push(...this.scan(this.userDir, "user"));
    return out;
  }

  private scan(root: string, source: PackSource): Candidate[] {
    if (!existsSync(root)) return [];
    const names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
      .map((d) => d.name)
      .sort();
    const out: Candidate[] = [];
    for (const name of names) {
      const c = this.readCandidate(join(root, name), name, source);
      if (c) out.push(c);
    }
    return out;
  }

  private readCandidate(dir: string, name: string, source: PackSource): Candidate | null {
    const manifestPath = join(dir, "pack.json");
    if (!existsSync(manifestPath)) return null;
    try {
      const manifest = parseManifestText(readFileSync(manifestPath, "utf8"), {
        source: `${source} pack "${name}" (pack.json)`,
        folderName: name,
        packSource: source,
      });
      return { id: manifest.id, source, dir, manifest, error: null };
    } catch (e) {
      const msg =
        e instanceof ManifestError
          ? e.message
          : `could not read pack.json: ${(e as Error).message}`;
      return { id: name, source, dir, manifest: null, error: msg };
    }
  }

  /** Re-read one pack's manifest from disk (or discover a pack added after boot). */
  private refresh(id: string): Entry {
    const existing = this.entries.get(id);
    let fresh: Candidate | null = null;
    if (existing) {
      fresh = this.readCandidate(existing.dir, id, existing.source);
    } else if (/^[a-z][a-z0-9-]{1,31}$/.test(id)) {
      fresh =
        this.readCandidate(join(this.builtinDir, id), id, "builtin") ??
        this.readCandidate(join(this.userDir, id), id, "user");
    }
    if (!fresh) {
      if (existing) {
        existing.manifest = null;
        existing.error = "pack.json is gone";
        return existing;
      }
      throw new Error(`unknown pack: ${id}`);
    }
    if (existing) {
      existing.manifest = fresh.manifest;
      existing.error = fresh.error;
      return existing;
    }
    const entry: Entry = {
      ...fresh,
      enabled: false,
      state: fresh.manifest ? "disabled" : "invalid",
      loaded: null,
      review: null,
    };
    this.entries.set(id, entry);
    return entry;
  }

  /**
   * `entryHash` covers every file in the pack folder (not only the entry),
   * also for a pack without code. When the folder cannot be hashed it is
   * `unhashable:<reason>`, which enable() and the load path refuse for user
   * packs.
   */
  private hashes(entry: Entry): { manifestHash: string; entryHash: string } {
    const m = entry.manifest as PackManifest;
    let entryHash = "";
    try {
      if (m.entry !== undefined) resolveEntry(entry.dir, m.entry);
      entryHash = packFolderHash(entry.dir);
    } catch (e) {
      entryHash = e instanceof PackHashError ? `unhashable:${e.message}` : "missing";
    }
    return { manifestHash: manifestConsentHash(m), entryHash };
  }

  private snapshotRoot(id: string): string {
    return join(this.opts.home, "pack-snapshots", id);
  }

  /**
   * A private copy of the pack folder whose content hashes to `hash`, or null
   * when the folder no longer does. The copy is hashed, not the original, so
   * what is imported is exactly what was compared with the consent.
   */
  private snapshotFor(entry: Entry, hash: string): string | null {
    const root = this.snapshotRoot(entry.id);
    const dir = join(root, hash);
    try {
      if (existsSync(dir) && packFolderHash(dir) === hash) return dir;
    } catch {
      // fall through and rebuild it
    }
    rmSync(dir, { recursive: true, force: true });
    const tmp = join(root, `.tmp-${randomBytes(6).toString("hex")}`);
    try {
      copyPackFolder(entry.dir, tmp);
      if (packFolderHash(tmp) !== hash) return null;
      renameSync(tmp, dir);
      return dir;
    } catch (e) {
      if (e instanceof PackHashError) return null;
      throw e;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Remove the snapshots of `id` other than `keep`. */
  private pruneSnapshots(id: string, keep: ReadonlySet<string>): void {
    const root = this.snapshotRoot(id);
    try {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!keep.has(join(root, d.name))) {
          rmSync(join(root, d.name), { recursive: true, force: true });
        }
      }
    } catch {
      // nothing to prune
    }
  }

  private reviewOf(
    entry: Entry,
    persisted: PersistedPackState | undefined,
    hashes: { manifestHash: string; entryHash: string },
    items = consentItems(entry.manifest as PackManifest),
  ): PackReview | null {
    const consent = persisted?.consent;
    const manifestChanged = consent?.manifestHash !== hashes.manifestHash;
    const entryChanged = consent?.entryHash !== hashes.entryHash;
    if (consent && !manifestChanged && !entryChanged) return null;
    return {
      previous: consent?.summary ?? [],
      current: summaryLines(items),
      manifestChanged,
      entryChanged,
    };
  }

  /**
   * Bring one entry in line with its enabled flag and what is on disk. A
   * replacement is fully built (import, setup, tools) BEFORE the running
   * instance is swapped out, so a broken update leaves no gap and other packs
   * are never touched.
   */
  private async reloadEntry(entry: Entry, state: PersistedState, keepOld = false): Promise<void> {
    const { registry, host } = this.opts;
    const persisted = state.packs[entry.id];
    if (!entry.manifest) {
      this.unloadEntry(entry);
      entry.state = "invalid";
      return;
    }
    if (!entry.enabled) {
      this.unloadEntry(entry);
      entry.state = "disabled";
      entry.review = null;
      return;
    }
    if (entry.source === "user") {
      const hashes = this.hashes(entry);
      if (hashes.entryHash.startsWith("unhashable:")) {
        this.unloadEntry(entry);
        this.fail(entry, new Error(`not loaded: ${hashes.entryHash.slice(11)}`));
        return;
      }
      const review = this.reviewOf(entry, persisted, hashes);
      if (review) {
        // Consent does not cover what is on disk now: do not run it.
        this.unloadEntry(entry);
        entry.state = "needs-review";
        entry.review = review;
        entry.error = review.previous.length
          ? "the pack changed since you enabled it; review and enable it again"
          : "the pack was never reviewed; review and enable it";
        host.logger.warn({ pack: entry.id }, "pack needs review, not loaded");
        return;
      }
      // Run from a copy that was itself hashed and matches the consent. Without
      // a valid consented hash there is no verified copy, and the live folder
      // is never run: fail closed.
      const consented = persisted?.consent?.entryHash ?? "";
      if (!/^[0-9a-f]{64}$/.test(consented)) {
        this.unloadEntry(entry);
        this.fail(
          entry,
          new Error(
            "not loaded: the pack has no reviewed, hashed copy; review and enable it again",
          ),
        );
        return;
      }
      const snapshot = this.snapshotFor(entry, consented);
      if (!snapshot) {
        this.unloadEntry(entry);
        entry.state = "needs-review";
        entry.review = this.reviewOf(entry, persisted, { ...hashes, entryHash: "changed" });
        entry.error = "the pack changed while it was being loaded; review and enable it again";
        host.logger.warn({ pack: entry.id }, "pack changed during load, not loaded");
        return;
      }
      entry.runDir = snapshot;
    }
    entry.review = null;
    const previousRunDir = entry.loaded?.runDir;

    let fresh: LoadedPack;
    try {
      fresh = await this.prepare(entry, persisted, {
        ...(persisted?.settings ?? {}),
        ...(this.opts.settingsOverrides?.[entry.id] ?? {}),
      });
    } catch (e) {
      // Only an explicit reload keeps the old instance: enable() may have
      // changed grants, and the old instance was built with the old ones.
      if (!keepOld) this.unloadEntry(entry);
      this.keepOldOrFail(entry, e);
      return;
    }
    const old = entry.loaded;
    const router = this.opts.capabilities;
    try {
      // Atomic too: on a duplicate provider id the old providers stay.
      router?.registerPack(entry.id, entry.source, fresh.providerBindings);
    } catch (e) {
      this.retire(entry.id, fresh, 0);
      if (!keepOld) this.unloadEntry(entry);
      this.keepOldOrFail(entry, e);
      return;
    }
    registry.unregisterPack(entry.id);
    try {
      // Atomic: on a name collision nothing of this pack is registered.
      registry.registerPack(entry.id, fresh.registered);
    } catch (e) {
      if (old && keepOld) router?.registerPack(entry.id, entry.source, old.providerBindings);
      else router?.unregisterPack(entry.id);
      this.retire(entry.id, fresh, 0);
      if (old && !keepOld) {
        this.retire(entry.id, old, this.unloadGraceMs);
        entry.loaded = null;
      } else if (old) {
        try {
          registry.registerPack(entry.id, old.registered);
        } catch {
          this.retire(entry.id, old, this.unloadGraceMs);
          entry.loaded = null;
        }
      }
      this.keepOldOrFail(entry, e);
      return;
    }
    entry.loaded = fresh;
    entry.state = "loaded";
    entry.error = null;
    if (old) this.retire(entry.id, old, this.unloadGraceMs);
    if (entry.source === "user" && fresh.runDir) {
      // Calls still running in the previous instance may import lazily.
      this.pruneSnapshots(
        entry.id,
        new Set([fresh.runDir, ...(previousRunDir ? [previousRunDir] : [])]),
      );
    }
  }

  /**
   * A replacement could not be built. When an instance is already serving it
   * keeps serving (state stays "loaded", the error says the update failed);
   * otherwise the pack is failed.
   */
  private keepOldOrFail(entry: Entry, e: unknown): void {
    if (!entry.loaded) {
      this.fail(entry, e);
      return;
    }
    const { host } = this.opts;
    const reason = host.store.redactor.redact(e instanceof Error ? e.message : String(e));
    entry.state = "loaded";
    entry.error = `reload failed, still running the previous version: ${reason}`;
    host.logger.error({ pack: entry.id, err: reason }, "pack reload failed, previous version kept");
  }

  private fail(entry: Entry, e: unknown): void {
    const { host } = this.opts;
    entry.state = "failed";
    entry.error = host.store.redactor.redact(e instanceof Error ? e.message : String(e));
    host.logger.error({ pack: entry.id, err: entry.error }, "pack failed to load");
  }

  /** Stop serving a pack now; let in-flight calls finish (bounded), then dispose. */
  private unloadEntry(entry: Entry): void {
    const old = entry.loaded;
    if (!old) return;
    this.opts.registry.unregisterPack(entry.id);
    this.opts.capabilities?.unregisterPack(entry.id);
    entry.loaded = null;
    this.retire(entry.id, old, this.unloadGraceMs);
  }

  private retire(id: string, pack: LoadedPack, graceMs: number): void {
    const job = (async () => {
      if (pack.inflight.count > 0 && graceMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          new Promise<void>((done) => pack.inflight.waiters.push(done)),
          new Promise<void>((done) => {
            timer = setTimeout(done, graceMs);
          }),
        ]);
        clearTimeout(timer);
      }
      try {
        await pack.definition?.dispose?.();
      } catch (err) {
        this.opts.host.logger.warn(
          { pack: id, err: this.opts.host.store.redactor.redact((err as Error).message) },
          "pack dispose failed",
        );
      }
      // Aborts whatever is still running and makes the context unusable.
      await pack.scoped?.dispose();
    })();
    this.retiring.add(job);
    void job.finally(() => this.retiring.delete(job));
  }

  /** Build a pack instance without registering it. Throws after cleaning up. */
  private async prepare(
    entry: Entry,
    persisted: PersistedPackState | undefined,
    persistedSettings: Record<string, unknown>,
  ): Promise<LoadedPack> {
    const manifest = entry.manifest as PackManifest;
    const { host } = this.opts;
    const inflight: Inflight = { count: 0, waiters: [] };
    // A user pack runs from its verified snapshot, never from the live folder;
    // with no snapshot there is nothing verified to run.
    if (entry.source === "user" && !entry.runDir) {
      throw new Error(
        "a user pack must run from its reviewed snapshot; review and enable it again",
      );
    }
    const runDir = entry.source === "user" ? (entry.runDir as string) : entry.dir;

    const settings = resolveSettings(manifest, persistedSettings);
    // A setting marked as a local endpoint widens the pack's network to that
    // one host:port, after the same checks as localNetwork (loopback or
    // RFC1918 only, never the daemon's port, link-local or metadata).
    const extraLocalNetwork: string[] = [];
    for (const key of endpointSettings(manifest)) {
      const value = settings[key];
      if (typeof value !== "string" || value.trim() === "") continue;
      try {
        extraLocalNetwork.push(localEndpointEntry(value.trim(), host.daemonPorts ?? []));
      } catch (e) {
        throw new Error(`setting "${key}" ${(e as Error).message}`);
      }
    }
    // Spawn roots come only from what the user saved, never from a manifest
    // default: a pack must not grant itself folders the user never listed.
    const userFolders: Record<string, unknown> = {};
    for (const key of folderListSettings(manifest)) {
      if (Object.hasOwn(persistedSettings, key)) userFolders[key] = settings[key];
    }
    const extraSpawnRoots = spawnRootsFromSettings(
      manifest,
      userFolders,
      this.opts.home,
      (key, msg) => host.logger.warn({ pack: manifest.id, setting: key }, `folder skipped: ${msg}`),
    );
    const dataDir = join(this.opts.home, "pack-data", manifest.id);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    const scoped = createPackContext({
      manifest,
      dataDir,
      settings,
      host,
      source: entry.source,
      grants: persisted?.grants ?? [],
      packDir: runDir,
      home: this.opts.home,
      extraLocalNetwork,
      extraSpawnRoots,
    });

    const stage: {
      definition: PackDefinition | null;
      setupCalled: boolean;
      providers: AnyProviderDefinition[];
      services: PackServices;
    } = {
      definition: null,
      setupCalled: false,
      providers: [],
      services: {},
    };
    const work = (async (): Promise<RegisteredTool[]> => {
      if (manifest.entry === undefined) return [];
      const file = resolveEntry(runDir, manifest.entry);
      const importModule = this.opts.importModule ?? ((href: string) => import(href));
      const mod = (await importModule(this.entryHref(file))) as { default?: unknown };
      const definition = await toDefinition(mod.default);
      stage.definition = definition;
      stage.setupCalled = true;
      const services = (await definition.setup?.(scoped.base)) ?? {};
      assertServices(services);
      const baseWithServices = { ...scoped.base, ...services };
      const defs =
        typeof definition.tools === "function"
          ? await definition.tools(baseWithServices)
          : (definition.tools ?? []);
      const providers =
        typeof definition.providers === "function"
          ? await definition.providers(baseWithServices)
          : (definition.providers ?? []);
      if (!Array.isArray(providers)) throw new Error("providers must be an array");
      if (providers.length > 0 && !this.opts.capabilities) {
        host.logger.warn({ pack: manifest.id }, "pack declares providers but routing is off");
      }
      stage.providers = [...providers];
      stage.services = services;
      return defs.map((def) => this.wrapTool(manifest, def, scoped, services, inflight));
    })();

    let timer: NodeJS.Timeout | undefined;
    try {
      const registered = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new LoadTimeoutError(this.loadTimeoutMs)),
            this.loadTimeoutMs,
          );
        }),
      ]);
      const services = stage.services;
      const flows = loadWorkflows({
        manifest,
        packDir: runDir,
        scoped,
        host,
        tool: (name) => this.opts.registry.get(name),
        pack: (id) => {
          const e = this.entries.get(id);
          return e ? { state: e.state, enabled: e.enabled, error: e.error } : undefined;
        },
        track: async (run) => {
          inflight.count++;
          try {
            return await run();
          } finally {
            inflight.count--;
            if (inflight.count === 0) for (const done of inflight.waiters.splice(0)) done();
          }
        },
      });
      for (const f of flows.errors) {
        host.logger.warn(
          { pack: manifest.id, workflow: f.name, err: f.error },
          "workflow not loaded",
        );
      }
      registered.push(...flows.tools);
      // Providers run with THIS pack's context: its own secrets, network and
      // library, never the caller's.
      const providerBindings: ProviderBinding[] = stage.providers.map((def) => ({
        def,
        context: (callCtx, toolName, observer) =>
          ({ ...scoped.forCall(callCtx, toolName, observer), ...services }) as PackContext &
            PackServices,
      }));
      return {
        scoped,
        definition: stage.definition,
        registered,
        tools: registered.map((t) => t.name),
        skills: indexSkills(runDir, manifest),
        ...(entry.source === "user" && entry.runDir ? { runDir: entry.runDir } : {}),
        workflows: flows.names,
        workflowErrors: flows.errors,
        inflight,
        providers: stage.providers.map((p) => `${p.capability}:${String(p.id)}`),
        providerBindings,
      };
    } catch (e) {
      // A hung import/setup cannot be cancelled; make sure its late result is
      // ignored, and release whatever setup() may have acquired.
      work.catch(() => {});
      if (stage.setupCalled) {
        try {
          await stage.definition?.dispose?.();
        } catch (err) {
          host.logger.warn(
            { pack: manifest.id, err: host.store.redactor.redact((err as Error).message) },
            "pack dispose after a failed load failed",
          );
        }
      }
      await scoped.dispose();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A changed entry file gets a new module URL, or the module cache would serve the old code. */
  private entryHref(file: string): string {
    const href = pathToFileURL(file).href;
    let hash = "";
    try {
      hash = sha256(readFileSync(file)).slice(0, 16);
    } catch {
      return href;
    }
    const first = this.importedHash.get(file);
    if (first === undefined) {
      this.importedHash.set(file, hash);
      return href;
    }
    return first === hash ? href : `${href}?v=${hash}`;
  }

  private wrapTool(
    manifest: PackManifest,
    def: AnyToolDefinition,
    scoped: ScopedPackContext,
    services: PackServices,
    inflight: Inflight,
  ): RegisteredTool {
    if (!def || typeof def !== "object") throw new Error("a tool definition must be an object");
    const name = String(def.name);
    const problem = toolNameProblem(name);
    if (problem) throw new Error(problem);
    if (isReservedToolName(name, manifest.id)) throw new ReservedToolNameError(name, manifest.id);
    if (typeof def.description !== "string" || def.description === "") {
      throw new Error(`tool "${name}" needs a description`);
    }
    if (!def.input || typeof (def.input as { safeParse?: unknown }).safeParse !== "function") {
      throw new Error(`tool "${name}" needs a zod input schema`);
    }
    if (typeof def.run !== "function")
      throw new Error(`tool "${name}" needs a run(input, ctx) function`);
    const declared = new Map(manifest.secrets.map((s) => [s.name, s]));
    const needs = [...(def.secrets ?? [])];
    for (const s of needs) {
      if (!declared.has(s))
        throw new Error(`tool "${name}" needs the secret ${s}, which pack.json does not declare`);
    }
    const granted = new Set(scoped.allowedSecrets);
    return {
      name,
      packId: manifest.id,
      origin: "native",
      description: def.description,
      inputSchema: toolInputJsonSchema(def.input),
      ...(def.annotations ? { annotations: def.annotations } : {}),
      tags: [...(def.tags ?? [])],
      ...(def.capability ? { capability: def.capability } : {}),
      requiresSecrets: needs,
      longRunning: def.longRunning === true,
      input: def.input,
      async run(input, callCtx) {
        inflight.count++;
        try {
          const scopedCtx = scoped.forCall(callCtx, name);
          // Fail fast, before any side effect, when a declared need is not
          // granted (permission error) or not set (missing secret).
          for (const s of needs) {
            if (!granted.has(s)) {
              throw new PackPermissionError(
                manifest.id,
                `secret ${s} was not granted to this pack (enable the pack again and grant it)`,
                "secret_not_granted",
              );
            }
            if (!(await scopedCtx.secrets.has(s))) {
              const decl = declared.get(s);
              throw new MissingSecretError({
                pack: manifest.id,
                name: s,
                ...(decl?.label !== undefined ? { label: decl.label } : {}),
                ...(decl?.helpUrl !== undefined ? { helpUrl: decl.helpUrl } : {}),
              });
            }
          }
          const ctx = { ...scopedCtx, ...services } as PackContext & PackServices;
          return await def.run(input, ctx);
        } finally {
          inflight.count--;
          if (inflight.count === 0) for (const done of inflight.waiters.splice(0)) done();
        }
      },
    };
  }

  private readState(): PersistedState {
    if (!existsSync(this.statePath)) return { version: 1, packs: {} };
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<PersistedState>;
      const packs: Record<string, PersistedPackState> = {};
      if (raw && typeof raw.packs === "object" && raw.packs) {
        for (const [id, v] of Object.entries(raw.packs)) {
          if (!v || typeof v !== "object" || id in Object.prototype) continue;
          const c = v.consent as Partial<PersistedConsent> | undefined;
          const consent =
            c &&
            typeof c === "object" &&
            typeof c.manifestHash === "string" &&
            typeof c.entryHash === "string"
              ? {
                  manifestHash: c.manifestHash,
                  entryHash: c.entryHash,
                  summary: Array.isArray(c.summary)
                    ? c.summary.filter((s): s is string => typeof s === "string")
                    : [],
                  at: typeof c.at === "string" ? c.at : "",
                }
              : undefined;
          packs[id] = {
            ...(typeof v.enabled === "boolean" ? { enabled: v.enabled } : {}),
            ...(v.settings && typeof v.settings === "object" ? { settings: v.settings } : {}),
            ...(Array.isArray(v.grants)
              ? { grants: v.grants.filter((g): g is string => typeof g === "string") }
              : {}),
            ...(consent ? { consent } : {}),
          };
        }
      }
      const mounts: Record<string, boolean> = {};
      if (raw && typeof raw.mounts === "object" && raw.mounts && !Array.isArray(raw.mounts)) {
        for (const [id, on] of Object.entries(raw.mounts)) {
          if (typeof on === "boolean" && !(id in Object.prototype)) mounts[id] = on;
        }
      }
      return { version: 1, packs, ...(Object.keys(mounts).length ? { mounts } : {}) };
    } catch (e) {
      // Unreadable state: fall back to defaults (user packs stay disabled).
      // A parse error quotes the file, and a system error its full path: log the kind only.
      this.opts.host.logger.warn(
        { err: (e as NodeJS.ErrnoException).code ?? (e as Error).name ?? "error" },
        "packs.json unreadable, using defaults",
      );
      return { version: 1, packs: {} };
    }
  }

  /** Atomic (temp file + rename), owner-only. */
  private writeState(state: PersistedState): void {
    mkdirSync(this.opts.home, { recursive: true });
    writeFileAtomicSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

/** Entry path inside the pack folder. `./index.js` falls back to `./index.ts` in dev. */
export function resolveEntry(packDir: string, entry: string): string {
  const inside = (p: string) => {
    try {
      return resolveInside(packDir, p);
    } catch (e) {
      if (e instanceof UnsafePathError) {
        throw new Error(`entry "${entry}" must stay inside the pack folder (${e.reason})`);
      }
      throw e;
    }
  };
  const file = inside(entry);
  if (existsSync(file) && statSync(file).isFile()) return file;
  if (entry.endsWith(".js")) {
    const ts = inside(`${entry.slice(0, -3)}.ts`);
    if (existsSync(ts) && statSync(ts).isFile()) return ts;
  }
  throw new Error(`entry "${entry}" not found in the pack folder`);
}

async function toDefinition(exported: unknown): Promise<PackDefinition> {
  let value = exported;
  // Factories get the one frozen API object, never the module namespace.
  if (typeof value === "function") value = await (value as PackFactory)(packApi);
  if (!value || typeof value !== "object") {
    throw new Error(
      "the entry module must default-export definePack({...}) or a function (api) => definePack({...})",
    );
  }
  const def = value as PackDefinition;
  const v = def.apiVersion as number;
  if (!Number.isInteger(v) || v < 1 || v > PACK_API_VERSION) {
    throw new Error(
      `the pack definition must come from definePack() (apiVersion 1 to ${PACK_API_VERSION})`,
    );
  }
  return def;
}

function assertServices(services: unknown): asserts services is PackServices {
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    throw new Error("setup() must return an object of services (or nothing)");
  }
  for (const key of Object.keys(services)) {
    if (CTX_KEYS.has(key))
      throw new Error(`setup() returned the service "${key}", which would shadow ctx.${key}`);
  }
}

/**
 * The value of a list setting (`type: "array"`): trimmed, non-empty strings.
 * One string is read as a comma-separated list, which is how such settings
 * were stored before lists existed (and how an environment override arrives);
 * an empty string is an empty list. Anything else is refused.
 */
export function settingList(key: string, value: unknown): string[] {
  const raw: unknown =
    typeof value === "string" ? value.split(",").filter((s) => s.trim() !== "") : value;
  if (!Array.isArray(raw)) throw new Error(`setting "${key}" must be a list of strings`);
  if (raw.length > SETTING_LIST_MAX_ITEMS) {
    throw new Error(`setting "${key}" holds at most ${SETTING_LIST_MAX_ITEMS} items`);
  }
  const out: string[] = [];
  for (const item of raw as unknown[]) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text === "" || text.length > SETTING_LIST_ITEM_MAX_CHARS) {
      throw new Error(
        `setting "${key}" must be a list of non-empty strings of at most ${SETTING_LIST_ITEM_MAX_CHARS} characters`,
      );
    }
    out.push(text);
  }
  return out;
}

function resolveSettings(
  manifest: PackManifest,
  persisted: Record<string, unknown>,
): Record<string, unknown> {
  const props = manifest.settings?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop.default !== undefined) out[key] = prop.default;
    if (!(key in persisted)) continue;
    const v = persisted[key];
    if (prop.type === "array") {
      out[key] = Object.freeze(settingList(key, v));
      continue;
    }
    const ok =
      (prop.type === "string" && typeof v === "string") ||
      (prop.type === "boolean" && typeof v === "boolean") ||
      (prop.type === "number" && typeof v === "number" && Number.isFinite(v)) ||
      (prop.type === "integer" && Number.isInteger(v));
    if (!ok) throw new Error(`setting "${key}" must be a ${prop.type}`);
    if (prop.enum && !prop.enum.includes(v as string | number))
      throw new Error(`setting "${key}" is not one of the allowed values`);
    out[key] = v;
  }
  for (const key of manifest.settings?.required ?? []) {
    if (out[key] === undefined) throw new Error(`required setting "${key}" is not set`);
  }
  return out;
}

function indexSkills(packDir: string, manifest: PackManifest): PackSkill[] {
  if (!manifest.skills) return [];
  const dir = resolveInside(packDir, manifest.skills);
  if (!existsSync(dir)) return [];
  const out: PackSkill[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = resolveInside(dir, join(d.name, "SKILL.md"));
    if (existsSync(file)) out.push({ pack: manifest.id, name: d.name, path: file });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
