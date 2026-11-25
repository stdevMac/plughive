// src/core/packs/context.ts
//
// Builds the PackContext one pack sees. Every member is gated by that pack's
// manifest: secrets by `secrets` (and, for user packs, by what the user
// granted), fetch by `permissions.network` / `localNetwork`, spawn by
// `permissions.spawn`, and so on.
//
// HONEST LIMIT: this is least privilege at the API level, not an OS sandbox.
// A code pack runs in the daemon process and could bypass the context by
// importing node modules itself. The boundary test keeps the repo's own packs
// honest; user packs are disabled until the user reviews and enables them.
//
// Redaction of what flows back out (results, errors, logs) is a seatbelt
// against accidents, not a boundary: it only knows values the secret store
// served, and misses short or transformed ones.
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  type FileHandle,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { loadExeca } from "../../lib/lazy-execa.js";
import {
  defaultSystemPath,
  exeCandidates,
  homeEnv,
  homeEnvDirs,
  isBatchScript,
  isWindows,
  joinPath,
  splitPath,
  systemChildEnv,
} from "../../lib/platform.js";
import { type CapabilityName, isCapabilityName } from "../capabilities/schemas.js";
import { openInside, readFileCapped, resolveInside } from "../fs/safe-path.js";
import { currentScopeAllows } from "../mcp/scope.js";
import { isPrivateAddress, parseIPv4, parseIPv6 } from "../net/ip.js";
import {
  type LookupAddress,
  type SafeFetch,
  type SafeFetchPolicy,
  createSafeFetch,
} from "../net/safe-fetch.js";
import {
  ARTIFACT_KINDS,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactRef,
  type CapabilityProviderInfo,
  type CapabilityRunOptions,
  FETCH_DEFAULT_TIMEOUT_MS,
  FETCH_MAX_TIMEOUT_MS,
  type LlmChatRequest,
  type LlmChatResult,
  type MaterializedArtifact,
  type PackCapabilities,
  type PackContext,
  type PackFetchInit,
  type PackLogger,
  PackPermissionError,
  type PackPermissionReason,
  SpawnError,
  type SpawnOptions,
  type SpawnResult,
} from "../pack-api.js";
import { PolicyError, isPolicyErrorCode } from "../policy/errors.js";
import type { PolicyGate } from "../policy/gate.js";
import {
  type LayeredSecretStore,
  MissingSecretError,
  SECRET_NAME_PATTERN,
} from "../secrets/index.js";
import type { CallContext, ToolEnvelope, UsageSink } from "../tools/registry.js";
import {
  type PackManifest,
  type PackSource,
  isDeniedSecretName,
  isReservedPackId,
  secretNameAllowed,
} from "./manifest.js";

/**
 * Header every pack fetch carries, set by the host and not overridable by the
 * pack. The daemon's own HTTP surface rejects requests that carry it, so a
 * pack cannot drive the daemon's API through a localNetwork grant.
 */
export const PACK_MARKER_HEADER = "x-plughive-pack";

export { PackPermissionError };
export type { PackPermissionReason };

/** Thrown by every capability of a context whose pack was unloaded. */
export class PackDisposedError extends Error {
  readonly code = "PACK_DISPOSED" as const;
  constructor(readonly pack: string) {
    super(`Pack "${pack}" was unloaded; its context can no longer be used`);
    this.name = "PackDisposedError";
  }
}

/** A library row as the host sees it (with the on-disk path, never shown to packs). */
export interface HostArtifact extends Omit<ArtifactRecord, "url"> {
  path: string;
}

export interface HostArtifactRef {
  id: string;
  url: string;
  mime: string;
  bytes?: number;
  model?: string | null;
  prompt?: string | null;
  cost_usd?: number | null;
  costUsd?: number | null;
  path?: string;
}

/** The daemon artifact library, as far as pack contexts reach it. */
export interface HostLibrary {
  get(id: string): HostArtifact | null;
  list(
    filter: { tool?: string; kind?: ArtifactKind; model?: string; since?: string },
    limit?: number,
  ): HostArtifact[];
  save(input: {
    kind: ArtifactKind;
    mime: string;
    bytes: Buffer;
    tool: string;
    model?: string | null;
    prompt?: string | null;
    meta?: Record<string, unknown> | null;
    costUsd?: number | null;
  }): HostArtifactRef;
  /** Download URL of an artifact. Default: `/artifacts/<id>` (relative). */
  urlFor?(id: string): string;
  /** Bytes of an artifact. Default: read `path` from disk. */
  readBytes?(id: string): Promise<Uint8Array> | Uint8Array;
  /**
   * Store an artifact by streaming from an open file (importFile). The
   * library must stop and clean up once more than `maxBytes` arrive. Without
   * it, importFile reads the file (capped) and calls `save`.
   */
  importHandle?(
    input: Omit<HostSaveInput, "bytes">,
    handle: FileHandle,
    maxBytes: number,
  ): Promise<HostArtifactRef>;
}

export type HostSaveInput = Parameters<HostLibrary["save"]>[0];

/** Who is asking the capability router, as the context reports it. */
export interface CapabilityCaller {
  pack: string;
  depth: number;
  signal: AbortSignal;
  /** The tool the caller is running (usage attribution). */
  tool: string;
  /** The caller's progress reporter: a provider's ctx.progress reaches it. */
  progress?: (fraction: number, message?: string) => void;
}

/** The capability router, as far as pack contexts reach it. */
export interface HostCapabilities {
  run(
    capability: CapabilityName,
    input: unknown,
    opts: CapabilityRunOptions,
    caller: CapabilityCaller,
  ): Promise<unknown>;
  list(capability?: CapabilityName): Promise<CapabilityProviderInfo[]>;
  /** True when some auto-routable provider is registered for `capability`. */
  has(capability: CapabilityName): boolean;
}

/** Observes what a context's fetch sees (the router uses it to classify failures). */
export interface FetchObserver {
  /** Called right before a request is handed to the transport (every check passed). */
  onRequest?(info: { method: string }): void;
  onResponse?(info: { method: string; status: number; headers: Headers }): void;
  /** The transport failed after onRequest: no response was received. */
  onError?(info: { method: string; error: unknown }): void;
}

export type HostLlm = (req: LlmChatRequest, signal?: AbortSignal) => Promise<LlmChatResult>;

export interface HostTools {
  /** The registry's redacting, metering call path (never throws). */
  call(name: string, args: unknown, callCtx: CallContext): Promise<ToolEnvelope>;
  get(name: string): { packId: string; capability?: string } | undefined;
  /**
   * Name of the tool tagged with `capability`, for tags the capability router
   * does not route. Must not depend on the order packs were loaded in.
   */
  resolveCapability?(capability: string): string | undefined;
}

export interface HostLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Programs plughive installed itself (tools/bin under the home). A declared
 * binary found there is used before the PATH, but only when its real path is
 * the one the installer recorded, and every run re-checks its sha256.
 */
