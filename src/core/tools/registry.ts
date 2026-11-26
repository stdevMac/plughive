// src/core/tools/registry.ts
//
// One registry for every callable tool: pack tools ("native") and tools
// proxied from mounted upstream MCP servers ("mounted"). Names are globally
// unique. A pack whose tool name collides with an existing one is rejected as
// a whole; nothing is ever silently overridden.
//
// `call()` owns the result envelope ({ok,result} / {ok:false,error}), input
// validation, secret redaction of results and errors, logging and metering.
import { z } from "zod";
import type { ToolAnnotations } from "../pack-api.js";
import { type ApprovalRef, PolicyError, type PolicyErrorCode } from "../policy/errors.js";
import type { PolicyGate } from "../policy/gate.js";
import { MissingSecretError, type Redactor, SECRET_NAME_PATTERN } from "../secrets/index.js";
import { addAccountedCost, settleCostScope, unaccountedCost } from "./cost-scope.js";

/** "workflow": a declarative recipe of a pack (wf_<name>), run by the workflow engine. */
export type ToolOrigin = "native" | "mounted" | "workflow";

export interface CallContext {
  signal?: AbortSignal;
  /** Nesting depth for tool-to-tool calls (ctx.tools.call). */
  depth?: number;
  /** Pack id of the calling pack for nested calls (logged and recorded in the usage ledger). */
  caller?: string;
  /** Progress sink for this call: fraction in [0, 1] and an optional short message. */
  progress?: (fraction: number, message?: string) => void;
  /** Host-only: the caller records usage itself. */
  skipMetering?: boolean;
}

/**
 * The one set of tool names owned by the daemon: the core tools the protocol
 * layer serves itself (search surface, job waiting and cancelling) and the names
 * kept for the daemon's built-in tools. Nobody registers the first five; the
 * others (and any name that starts with RESERVED_TOOL_PREFIX) only the "core"
 * origin (src/core/tools/builtin). No mount may shadow any of them.
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_tools",
  "describe_tool",
  "execute_tool",
  "wait_for_job",
  "cancel_job",
  "get_job_status",
  "list_packs",
]);
export const RESERVED_TOOL_PREFIX = "plughive_";
const PROTOCOL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_tools",
  "describe_tool",
  "execute_tool",
  "wait_for_job",
  "cancel_job",
]);
const RESERVED_NAME_OWNERS: ReadonlySet<string> = new Set(["core"]);

/** The single reserved-name check: true when `packId` may not register `name`. */
export function isReservedToolName(name: string, packId?: string): boolean {
  const lower = String(name).toLowerCase();
  if (PROTOCOL_TOOL_NAMES.has(lower)) return true;
  if (!RESERVED_TOOL_NAMES.has(lower) && !lower.startsWith(RESERVED_TOOL_PREFIX)) return false;
  return packId === undefined || !RESERVED_NAME_OWNERS.has(packId);
}

export class ReservedToolNameError extends Error {
  readonly code = "TOOL_NAME_RESERVED" as const;
  constructor(
    readonly tool: string,
    readonly packId: string,
  ) {
    super(
      `Pack "${packId}" defines the tool "${tool}", which is a reserved core tool name. Rename it.`,
    );
    this.name = "ReservedToolNameError";
  }
}

/** A requested tool name made safe to echo and log: valid characters only, capped length. */
export function sanitizeToolName(name: unknown): string {
  if (typeof name !== "string" || name === "") return "(invalid name)";
  return /^[A-Za-z0-9_.-]{1,128}$/.test(name) ? name : "(invalid name)";
}

export interface RegisteredTool {
  name: string;
  packId: string;
  origin: ToolOrigin;
  description: string;
  /** JSON Schema advertised in tools/list. */
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  tags: readonly string[];
  capability?: string;
  requiresSecrets: readonly string[];
  longRunning: boolean;
  /** Validates raw arguments. */
  input: z.ZodType;
  /** Runs with already-validated input. */
  run(input: unknown, callCtx: CallContext): Promise<unknown>;
}

