// Shared helpers for the provider packs (fal, replicate, openrouter).
//
// Packs may import only `plughive/pack`, node built-ins and their own files,
// so this file is copied verbatim into each provider pack. Keep the copies in
// sync: tests/packs/provider-common.test.ts checks that they are identical.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ArtifactKind, type PackContext, type PackFetch, z } from "plughive/pack";

export const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_OUTPUT_FILES = 32;
export const MAX_INPUT_ARTIFACTS = 16;

// biome-ignore lint/suspicious/noExplicitAny: external JSON of unknown shape
export type Json = any;
export type JsonSchema = Record<string, Json>;

export interface ArtifactOut {
  id: string;
  url: string;
  mime: string;
}

/** An error whose message is safe to show (never holds a secret or a signed URL). */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;
  constructor(provider: string, message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
  }
}

export class CancelledError extends Error {
  constructor(message = "The call was cancelled.") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

/** Sleep that wakes early (and throws) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read a response body, failing once it grows past `max` bytes. */
export async function readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`${what} is ${declared} bytes, over the ${max}-byte limit`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`${what} is over the ${max}-byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function readText(res: Response, max = MAX_JSON_BYTES): Promise<string> {
  return new TextDecoder().decode(await readCapped(res, max, "response"));
}

/** Parse a JSON body; returns `undefined` for an empty or non-JSON body. */
export async function readJson(res: Response, max = MAX_JSON_BYTES): Promise<Json> {
  const text = await readText(res, max);
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Invisible or layout-changing code points: C0/C1 controls, zero-width
 * characters, bidi embeddings/overrides/isolates and the BOM. Remote catalogs
 * are untrusted, so these never reach tool names, titles or descriptions.
 */
function isHiddenChar(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** One line of plain text: whitespace collapsed, hidden characters removed, at most `max` chars. */
export function oneLine(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
  let flat = "";
  for (const ch of s.replace(/\s+/g, " ")) {
    if (!isHiddenChar(ch.codePointAt(0) ?? 0)) flat += ch;
  }
  flat = flat.replace(/ {2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

/** Longest tool description the packs generate from remote catalog text. */
export const MAX_TOOL_DESCRIPTION = 1200;

/** A tool description built from untrusted parts: one line, cleaned, length-capped. */
export function toolDescription(...parts: (string | null | undefined | false)[]): string {
  return oneLine(parts.filter(Boolean).join(" "), MAX_TOOL_DESCRIPTION);
}

/** `decodeURIComponent` that returns null for malformed input instead of throwing. */
export function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Timeout for long synchronous provider calls and big downloads/uploads. */
export const LONG_CALL_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Model ids and tool names
// ---------------------------------------------------------------------------

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Validate an untrusted model id of `minSegments..maxSegments` slash-separated
 * segments. Rejects "..", empty segments, query or fragment characters.
 */
export function checkModelId(
  provider: string,
  id: string,
  minSegments: number,
  maxSegments: number,
): string {
  const parts = id.split("/");
  const ok =
    id.length <= 200 &&
    parts.length >= minSegments &&
    parts.length <= maxSegments &&
    parts.every((p) => SEGMENT.test(p) && !/^\.+$/.test(p));
  if (!ok) {
    throw new ProviderError(
      provider,
      `"${oneLine(id, 80)}" is not a valid ${provider} model id. Use the id exactly as ${provider}_search_models returns it.`,
    );
  }
  return id;
}

/** URL path for a validated id: each segment percent-encoded. */
export function encodeId(id: string): string {
  return id.split("/").map(encodeURIComponent).join("/");
}

/** `<packId>_<slug>`: lowercase snake case, never "__", at most 64 chars. */
export function toolNameFor(packId: string, slug: string): string {
  let s = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const max = 64 - packId.length - 1;
  if (s.length > max) {
    const hash = createHash("sha256").update(slug).digest("hex").slice(0, 6);
    s = `${s.slice(0, max - 7).replace(/_+$/, "")}_${hash}`;
  }
  return `${packId}_${s || "model"}`;
}

/** Comma or whitespace separated model list from a string setting. */
export function parseModelList(value: unknown, max = 25): string[] {
  if (typeof value !== "string") return [];
  const seen = new Set<string>();
  for (const raw of value.split(/[\s,]+/)) {
    const v = raw.trim();
    if (v) seen.add(v);
    if (seen.size >= max) break;
  }
  return [...seen];
}

export function numberSetting(
  settings: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const v = settings[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------
// Catalog cache: in-memory over a JSON file per key in the pack's dataDir.
// ---------------------------------------------------------------------------

interface CacheEntry {
  key: string;
  savedAt: number;
  value: Json;
}

export class JsonCache {
  private readonly mem = new Map<string, CacheEntry>();
  constructor(
    private readonly dir: string,
    private readonly ttlMs: number,
    private readonly maxMem = 200,
  ) {}

  private file(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 40)}.json`);
  }

  /** `fresh` is false when the entry is older than the TTL. */
  async get(key: string): Promise<{ value: Json; fresh: boolean } | null> {
    let entry = this.mem.get(key);
    if (!entry) {
      try {
        const parsed = JSON.parse(await readFile(this.file(key), "utf8")) as CacheEntry;
        if (parsed && parsed.key === key && typeof parsed.savedAt === "number") {
          entry = parsed;
          this.remember(entry);
        }
      } catch {
        return null;
      }
    }
    if (!entry) return null;
    return { value: entry.value, fresh: Date.now() - entry.savedAt < this.ttlMs };
  }

  async set(key: string, value: Json): Promise<void> {
    const entry: CacheEntry = { key, savedAt: Date.now(), value };
    this.remember(entry);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const file = this.file(key);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
      await rename(tmp, file);
    } catch {
      // The disk cache is an optimisation; memory still holds the entry.
    }
  }

  private remember(entry: CacheEntry): void {
    this.mem.delete(entry.key);
    this.mem.set(entry.key, entry);
    while (this.mem.size > this.maxMem) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
    }
  }

  /**
   * Fresh cache entry, else `load()` (cached on success), else a stale entry
   * when `load()` fails. Rethrows when there is nothing to fall back to.
   */
  async through(key: string, load: () => Promise<Json>): Promise<{ value: Json; cached: boolean }> {
    const hit = await this.get(key);
    if (hit?.fresh) return { value: hit.value, cached: true };
    try {
      const value = await load();
      await this.set(key, value);
      return { value, cached: false };
    } catch (e) {
      if (hit && !(e instanceof CancelledError)) return { value: hit.value, cached: true };
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// JSON Schema: OpenAPI component schemas to a self-contained JSON Schema, then zod.
// ---------------------------------------------------------------------------

const MAX_SCHEMA_NODES = 20_000;
const REF_PATTERN = /^#\/(?:components\/schemas|\$defs|definitions)\/([^/]+)$/;
const DEFS_REF = /^#\/\$defs\/(.+)$/;

/**
 * `out[k] = v` for keys that come from remote JSON: a "__proto__" key stays an
 * ordinary own property instead of replacing `out`'s prototype.
 */
function setOwn(out: Record<string, Json>, k: string, v: Json): void {
  if (k === "__proto__") {
    Object.defineProperty(out, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    out[k] = v;
  }
}

/**
 * Turn an OpenAPI 3.0/3.1 schema plus its `components.schemas` into a
 * self-contained draft 2020-12 schema: refs become `#/$defs/<name>` (only the
 * reachable ones are copied) and `nullable: true` becomes a null union.
 */
export function openApiToJsonSchema(
  root: Json,
  components: Record<string, Json> | undefined,
): JsonSchema {
  const comps = components ?? {};
  const defs: Record<string, Json> = {};
  const pending: string[] = [];
  let nodes = 0;

  const walk = (node: Json): Json => {
    if (++nodes > MAX_SCHEMA_NODES) throw new Error("schema is too large");
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref") {
        const m = typeof v === "string" ? v.match(REF_PATTERN) : null;
        const name = m?.[1] ? safeDecode(m[1]) : null;
        if (name !== null && Object.hasOwn(comps, name)) {
          if (!(name in defs) && !pending.includes(name)) pending.push(name);
          out.$ref = `#/$defs/${encodeURIComponent(name)}`;
        }
        // Unresolvable refs are dropped: the node becomes permissive.
        continue;
      }
      if (["nullable", "discriminator", "xml", "externalDocs", "example"].includes(k)) continue;
      setOwn(out, k, k === "properties" ? walkMap(v) : walk(v));
    }
    if ((node as Record<string, Json>).nullable === true) {
      return { anyOf: [out, { type: "null" }] };
    }
    return out;
  };
  const walkMap = (m: Json): Json => {
    if (!m || typeof m !== "object" || Array.isArray(m)) return m;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(m)) setOwn(out, k, walk(v));
    return out;
  };

  const top = walk(root) as JsonSchema;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    defs[name] = walk(comps[name]);
  }
  if (Object.keys(defs).length > 0) top.$defs = defs;
  return top;
}