export interface HostTrustedTools {
  /** <home>/tools/bin. */
  readonly binDir: string;
  /** Absolute real path tools/bin/<name> must resolve to, or null when not installed. */
  lockedTarget(name: string): string | null;
  /** `realPath` is still the installed program for `name`, byte for byte. */
  verify(name: string, realPath: string): Promise<boolean>;
  /** Called after an install or uninstall; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** Daemon services a pack context is cut from. */
export interface PackHost {
  store: LayeredSecretStore;
  logger: HostLogger;
  library?: HostLibrary;
  llm?: HostLlm;
  tools?: HostTools;
  /** Capability router (ctx.capabilities, and ctx.llm.chat when a chat provider exists). */
  capabilities?: HostCapabilities;
  /** Usage ledger: nested llm.chat calls are recorded here with the calling pack. */
  usage?: UsageSink;
  /** Spend gate: a workflow run over a cap asks once for the whole run. Absent: no gate. */
  policy?: Pick<PolicyGate, "runWorkflow">;
  /** Extra safe-fetch policy (tests: injected DNS lookup, private CA). Never widens hosts. */
  fetchPolicy?: Omit<SafeFetchPolicy, "allowHosts" | "allowLocal">;
  /** Ports the daemon itself listens on: no localNetwork grant reaches them. */
  daemonPorts?: readonly number[];
  /** PATH used to resolve `permissions.spawn` binaries. Default: the daemon's PATH. */
  spawnPath?: string;
  /** tools/bin, searched before the PATH (see HostTrustedTools). */
  trustedTools?: HostTrustedTools;
  /** Cap on one saved or imported artifact. Default 256 MiB. */
  maxArtifactBytes?: number;
  /**
   * Test seams (`plughive/pack/testing`). The permission checks still run;
   * only the final network / process step is replaced.
   */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  spawnImpl?: (
    binary: string,
    args: readonly string[],
    opts: SpawnOptions,
  ) => Promise<Partial<SpawnResult>> | Partial<SpawnResult>;
}

export interface CreatePackContextOptions {
  manifest: PackManifest;
  dataDir: string;
  settings: Readonly<Record<string, unknown>>;
  host: PackHost;
  /** Default "builtin". A "user" pack only gets the secrets named in `grants`. */
  source?: PackSource;
  /** Secret names the user granted at enable time (user packs). */
  grants?: readonly string[];
  /** The pack's own folder: binaries resolving into it are refused. */
  packDir?: string;
  /** plughive home: binaries resolving into it are refused. */
  home?: string;
  /**
   * Extra `localNetwork` entries the user granted through settings with
   * `format: "local-endpoint"` (validated by the loader; re-checked here).
   */
  extraLocalNetwork?: readonly string[];
  /**
   * Canonical folders the user listed in `format: "folder-list"` settings
   * (validated by the loader with spawnRootEntry): an absolute ctx.spawn cwd
   * may point inside one of them.
   */
  extraSpawnRoots?: readonly string[];
}

export interface ScopedPackContext {
  /** Context for setup() and the tools(ctx) factory. */
  readonly base: PackContext;
  /** Context for one tool call (signal, nested-call depth, artifact attribution). */
  forCall(callCtx: CallContext, toolName: string, observer?: FetchObserver): PackContext;
  /** Secret names this pack can actually read (declared, not denied, granted). */
  readonly allowedSecrets: readonly string[];
  /** Declared binary name → absolute path, or null when not installed / refused. */
  readonly binaries: ReadonlyMap<string, string | null>;
  /** Abort in-flight work and close pooled connections. Every capability throws afterwards. */
  dispose(): Promise<void>;
}

export const MAX_TOOL_DEPTH = 8;
const DEFAULT_SPAWN_TIMEOUT_MS = 60_000;
export const MAX_SPAWN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SPAWN_MAX_OUTPUT = 10 * 1024 * 1024;
export const MAX_SPAWN_OUTPUT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const OWN_LIST_SCAN = 2000;
/** Longest line handed to a spawn onStdout/onStderr callback. */
export const SPAWN_LINE_MAX = 8 * 1024;
const MATERIALIZE_DIR = ".materialized";

/** Extension a materialized copy gets when the stored path has none. */
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/mp4": ".m4a",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "application/json": ".json",
};

/** Splits a stream into lines for spawn callbacks (bounded, never throws). */
function lineSink(cb: (line: string) => void): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  const emit = (line: string) => {
    if (line.length === 0) return;
    try {
      cb(line);
    } catch {
      /* the callback's problem, not the child's */
    }
  };
  const drain = () => {
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop() ?? "";
    for (const p of parts) {
      for (let i = 0; i < p.length; i += SPAWN_LINE_MAX) emit(p.slice(i, i + SPAWN_LINE_MAX));
    }
    while (buf.length > SPAWN_LINE_MAX) {
      emit(buf.slice(0, SPAWN_LINE_MAX));
      buf = buf.slice(SPAWN_LINE_MAX);
    }
  };
  return {
    push(chunk) {
      buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
      drain();
    },
    end() {
      buf += decoder.end();
      drain();
      emit(buf);
      buf = "";
    },
  };
}

/** Types a browser would run or render as a document when served from the daemon origin. */
const ACTIVE_MIMES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
  "text/ecmascript",
  "text/css",
  "application/x-shockwave-flash",
]);
const SAFE_MIMES = new Set([
  "application/pdf",
  "application/json",
  "application/zip",
  "application/gzip",
  "application/octet-stream",
  "text/plain",
  "text/markdown",
  "text/csv",
]);
const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/**
 * What a declared mime is stored as: active content becomes text/plain,
 * anything not on the allow-list becomes application/octet-stream.
 */
export function storedMime(declared: unknown): { mime: string; declared: string | null } {
  const raw = typeof declared === "string" ? declared : "";
  const base = (raw.split(";")[0] ?? "").trim().toLowerCase();
  if (!MIME_SHAPE.test(base))
    return { mime: "application/octet-stream", declared: raw.slice(0, 100) };
  if (ACTIVE_MIMES.has(base)) return { mime: "text/plain", declared: base };
  if (SAFE_MIMES.has(base) || /^(image|video|audio)\//.test(base))
    return { mime: base, declared: null };
  return { mime: "application/octet-stream", declared: base };
}

/**
 * The directories a pack's child processes get instead of the daemon's own.
 * Each pack has a private HOME under its data folder, so a spawned program
 * (ffmpeg, pandoc, a TeX engine, ...) that follows "~" or an XDG default
 * lands in the pack's folder and not in the user's dotfiles. A pack that
 * declares `permissions.userHome` keeps the user's real HOME (and so the real
 * XDG defaults); its temporary files still go to the pack's folder.
 *
 * `dirs` are relative to the data folder and must exist (0700) before a spawn.
 */
export function packChildEnv(
  dataDir: string,
  userHome: boolean,
  realHome: string | undefined = homedir(),
  platform: NodeJS.Platform = process.platform,
): { env: Record<string, string>; dirs: string[] } {
  const tmp = join(dataDir, ".tmp");
  if (userHome && realHome) {
    const { APPDATA: _a, LOCALAPPDATA: _l, ...env } = homeEnv(realHome, tmp, platform);
    if (isWindows(platform)) {
      // The user's real per-user folders stay as they are.
      for (const name of ["APPDATA", "LOCALAPPDATA"] as const) {
        const v = process.env[name];
        if (v) env[name] = v;
      }
    }
    return { env, dirs: [".tmp"] };
  }
  const home = join(dataDir, ".home");
  return {
    env: {
      ...homeEnv(home, tmp, platform),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      TEXMFVAR: join(home, ".texmf-var"),
    },
    dirs: [
      ".home",
      ".tmp",
      join(".home", ".config"),
      join(".home", ".cache"),
      join(".home", ".local", "share"),
      join(".home", ".local", "state"),
      join(".home", ".texmf-var"),
      ...homeEnvDirs(platform).map((d) => join(".home", d)),
    ],
  };
}

const LOCALE_NAME = /^(LANG|LC_[A-Z]+)$/;

/**
 * The daemon's locale (LANG and LC_*), the only part of its own environment a
 * pack's child inherits, so programs read and print non-ASCII file names and
 * text the way the user's shell does.
 */
export function localeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (!LOCALE_NAME.test(name) || typeof value !== "string") continue;
    if (value.length === 0 || value.length > 128 || !/^[A-Za-z0-9_.@=;:/-]+$/.test(value)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Environment names a pack may not set for a child: they change what code runs.
 *
 * A child never inherits the daemon's environment: it gets exactly the
 * allowlist PATH (the daemon's, cleaned), HOME, TMPDIR, the pack's XDG
 * folders, the locale (localeEnv), and what the pack passes in `env` (its own
 * secrets or settings), minus the names below.
 */
const STRIPPED_ENV_NAMES = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "IFS",
  "CDPATH",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  // Code or trust loaded through these (OpenSSL engines, glibc tunables), a
  // proxy that reroutes the child's plain-http traffic, and a CA bundle that
  // replaces TLS trust. HOME is re-applied after the pack's env below, and is
  // stripped here too so the drop is explicit (the check is case-insensitive).
  "OPENSSL_ENGINES",
  "GLIBC_TUNABLES",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "OPENSSL_CONF",
  "HOME",
  // Windows: where the system and the per-user folders are.
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);
const STRIPPED_ENV_PREFIXES = ["LD_", "DYLD_", "PLUGHIVE_", "BASH_FUNC_"];

export function isStrippedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    STRIPPED_ENV_NAMES.has(upper) ||
    STRIPPED_ENV_PREFIXES.some((p) => upper.startsWith(p))
  );
}

