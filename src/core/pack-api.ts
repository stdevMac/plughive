// src/core/pack-api.ts
//
// The public pack API, published as `plughive/pack` (package.json "exports").
// Packs under `packs/` import nothing else from the daemon. This module holds
// types and identity helpers only: no daemon state, no side effects.
//
// TRUST MODEL, stated honestly for pack authors and reviewers:
//   - A pack runs IN the daemon process. The PackContext below is least
//     privilege at the API level (what the daemon hands a well-behaved pack);
//     it is NOT an OS sandbox. A malicious pack that imports node:fs or
//     node:child_process itself is not contained by anything in this file.
//   - Built-in packs (the repo's packs/ folder) are reviewed code and get the
//     secrets they declare. User packs stay disabled until the user reviews
//     what they declare and enables them, granting secrets by name.
//   - That consent is pinned to a hash of the whole manifest and of every
//     file in the pack folder (size-capped). When either changes, the pack is
//     not loaded ("needs-review") until the user consents again. A user pack
//     folder holding a symlink is refused outright. A user pack runs from a
//     copy of its folder that was hashed and matches the consent.
//   - Secret redaction of results, errors and logs is a seatbelt against
//     accidents, not a boundary: short values and values a pack transformed
//     (encoded, split, hashed) are not caught.
import { z } from "zod";
import { PACK_API_VERSION } from "./packs/api-version.js";
import { MissingSecretError } from "./secrets/errors.js";

export { z };
export { MissingSecretError };
export type { MissingSecretInfo } from "./secrets/errors.js";
export type { PackManifest } from "./packs/manifest.js";
export {
  AudioTranscribeInputSchema,
  AudioTranscribeOutputSchema,
  CAPABILITY_NAMES,
  CAPABILITY_SCHEMAS,
  CapabilityArtifactSchema,
  ChatInputSchema,
  ChatMessageSchema,
  ChatOutputSchema,
  ImageGenerateInputSchema,
  ImageGenerateOutputSchema,
  MediaResultSchema,
  MusicGenerateInputSchema,
  MusicGenerateOutputSchema,
  SpeechGenerateInputSchema,
  SpeechGenerateOutputSchema,
  TranscriptSegmentSchema,
  VideoGenerateInputSchema,
  VideoGenerateOutputSchema,
  ImageEditInputSchema,
  ImageEditOutputSchema,
  ImageUpscaleInputSchema,
  ImageUpscaleOutputSchema,
  ImageRemoveBackgroundInputSchema,
  ImageRemoveBackgroundOutputSchema,
  VideoUpscaleInputSchema,
  VideoUpscaleOutputSchema,
  VideoLipsyncInputSchema,
  VideoLipsyncOutputSchema,
  STEM_NAMES,
  AudioSeparateStemsInputSchema,
  AudioSeparateStemsOutputSchema,
  VoiceCloneInputSchema,
  VoiceCloneOutputSchema,
  SoundEffectInputSchema,
  SoundEffectOutputSchema,
  ThreeDGenerateInputSchema,
  ThreeDGenerateOutputSchema,
  DocumentParseInputSchema,
  DocumentParseOutputSchema,
  DOCUMENT_FORMATS,
  DocumentConvertInputSchema,
  DocumentConvertOutputSchema,
  TextTranslateInputSchema,
  TextTranslateOutputSchema,
  TextEmbedInputSchema,
  TextEmbedOutputSchema,
  TextRerankInputSchema,
  TextRerankOutputSchema,
  WebSearchInputSchema,
  WebSearchResultSchema,
  WebSearchOutputSchema,
  WebFetchInputSchema,
  WebFetchOutputSchema,
  MediaTranscriptInputSchema,
  MediaTranscriptOutputSchema,
  isCapabilityName,
} from "./capabilities/schemas.js";
export type {
  CapabilityInput,
  CapabilityName,
  CapabilityOutput,
  CapabilityParsedInput,
} from "./capabilities/schemas.js";
import type {
  CapabilityInput,
  CapabilityName,
  CapabilityOutput,
  CapabilityParsedInput,
} from "./capabilities/schemas.js";

/** Pack API version this daemon implements (defined in packs/api-version.ts). */
export { PACK_API_VERSION };
export const apiVersion = PACK_API_VERSION;

// Safe file access for packs that handle files a child process produced
// (sandbox outputs, converted documents, ...): open a path inside a root with
// every symlink segment checked, and read through the descriptor that was
// checked. Pure functions, no daemon state.
export { UnsafePathError, openInside, readFileCapped, resolveInside } from "./fs/safe-path.js";
export type {
  OpenInsideOptions,
  ReadableUserFile,
  ReadableUserFileOptions,
  UnsafePathReason,
} from "./fs/safe-path.js";