/** Follow a top-level `$ref` / single `allOf` to the object schema it names. */
export function derefTop(schema: JsonSchema): JsonSchema {
  let s: Json = schema;
  const defs = (schema.$defs ?? {}) as Record<string, Json>;
  for (let i = 0; i < 5; i++) {
    const m = typeof s?.$ref === "string" ? (s.$ref as string).match(DEFS_REF) : null;
    if (m?.[1]) {
      const name = safeDecode(m[1]);
      s = name !== null && Object.hasOwn(defs, name) ? defs[name] : {};
      continue;
    }
    if (Array.isArray(s?.allOf) && s.allOf.length === 1 && !s.properties) {
      s = s.allOf[0];
      continue;
    }
    break;
  }
  return (s && typeof s === "object" ? s : {}) as JsonSchema;
}

/** A property schema with a single-`allOf` / `$ref` wrapper resolved. */
export function resolveProp(p: Json, defs: Record<string, Json>): Json {
  let s = p;
  for (let i = 0; i < 4; i++) {
    if (Array.isArray(s?.allOf) && s.allOf.length === 1) {
      s = {
        ...s.allOf[0],
        ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== "allOf")),
      };
      continue;
    }
    const m = typeof s?.$ref === "string" ? (s.$ref as string).match(DEFS_REF) : null;
    if (m?.[1]) {
      const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== "$ref"));
      const name = safeDecode(m[1]);
      s = { ...(name !== null && Object.hasOwn(defs, name) ? defs[name] : {}), ...rest };
      continue;
    }
    break;
  }
  return s;
}

/** Top-level input properties with `$ref`/`allOf` wrappers resolved. */
export function resolvedProps(schema: JsonSchema | null | undefined): Record<string, Json> {
  if (!schema) return {};
  const s = derefTop(schema);
  const defs = (schema.$defs ?? {}) as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, Json>)) {
    if (isSafeSchemaName(k)) out[k] = resolveProp(v, defs);
  }
  return out;
}