export interface ToolCallError {
  code: "UNKNOWN_TOOL" | "INVALID_ARGUMENTS" | "MISSING_SECRET" | "TOOL_ERROR" | PolicyErrorCode;
  message: string;
  retryable: boolean;
  issues?: unknown[];
  pack?: string;
  secret?: string;
  label?: string;
  helpUrl?: string;
  /** Spend policy errors: the approval request (link where a person decides). */
  approval?: ApprovalRef;
}

export type ToolEnvelope = { ok: true; result: unknown } | { ok: false; error: ToolCallError };

export class ToolNameConflictError extends Error {
  readonly code = "TOOL_NAME_CONFLICT" as const;
  constructor(
    readonly tool: string,
    readonly packId: string,
    readonly existingPackId: string,
  ) {
    super(
      existingPackId === packId
        ? `Pack "${packId}" defines the tool "${tool}" more than once.`
        : `Pack "${packId}" defines the tool "${tool}", which pack "${existingPackId}" already provides. Tool names must be unique across packs; rename one of them.`,
    );
    this.name = "ToolNameConflictError";
  }
}

export class UnknownToolError extends Error {
  readonly code = "UNKNOWN_TOOL" as const;
  constructor(readonly tool: string) {
    super(`unknown tool: ${tool}`);
    this.name = "UnknownToolError";
  }
}

export class InvalidArgumentsError extends Error {
  readonly code = "INVALID_ARGUMENTS" as const;
  constructor(
    readonly tool: string,
    readonly issues: z.core.$ZodIssue[],
    pretty: string,
  ) {
    super(`invalid arguments for ${tool}: ${pretty}`);
    this.name = "InvalidArgumentsError";
  }
}

/** JSON Schema advertised in tools/list for a tool's zod input schema. */
export function toolInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // io: "input" keeps defaulted fields optional (what callers may send);
  // unrepresentable: "any" keeps custom/transform types from throwing.
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return { ...json, type: json.type ?? "object" };
}

export type MountedToolHints = Pick<
  ToolAnnotations,
  "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint"
>;

/**
 * Annotations for a mounted tool. As in the MCP spec, a tool is destructive
 * unless it says it is read-only or not destructive, so ask_before_destructive
 * (and the fail-closed broken-policy check) covers mounted tools too.
 */
export function mountedAnnotations(hints: MountedToolHints = {}): ToolAnnotations {
  const readOnly = hints.readOnlyHint === true;
  return {
    ...hints,
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && hints.destructiveHint !== false,
  };
}

export interface MountedToolSource {
  list(): Array<{
    qualifiedName: string;
    mountId: string;
    prefix: string;
    upstreamName: string;
    description: string;
    /** The upstream's own input schema. Untrusted: sanitised before it is advertised. */
    inputSchema?: unknown;
    /** The upstream's boolean annotation hints. Untrusted. */
    hints?: MountedToolHints;
  }>;
  call(mountId: string, upstreamName: string, args: Record<string, unknown>): Promise<unknown>;
}

interface RegistryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface UsageSink {
  record(input: {
    tool: string;
    vendor?: string | null;
    capability?: string | null;
    provider?: string | null;
    costUsd?: number | null;
    latencyMs: number;
    status: "ok" | "error";
    error?: string | null;
    /** Nested calls: `{ caller: <pack id>, depth }`. */
    meta?: Record<string, unknown> | null;
  }): void;
}