// ---------------------------------------------------------------------------
// Context surface
// ---------------------------------------------------------------------------

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface PackLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface PackSecrets {
  /**
   * Value of a secret declared in this pack's manifest. Throws
   * MissingSecretError when it is not set, and a permission error for names
   * that are undeclared or (user packs) that the user did not grant.
   */
  get(name: string): Promise<string>;
  has(name: string): Promise<boolean>;
}

export interface SpawnOptions {
  /**
   * Working directory, inside the pack's dataDir (relative paths resolve
   * there). Default: dataDir. An absolute path may also name a folder inside
   * one the user listed in a `format: "folder-list"` setting of the pack.
   */
  cwd?: string;
  /** Written to stdin. */
  input?: string | Uint8Array;
  /** Default 60000 ms; clamped to 30 minutes. */
  timeoutMs?: number;
  /** Cap per stream (stdout, stderr). Default 10 MiB; clamped to 256 MiB. */
  maxOutputBytes?: number;
  /**
   * Extra environment. The child gets a daemon-controlled PATH, a HOME of the
   * pack's own (<dataDir>/.home, with TMPDIR, XDG_* and TEXMFVAR beside it;
   * the user's real HOME only with `permissions.userHome: true`) and these,
   * never the daemon's environment. HOME cannot be set here; TMPDIR, XDG_*
   * and TEXMFVAR can. Names that change what code runs
   * (PATH, LD_*, DYLD_*, NODE_OPTIONS, BASH_ENV, PYTHONPATH, GIT_SSH,
   * PLUGHIVE_* and similar) are dropped with a warning.
   */
  env?: Record<string, string>;
  /**
   * Called with each line of stdout as it arrives (split on \n, \r\n or a bare
   * \r, so carriage-return progress output works). Empty lines are skipped.
   * A line longer than 8 KiB is delivered in 8 KiB pieces, so a child that
   * never prints a newline cannot grow a buffer without bound. Errors the
   * callback throws are ignored. The full output is
   * still returned in the result, subject to `maxOutputBytes`.
   */
  onStdout?: (line: string) => void;
  /** Same as `onStdout`, for stderr (where ffmpeg writes its progress). */
  onStderr?: (line: string) => void;
  /**
   * Run the child in its own process group (POSIX) and, on timeout, output
   * cap or cancellation, kill the whole tree (the group on POSIX,
   * `taskkill /T` on Windows), not only the direct child. For programs that
   * start helpers of their own (agent CLIs, language servers).
   */
  killTree?: boolean;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  /** -1 when the process was killed (timeout, output cap) before it exited. */
  exitCode: number;
  /** Killed after `timeoutMs`; stdout/stderr hold what was produced until then. */
  timedOut: boolean;
  /** Killed because a stream passed `maxOutputBytes`; the output is cut there. */
  truncated: boolean;
}

/** Thrown by ctx.spawn when the process never ran or the call was cancelled. */
export class SpawnError extends Error {
  constructor(
    readonly code: "not_installed" | "not_started" | "cancelled",
    message: string,
  ) {
    super(message);
    this.name = "SpawnError";
  }
}

/**
 * What an artifact is. `audio` for speech, music and sound; `document` for
 * text-like output (subtitles, transcripts, markdown); `data` for machine
 * readable output (JSON, CSV); `other` for anything else.
 */
export type ArtifactKind = "image" | "video" | "audio" | "pdf" | "document" | "data" | "other";

/** Every ArtifactKind, in a stable order. */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = Object.freeze([
  "image",
  "video",
  "audio",
  "pdf",
  "document",
  "data",
  "other",
]);

/** What ctx.library.save/importFile return. No filesystem path: use `id` or `url`. */
export interface ArtifactRef {
  id: string;
  url: string;
  mime: string;
  model?: string | null;
  costUsd?: number | null;
  prompt?: string | null;
  bytes?: number;
}

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  mime: string;
  /** Download URL on the daemon. */
  url: string;
  bytes: number;
  tool: string;
  model: string | null;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  costUsd: number | null;
  createdAt: string;
}