export interface FieldInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export function fieldsOf(schema: JsonSchema): FieldInfo[] {
  const s = derefTop(schema);
  const defs = (schema.$defs ?? {}) as Record<string, Json>;
  const props = (s.properties ?? {}) as Record<string, Json>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const typeOf = (raw: Json, depth = 0): string => {
    if (depth > 4) return "any";
    const p = resolveProp(raw, defs);
    if (!p || typeof p !== "object") return "any";
    if (Array.isArray(p.enum))
      return `enum(${p.enum
        .slice(0, 12)
        .map((x: Json) => oneLine(String(x), 40))
        .join("|")})`;
    if (typeof p.type === "string") {
      return p.type === "array" ? `array<${typeOf(p.items, depth + 1)}>` : oneLine(p.type, 20);
    }
    if (Array.isArray(p.type)) return p.type.map((x: Json) => oneLine(String(x), 20)).join("|");
    const alt = p.anyOf ?? p.oneOf;
    if (Array.isArray(alt))
      return alt
        .slice(0, 6)
        .map((x: Json) => typeOf(x, depth + 1))
        .join("|");
    if (p.properties) return "object";
    return "any";
  };
  const order = Array.isArray(s["x-fal-order-properties"])
    ? (s["x-fal-order-properties"] as string[])
    : null;
  const rank = (name: string): number => {
    if (order) {
      const i = order.indexOf(name);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    }
    const x = props[name]?.["x-order"];
    return typeof x === "number" ? x : Number.MAX_SAFE_INTEGER;
  };
  return Object.keys(props)
    .sort((a, b) => rank(a) - rank(b))
    .map((name) => {
      const p = resolveProp(props[name], defs);
      return {
        name,
        type: typeOf(props[name]),
        required: required.has(name),
        description: oneLine(p?.description ?? p?.title ?? "", 140),
      };
    });
}

export function fieldSummary(fields: FieldInfo[], max = 30): string {
  const shown = fields
    .slice(0, max)
    .map((f) => `${f.name}${f.required ? " (required)" : ""}: ${f.type}`);
  if (fields.length > max) shown.push(`... ${fields.length - max} more`);
  return shown.join("; ");
}

export interface ConvertedSchema {
  zod: z.ZodType;
  /** False when the JSON Schema could not be converted and a permissive schema is used. */
  exact: boolean;
  fields: FieldInfo[];
}

// Remote model schemas are untrusted input. These caps keep a hostile or
// broken catalog entry from blocking the event loop or flooding the client.
export const SCHEMA_LIMITS = {
  /** Serialised size of the cleaned schema. */
  maxBytes: 256 * 1024,
  /** Serialised size of the raw schema before cleaning is attempted. */
  maxRawBytes: 4 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 20_000,
  maxProperties: 200,
  maxEnum: 200,
  maxEnumValueChars: 500,
  maxDescription: 300,
  maxTitle: 120,
  maxStringValue: 1000,
  maxExamples: 3,
  maxDefs: 500,
} as const;

/** Keywords kept by `sanitizeSchema`. Everything else (notably `pattern`) is dropped. */
const SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "default",
  "description",
  "title",
  "examples",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  "$defs",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "format",
  "contentMediaType",
  "contentEncoding",
  "readOnly",
  "writeOnly",
  "deprecated",
  "x-order",
  "x-fal-order-properties",
]);
const SCHEMA_SUBSCHEMA = new Set(["items", "additionalProperties", "not"]);
const SCHEMA_SUBSCHEMA_LIST = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);
const SAFE_NAME = /^[A-Za-z0-9_$][A-Za-z0-9_.$@:-]{0,99}$/;
const UNSAFE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function isSafeSchemaName(name: string): boolean {
  return SAFE_NAME.test(name) && !UNSAFE_NAMES.has(name);
}

export interface SanitizedSchema {
  schema: JsonSchema;
  /** False when the schema must not be compiled (too big, cyclic refs, not an object). */
  ok: boolean;
  /** Why `ok` is false. */
  reason?: string;
  /** Things that were dropped or capped. */
  notes: string[];
}

function shortValue(v: Json): boolean {
  if (typeof v === "string") return v.length <= SCHEMA_LIMITS.maxEnumValueChars;
  return v === null || typeof v === "number" || typeof v === "boolean";
}