const METADATA_HOSTS = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);
const EC2_V6 = parseIPv6("fd00:ec2::254");

function blockedV4(b: Uint8Array): boolean {
  // 169.254.0.0/16 (link-local, cloud metadata) and Alibaba's 100.100.100.200.
  return (
    (b[0] === 169 && b[1] === 254) || (b[0] === 100 && b[1] === 100 && b[2] === 100 && b[3] === 200)
  );
}

/**
 * Hosts no `localNetwork` grant can reach: link-local addresses
 * (169.254.0.0/16, fe80::/10, including IPv4-mapped forms) and the cloud
 * metadata endpoints. Accepts a hostname or an IP literal (brackets tolerated).
 */
export function isLinkLocalOrMetadataHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (METADATA_HOSTS.has(h)) return true;
  const bare = h.split("%")[0] ?? h;
  const v4 = parseIPv4(bare);
  if (v4) return blockedV4(v4);
  const v6 = parseIPv6(bare);
  if (!v6) return false;
  if (v6[0] === 0xfe && ((v6[1] ?? 0) & 0xc0) === 0x80) return true;
  if (EC2_V6 && v6.every((byte, i) => byte === EC2_V6[i])) return true;
  const mapped = v6.subarray(0, 10).every((x) => x === 0) && v6[10] === 0xff && v6[11] === 0xff;
  const compat = v6.subarray(0, 12).every((x) => x === 0);
  if (mapped || compat) return blockedV4(v6.subarray(12));
  return false;
}

function splitHostPort(entry: string): { host: string; port: number | null } {
  const at = entry.lastIndexOf(":");
  if (at <= 0 || entry.endsWith("]")) return { host: entry, port: null };
  const port = Number(entry.slice(at + 1));
  return Number.isInteger(port) ? { host: entry.slice(0, at), port } : { host: entry, port: null };
}

function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  return (parseIPv4(h) !== null || parseIPv6(h) !== null) && isPrivateAddress(h);
}

/** Loopback (127/8, ::1, localhost) or RFC 1918 (10/8, 172.16/12, 192.168/16). */
function isLoopbackOrRfc1918(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1") return true;
  const v4 = parseIPv4(h);
  if (!v4) return false;
  const [a = 0, b = 0] = v4;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Validate a `format: "local-endpoint"` setting value and return the
 * `host:port` localNetwork entry it grants. Throws a plain message (never
 * echoing more than the host) when the URL is not http(s), is not loopback or
 * RFC 1918, is link-local or a metadata address, or points at a daemon port.
 */
export function localEndpointEntry(value: string, daemonPorts: readonly number[]): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("is not a URL (for example http://127.0.0.1:8188)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("must be an http(s) URL");
  }
  if (url.username || url.password) throw new Error("must not carry a user name or password");
  const host = url.hostname.toLowerCase();
  if (isLinkLocalOrMetadataHost(host)) {
    throw new Error("points at a link-local or metadata address, which is always refused");
  }
  if (!isLoopbackOrRfc1918(host)) {
    throw new Error(
      "must be on this machine or your LAN (localhost, 127.x, 10.x, 172.16-31.x or 192.168.x)",
    );
  }
  const port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
  if (daemonPorts.includes(port)) {
    throw new Error("points at the plughive daemon's own port, which no pack may reach");
  }
  return `${host}:${port}`;
}

/**
 * Validate one entry of a `format: "folder-list"` setting and return its
 * canonical path (symlinks resolved). Throws a plain message when the entry
 * is not an absolute path to an existing folder, is the filesystem root or
 * the user's home folder itself, or lies inside the plughive home (where
 * secrets, other packs' data and the library live).
 */
export function spawnRootEntry(
  value: string,
  plugHiveHome: string | undefined,
  userHome: string = homedir(),
): string {
  const raw = value.trim().replace(/^~(?=$|[\\/])/, userHome);
  if (!isAbsolute(raw)) throw new Error(`"${value.slice(0, 200)}" is not an absolute path`);
  let real: string;
  try {
    real = realpathSync.native(raw);
  } catch {
    throw new Error(`"${value.slice(0, 200)}" does not exist`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`"${value.slice(0, 200)}" is not a folder`);
  if (resolve(real, "..") === real) throw new Error("the filesystem root is too broad");
  const realHome = (() => {
    try {
      return realpathSync.native(userHome);
    } catch {
      return resolve(userHome);
    }
  })();
  if (real === realHome)
    throw new Error("the home folder itself is too broad; name a project folder");
  if (plugHiveHome) {
    let store: string;
    try {
      store = realpathSync.native(plugHiveHome);
    } catch {
      store = resolve(plugHiveHome);
    }
    const rel = relative(store, real);
    const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    const rel2 = relative(real, store);
    const contains = rel2 === "" || (!rel2.startsWith("..") && !isAbsolute(rel2));
    if (inside || contains) throw new Error(`"${value.slice(0, 200)}" overlaps the plughive home`);
  }
  return real;
}

/** Live process groups started with killTree, killed if the daemon exits first. */
const liveTrees = new Set<number>();
let treeExitHook = false;

/** Kill a child and everything it started. Never throws. */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (isWindows()) {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    try {
      void loadExeca()
        .then(({ execa }) =>
          execa(join(root, "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], {
            reject: false,
            windowsHide: true,
            stdio: "ignore",
            extendEnv: false,
            env: { SystemRoot: root },
          }),
        )
        .catch(() => {});
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* the group is already gone */
  }
}

function hostAllowed(entries: readonly string[], url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "http:" ? "80" : "443");
  return entries.some((raw) => {
    const e = raw.toLowerCase();
    if (e === "*") return true;
    if (e.startsWith("*.")) return host.endsWith(e.slice(1));
    return e === host || e === `${host}:${port}`;
  });
}

function describeName(name: unknown): string {
  // Never echo something that does not look like a secret name: a caller may
  // have passed a value by mistake.
  return typeof name === "string" && SECRET_NAME_PATTERN.test(name) ? name : "(invalid name)";
}