export interface ToolRegistryOptions {
  logger?: RegistryLogger;
  /** Redacts every secret value the store has handed out. */
  redactor?: Redactor;
  usage?: UsageSink;
  vendorOf?: (toolName: string) => string | null;
  meteringExempt?: ReadonlySet<string>;
  /** Applied to error messages and log lines: hides the home and data directories. */
  scrubPaths?: (text: string) => string;
  /**
   * Log argument VALUES (masked) with each call. Default: only when
   * PLUGHIVE_LOG_ARGS=1; otherwise the log line has names and sizes only.
   */
  logArgs?: boolean;
  /** The spend policy (src/core/policy): may refuse a call or ask a person first. */
  gate?: Pick<PolicyGate, "runTool">;
}

/** A tool result must fit in one JSON document a client can receive. */
export const NOT_SERIALISABLE_MESSAGE =
  "the tool returned a result that cannot be sent as JSON (circular or unsupported value)";
export const MAX_MOUNTED_SCHEMA_BYTES = 16 * 1024;
/** The largest result one call may return inline; bigger outputs belong in artifacts. */
export const MAX_INLINE_RESULT_BYTES = 16 * 1024 * 1024;
/** Error messages are cut to this many characters (after redaction). */
export const MAX_ERROR_MESSAGE_CHARS = 4000;

/** Cut a long message, saying so; redact before calling this so a secret is never half kept. */
function capMessage(text: string): string {
  return text.length > MAX_ERROR_MESSAGE_CHARS
    ? `${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}... (message cut)`
    : text;
}

/**
 * Replace the user's home directory and the daemon data directory in text
 * shown to clients or written to logs. Longest path first, so the data
 * directory wins when it lives under the home directory.
 */
export function createPathScrubber(
  dirs: {
    home?: string;
    dataDir?: string;
  },
  platform: NodeJS.Platform = process.platform,
): (text: string) => string {
  const pairs: Array<[string, string]> = [];
  const add = (dir: string | undefined, replacement: string) => {
    const bare = (dir ?? "").replace(/[/\\]+$/, "");
    if (bare.length > 1) pairs.push([bare, replacement]);
  };
  add(dirs.dataDir, "$PLUGHIVE_HOME");
  add(dirs.home, "~");
  pairs.sort((a, b) => b[0].length - a[0].length);
  if (platform === "win32") {
    // Windows paths are case-insensitive and either slash may appear
    // (C:\Users\me, c:/users/me, or JSON-escaped C:\\Users\\me).
    const patterns = pairs.map(([dir, replacement]) => {
      const parts = dir.split(/[/\\]+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      return [new RegExp(parts.join("[/\\\\]+"), "gi"), replacement] as const;
    });
    return (text) => {
      let out = text;
      for (const [re, replacement] of patterns) out = out.replace(re, () => replacement);
      return out;
    };
  }
  return (text) => {
    let out = text;
    for (const [dir, replacement] of pairs) out = out.split(dir).join(replacement);
    return out;
  };
}

/**
 * The input schema a mounted upstream advertises, when it is a plain, bounded
 * JSON Schema object; null otherwise (the caller falls back to a permissive
 * schema). Upstream data is never trusted: it is copied through JSON,
 * size-capped and forced to type "object".
 */
export function sanitizeMountedSchema(schema: unknown): Record<string, unknown> | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(schema);
  } catch {
    return null;
  }
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_MOUNTED_SCHEMA_BYTES) {
    return null;
  }
  const copy = JSON.parse(json) as Record<string, unknown>;
  if (copy.type !== undefined && copy.type !== "object") return null;
  const props = copy.properties;
  if (
    props !== undefined &&
    (props === null || typeof props !== "object" || Array.isArray(props))
  ) {
    return null;
  }
  const { $schema: _schema, $id: _id, ...rest } = copy;
  return { ...rest, type: "object" };
}