function cappedValue(v: Json): Json | undefined {
  if (typeof v === "string")
    return v.length <= SCHEMA_LIMITS.maxStringValue ? oneLineKeep(v) : undefined;
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  try {
    return JSON.stringify(v).length <= SCHEMA_LIMITS.maxStringValue ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Strip hidden characters but keep the string otherwise as is (defaults are data). */
function oneLineKeep(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (!isHiddenChar(c) || c === 0x0a || c === 0x09) out += ch;
  }
  return out;
}

/**
 * A copy of an untrusted JSON Schema that is safe to compile with zod and to
 * show to a client: no `pattern`/`patternProperties` (a remote regex can hang
 * the daemon), unknown keywords and unsafe property names dropped, enums,
 * strings, descriptions, property counts and depth capped. Cyclic `$ref`s and
 * oversized schemas come back with `ok: false`.
 */
export function sanitizeSchema(input: Json): SanitizedSchema {
  const notes = new Set<string>();
  const fail = (reason: string): SanitizedSchema => ({
    schema: { type: "object" },
    ok: false,
    reason,
    notes: [reason],
  });
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail("schema is not an object");
  let raw = 0;
  try {
    raw = JSON.stringify(input).length;
  } catch {
    return fail("schema is not plain JSON");
  }
  if (raw > SCHEMA_LIMITS.maxRawBytes) return fail(`schema is ${raw} bytes, over the limit`);

  let nodes = 0;
  const refs = new Map<string, Set<string>>();
  let tooBig = false;

  const clean = (node: Json, depth: number, owner: string): Json => {
    if (++nodes > SCHEMA_LIMITS.maxNodes) {
      tooBig = true;
      return {};
    }
    if (typeof node === "boolean") return node;
    if (!node || typeof node !== "object" || Array.isArray(node)) return {};
    if (depth > SCHEMA_LIMITS.maxDepth) {
      notes.add(
        `nesting deeper than ${SCHEMA_LIMITS.maxDepth} levels was replaced by an open schema`,
      );
      return {};
    }
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node as Record<string, Json>)) {
      if (k === "pattern" || k === "patternProperties") {
        notes.add("regular-expression constraints (pattern) are not enforced locally");
        continue;
      }
      if (!SCHEMA_KEYWORDS.has(k)) continue;
      if (k === "properties") {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const props: Record<string, Json> = {};
        let count = 0;
        for (const [name, sub] of Object.entries(v as Record<string, Json>)) {
          if (!isSafeSchemaName(name)) {
            notes.add("properties with unusual names were dropped");
            continue;
          }
          if (++count > SCHEMA_LIMITS.maxProperties) {
            notes.add(
              `only the first ${SCHEMA_LIMITS.maxProperties} properties of an object are kept`,
            );
            break;
          }
          props[name] = clean(sub, depth + 1, owner);
        }
        out.properties = props;
      } else if (k === "$defs") {
        // Handled at the top level only.
      } else if (SCHEMA_SUBSCHEMA.has(k)) {
        out[k] = typeof v === "boolean" ? v : clean(v, depth + 1, owner);
      } else if (SCHEMA_SUBSCHEMA_LIST.has(k)) {
        if (Array.isArray(v)) out[k] = v.slice(0, 50).map((x) => clean(x, depth + 1, owner));
      } else if (k === "$ref") {
        const m = typeof v === "string" ? v.match(DEFS_REF) : null;
        const name = m?.[1] ? safeDecode(m[1]) : null;
        if (name !== null && isSafeSchemaName(name)) {
          out.$ref = `#/$defs/${encodeURIComponent(name)}`;
          let set = refs.get(owner);
          if (!set) {
            set = new Set();
            refs.set(owner, set);
          }
          set.add(name);
        }
      } else if (k === "required") {
        if (Array.isArray(v)) {
          out.required = v
            .filter((x): x is string => typeof x === "string" && isSafeSchemaName(x))
            .slice(0, SCHEMA_LIMITS.maxProperties);
        }
      } else if (k === "enum") {
        if (!Array.isArray(v)) continue;
        if (v.length > SCHEMA_LIMITS.maxEnum || !v.every(shortValue)) {
          notes.add(
            `enums longer than ${SCHEMA_LIMITS.maxEnum} values (or with long values) are not enforced`,
          );
          continue;
        }
        out.enum = v.map((x) => (typeof x === "string" ? oneLineKeep(x) : x));
      } else if (k === "const") {
        if (shortValue(v)) out.const = typeof v === "string" ? oneLineKeep(v) : v;
      } else if (k === "default") {
        const d = cappedValue(v);
        if (d !== undefined) out.default = d;
      } else if (k === "examples") {
        if (!Array.isArray(v)) continue;
        const ex = v
          .slice(0, SCHEMA_LIMITS.maxExamples)
          .map(cappedValue)
          .filter((x) => x !== undefined);
        if (ex.length > 0) out.examples = ex;
      } else if (k === "description") {
        const d = oneLine(v, SCHEMA_LIMITS.maxDescription);
        if (d) out.description = d;
      } else if (k === "title") {
        const t = oneLine(v, SCHEMA_LIMITS.maxTitle);
        if (t) out.title = t;
      } else if (k === "format" || k === "contentMediaType" || k === "contentEncoding") {
        if (typeof v === "string" && /^[A-Za-z0-9._/+-]{1,60}$/.test(v)) out[k] = v;
      } else if (k === "type") {
        const ok = (t: Json) =>
          typeof t === "string" &&
          ["object", "array", "string", "number", "integer", "boolean", "null"].includes(t);
        if (ok(v)) out.type = v;
        else if (Array.isArray(v) && v.length <= 7 && v.every(ok)) out.type = v;
      } else if (k === "x-fal-order-properties") {
        if (Array.isArray(v)) {
          out[k] = v
            .filter((x): x is string => typeof x === "string" && isSafeSchemaName(x))
            .slice(0, SCHEMA_LIMITS.maxProperties);
        }
      } else if (typeof v === "number" || typeof v === "boolean") {
        // Numeric and boolean keywords: minimum, maxLength, uniqueItems, x-order, ...
        if (typeof v === "boolean" || Number.isFinite(v)) out[k] = v;
      }
    }
    return out;
  };

  const ROOT = "\u0000root";
  const top = clean(input, 0, ROOT) as Record<string, Json>;
  const rawDefs = (input as Record<string, Json>).$defs;
  if (rawDefs && typeof rawDefs === "object" && !Array.isArray(rawDefs)) {
    const defs: Record<string, Json> = {};
    let count = 0;
    for (const [name, sub] of Object.entries(rawDefs as Record<string, Json>)) {
      if (!isSafeSchemaName(name)) continue;
      if (++count > SCHEMA_LIMITS.maxDefs) return fail("schema has too many definitions");
      defs[name] = clean(sub, 1, name);
    }
    if (Object.keys(defs).length > 0) top.$defs = defs;
  }
  if (tooBig) return fail("schema has too many nodes");

  // Refuse reference cycles (a model schema that refers to itself).
  const defined = new Set(Object.keys((top.$defs ?? {}) as Record<string, Json>));
  for (const targets of refs.values()) {
    for (const t of targets) {
      if (!defined.has(t)) {
        return {
          ...fail(`schema refers to a missing definition "${oneLine(t, 60)}"`),
          schema: top,
        };
      }
    }
  }
  const state = new Map<string, 1 | 2>();
  const cyclic = (name: string): boolean => {
    const s = state.get(name);
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(name, 1);
    for (const t of refs.get(name) ?? []) if (cyclic(t)) return true;
    state.set(name, 2);
    return false;
  };
  for (const t of refs.get(ROOT) ?? []) {
    if (cyclic(t)) return { ...fail("schema has recursive $ref definitions"), schema: top };
  }
  for (const name of defined) {
    if (cyclic(name)) return { ...fail("schema has recursive $ref definitions"), schema: top };
  }

  const size = JSON.stringify(top).length;
  if (size > SCHEMA_LIMITS.maxBytes) return fail(`cleaned schema is ${size} bytes, over the limit`);
  return { schema: top, ok: true, notes: [...notes] };
}