export interface LibrarySaveInput {
  kind: ArtifactKind;
  mime: string;
  bytes: Uint8Array;
  /**
   * @deprecated Ignored. The host sets the attribution to
   * `<pack id>/<calling tool name>`; a pack cannot claim another tool's name.
   */
  tool?: string;
  model?: string | null;
  prompt?: string | null;
  meta?: Record<string, unknown> | null;
  costUsd?: number | null;
}

export interface LibraryImportInput extends Omit<LibrarySaveInput, "bytes"> {
  /**
   * Path inside the pack's dataDir. The file is streamed into the library
   * (never held in memory), so multi-GB outputs are fine up to the daemon's
   * artifact size cap.
   */
  sourcePath: string;
}

export interface MaterializeOptions {
  /** Folder inside the pack's dataDir to put the file in. Default ".materialized". */
  dir?: string;
}

/** A read-only copy of an artifact on disk, inside the pack's dataDir. */
export interface MaterializedArtifact {
  /** Absolute path of the copy. Mode 0400: read it, pass it to a spawned tool. */
  path: string;
  bytes: number;
  mime: string;
  /** Delete the copy. Also done when the pack unloads. Safe to call twice. */
  cleanup(): Promise<void>;
}

export interface LibraryListFilter {
  /**
   * A bare tool name means one of this pack's own tools (stored as
   * `<pack id>/<name>`). Packs with "read-all"/"full" may also pass a full
   * attribution as stored (`<other pack>/<tool>`, or a core tool name).
   */
  tool?: string;
  kind?: ArtifactKind;
  model?: string;
  since?: string;
  limit?: number;
}

/**
 * Artifact library, gated by `permissions.library`:
 *   "read"      get/list/read artifacts THIS pack created
 *   "read-all"  get/list/read every artifact
 *   "write"     save/importFile, and read what this pack created
 *   "full"      save/importFile and read every artifact
 * Saved artifacts are attributed to `<pack id>/<tool name>` by the host. Active
 * content types (text/html, image/svg+xml, scripts, XML) are stored as
 * text/plain and unknown types as application/octet-stream, with the declared
 * type kept in `meta.declaredMime`. `importFile` takes a regular file inside
 * the pack's dataDir (no symlinks, no hard links).
 */