export const MOUNT_PACK_ID = "gateway";
const DynamicInput = z.object({}).passthrough();
const DYNAMIC_SCHEMA = toolInputJsonSchema(DynamicInput);
const silentLogger: RegistryLogger = { info() {}, warn() {}, error() {} };

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private mounts: MountedToolSource | null = null;
  private readonly logger: RegistryLogger;
  private pathScrubber: ((text: string) => string) | undefined;
  private readonly logArgs: boolean;

  constructor(private readonly opts: ToolRegistryOptions = {}) {
    this.logger = opts.logger ?? silentLogger;
    this.pathScrubber = opts.scrubPaths;
    this.logArgs = opts.logArgs ?? process.env.PLUGHIVE_LOG_ARGS === "1";
  }

  /**
   * Register all tools of one pack atomically: if any name is invalid or
   * already taken, nothing is registered and ToolNameConflictError is thrown.
   */
  registerPack(packId: string, tools: readonly RegisteredTool[]): void {
    const incoming = new Set<string>();
    for (const tool of tools) {
      if (isReservedToolName(tool.name, packId)) throw new ReservedToolNameError(tool.name, packId);
      if (incoming.has(tool.name)) throw new ToolNameConflictError(tool.name, packId, packId);
      incoming.add(tool.name);
      const existing = this.tools.get(tool.name);
      if (existing) throw new ToolNameConflictError(tool.name, packId, existing.packId);
    }
    for (const tool of tools) {
      this.tools.set(tool.name, {
        ...tool,
        packId,
        origin: tool.origin === "workflow" ? "workflow" : "native",
      });
    }
  }

  unregisterPack(packId: string): void {
    for (const [name, tool] of this.tools) if (tool.packId === packId) this.tools.delete(name);
  }

  /** Expose tools of mounted upstream servers, evaluated on every list/get. */
  attachMounts(source: MountedToolSource): void {
    this.mounts = source;
  }

  private mountedTools(): RegisteredTool[] {
    if (!this.mounts) return [];
    const source = this.mounts;
    const out: RegisteredTool[] = [];
    for (const t of source.list()) {
      // A mount can never shadow a pack tool (pack names cannot contain "__").
      if (this.tools.has(t.qualifiedName) || isReservedToolName(t.qualifiedName)) continue;
      out.push({
        name: t.qualifiedName,
        packId: MOUNT_PACK_ID,
        origin: "mounted",
        description: `[${t.prefix}] ${t.description}`,
        inputSchema: sanitizeMountedSchema(t.inputSchema) ?? DYNAMIC_SCHEMA,
        annotations: mountedAnnotations(t.hints),
        tags: [`mount:${t.mountId}`],
        requiresSecrets: [],
        longRunning: false,
        input: DynamicInput,
        run: (input) => source.call(t.mountId, t.upstreamName, input as Record<string, unknown>),
      });
    }
    return out;
  }

  /** Pack tools in registration order, then mounted tools. */
  list(): RegisteredTool[] {
    return [...this.tools.values(), ...this.mountedTools()];
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name) ?? this.mountedTools().find((t) => t.name === name);
  }

  /**
   * Validate and run, for tests only: it skips the policy gate, redaction and
   * metering. Serve calls with call(). Throws UnknownToolError,
   * InvalidArgumentsError or whatever the tool throws.
   */
  async invoke(name: string, rawInput: unknown, callCtx: CallContext = {}): Promise<unknown> {
    const tool = this.get(name);
    if (!tool) throw new UnknownToolError(name);
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new InvalidArgumentsError(
        tool.name,
        parsed.error.issues,
        z.prettifyError(parsed.error),
      );
    }
    return tool.run(parsed.data, callCtx);
  }

  /** Validate, run, redact and meter. Never throws. */
  async call(name: string, rawInput: unknown, callCtx: CallContext = {}): Promise<ToolEnvelope> {
    const tool = this.get(name);
    if (!tool) {
      // The requested name is caller-controlled: never echo or log it raw.
      const requested = this.redact(sanitizeToolName(name));
      this.logger.warn({ requested }, "unknown tool requested");
      return {
        ok: false,
        error: { code: "UNKNOWN_TOOL", message: `unknown tool: ${requested}`, retryable: false },
      };
    }
    const start = Date.now();
    const nested = callCtx.caller ? { caller: callCtx.caller, depth: callCtx.depth ?? 0 } : null;
    this.logger.info(
      { tool: tool.name, args: this.loggableArgs(rawInput), ...nested },
      "→ tool call",
    );
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      this.logger.warn({ tool: tool.name }, "← tool invalid arguments");
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENTS",
          message: capMessage(
            this.scrub(
              this.redact(`invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`),
            ),
          ),
          retryable: false,
          issues: this.redact(parsed.error.issues),
        },
      };
    }

    // Costs written to the ledger by what this call runs (capability
    // providers, nested tools) are collected here, so they are not written
    // again for this tool.
    const gate = this.opts.gate;
    const ran = await settleCostScope(() =>
      gate
        ? gate.runTool(tool, parsed.data, callCtx.signal, () => tool.run(parsed.data, callCtx))
        : tool.run(parsed.data, callCtx),
    );
    try {
      if (!ran.ok) throw ran.error;
      // Secrets redacted and private paths hidden, as for errors.
      const result = this.scrubDeep(this.redact(ran.value));
      // A result nobody can serialise (cycle, BigInt) is a tool error, not a crash later.
      if (result !== undefined) {
        let json: string | undefined;
        try {
          json = JSON.stringify(result);
        } catch {
          throw new Error(NOT_SERIALISABLE_MESSAGE);
        }
        const bytes = json === undefined ? 0 : Buffer.byteLength(json, "utf8");
        if (bytes > MAX_INLINE_RESULT_BYTES) {
          throw new Error(
            `the tool returned ${bytes} bytes, over the ${MAX_INLINE_RESULT_BYTES} byte limit for a result. Large outputs belong in artifacts: ask the tool for a smaller result.`,
          );
        }
      }
      const latencyMs = Date.now() - start;
      this.logger.info({ tool: tool.name, ms: latencyMs }, "← tool ok");
      const own = unaccountedCost(extractCostUsd(result), ran.accounted);
      if (!callCtx.skipMetering) this.meter(tool, latencyMs, "ok", null, own, nested);
      addAccountedCost(ran.accounted + (callCtx.skipMetering ? 0 : (own ?? 0)));
      return { ok: true, result };
    } catch (e) {
      const error = this.toError(e, tool);
      const latencyMs = Date.now() - start;
      this.logger.error(
        { tool: tool.name, ms: latencyMs, err: error.message, code: error.code, ...nested },
        "← tool error",
      );
      if (!callCtx.skipMetering) {
        this.meter(tool, latencyMs, "error", error.message, null, nested);
      }
      addAccountedCost(ran.accounted);
      return { ok: false, error };
    }
  }

  // Redaction here is a seatbelt against accidents (a secret echoed in an
  // error or a result), NOT a security boundary: short values and values a
  // tool transformed (hashed, split, re-encoded in an unusual way) pass.
  private toError(e: unknown, tool: RegisteredTool): ToolCallError {
    // Only the real class counts (no duck typing), the pack id comes from the
    // registered tool, and the whole envelope is redacted.
    if (e instanceof MissingSecretError) {
      const secret = SECRET_NAME_PATTERN.test(String(e.name)) ? String(e.name) : "(invalid name)";
      return this.redact({
        code: "MISSING_SECRET" as const,
        message: `Pack "${tool.packId}" needs the secret ${secret}, which is not set.`,
        retryable: false,
        pack: tool.packId,
        secret,
        ...(typeof e.label === "string" ? { label: e.label.slice(0, 200) } : {}),
        ...(typeof e.helpUrl === "string" ? { helpUrl: e.helpUrl.slice(0, 500) } : {}),
      });
    }
    if (e instanceof PolicyError) {
      return {
        code: e.code,
        message: capMessage(this.scrub(this.redact(e.message))),
        retryable: e.code === "APPROVAL_REQUIRED",
        ...(e.approval ? { approval: this.redact({ ...e.approval }) } : {}),
      };
    }
    let msg: string;
    try {
      msg = e instanceof Error ? e.message : String(e);
    } catch {
      msg = "the tool failed";
    }
    return {
      code: "TOOL_ERROR",
      message: capMessage(this.scrub(this.redact(msg))),
      retryable: false,
    };
  }

  /** Set after construction by the daemon, which knows the directories to hide. */
  setPathScrubber(scrub: (text: string) => string): void {
    this.pathScrubber = scrub;
  }

  private scrub(text: string): string {
    return this.pathScrubber ? this.pathScrubber(text) : text;
  }

  /** Every string (value or key) in a result with private paths hidden. */
  private scrubDeep<T>(value: T): T {
    const scrub = this.pathScrubber;
    if (!scrub) return value;
    const seen = new WeakSet<object>();
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return scrub(v);
      if (v === null || typeof v !== "object" || seen.has(v)) return v;
      if (Array.isArray(v)) {
        seen.add(v);
        return v.map(walk);
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v;
      seen.add(v);
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) out[scrub(key)] = walk(item);
      return out;
    };
    return walk(value) as T;
  }

  /** An error as it may be logged: stored secrets redacted, private paths hidden, bounded. */
  safeMessage(e: unknown): string {
    let msg: string;
    try {
      msg = e instanceof Error ? e.message : String(e);
    } catch {
      msg = "error";
    }
    return this.scrub(this.redact(msg)).slice(0, 500);
  }

  /**
   * Arguments as logged. By default only their names and sizes: callers pass
   * prompts, URLs and sometimes credentials, and the redactor only knows the
   * values in the secret store. With PLUGHIVE_LOG_ARGS=1 the values are
   * logged, masked by key name at every depth, with URL credentials removed.
   */
  private loggableArgs(rawInput: unknown): unknown {
    if (!this.logArgs) return describeArgs(rawInput);
    const args = this.redact(redactArgs(rawInput));
    if (!this.pathScrubber) return args;
    try {
      const json = JSON.stringify(args);
      return json === undefined ? args : JSON.parse(this.scrub(json));
    } catch {
      return "(arguments not shown)";
    }
  }

  private redact<T>(value: T): T {
    const r = this.opts.redactor;
    if (!r) return value;
    // Strings keep their type; everything else (including Buffers and typed
    // arrays, which become a "[binary N bytes]" marker) is walked.
    return typeof value === "string" ? (r.redact(value) as T) : r.redactDeep(value);
  }

  private meter(
    tool: RegisteredTool,
    latencyMs: number,
    status: "ok" | "error",
    error: string | null,
    costUsd: number | null,
    nested: { caller: string; depth: number } | null = null,
  ): void {
    const usage = this.opts.usage;
    if (!usage || this.opts.meteringExempt?.has(tool.name)) return;
    try {
      usage.record({
        tool: tool.name,
        vendor: this.opts.vendorOf?.(tool.name) ?? null,
        costUsd,
        latencyMs,
        status,
        error,
        meta: { pack: tool.packId, ...(nested ?? {}) },
      });
    } catch (e) {
      this.logger.warn({ tool: tool.name, err: this.safeMessage(e) }, "usage record failed");
    }
  }
}