/** JSON Schema to zod via z.fromJSONSchema, with a permissive object fallback. */
export function toZod(schema: JsonSchema): ConvertedSchema {
  const clean = sanitizeSchema(schema);
  let fields: FieldInfo[] = [];
  try {
    fields = fieldsOf(clean.schema);
  } catch {
    fields = [];
  }
  if (!clean.ok) return { zod: z.looseObject({}), exact: false, fields };
  try {
    const converted = z.fromJSONSchema(clean.schema as never) as z.ZodType;
    // The registry advertises the schema with z.toJSONSchema; make sure that works too.
    const advertised = z.toJSONSchema(converted, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "any",
    }) as Json;
    if (advertised?.type !== "object") throw new Error("model input is not an object schema");
    return { zod: converted, exact: true, fields };
  } catch {
    return { zod: z.looseObject({}), exact: false, fields };
  }
}

/** Zod issues as one readable line per problem. */
export function describeIssues(error: z.ZodError, max = 8): string {
  const lines = error.issues.slice(0, max).map((i) => {
    const path = i.path.length > 0 ? i.path.join(".") : "(input)";
    return `${path}: ${i.message}`;
  });
  if (error.issues.length > max) lines.push(`... ${error.issues.length - max} more`);
  return lines.join("; ");
}

/** A small example input from required fields, defaults and enum values. */
export function exampleInput(schema: JsonSchema, overrides: Record<string, Json> = {}): Json {
  const s = derefTop(schema);
  const defs = (schema.$defs ?? {}) as Record<string, Json>;
  const props = (s.properties ?? {}) as Record<string, Json>;
  const required: string[] = Array.isArray(s.required) ? (s.required as string[]) : [];
  const out: Record<string, Json> = {};
  const sample = (name: string, raw: Json): Json => {
    if (name in overrides) return overrides[name];
    const p = resolveProp(raw, defs);
    if (Array.isArray(p?.examples) && p.examples.length > 0) return p.examples[0];
    if (p?.default !== undefined) return p.default;
    if (Array.isArray(p?.enum) && p.enum.length > 0) return p.enum[0];
    const type = Array.isArray(p?.type) ? p.type[0] : p?.type;
    if (type === "array") return /url|uri|image/i.test(name) ? ["artifact:<artifact id>"] : [];
    if (/url|uri/i.test(name)) return "artifact:<artifact id>";
    if (type === "integer" || type === "number") return p?.minimum ?? 1;
    if (type === "boolean") return false;
    if (type === "object") return {};
    return "...";
  };
  const wanted = new Set([...required, ...Object.keys(overrides).filter((k) => k in props)]);
  if (wanted.size === 0 && "prompt" in props) wanted.add("prompt");
  for (const name of wanted) out[name] = sample(name, props[name]);
  return out;
}

// ---------------------------------------------------------------------------
// Inputs: `artifact:<id>` references become data URIs (or provider uploads).
// ---------------------------------------------------------------------------