function isInside(parent: string | undefined, child: string): boolean {
  if (!parent) return false;
  let root = resolve(parent);
  try {
    root = realpathSync.native(root);
  } catch {
    /* not there: compare lexically */
  }
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Absolute PATH entries only, without anything inside the pack or the plughive home. */
function safePathDirs(raw: string, forbidden: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const dir of splitPath(raw)) {
    if (!isAbsolute(dir)) continue;
    let real: string;
    try {
      real = realpathSync.native(dir);
    } catch {
      continue;
    }
    if (forbidden.some((f) => isInside(f, real))) continue;
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

function resolveBinary(
  name: string,
  dirs: readonly string[],
  forbidden: readonly (string | undefined)[],
): string | null {
  for (const dir of dirs) {
    for (const file of exeCandidates(name)) {
      const candidate = join(dir, file);
      try {
        const real = realpathSync.native(candidate);
        if (!statSync(real).isFile()) continue;
        // Windows has no execute bit; the PATHEXT match above stands in for it.
        if (!isWindows()) accessSync(real, fsConstants.X_OK);
        if (forbidden.some((f) => isInside(f, real))) continue;
        // .cmd/.bat need cmd.exe, which re-parses arguments: never run them.
        if (isBatchScript(real)) continue;
        return real;
      } catch {
        /* next candidate */
      }
    }
  }
  return null;
}

/**
 * `name` in the installer's tools/bin: its real path must be the locked one
 * (or, where the shim is a copy, the copy itself), never inside the
 * pack's folder or data folder, executable and not a batch script.
 */
function resolveTrusted(
  name: string,
  trusted: HostTrustedTools,
  forbidden: readonly (string | undefined)[],
): string | null {
  const locked = trusted.lockedTarget(name);
  if (!locked) return null;
  let binReal: string;
  try {
    binReal = realpathSync.native(trusted.binDir);
  } catch {
    return null;
  }
  for (const file of exeCandidates(name)) {
    try {
      const candidate = join(trusted.binDir, file);
      const real = realpathSync.native(candidate);
      // A copy in tools/bin (Windows, or a filesystem without symlinks); hashed before spawn.
      const copy = real === join(binReal, file);
      if (real !== locked && !copy) continue;
      if (!statSync(real).isFile()) continue;
      if (!isWindows()) accessSync(real, fsConstants.X_OK);
      if (forbidden.some((f) => isInside(f, real))) continue;
      if (isBatchScript(real)) continue;
      return real;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** Declared binaries, resolved on first use and again after the installer changes tools/. */
class LiveBinaries implements ReadonlyMap<string, string | null> {
  private cache = new Map<string, string | null>();
  constructor(
    private readonly names: readonly string[],
    private readonly resolveOne: (name: string) => string | null,
  ) {}
  clear(): void {
    this.cache.clear();
  }
  get(name: string): string | null | undefined {
    if (!this.names.includes(name)) return undefined;
    if (!this.cache.has(name)) this.cache.set(name, this.resolveOne(name));
    return this.cache.get(name) ?? null;
  }
  has(name: string): boolean {
    return this.names.includes(name);
  }
  get size(): number {
    return this.names.length;
  }
  *entries(): MapIterator<[string, string | null]> {
    for (const n of this.names) yield [n, this.get(n) ?? null];
  }
  *keys(): MapIterator<string> {
    yield* this.names;
  }
  *values(): MapIterator<string | null> {
    for (const n of this.names) yield this.get(n) ?? null;
  }
  [Symbol.iterator](): MapIterator<[string, string | null]> {
    return this.entries();
  }
  forEach(
    cb: (value: string | null, key: string, map: ReadonlyMap<string, string | null>) => void,
  ): void {
    for (const [k, v] of this.entries()) cb(v, k, this);
  }
}

function clampFinite(value: unknown, fallback: number, max: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`spawn ${what} must be a positive, finite number`);
  }
  return Math.min(Math.floor(value), max);
}

export function createPackContext(opts: CreatePackContextOptions): ScopedPackContext {
  const { manifest, dataDir, host } = opts;
  const id = manifest.id;
  const source: PackSource = opts.source ?? "builtin";
  const perms = manifest.permissions;
  const redactor = host.store.redactor;
  const lifetime = new AbortController();
  const settings = Object.freeze({ ...opts.settings });
  let disposed = false;
  const alive = () => {
    if (disposed) throw new PackDisposedError(id);
  };

  // --- logger --------------------------------------------------------------
  // `pack` is written last: a pack cannot log under another pack's identity.
  const log =
    (level: keyof HostLogger) =>
    (msg: string, data?: Record<string, unknown>): void => {
      alive();
      host.logger[level](
        redactor.redactDeep({ ...data, pack: id }) as Record<string, unknown>,
        redactor.redact(String(msg)),
      );
    };
  const logger: PackLogger = {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };

  // --- secrets -------------------------------------------------------------
  const declared = new Map(manifest.secrets.map((s) => [s.name, s]));
  const granted = new Set(opts.grants ?? []);
  const allowed = new Set(
    [...declared.keys()].filter(
      (name) => secretNameAllowed(name, source) && (source === "builtin" || granted.has(name)),
    ),
  );
  // The environment provides a value only to a pack shipped with plughive,
  // and only while that pack is loaded. A user pack reads what the user
  // stored, never what the daemon inherited from the shell that started it.
  const fromEnvironment = source === "builtin";
  const secretOwner = {};
  if (fromEnvironment) host.store.declareNames(allowed, secretOwner);

  const usable = (name: string) => {
    alive();
    const decl = typeof name === "string" ? declared.get(name) : undefined;
    if (!decl) {
      throw new PackPermissionError(
        id,
        `secret ${describeName(name)} is not declared in pack.json "secrets"`,
      );
    }
    if (isDeniedSecretName(decl.name)) {
      throw new PackPermissionError(id, `${decl.name} is not a name packs may read`, "denied");
    }
    if (!secretNameAllowed(decl.name, source)) {
      throw new PackPermissionError(
        id,
        `${decl.name} is not a name a user pack may read (declare a name of the pack's own)`,
        "denied",
      );
    }
    if (!allowed.has(decl.name)) {
      throw new PackPermissionError(
        id,
        `secret ${decl.name} was not granted to this pack (enable the pack again and grant it)`,
        "secret_not_granted",
      );
    }
    return decl;
  };
  const secrets: PackContext["secrets"] = {
    async get(name) {
      const decl = usable(name);
      const value = fromEnvironment
        ? await host.store.get(decl.name)
        : await host.store.getStored(decl.name);
      if (value === null || value === "") {
        throw new MissingSecretError({
          pack: id,
          name: decl.name,
          ...(decl.label !== undefined ? { label: decl.label } : {}),
          ...(decl.helpUrl !== undefined ? { helpUrl: decl.helpUrl } : {}),
        });
      }
      return value;
    },
    async has(name) {
      const decl = usable(name);
      return fromEnvironment ? host.store.has(decl.name) : host.store.hasStored(decl.name);
    },
  };

  // --- fetch ---------------------------------------------------------------
  const daemonPorts = new Set(host.daemonPorts ?? []);
  // User-granted endpoints must be a local name or private address with a
  // port. Declared entries get the same test: only a local name (localhost
  // or a private IP literal) may be reached locally, never a hostname the
  // pack made up. All entries lose link-local, metadata and the daemon's own
  // port.
  const grantedLocal = (opts.extraLocalNetwork ?? []).filter((entry) => {
    const { host: h, port } = splitHostPort(String(entry));
    return port !== null && isLocalName(h);
  });
  const localEntries = [...new Set([...perms.localNetwork, ...grantedLocal])].filter((entry) => {
    const { host: h, port } = splitHostPort(entry);
    const drop =
      !isLocalName(h) || isLinkLocalOrMetadataHost(h) || (port !== null && daemonPorts.has(port));
    if (drop) {
      host.logger.warn(
        { pack: id, entry },
        "localNetwork entry ignored: not a local name, link-local, metadata or the daemon's own port",
      );
    }
    return !drop;
  });
  const hasNetwork = perms.network.length > 0 || localEntries.length > 0;
  const baseLookup =
    host.fetchPolicy?.lookup ??
    (async (hostname: string): Promise<LookupAddress[]> =>
      (await dnsLookup(hostname, { all: true })) as LookupAddress[]);
  // Created once. After dispose it is closed and never rebuilt.
  const safeFetch: SafeFetch | null =
    hasNetwork && !host.fetchImpl
      ? createSafeFetch({
          ...host.fetchPolicy,
          allowHosts: [...perms.network],
          ...(localEntries.length > 0 ? { allowLocal: localEntries } : {}),
          redirectHeaderAllowlist: [
            ...(host.fetchPolicy?.redirectHeaderAllowlist ?? []),
            PACK_MARKER_HEADER,
          ],
          // Runs before every connection (pre-flight and connect time), on
          // every hop: what the name resolves to decides, not what it reads.
          lookup: async (hostname, target) => {
            const addrs = await baseLookup(hostname);
            if (addrs.some((a) => isLinkLocalOrMetadataHost(a.address))) {
              throw new PackPermissionError(
                id,
                "the host resolves to a link-local or metadata address",
                "denied",
              );
            }
            if (
              target !== undefined &&
              daemonPorts.has(target.port) &&
              addrs.some((a) => isPrivateAddress(a.address))
            ) {
              throw new PackPermissionError(
                id,
                "the host resolves to this machine or the local network on the daemon's own port",
                "denied",
              );
            }
            return addrs;
          },
        })
      : null;

  const fetchWith = (signal: AbortSignal, observer?: FetchObserver): PackContext["fetch"] => {
    return async (input, rawInit?: PackFetchInit) => {
      alive();
      const { timeoutMs: rawTimeout, ...init } = rawInit ?? {};
      if (
        rawTimeout !== undefined &&
        (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0)
      ) {
        throw new TypeError("fetch timeoutMs must be a positive, finite number");
      }
      const timeoutMs = Math.min(
        Math.floor(rawTimeout ?? FETCH_DEFAULT_TIMEOUT_MS),
        FETCH_MAX_TIMEOUT_MS,
      );
      let url: URL | null = null;
      try {
        url = new URL(input instanceof Request ? input.url : String(input));
      } catch {
        url = null;
      }
      // Hard denials come first, so they read the same whatever is declared.
      if (url && isLinkLocalOrMetadataHost(url.hostname)) {
        throw new PackPermissionError(
          id,
          "link-local and cloud metadata addresses are never reachable",
          "denied",
        );
      }
      const port = url ? Number(url.port || (url.protocol === "http:" ? 80 : 443)) : 0;
      if (url && daemonPorts.has(port) && isLocalName(url.hostname)) {
        throw new PackPermissionError(id, "the daemon's own port is not reachable", "denied");
      }
      if (!hasNetwork) {
        throw new PackPermissionError(
          id,
          "network access is not declared (permissions.network in pack.json)",
        );
      }
      if (!url) throw new TypeError("fetch: invalid URL");
      // The marker is set last, on a fresh Headers object: a pack cannot drop
      // or spoof it.
      const headers = new Headers(
        init.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set(PACK_MARKER_HEADER, id);
      // The deadline covers the whole exchange: aborting the signal after the
      // headers arrived also errors the body stream.
      const deadline = AbortSignal.timeout(timeoutMs);
      const merged = AbortSignal.any(
        init.signal ? [init.signal, signal, deadline] : [signal, deadline],
      );
      const finalInit = { ...init, headers, signal: merged };
      const method = (
        init.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      let response: Response;
      if (host.fetchImpl && !hostAllowed(perms.network, url) && !hostAllowed(localEntries, url)) {
        throw new PackPermissionError(
          id,
          `host ${url.host} is not declared in permissions.network`,
        );
      }
      try {
        observer?.onRequest?.({ method });
      } catch {
        /* observers never break a fetch */
      }
      try {
        response = host.fetchImpl
          ? await host.fetchImpl(input, finalInit)
          : await (safeFetch as SafeFetch)(input, finalInit);
      } catch (err) {
        try {
          observer?.onError?.({ method, error: err });
        } catch {
          /* observers never break a fetch */
        }
        throw err;
      }
      try {
        observer?.onResponse?.({ method, status: response.status, headers: response.headers });
      } catch {
        /* observers never break a fetch */
      }
      return response;
    };
  };

  // --- spawn ---------------------------------------------------------------
  // Declared binaries are resolved on first use (and again after the installer
  // changes tools/), on a PATH the daemon controls; the child is then started
  // by absolute path. Anything that resolves into the pack's own folder or the
  // plughive home is refused: a pack must not ship (or drop) the program it
  // then asks to run. The one exception is the installer's tools/bin, whose
  // programs are pinned in tools/lock.json and re-hashed before every run.
  const forbiddenRoots = [opts.packDir, opts.home, dataDir];
  const pathDirs = safePathDirs(
    host.spawnPath ?? process.env.PATH ?? process.env.Path ?? defaultSystemPath(),
    forbiddenRoots,
  );
  const childPath = joinPath(pathDirs) || defaultSystemPath();
  const childSystem = systemChildEnv();
  const trusted = host.spawnImpl ? undefined : host.trustedTools;
  const trustedPaths = new Set<string>();
  const binaries = new LiveBinaries(perms.spawn, (name) => {
    if (host.spawnImpl) return name;
    const managed = trusted ? resolveTrusted(name, trusted, [opts.packDir, dataDir]) : null;
    if (managed) {
      trustedPaths.add(managed);
      return managed;
    }
    return resolveBinary(name, pathDirs, forbiddenRoots);
  });
  const unsubscribeTools = trusted?.subscribe(() => binaries.clear());

  // HOME, TMPDIR and the XDG folders of every child: the pack's own, unless
  // the manifest asks for the user's HOME. Made on first use, each checked to
  // resolve inside the data folder (a symlink planted there cannot point the
  // child's HOME back at the real one).
  const childBase = packChildEnv(dataDir, perms.userHome === true);
  const childLocale = localeEnv();
  const prepareChildDirs = (): void => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const root = realpathSync.native(dataDir);
    for (const rel of childBase.dirs) {
      const dir = resolveInside(dataDir, rel);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (realpathSync.native(dir) !== join(root, rel)) {
        throw new SpawnError("not_started", `the pack's ${rel} folder is not a plain directory`);
      }
      chmodSync(dir, 0o700);
    }
  };

  // Folders the user let this pack's children work in (already canonical).
  const spawnRoots = [...(opts.extraSpawnRoots ?? [])];
  const spawnCwd = (requested: string | undefined): string => {
    if (typeof requested === "string" && isAbsolute(requested) && spawnRoots.length > 0) {
      for (const root of spawnRoots) {
        try {
          return resolveInside(root, requested);
        } catch {
          /* try the next root */
        }
      }
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    return resolveInside(dataDir, requested ?? ".");
  };

  // The folder a declared program was installed into (the files it ships
  // beside itself, such as Real-ESRGAN's models). For an plughive install it
  // is the install folder from the lock, also when tools/bin holds a copy.
  const programDir: PackContext["programDir"] = (binary) => {
    alive();
    if (typeof binary !== "string" || !perms.spawn.includes(binary)) {
      throw new PackPermissionError(
        id,
        `binary ${typeof binary === "string" ? `"${binary.slice(0, 64)}"` : "(invalid)"} is not declared in permissions.spawn`,
      );
    }
    if (host.spawnImpl) return null;
    const absolute = binaries.get(binary) ?? null;
    if (!absolute) return null;
    if (trustedPaths.has(absolute)) {
      const locked = trusted?.lockedTarget(binary);
      return locked ? dirname(locked) : null;
    }
    try {
      return dirname(realpathSync.native(absolute));
    } catch {
      return null;
    }
  };

  const spawnWith = (signal: AbortSignal): PackContext["spawn"] => {
    return async (binary, args, spawnOpts: SpawnOptions = {}): Promise<SpawnResult> => {
      alive();
      if (typeof binary !== "string" || !perms.spawn.includes(binary)) {
        throw new PackPermissionError(
          id,
          `binary ${typeof binary === "string" ? `"${binary.slice(0, 64)}"` : "(invalid)"} is not declared in permissions.spawn`,
        );
      }
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
        throw new TypeError("spawn args must be an array of strings");
      }
      const timeoutMs = clampFinite(
        spawnOpts.timeoutMs,
        DEFAULT_SPAWN_TIMEOUT_MS,
        MAX_SPAWN_TIMEOUT_MS,
        "timeoutMs",
      );
      const maxBuffer = clampFinite(
        spawnOpts.maxOutputBytes,
        DEFAULT_SPAWN_MAX_OUTPUT,
        MAX_SPAWN_OUTPUT_BYTES,
        "maxOutputBytes",
      );
      // cwd never leaves the pack's data dir (symlinks resolved), or a
      // folder the user listed in a folder-list setting.
      const cwd = spawnCwd(spawnOpts.cwd);
      const killTree = spawnOpts.killTree === true;
      const env: Record<string, string> = {};
      const dropped: string[] = [];
      for (const [k, v] of Object.entries(spawnOpts.env ?? {})) {
        if (isStrippedEnvName(k) || typeof v !== "string") dropped.push(k.slice(0, 64));
        else env[k] = v;
      }
      if (dropped.length > 0) {
        host.logger.warn(
          { pack: id, binary, dropped },
          "spawn: environment names a pack may not set were dropped",
        );
      }
      const clean: SpawnOptions = {
        cwd,
        timeoutMs,
        maxOutputBytes: maxBuffer,
        env,
        ...(spawnOpts.input !== undefined ? { input: spawnOpts.input } : {}),
        ...(killTree ? { killTree: true } : {}),
      };

      const onStdout = typeof spawnOpts.onStdout === "function" ? spawnOpts.onStdout : undefined;
      const onStderr = typeof spawnOpts.onStderr === "function" ? spawnOpts.onStderr : undefined;

      if (host.spawnImpl) {
        const r = await host.spawnImpl(binary, args, clean);
        const out = {
          stdout: r.stdout ?? "",
          stderr: r.stderr ?? "",
          exitCode: r.exitCode ?? 0,
          timedOut: r.timedOut ?? false,
          truncated: r.truncated ?? false,
        };
        // Test seam: replay the recorded output through the line callbacks.
        for (const [cb, text] of [
          [onStdout, out.stdout],
          [onStderr, out.stderr],
        ] as const) {
          if (!cb) continue;
          const sink = lineSink(cb);
          sink.push(text);
          sink.end();
        }
        return out;
      }

      const absolute = binaries.get(binary) ?? null;
      if (!absolute) {
        throw new SpawnError(
          "not_installed",
          `"${binary}" is not installed (not found on the daemon's PATH). Install it, then restart the daemon or re-enable the "${id}" pack.`,
        );
      }
      if (trustedPaths.has(absolute) && !(await trusted?.verify(binary, absolute))) {
        host.logger.warn(
          { pack: id, binary },
          "spawn: installed program failed its integrity check",
        );
        throw new SpawnError(
          "not_started",
          `"${binary}" in plughive's tools folder failed its integrity check (it changed after it was installed). Reinstall it from the Software page.`,
        );
      }
      const { execa } = await loadExeca();
      if (signal.aborted) throw new SpawnError("cancelled", `${binary} was cancelled`);
      prepareChildDirs();
      const subprocess = execa(absolute, [...args], {
        shell: false,
        reject: false,
        // killTree: our own timer kills the whole group (execa's timeout
        // would signal the direct child only and wait on its helpers).
        ...(killTree ? {} : { timeout: timeoutMs }),
        maxBuffer,
        ...(killTree ? { detached: !isWindows(), windowsHide: true } : {}),
        extendEnv: false,
        env: {
          ...childSystem,
          ...childLocale,
          ...childBase.env,
          ...env,
          PATH: childPath,
          HOME: childBase.env.HOME as string,
        },
        cwd,
        ...(spawnOpts.input !== undefined
          ? { input: spawnOpts.input }
          : { stdin: "ignore" as const }),
        cancelSignal: signal,
        stripFinalNewline: false,
      });
      let treeTimedOut = false;
      let treeTruncated = false;
      let treeTimer: NodeJS.Timeout | undefined;
      let onTreeAbort: (() => void) | undefined;
      const treePid = subprocess.pid;
      if (killTree && treePid !== undefined) {
        liveTrees.add(treePid);
        if (!treeExitHook) {
          treeExitHook = true;
          process.once("exit", () => {
            for (const pid of liveTrees) killProcessTree(pid);
          });
        }
        treeTimer = setTimeout(() => {
          treeTimedOut = true;
          killProcessTree(treePid);
        }, timeoutMs);
        treeTimer.unref?.();
        onTreeAbort = () => killProcessTree(treePid);
        signal.addEventListener("abort", onTreeAbort, { once: true });
        // Output cap: execa stops the direct child; the helpers it started
        // may still hold the pipes open, so the group goes too.
        for (const stream of [subprocess.stdout, subprocess.stderr]) {
          let seen = 0;
          stream?.on("data", (chunk: Buffer | string) => {
            seen += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
            if (seen > maxBuffer && !treeTruncated) {
              treeTruncated = true;
              killProcessTree(treePid);
            }
          });
        }
      }
      // Extra 'data' listeners see the same chunks execa buffers.
      const sinks: { end(): void }[] = [];
      for (const [cb, stream] of [
        [onStdout, subprocess.stdout],
        [onStderr, subprocess.stderr],
      ] as const) {
        if (!cb || !stream) continue;
        const sink = lineSink(cb);
        stream.on("data", (chunk: Buffer | string) => sink.push(chunk));
        sinks.push(sink);
      }
      const result = await subprocess;
      if (killTree && treePid !== undefined) {
        clearTimeout(treeTimer);
        if (onTreeAbort) signal.removeEventListener("abort", onTreeAbort);
        // Whatever the child left running goes with it.
        killProcessTree(treePid);
        liveTrees.delete(treePid);
      }
      for (const sink of sinks) sink.end();
      const stdout = String(result.stdout ?? "");
      const stderr = String(result.stderr ?? "");
      if (result.timedOut || treeTimedOut)
        return { stdout, stderr, exitCode: -1, timedOut: true, truncated: false };
      if (result.isMaxBuffer || treeTruncated) {
        return { stdout, stderr, exitCode: -1, timedOut: false, truncated: true };
      }
      if (result.isCanceled) throw new SpawnError("cancelled", `${binary} was cancelled`);
      if (result.exitCode === undefined) {
        const code = (result as { code?: string }).code;
        if (result.signal) {
          return { stdout, stderr, exitCode: -1, timedOut: false, truncated: false };
        }
        throw new SpawnError("not_started", `could not start ${binary}${code ? ` (${code})` : ""}`);
      }
      return { stdout, stderr, exitCode: result.exitCode, timedOut: false, truncated: false };
    };
  };

  // --- library -------------------------------------------------------------
  const canWrite = perms.library === "write" || perms.library === "full";
  const canReadAll = perms.library === "read-all" || perms.library === "full";
  const maxArtifactBytes = host.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const ownPrefix = `${id}/`;
  const needLibrary = (write: boolean) => {
    alive();
    if (perms.library === "none" || (write && !canWrite)) {
      throw new PackPermissionError(
        id,
        `library ${write ? "write" : "read"} access is not declared (permissions.library is "${perms.library}")`,
      );
    }
    if (!host.library) throw new Error("the artifact library is not available");
    return host.library;
  };
  const visible = (a: HostArtifact) => canReadAll || a.tool.startsWith(ownPrefix);
  const urlOf = (lib: HostLibrary, artifactId: string) =>
    lib.urlFor?.(artifactId) ?? `/artifacts/${artifactId}`;
  const toRecord = (lib: HostLibrary, a: HostArtifact): ArtifactRecord => ({
    id: a.id,
    kind: a.kind,
    mime: a.mime,
    url: urlOf(lib, a.id),
    bytes: a.bytes,
    tool: a.tool,
    model: a.model,
    prompt: a.prompt,
    meta: a.meta,
    costUsd: a.costUsd,
    createdAt: a.createdAt,
  });
  // The host mints the URL (signed when the daemon requires an access key).
  const toRef = (lib: HostLibrary, r: HostArtifactRef): ArtifactRef => ({
    id: r.id,
    url: lib.urlFor ? lib.urlFor(r.id) : r.url,
    mime: r.mime,
    model: r.model ?? null,
    costUsd: r.costUsd ?? r.cost_usd ?? null,
    prompt: r.prompt ?? null,
    ...(r.bytes !== undefined ? { bytes: r.bytes } : {}),
  });
  // Materialized copies still on disk; removed on dispose.
  const materialized = new Set<string>();
  const removeCopy = async (path: string) => {
    materialized.delete(path);
    await rm(path, { force: true }).catch(() => undefined);
  };

  const libraryFor = (toolName: string): PackContext["library"] => {
    type StoreInput = {
      kind: unknown;
      mime: unknown;
      model?: string | null;
      prompt?: string | null;
      meta?: Record<string, unknown> | null;
      costUsd?: number | null;
    };
    const normalise = (input: StoreInput): Omit<HostSaveInput, "bytes"> => {
      if (!ARTIFACT_KINDS.includes(input.kind as ArtifactKind)) {
        throw new TypeError(`library: kind must be one of ${ARTIFACT_KINDS.join(", ")}`);
      }
      const { mime, declared: declaredMime } = storedMime(input.mime);
      const meta =
        declaredMime !== null ? { ...(input.meta ?? {}), declaredMime } : (input.meta ?? null);
      return {
        kind: input.kind as ArtifactKind,
        mime,
        // Attribution is the host's: `<pack id>/<tool that is running>`.
        tool: `${id}/${toolName}`,
        model: input.model ?? null,
        prompt: input.prompt ?? null,
        meta,
        costUsd:
          typeof input.costUsd === "number" && Number.isFinite(input.costUsd)
            ? input.costUsd
            : null,
      };
    };
    const store = (lib: HostLibrary, input: StoreInput, bytes: Buffer): ArtifactRef => {
      const row = normalise(input);
      if (bytes.byteLength > maxArtifactBytes) {
        throw new RangeError(`library: artifact is larger than ${maxArtifactBytes} bytes`);
      }
      return toRef(lib, lib.save({ ...row, bytes }));
    };
    const readable = (lib: HostLibrary, artifactId: unknown): HostArtifact => {
      const a = lib.get(String(artifactId));
      if (!a || !visible(a))
        throw new Error(`artifact not found: ${String(artifactId).slice(0, 64)}`);
      return a;
    };
    return {
      async get(artifactId) {
        const lib = needLibrary(false);
        const a = lib.get(String(artifactId));
        return a && visible(a) ? toRecord(lib, a) : null;
      },
      async list(filter = {}) {
        const lib = needLibrary(false);
        const { limit: rawLimit, tool, ...rest } = filter;
        const limit = Math.max(1, Math.min(Math.floor(Number(rawLimit ?? 50)) || 50, 500));
        if (canReadAll) {
          return lib
            .list({ ...rest, ...(tool !== undefined ? { tool } : {}) }, limit)
            .map((a) => toRecord(lib, a));
        }
        if (tool !== undefined) {
          const full = tool.startsWith(ownPrefix) ? tool : `${ownPrefix}${tool}`;
          return lib
            .list({ ...rest, tool: full }, limit)
            .filter(visible)
            .map((a) => toRecord(lib, a));
        }
        // The library filters by exact tool only: scan recent rows and keep ours.
        return lib
          .list(rest, OWN_LIST_SCAN)
          .filter(visible)
          .slice(0, limit)
          .map((a) => toRecord(lib, a));
      },
      async read(artifactId) {
        const lib = needLibrary(false);
        const a = readable(lib, artifactId);
        if (lib.readBytes) return new Uint8Array(await lib.readBytes(a.id));
        return new Uint8Array(await readFile(a.path));
      },
      async materialize(artifactId, mopts = {}): Promise<MaterializedArtifact> {
        const lib = needLibrary(false);
        const a = readable(lib, artifactId);
        const sub = mopts.dir ?? MATERIALIZE_DIR;
        if (typeof sub !== "string" || sub.length === 0) {
          throw new TypeError("library.materialize: dir must be a non-empty string");
        }
        // dataDir is kernel-assigned; a pack that never wrote files may not have one yet.
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        // The folder must resolve inside dataDir (no "..", no symlinked parent).
        const dir = resolveInside(dataDir, sub);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        resolveInside(dataDir, relative(realpathSync.native(dataDir), dir) || ".");
        const stored = extname(a.path).toLowerCase();
        const ext = /^\.[a-z0-9]{1,8}$/.test(stored) ? stored : (MIME_EXT[a.mime] ?? ".bin");
        const name = `${a.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${randomBytes(6).toString("hex")}${ext}`;
        const rel = join(relative(realpathSync.native(dataDir), dir), name);
        const dest = resolveInside(dataDir, rel);

        let done = false;
        if (!lib.readBytes) {
          // The stored file must be a regular file (never follow a link there).
          const info = await lstat(a.path);
          if (!info.isFile()) throw new Error(`artifact not found: ${a.id.slice(0, 64)}`);
          try {
            // Copy-on-write clone; EXCL: never write through an existing entry.
            await copyFile(
              a.path,
              dest,
              fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE,
            );
            done = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
            await rm(dest, { force: true }).catch(() => undefined);
          }
        }
        if (!done) {
          // Fresh file (O_EXCL, O_NOFOLLOW), checked to be inside dataDir.
          const out = await openInside(dataDir, rel, {
            flags: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
            mode: 0o600,
          });
          try {
            if (lib.readBytes) {
              await out.writeFile(await lib.readBytes(a.id));
            } else {
              const src = await open(a.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
              try {
                // Positional reads and writes, not streams: a FileHandle stream
                // made with autoClose:false keeps a reference that close() then
                // waits on forever (Node 26), and the handle is later closed by
                // the garbage collector, which crashes the process.
                const buffer = Buffer.allocUnsafe(1024 * 1024);
                let pos = 0;
                for (;;) {
                  lifetime.signal.throwIfAborted();
                  const { bytesRead } = await src.read(buffer, 0, buffer.length, pos);
                  if (bytesRead === 0) break;
                  let written = 0;
                  while (written < bytesRead) {
                    const res = await out.write(
                      buffer,
                      written,
                      bytesRead - written,
                      pos + written,
                    );
                    written += res.bytesWritten;
                  }
                  pos += bytesRead;
                }
              } finally {
                await src.close().catch(() => undefined);
              }
            }
          } catch (err) {
            await out.close().catch(() => undefined);
            await rm(dest, { force: true }).catch(() => undefined);
            throw err;
          }
          await out.close();
        }
        // Re-check what landed: a regular file, inside dataDir, then read-only.
        const check = await openInside(dataDir, rel);
        let bytes: number;
        try {
          bytes = (await check.stat()).size;
          await check.chmod(0o400);
        } finally {
          await check.close().catch(() => undefined);
        }
        materialized.add(dest);
        let cleaned = false;
        return {
          path: dest,
          bytes,
          mime: a.mime,
          async cleanup() {
            if (cleaned) return;
            cleaned = true;
            await removeCopy(dest);
          },
        };
      },
      async save(input) {
        const lib = needLibrary(true);
        if (!(input?.bytes instanceof Uint8Array)) {
          throw new TypeError("library.save: bytes must be a Uint8Array");
        }
        return store(lib, input, Buffer.from(input.bytes));
      },
      async importFile(input) {
        const lib = needLibrary(true);
        // Only a regular file the pack produced in its own data dir: opened
        // without following symlinks, hard links refused, read through the
        // descriptor that was checked, with the size cap enforced while reading.
        const row = normalise(input);
        const handle = await openInside(dataDir, input.sourcePath);
        try {
          if (lib.importHandle) {
            const info = await handle.stat();
            if (info.size > maxArtifactBytes) {
              throw new RangeError(`library: artifact is larger than ${maxArtifactBytes} bytes`);
            }
            // Streamed: never held in memory. The library enforces the cap
            // while copying (the file may still be growing).
            return toRef(lib, await lib.importHandle(row, handle, maxArtifactBytes));
          }
          const bytes = await readFileCapped(handle, { maxBytes: maxArtifactBytes });
          return toRef(lib, lib.save({ ...row, bytes }));
        } finally {
          await handle.close().catch(() => undefined);
        }
      },
    };
  };

  // --- llm -----------------------------------------------------------------
  /** ctx.llm.chat through a `chat` provider; null when none can take it. */
  const chatViaCapability = async (
    req: LlmChatRequest,
    callCtx: CallContext,
    signal: AbortSignal,
    toolName: string,
  ): Promise<LlmChatResult | null> => {
    const caps = host.capabilities;
    if (!caps?.has("chat")) return null;
    try {
      const out = (await caps.run(
        "chat",
        {
          messages: req.messages,
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
        {},
        { pack: id, depth: (callCtx.depth ?? 0) + 1, signal, tool: toolName },
      )) as { text: string; model: string; cost_usd?: number | null };
      return {
        text: out.text,
        model: out.model,
        costUsd: typeof out.cost_usd === "number" ? out.cost_usd : null,
      };
    } catch (err) {
      // No configured provider (or none serves the requested model): keep
      // the old path when there is one.
      const code = (err as { code?: unknown }).code;
      if (host.llm && (code === "NO_PROVIDER" || code === "NO_PROVIDER_FOR_MODEL")) return null;
      throw err;
    }
  };

  const llmWith = (
    signal: AbortSignal,
    toolName: string,
    callCtx: CallContext,
  ): PackContext["llm"] => ({
    async chat(req) {
      alive();
      if (!perms.llm) {
        throw new PackPermissionError(
          id,
          "llm access is not declared (permissions.llm in pack.json)",
        );
      }
      if (!host.llm && !host.capabilities?.has("chat")) {
        throw new Error("no LLM provider is configured");
      }
      if (signal.aborted) throw new Error("llm.chat was cancelled");
      const start = Date.now();
      const meta = { caller: id, tool: toolName, model: req?.model ?? null };
      try {
        const routed = await chatViaCapability(req, callCtx, signal, toolName);
        if (!routed && !host.llm) throw new Error("no LLM provider is configured");
        const out = routed ?? (await (host.llm as HostLlm)(req, signal));
        const latencyMs = Date.now() - start;
        host.logger.info({ pack: id, tool: toolName, model: out.model, latencyMs }, "llm.chat");
        host.usage?.record({
          tool: "llm.chat",
          costUsd: out.costUsd ?? null,
          latencyMs,
          status: "ok",
          meta: { ...meta, model: out.model },
        });
        return out;
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = redactor.redact(err instanceof Error ? err.message : String(err));
        host.logger.warn(
          { pack: id, tool: toolName, latencyMs, error: message },
          "llm.chat failed",
        );
        host.usage?.record({ tool: "llm.chat", latencyMs, status: "error", error: message, meta });
        // The message is redacted; the provider's error code (RATE_LIMITED,
        // NO_PROVIDER, ...) is kept so the pack can tell the cases apart.
        const failure = new Error(message) as Error & { code?: string };
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) failure.code = code;
        throw failure;
      }
    },
  });

  // --- tools ---------------------------------------------------------------
  const toolsWith = (callCtx: CallContext, signal: AbortSignal): PackContext["tools"] => ({
    async call(requested, args = {}) {
      alive();
      if (typeof requested !== "string") throw new TypeError("tools.call: name must be a string");
      if (!host.tools) throw new Error("the tool registry is not available");
      let name = requested;
      if (requested.startsWith("cap:")) {
        if (!perms.tools.includes(requested)) {
          throw new PackPermissionError(
            id,
            `the capability "${requested.slice(0, 80)}" is not declared in permissions.tools`,
          );
        }
        const capability = requested.slice(4);
        // A routed capability goes through the capability router, the same
        // path as ctx.capabilities.run: explicit provider, then the user's
        // preference, then priority. Which pack loaded first plays no part.
        if (isCapabilityName(capability) && host.capabilities?.has(capability)) {
          const capDepth = (callCtx.depth ?? 0) + 1;
          if (capDepth > MAX_TOOL_DEPTH) {
            throw new Error(`tool call nesting deeper than ${MAX_TOOL_DEPTH}`);
          }
          return await host.capabilities.run(
            capability,
            args,
            {},
            {
              pack: id,
              depth: capDepth,
              signal,
              tool: "tools.call",
              ...(callCtx.progress ? { progress: callCtx.progress } : {}),
            },
          );
        }
        const resolved = host.tools.resolveCapability?.(capability);
        if (!resolved)
          throw new Error(`no tool provides the capability "${requested.slice(4, 84)}"`);
        name = resolved;
      } else {
        const target = host.tools.get(name);
        const allowedCall =
          perms.tools.includes(name) ||
          (target !== undefined &&
            // Mounted servers and the daemon's own tools are named one by one.
            ((!isReservedPackId(target.packId) && perms.tools.includes(`pack:${target.packId}`)) ||
              (target.capability !== undefined &&
                perms.tools.includes(`cap:${target.capability}`))));
        if (!allowedCall) {
          throw new PackPermissionError(
            id,
            `calling the tool "${name.slice(0, 80)}" is not declared in permissions.tools`,
          );
        }
      }
      const depth = (callCtx.depth ?? 0) + 1;
      if (depth > MAX_TOOL_DEPTH) {
        throw new Error(`tool call nesting deeper than ${MAX_TOOL_DEPTH}`);
      }
      // One path for every call: the registry validates, redacts, logs and
      // meters it with this pack recorded as the caller.
      const envelope = await host.tools.call(name, args, { depth, caller: id, signal });
      if (envelope.ok) return envelope.result;
      const e = envelope.error;
      if (e.code === "MISSING_SECRET" && e.pack && e.secret) {
        throw new MissingSecretError({
          pack: e.pack,
          name: e.secret,
          ...(e.label !== undefined ? { label: e.label } : {}),
          ...(e.helpUrl !== undefined ? { helpUrl: e.helpUrl } : {}),
        });
      }
      // Spend policy errors keep their class: an outer call reports the same code and link.
      if (isPolicyErrorCode(e.code)) throw new PolicyError(e.message, e.code, e.approval);
      const err = new Error(e.message) as Error & { code?: string };
      err.code = e.code;
      throw err;
    },
    // Whether the caller of the running tool may use `name` itself (profile
    // exposure). Host code and the default profile may use everything.
    allowedForCaller: (name) => currentScopeAllows(name),
  });

  // --- capabilities ---------------------------------------------------------
  const needCapability = (capability: unknown): CapabilityName => {
    alive();
    if (!isCapabilityName(capability)) {
      throw new TypeError(`capabilities: unknown capability "${String(capability).slice(0, 40)}"`);
    }
    if (!perms.tools.includes(`cap:${capability}`)) {
      throw new PackPermissionError(
        id,
        `the capability "${capability}" is not declared in permissions.tools (add "cap:${capability}")`,
      );
    }
    if (!host.capabilities) throw new Error("capability routing is not available");
    return capability;
  };
  const capabilitiesWith = (
    callCtx: CallContext,
    signal: AbortSignal,
    toolName: string,
  ): PackCapabilities => ({
    async run(capability, input, runOpts) {
      const cap = needCapability(capability);
      const depth = (callCtx.depth ?? 0) + 1;
      if (depth > MAX_TOOL_DEPTH)
        throw new Error(`tool call nesting deeper than ${MAX_TOOL_DEPTH}`);
      const o: CapabilityRunOptions = {};
      if (typeof runOpts?.provider === "string") o.provider = runOpts.provider;
      if (typeof runOpts?.model === "string") o.model = runOpts.model;
      if (typeof runOpts?.maxCostUsd === "number") o.maxCostUsd = runOpts.maxCostUsd;
      if (runOpts?.cache === false) o.cache = false;
      // The router validated the output against the capability schema.
      return (await (host.capabilities as HostCapabilities).run(cap, input, o, {
        pack: id,
        depth,
        signal,
        tool: toolName,
        ...(callCtx.progress ? { progress: callCtx.progress } : {}),
      })) as never;
    },
    async list(capability) {
      if (capability !== undefined) {
        const cap = needCapability(capability);
        return (host.capabilities as HostCapabilities).list(cap);
      }
      alive();
      if (!host.capabilities) throw new Error("capability routing is not available");
      // Only the capabilities this pack declared.
      const all = await host.capabilities.list();
      return all.filter((p) => perms.tools.includes(`cap:${p.capability}`));
    },
  });

  const build = (callCtx: CallContext, toolName: string, observer?: FetchObserver): PackContext => {
    const signal = callCtx.signal
      ? AbortSignal.any([callCtx.signal, lifetime.signal])
      : lifetime.signal;
    const report = callCtx.progress;
    return {
      pack: Object.freeze({
        id,
        version: manifest.version,
        dataDir,
        daemonPorts: Object.freeze([...(host.daemonPorts ?? [])]),
      }),
      secrets,
      settings,
      fetch: fetchWith(signal, observer),
      spawn: spawnWith(signal),
      programDir,
      library: libraryFor(toolName),
      llm: llmWith(signal, toolName, callCtx),
      tools: toolsWith(callCtx, signal),
      capabilities: capabilitiesWith(callCtx, signal, toolName),
      logger,
      signal,
      progress(fraction, message) {
        if (disposed || !report) return;
        const f = Number(fraction);
        report(
          Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0,
          message === undefined ? undefined : redactor.redact(String(message).slice(0, 500)),
        );
      },
    };
  };

  return {
    base: build({}, "setup"),
    forCall: build,
    allowedSecrets: [...allowed],
    binaries,
    async dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeTools?.();
      host.store.releaseNames(secretOwner);
      lifetime.abort();
      if (safeFetch) await safeFetch.close().catch(() => {});
      await Promise.all([...materialized].map((p) => removeCopy(p)));
    },
  };
}