/** No single call costs more than this; a larger figure is a broken or hostile result. */
export const MAX_COST_USD = 10_000;

/** A cost a tool result may put in the usage ledger: a finite amount from 0 to MAX_COST_USD. */
function validCost(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_COST_USD;
}

/**
 * The cost a tool result reports. The result comes from a pack or a mounted
 * server, so anything that is not a plausible amount (NaN, negative, infinite,
 * over MAX_COST_USD, not a number) counts as "not reported".
 */
export function extractCostUsd(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.cost_usd === "number") return validCost(r.cost_usd) ? r.cost_usd : null;
  if (typeof r.costUsd === "number") return validCost(r.costUsd) ? r.costUsd : null;
  if (Array.isArray(r.artifacts)) {
    let total = 0;
    for (const a of r.artifacts as unknown[]) {
      if (!a || typeof a !== "object") continue;
      const item = a as { cost_usd?: unknown; costUsd?: unknown };
      const cost = item.cost_usd ?? item.costUsd;
      if (validCost(cost)) total += cost;
    }
    return total > 0 && validCost(total) ? total : null;
  }
  return null;
}

const SECRET_KEY_NAME =
  /^(authorization|cookie|set-cookie|passwd|password|passphrase|secret|.*credentials?|.*signature|sig|bearer|.*api[_-]?key|.*access[_-]?key|.*private[_-]?key|.*[_-]?token|token.*|.*[_-]?secret|.*password|x-.*-key|key)$/i;