const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ARTIFACT_REF = /^artifact:([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

export function checkArtifactId(id: string): string {
  if (!ARTIFACT_ID.test(id)) throw new Error(`"${oneLine(id, 60)}" is not a valid artifact id`);
  return id;
}

export interface LoadedArtifact {
  id: string;
  mime: string;
  bytes: Uint8Array;
}

export async function loadArtifact(ctx: PackContext, id: string): Promise<LoadedArtifact> {
  checkArtifactId(id);
  const rec = await ctx.library.get(id);
  if (!rec) {
    throw new Error(
      `artifact ${id} was not found in the library. Use an id returned by a previous tool call.`,
    );
  }
  const bytes = await ctx.library.read(id);
  return { id, mime: rec.mime || "application/octet-stream", bytes };
}

export function dataUri(a: { mime: string; bytes: Uint8Array }): string {
  return `data:${a.mime};base64,${Buffer.from(a.bytes).toString("base64")}`;
}

export interface ResolveOptions {
  /** Max bytes per inlined artifact. Bigger ones need `upload`. */
  maxInlineBytes: number;
  /** Turn a large artifact into a URL the provider can fetch. */
  upload?: (a: LoadedArtifact) => Promise<string>;
}

/** Resolve one artifact id to a data URI (or an upload URL). */
export async function artifactToUrl(
  ctx: PackContext,
  id: string,
  opts: ResolveOptions,
): Promise<string> {
  const a = await loadArtifact(ctx, id);
  if (a.bytes.byteLength <= opts.maxInlineBytes) return dataUri(a);
  if (opts.upload) return opts.upload(a);
  throw new Error(
    `artifact ${id} is ${a.bytes.byteLength} bytes; this provider accepts at most ${opts.maxInlineBytes} bytes inline`,
  );
}

/**
 * Replace every string of the form `artifact:<id>` anywhere in `value` with a
 * data URI (or an upload URL). Other values are returned unchanged.
 */
export async function resolveArtifactRefs(
  value: Json,
  ctx: PackContext,
  opts: ResolveOptions,
): Promise<Json> {
  const memo = new Map<string, string>();
  const one = async (id: string): Promise<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (memo.size >= MAX_INPUT_ARTIFACTS) {
      throw new Error(`at most ${MAX_INPUT_ARTIFACTS} artifacts can be passed in one call`);
    }
    const out = await artifactToUrl(ctx, id, opts);
    memo.set(id, out);
    return out;
  };
  const walk = async (v: Json, depth: number): Promise<Json> => {
    if (depth > 20) return v;
    if (typeof v === "string") {
      const m = v.match(ARTIFACT_REF);
      return m?.[1] ? one(m[1]) : v;
    }
    if (Array.isArray(v)) {
      const out: Json[] = [];
      for (const x of v) out.push(await walk(x, depth + 1));
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) setOwn(out, k, await walk(x, depth + 1));
      return out;
    }
    return v;
  };
  return walk(value, 0);
}

/**
 * Refuse http(s) URLs in url-ish input fields unless `allowUrls` is on: the
 * provider fetches them itself, so anything in the link (a query string with a
 * secret, say) is handed to a third party. `artifact:<id>` refs are not URLs
 * and are resolved separately; data: URIs are inline. Key names decide, so
 * prompt text may mention URLs while file fields may not.
 */