export interface PackLibrary {
  get(id: string): Promise<ArtifactRecord | null>;
  list(filter?: LibraryListFilter): Promise<ArtifactRecord[]>;
  /** Bytes of a stored artifact. */
  read(id: string): Promise<Uint8Array>;
  save(input: LibrarySaveInput): Promise<ArtifactRef>;
  importFile(input: LibraryImportInput): Promise<ArtifactRef>;
  /**
   * Put a stored artifact on disk in this pack's dataDir without loading it
   * into memory, for tools that take a file path (ffmpeg, whisper, uploads).
   * Same permission as `read`. The copy is a reflink (copy-on-write clone)
   * when the volume supports one, otherwise a streamed copy; it is never a
   * hard link, so writing to it cannot change the stored artifact. The file
   * is created fresh (no existing file or symlink is followed) and made
   * read-only.
   */
  materialize(id: string, opts?: MaterializeOptions): Promise<MaterializedArtifact>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmChatRequest {
  messages: LlmMessage[];
  /** Model id as the chat provider names it. Default: the provider's own default. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmChatResult {
  text: string;
  model: string;
  costUsd: number | null;
}

/**
 * Needs `permissions.llm: true`. The request is routed through the capability
 * router to a pack that provides the `chat` capability (see `providers`).
 */
export interface PackLlm {
  chat(req: LlmChatRequest): Promise<LlmChatResult>;
}

/**
 * Needs the tool name, "pack:<id>" or "cap:<capability>" in `permissions.tools`.
 * `call("cap:<capability>", args)` calls whichever tool currently provides that
 * capability. Returns the tool's (redacted) result or throws. Nested calls are
 * metered with the calling pack recorded, and capped in depth.
 */
export interface PackTools {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /**
   * True when the caller this pack is running for may itself use the tool
   * `name` (profile exposure; always true for host code and the default
   * profile). A pack uses it to refuse a step the caller could not do
   * directly (for example a stored script that would run a command).
   */
  allowedForCaller?(name: string): boolean;
}

export interface PackFetchInit extends RequestInit {
  /**
   * Total time budget for the request in ms, from the call until the response
   * body has been read to the end (headers AND body). It is not an idle
   * timeout: a slow but steady download is still cut at the deadline. Default
   * 60000; clamped to 15 minutes. On expiry the request is aborted with a
   * TimeoutError. A caller `signal` still applies as well.
   */
  timeoutMs?: number;
}

export type PackFetch = (input: string | URL | Request, init?: PackFetchInit) => Promise<Response>;

/** Default and maximum of `PackFetchInit.timeoutMs`. */
export const FETCH_DEFAULT_TIMEOUT_MS = 60_000;
export const FETCH_MAX_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface CapabilityRunOptions {
  /** Run this provider only (no fallback). A provider id from `list()`. */
  provider?: string;
  /**
   * Run with this model. Providers whose `models()` include it are tried, in
   * the usual order; when none lists it, the call fails with a helpful error.
   */
  model?: string;
  /**
   * Run only providers whose estimate is at most this many US dollars;
   * providers that cannot estimate are skipped ("cost unknown"). The same as
   * a `max_cost_usd` field in the input.
   */
  maxCostUsd?: number;
  /**
   * False skips the paid-call cache: a paid provider runs even when the same
   * call has a saved result. The same as a `cache: false` field in the input.
   */
  cache?: boolean;
}

export type ProviderCost = "local" | "account" | "paid";

export interface CapabilityProviderInfo {
  capability: CapabilityName;
  /** Provider id, unique per capability (for example "gemini"). */
  id: string;
  /** Pack that registered the provider. */
  pack: string;
  priority: number;
  configured: boolean;
  /** Models the provider reported, or null when it does not say. */
  models: string[] | null;
  /** Set while the provider cools down after a rate limit (ISO time). */
  coolingDownUntil: string | null;
  /** Position in the user's preference order, or null when not listed. */
  preferred: number | null;
  /** False for user-pack providers the user has not put in the preference order. */
  autoRoute: boolean;
  /** Where the work runs and who pays (ProviderDefinition.cost). */
  cost: ProviderCost;
  /** What to set up to enable it (never a secret value), or null. */
  setupHint: string | null;
}

/** A capability result: the normalised output plus the provider that served it. */
export type CapabilityResult<C extends CapabilityName> = CapabilityOutput<C> & {
  provider: string;
};

/**
 * Needs `cap:<capability>` in `permissions.tools` for each capability used.
 * `run` validates the input against the normalised schema, picks a provider
 * (explicit provider or model first, then the user's preference order, then
 * priority) and falls back to the next provider only on failures that
 * provably happened before a provider accepted anything (not set up, refused
 * connection, HTTP 429/401/403, any network error or 5xx while only GETs were
 * sent). A timeout, reset or 5xx after a non-GET request was sent is final:
 * the job may exist upstream.
 */
export interface PackCapabilities {
  run<C extends CapabilityName>(
    capability: C,
    input: CapabilityInput<C>,
    opts?: CapabilityRunOptions,
  ): Promise<CapabilityResult<C>>;
  list(capability?: CapabilityName): Promise<CapabilityProviderInfo[]>;
}

/**
 * Throw from a provider's `run` to tell the router how to treat a failure.
 * Without it the router decides from the error (network error codes, the
 * status of the last response the provider received).
 */
export class CapabilityError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly code: string;
  /**
   * True when the provider may have billed the call. It wins over
   * `retryable`: no other provider is ever tried after it.
   */
  readonly mayHaveCharged: boolean;
  constructor(
    message: string,
    opts: {
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
      code?: string;
      mayHaveCharged?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "CapabilityError";
    this.mayHaveCharged = opts.mayHaveCharged === true;
    this.retryable = (opts.retryable ?? false) && !this.mayHaveCharged;
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.code = opts.code ?? "CAPABILITY_ERROR";
  }
}

export type PackPermissionReason = "not_declared" | "secret_not_granted" | "denied";

/**
 * Thrown when a pack uses something its manifest does not declare (or the
 * user did not grant): a host, a binary, a secret, a tool, a folder.
 */
export class PackPermissionError extends Error {
  readonly code = "PACK_PERMISSION_DENIED" as const;
  constructor(
    readonly pack: string,
    message: string,
    readonly reason: PackPermissionReason = "not_declared",
  ) {
    super(`Pack "${pack}": ${message}`);
    this.name = "PackPermissionError";
  }
}

export interface PackInfo {
  id: string;
  version: string;
  /** `$PLUGHIVE_HOME/pack-data/<id>`, mode 0700. */
  dataDir: string;
  /**
   * Ports the daemon itself listens on. `ctx.fetch` already refuses them; a
   * pack that opens sockets by other means (a headless browser) must too.
   */
  daemonPorts?: readonly number[];
}

/** Everything a pack may touch. Each member is gated by the manifest. */
export interface PackContext {
  pack: PackInfo;
  secrets: PackSecrets;
  settings: Readonly<Record<string, unknown>>;
  /** SSRF-safe fetch limited to `permissions.network` (and `localNetwork`). */
  fetch: PackFetch;
  /**
   * Runs a binary listed in `permissions.spawn`: argv array, no shell, timeout
   * and output cap. The binary is resolved once, at load, on a
   * daemon-controlled PATH and run by absolute path. A timeout or a passed
   * output cap resolves with `timedOut` / `truncated` and the partial output;
   * a missing binary or a cancelled call throws SpawnError.
   */
  spawn(binary: string, args: readonly string[], opts?: SpawnOptions): Promise<SpawnResult>;
  /**
   * The folder a binary listed in `permissions.spawn` is installed in (its real
   * location, not a link to it), or null when it is not installed. For files a
   * program ships beside itself, such as model folders.
   */
  programDir(binary: string): string | null;
  library: PackLibrary;
  llm: PackLlm;
  tools: PackTools;
  /** Capability routing (image.generate, chat, ...). See PackCapabilities. */
  capabilities: PackCapabilities;
  /** Logger whose output has secret values redacted. */
  logger: PackLogger;
  /** Always present. Aborted when the call is cancelled or the pack unloads. */
  signal: AbortSignal;
  /**
   * Report progress of the current call: `fraction` in [0, 1] plus an optional
   * short message. Always present; a no-op unless someone is listening (an MCP
   * progress token, or the job the call runs in).
   */
  progress(fraction: number, message?: string): void;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: services are pack-defined
export type PackServices = Record<string, any>;

export interface ToolDefinition<
  Input extends z.ZodType = z.ZodType,
  Services extends PackServices = PackServices,
  Output = unknown,
> {
  /** Valid MCP tool name, unique across all packs, without "__". */
  name: string;
  description: string;
  /** zod 4 schema for the arguments. Advertised as JSON Schema in tools/list. */
  input: Input;
  annotations?: ToolAnnotations;
  /** Capability this tool provides (for routing and the catalog). */
  capability?: string;
  /** Manifest secrets this tool needs. Checked before `run`, so a missing one fails fast. */
  secrets?: readonly string[];
  /**
   * The tool may take long: the core runs it as a background job. Clients that
   * negotiate MCP Tasks get a task handle; others get `{ job_id, status,
   * poll_with }` and poll with `wait_for_job` / `get_job_status`. Honor
   * `ctx.signal` (cancellation) and report with `ctx.progress?.(fraction, message)`.
   */
  longRunning?: boolean;
  tags?: readonly string[];
  run(input: z.output<Input>, ctx: PackContext & Services): Promise<Output> | Output;
}

export type AnyToolDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists erase service types
  Services extends PackServices = any,
> = ToolDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool lists erase input types
  any,
  Services,
  unknown
>;

/**
 * A capability provider. The router calls `run` with the input already
 * validated against the capability's normalised schema, and with THIS pack's
 * context (its own secrets, network and library permissions), never the
 * caller's. Artifacts it saves are attributed to `<pack>/provider:<capability>`.
 */
export interface ProviderDefinition<
  C extends CapabilityName = CapabilityName,
  Services extends PackServices = PackServices,
> {
  capability: C;
  /** Unique per capability across packs: lowercase letter first, then letters, digits, "_" or "-" (max 40). */
  id: string;
  /** Higher runs first. Default 0. */
  priority?: number;
  /**
   * Never picked automatically, even from a bundled pack: the router uses it
   * only when the user put its id in the capability preference order, or a
   * caller names it as `provider`.
   */
  optIn?: boolean;
  /**
   * What the user sets to enable this provider (key names, a backend URL
   * setting). Shown when no provider for the capability is set up. Never a
   * secret value.
   */
  setupHint?: string;
  /**
   * What a call costs the user: "local" runs on this computer for free,
   * "account" uses an app or subscription the user already pays for (a
   * signed-in CLI), "paid" bills an API key per call. Default "paid".
   */
  cost?: ProviderCost;
  /** Models this provider serves (used for explicit `model` routing). */
  models?(ctx: PackContext & Services): readonly string[] | Promise<readonly string[]>;
  /** Cheap check: keys present, backend reachable. Providers that are not configured are skipped. */
  isConfigured(ctx: PackContext & Services): boolean | Promise<boolean>;
  /**
   * Optional: what this call will cost, before it runs. Null when it cannot
   * tell. `basis` says where the number comes from ("static table",
   * "provider price API"). Used by the spend policy (caps, max_cost_usd);
   * a provider without it counts as "cost unknown". Must not charge.
   */
  estimate?(
    input: CapabilityParsedInput<C>,
    ctx: PackContext & Services,
  ): { usd: number; basis: string } | null | Promise<{ usd: number; basis: string } | null>;
  run(
    input: CapabilityParsedInput<C>,
    ctx: PackContext & Services,
  ): Promise<ProviderOutput<C>> | ProviderOutput<C>;
}

/** Drops string index signatures (recursively), so plain interfaces fit loose output schemas. */
type StripIndex<T> = T extends readonly (infer U)[]
  ? StripIndex<U>[]
  : T extends object
    ? { [K in keyof T as string extends K ? never : K]: StripIndex<T[K]> }
    : T;

/**
 * What a provider's `run` returns: the capability's output shape. Extra fields
 * are allowed (and kept); the router validates the common part.
 */
export type ProviderOutput<C extends CapabilityName> = StripIndex<CapabilityOutput<C>>;

export type AnyProviderDefinition<Services extends PackServices = PackServices> = {
  [C in CapabilityName]: ProviderDefinition<C, Services>;
}[CapabilityName];

/** Identity helper that keeps the capability's input type flowing into `run`. */
export function defineProvider<
  C extends CapabilityName,
  Services extends PackServices = PackServices,
>(def: ProviderDefinition<C, Services>): ProviderDefinition<C, Services> {
  return def;
}

export interface PackDefinition<Services extends PackServices = PackServices> {
  readonly apiVersion: typeof PACK_API_VERSION;
  /** Optional: build pack-local services once at load. They are merged into each tool's ctx. */
  setup?(ctx: PackContext): Services | Promise<Services>;
  tools?:
    | readonly AnyToolDefinition<Services>[]
    | ((
        ctx: PackContext & Services,
      ) =>
        | readonly AnyToolDefinition<Services>[]
        | Promise<readonly AnyToolDefinition<Services>[]>);
  /** Capability providers this pack serves (see ProviderDefinition). */
  providers?:
    | readonly AnyProviderDefinition<Services>[]
    | ((
        ctx: PackContext & Services,
      ) =>
        | readonly AnyProviderDefinition<Services>[]
        | Promise<readonly AnyProviderDefinition<Services>[]>);
  /** Called when the pack unloads (disable, reload, shutdown). */
  dispose?(): void | Promise<void>;
}

export type PackDefinitionInput<Services extends PackServices> = Omit<
  PackDefinition<Services>,
  "apiVersion"
>;

/** Identity helper that stamps the API version. `export default definePack({...})`. */
export function definePack<Services extends PackServices = PackServices>(
  def: PackDefinitionInput<Services>,
): PackDefinition<Services> {
  return { ...def, apiVersion: PACK_API_VERSION };
}

/** Identity helper that keeps the input type flowing into `run`. */
export function defineTool<
  Input extends z.ZodType,
  Services extends PackServices = PackServices,
  Output = unknown,
>(def: ToolDefinition<Input, Services, Output>): ToolDefinition<Input, Services, Output> {
  return def;
}

/**
 * The object handed to a factory-style default export
 * (`export default (api) => api.definePack({...})`). User packs outside the
 * repo cannot resolve the bare `plughive/pack` specifier, so they use this.
 */
export interface PackApi {
  readonly apiVersion: typeof PACK_API_VERSION;
  readonly PACK_API_VERSION: typeof PACK_API_VERSION;
  readonly z: typeof z;
  readonly definePack: typeof definePack;
  readonly defineTool: typeof defineTool;
  readonly defineProvider: typeof defineProvider;
  readonly MissingSecretError: typeof MissingSecretError;
  readonly SpawnError: typeof SpawnError;
  readonly CapabilityError: typeof CapabilityError;
}

export type PackFactory = (api: PackApi) => PackDefinition | Promise<PackDefinition>;

// The error classes are shared by every pack and the registry (`instanceof`),
// so no pack may patch their prototypes. Instances still get their own fields.
Object.freeze(MissingSecretError.prototype);
Object.freeze(SpawnError.prototype);
Object.freeze(CapabilityError.prototype);

/** The one frozen API object factories receive (never the module namespace). */
export const packApi: PackApi = Object.freeze({
  apiVersion: PACK_API_VERSION,
  PACK_API_VERSION,
  z,
  definePack,
  defineTool,
  defineProvider,
  MissingSecretError,
  SpawnError,
  CapabilityError,
});