const MASK = "[redacted]";
const MAX_LOGGED_STRING = 200;
const MAX_LOGGED_ITEMS = 10;
const MAX_LOGGED_KEYS = 50;
const MAX_LOGGED_DEPTH = 6;

/** Remove `user:pass@` and credential-looking query values from every URL in `text`. */
export function maskUrlCredentials(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, `$1${MASK}@`)
    .replace(/([?&;]([^=&;#\s]{1,64})=)([^&;#\s]*)/g, (whole, head: string, name: string) => {
      let key = name;
      try {
        key = decodeURIComponent(name);
      } catch {
        // keep the raw name
      }
      return SECRET_KEY_NAME.test(key) ? `${head}${MASK}` : whole;
    });
}

function maskString(value: string): string {
  const masked = maskUrlCredentials(value);
  return masked.length > MAX_LOGGED_STRING
    ? `${masked.slice(0, MAX_LOGGED_STRING)}…(${value.length} chars)`
    : masked;
}

/**
 * Tool arguments with their values, safe enough to log on request: any key
 * with a secret-looking name is masked at every depth, URLs lose their
 * userinfo and credential query values, long strings and lists are cut.
 */
export function redactArgs(args: unknown, depth = 0): unknown {
  if (typeof args === "string") return maskString(args);
  if (!args || typeof args !== "object") return args;
  if (depth >= MAX_LOGGED_DEPTH) return "[nested]";
  if (ArrayBuffer.isView(args)) return `[binary ${args.byteLength} bytes]`;
  if (Array.isArray(args)) {
    if (args.length > MAX_LOGGED_ITEMS) return `[array of ${args.length}]`;
    return args.map((item) => redactArgs(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(args as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, MAX_LOGGED_KEYS)) {
    out[k] = SECRET_KEY_NAME.test(k) ? MASK : redactArgs(v, depth + 1);
  }
  if (entries.length > MAX_LOGGED_KEYS) out["…"] = `${entries.length - MAX_LOGGED_KEYS} more keys`;
  return out;
}

/** The names and sizes of tool arguments, never a value. */
export function describeArgs(args: unknown, depth = 0): unknown {
  if (args === null || args === undefined) return String(args);
  if (typeof args === "string") return `string(${args.length})`;
  if (typeof args !== "object") return typeof args;
  if (ArrayBuffer.isView(args)) return `binary(${args.byteLength})`;
  if (Array.isArray(args)) return `array(${args.length})`;
  const entries = Object.entries(args as Record<string, unknown>);
  if (depth >= 2) return `object(${entries.length})`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, MAX_LOGGED_KEYS)) {
    // Argument names come from the caller too: keep them short and plain.
    out[k.slice(0, 64).replace(/[^\w.-]/g, "_")] = describeArgs(v, depth + 1);
  }
  if (entries.length > MAX_LOGGED_KEYS) out["…"] = `${entries.length - MAX_LOGGED_KEYS} more keys`;
  return out;
}