export function checkInputUrls(value: Json, allowUrls: boolean): void {
  const urlishKey = /url|uri|image|video|audio|file/i;
  const walk = (v: unknown, key: string | null): void => {
    if (typeof v === "string") {
      if (
        key !== null &&
        urlishKey.test(key) &&
        !v.startsWith("data:") &&
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v)
      ) {
        let u: URL | null = null;
        try {
          u = new URL(v);
        } catch {
          u = null;
        }
        if (u === null || u.protocol !== "https:") {
          throw new Error(`only https URLs are allowed in "${key}" (got ${v.slice(0, 24)}...)`);
        }
        if (!allowUrls) {
          throw new Error(
            `URL inputs are off: pass a library file as "artifact:<id>" in "${key}", or turn on the allow_url_inputs setting to let the provider fetch URLs`,
          );
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(value, null);
}

// ---------------------------------------------------------------------------
// Outputs: download provider files into the library.
// ---------------------------------------------------------------------------

export function kindOf(mime: string): ArtifactKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return "other";
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  pcm: "audio/pcm",
  glb: "model/gltf-binary",
  zip: "application/zip",
  json: "application/json",
  txt: "text/plain",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  pdf: "application/pdf",
};

export function mimeFromName(name: string): string | null {
  const m = name.match(/\.([A-Za-z0-9]{1,5})$/);
  return m?.[1] ? (EXT_MIME[m[1].toLowerCase()] ?? null) : null;
}

export function looksLikeFileUrl(u: string): boolean {
  if (u.startsWith("data:")) return /^data:[a-z]+\/[A-Za-z0-9.+-]+;base64,/.test(u);
  try {
    const url = new URL(u);
    return url.protocol === "https:" && mimeFromName(url.pathname) !== null;
  } catch {
    return false;
  }
}

export interface FileRef {
  url: string;
  mime?: string | null;
}

export interface SaveMeta {
  provider: string;
  model: string;
  prompt?: string | null;
  costUsd?: number | null;
  meta?: Record<string, unknown>;
  /** How to collect this job again without paying twice (names the get-result tool). */
  recoverHint?: string;
}

export interface SaveOptions {
  /** Fetch used for downloads. Default ctx.fetch. */
  fetch?: PackFetch;
  /** Extra headers for a download URL (only for the provider's own API host). */
  headersFor?: (url: URL) => Record<string, string> | undefined;
  maxBytes?: number;
}

export interface SaveResult {
  artifacts: ArtifactOut[];
  /** One entry per input file: the saved artifact, or null when it failed. */
  perFile: (ArtifactOut | null)[];
  /** Files that could not be saved, without their (possibly signed) URLs. */
  failed: { index: number; host: string; error: string }[];
}

/** Decode a `data:` URI. Returns null for anything else. */
export function decodeDataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
  const m = uri.match(/^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const body = m[4] ?? "";
  const bytes = m[3] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  return { mime, bytes: new Uint8Array(bytes) };
}

export async function saveFiles(
  ctx: PackContext,
  files: FileRef[],
  meta: SaveMeta,
  opts: SaveOptions = {},
): Promise<SaveResult> {
  const fetchFn = opts.fetch ?? ctx.fetch;
  const max = opts.maxBytes ?? MAX_FILE_BYTES;
  const out: SaveResult = { artifacts: [], perFile: [], failed: [] };
  for (const [i, f] of files.slice(0, MAX_OUTPUT_FILES).entries()) {
    throwIfAborted(ctx.signal);
    let host = "inline";
    try {
      let bytes: Uint8Array;
      let mime: string | null | undefined;
      const inline = f.url.startsWith("data:") ? decodeDataUri(f.url) : null;
      if (inline) {
        if (inline.bytes.byteLength > max) throw new Error(`file is over the ${max}-byte limit`);
        bytes = inline.bytes;
        mime = f.mime || inline.mime;
      } else {
        const url = new URL(f.url);
        host = url.host;
        if (url.protocol !== "https:") throw new Error("only https file URLs are downloaded");
        const res = await fetchFn(url.toString(), {
          headers: opts.headersFor?.(url) ?? {},
          timeoutMs: LONG_CALL_MS,
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(
            res.status === 403 || res.status === 404 || res.status === 410
              ? `download failed with HTTP ${res.status}; the provider link has probably expired`
              : `download failed with HTTP ${res.status}`,
          );
        }
        bytes = await readCapped(res, max, "output file");
        const header = res.headers.get("content-type")?.split(";")[0]?.trim();
        mime =
          f.mime ||
          (header && header !== "application/octet-stream" ? header : null) ||
          mimeFromName(url.pathname);
      }
      const finalMime = mime || "application/octet-stream";
      const ref = await ctx.library.save({
        kind: kindOf(finalMime),
        mime: finalMime,
        bytes,
        model: meta.model,
        prompt: meta.prompt ? meta.prompt.slice(0, 2000) : null,
        // The cost belongs to the whole call: record it once.
        costUsd: out.artifacts.length === 0 ? (meta.costUsd ?? null) : null,
        meta: { provider: meta.provider, ...(meta.meta ?? {}) },
      });
      const a = { id: ref.id, url: ref.url, mime: ref.mime };
      out.artifacts.push(a);
      out.perFile.push(a);
    } catch (e) {
      if (e instanceof CancelledError || ctx.signal?.aborted) throw new CancelledError();
      out.perFile.push(null);
      out.failed.push({ index: i, host, error: safeMessage(e) });
    }
  }
  return out;
}

/** Error text without URLs (signed links carry tokens in their query). */
export function safeMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return oneLine(
    msg.replace(/(?:https?:\/\/|data:)[^\s"')]+/g, (u) => hostOnly(u)),
    400,
  );
}

function hostOnly(u: string): string {
  if (u.startsWith("data:")) return "<inline data>";
  try {
    return `<${new URL(u).host}>`;
  } catch {
    return "<url>";
  }
}

/**
 * Walk a provider output: every file (a URL string accepted by `isFileUrl`, or
 * an object with such a `url`) is collected and replaced by a placeholder;
 * `bindArtifacts` later swaps the placeholder for `artifact_id`. Non-file
 * fields are kept as they are.
 */
export function extractFiles(
  output: Json,
  isFileUrl: (u: string) => boolean,
): { files: FileRef[]; stripped: Json } {
  const files: FileRef[] = [];
  const walk = (v: Json, depth: number): Json => {
    if (depth > 20) return v;
    if (typeof v === "string") {
      if (files.length < MAX_OUTPUT_FILES && isFileUrl(v)) {
        files.push({ url: v });
        return { $file: files.length - 1 };
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      if (typeof v.url === "string" && files.length < MAX_OUTPUT_FILES && isFileUrl(v.url)) {
        files.push({
          url: v.url,
          mime: typeof v.content_type === "string" ? v.content_type : null,
        });
        const rest: Record<string, Json> = {};
        for (const [k, x] of Object.entries(v)) {
          if (k !== "url" && k !== "file_data") setOwn(rest, k, x);
        }
        return { ...rest, $file: files.length - 1 };
      }
      const out: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) setOwn(out, k, walk(x, depth + 1));
      return out;
    }
    return v;
  };
  return { files, stripped: walk(output, 0) };
}

export function bindArtifacts(stripped: Json, saved: SaveResult): Json {
  const walk = (v: Json, depth: number): Json => {
    if (depth > 22) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length === 1 && typeof v.$file === "number") {
        return { artifact_id: saved.perFile[v.$file]?.id ?? null };
      }
      const out: Record<string, Json> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "$file" && typeof x === "number") out.artifact_id = saved.perFile[x]?.id ?? null;
        else setOwn(out, k, walk(x, depth + 1));
      }
      return out;
    }
    return v;
  };
  return walk(stripped, 0);
}

/** The run result every provider returns. */
export interface RunResult {
  artifacts: ArtifactOut[];
  output: Json;
  model: string;
  provider: string;
  cost_usd?: number;
  warnings?: string[];
}

/** Download every file in `output`, then build the normalised run result. */
export async function finishRun(
  ctx: PackContext,
  output: Json,
  meta: SaveMeta,
  isFileUrl: (u: string) => boolean,
  opts: SaveOptions = {},
): Promise<RunResult> {
  const { files, stripped } = extractFiles(output, isFileUrl);
  const saved = await saveFiles(ctx, files, meta, opts);
  if (files.length > 0 && saved.artifacts.length === 0) {
    throw new ProviderError(
      meta.provider,
      `the job finished but none of its ${files.length} output file(s) could be downloaded (${saved.failed
        .slice(0, 3)
        .map((f) => `${f.host}: ${f.error}`)
        .join("; ")}). The job is already paid for, so do not run it again: ${
        meta.recoverHint ?? "collect it with the provider's get-result tool"
      }.`,
    );
  }
  const result: RunResult = {
    artifacts: saved.artifacts,
    output: bindArtifacts(stripped, saved),
    model: meta.model,
    provider: meta.provider,
  };
  if (typeof meta.costUsd === "number") result.cost_usd = meta.costUsd;
  if (saved.failed.length > 0) {
    result.warnings = saved.failed.map((f) => `output file ${f.index} (${f.host}): ${f.error}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface PollStep<T> {
  done: boolean;
  value?: T;
  /** Fraction in [0, 1) while running. */
  fraction?: number;
  message?: string;
}

/**
 * What happened to the provider job when the call stopped waiting:
 * "sent" the provider accepted a cancel, "failed" the cancel request failed,
 * "unsupported" the provider has no cancel endpoint.
 */
export type CancelOutcome = "sent" | "failed" | "unsupported";

export interface PollOptions<T> {
  provider: string;
  signal?: AbortSignal;
  maxWaitMs: number;
  check: () => Promise<PollStep<T>>;
  /** Called once when the call is cancelled or times out. Throwing counts as "failed". */
  cancel: () => Promise<CancelOutcome>;
  /** The provider's job id, quoted in every error so the job can be found again. */
  jobId: string;
  /** How to collect the job later, e.g. "call fal_get_result with ...". */
  recoverHint: string;
  progress?: (fraction: number, message?: string) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Poll with exponential backoff until done, honouring cancellation and a time cap. */
export async function poll<T>(opts: PollOptions<T>): Promise<T> {
  const now = opts.now ?? Date.now;
  const wait = opts.sleepFn ?? sleep;
  const started = now();
  let delay = opts.initialDelayMs ?? 1000;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  let transientErrors = 0;
  const job = `${opts.provider} job ${opts.jobId}`;
  const cancelNow = async (): Promise<CancelOutcome> => {
    try {
      return await opts.cancel();
    } catch {
      return "failed";
    }
  };
  const fate = (outcome: CancelOutcome): string => {
    if (outcome === "sent") {
      return `A cancel request for ${job} was accepted; ${opts.provider} may still bill for any time it already ran.`;
    }
    if (outcome === "unsupported") {
      return `${opts.provider} has no cancel endpoint for this job, so ${job} keeps running and will be billed. To collect its output, ${opts.recoverHint}.`;
    }
    return `The cancel request for ${job} failed, so it may still be running and billed. To collect its output, ${opts.recoverHint}.`;
  };
  const cancelled = async (): Promise<never> => {
    throw new CancelledError(`The call was cancelled. ${fate(await cancelNow())}`);
  };
  for (;;) {
    if (opts.signal?.aborted) return cancelled();
    let step: PollStep<T>;
    try {
      step = await opts.check();
      transientErrors = 0;
    } catch (e) {
      if (opts.signal?.aborted || e instanceof CancelledError) return cancelled();
      if (e instanceof ProviderError && e.status !== null && e.status < 500 && e.status !== 429) {
        throw e;
      }
      if (e instanceof ProviderError && e.status === null) throw e;
      if (++transientErrors > 5) {
        // The provider could not be reached; the job itself may be fine. Leave it running.
        throw new ProviderError(
          opts.provider,
          `lost contact with ${job} after ${transientErrors} failed status checks (${safeMessage(e)}). It was not cancelled and may still finish and be billed. Do not run it again; ${opts.recoverHint}.`,
          e instanceof ProviderError ? e.status : null,
        );
      }
      step = { done: false };
    }
    if (step.done) return step.value as T;
    opts.progress?.(Math.max(0, Math.min(0.95, step.fraction ?? 0)), step.message);
    if (now() - started > opts.maxWaitMs) {
      const minutes = Math.max(1, Math.round(opts.maxWaitMs / 60000));
      throw new ProviderError(
        opts.provider,
        `${job} did not finish within ${minutes} minute(s). ${fate(await cancelNow())} Raise the max_wait_minutes setting for slow models.`,
      );
    }
    try {
      await wait(delay, opts.signal);
    } catch {
      return cancelled();
    }
    delay = Math.min(maxDelay, Math.round(delay * 1.5));
  }
}

/**
 * Run `fn` for a submitted (paid) job: a provider error that does not name the
 * job is rethrown with its id and how to collect it, so nobody pays twice.
 */
export async function withJobContext<T>(
  provider: string,
  label: string,
  jobId: string,
  recoverHint: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CancelledError || !(e instanceof ProviderError) || e.message.includes(jobId))
      throw e;
    throw new ProviderError(
      provider,
      `${e.message.replace(/\.$/, "")} (${label} ${jobId}; do not resubmit, ${recoverHint} to check it again).`,
      e.status,
    );
  }
}

/** Smooth progress estimate for providers that report no fraction. */
export function elapsedFraction(elapsedMs: number, typicalMs = 60_000): number {
  return 0.1 + 0.8 * (1 - Math.exp(-elapsedMs / typicalMs));
}

/** Validate `input` with a converted schema; throws a readable error before any network call. */
export function validateInput(
  provider: string,
  model: string,
  schema: ConvertedSchema,
  input: Json,
): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProviderError(provider, `input for ${model} must be a JSON object`);
  }
  const parsed = schema.zod.safeParse(input);
  if (!parsed.success) {
    throw new ProviderError(
      provider,
      `input for ${model} does not match its schema: ${describeIssues(parsed.error)}. Call ${provider}_describe_model to see the fields.`,
    );
  }
  if (!schema.exact) {
    const missing = schema.fields
      .filter((f) => f.required && !(f.name in (input as Record<string, Json>)))
      .map((f) => f.name);
    if (missing.length > 0) {
      throw new ProviderError(
        provider,
        `input for ${model} is missing required field(s): ${missing.join(", ")}`,
      );
    }
  }
}
