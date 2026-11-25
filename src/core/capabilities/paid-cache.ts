// Paid-call cache: the same paid capability call (capability, provider pin,
// model and normalized input) made again within the TTL returns the saved
// result instead of paying a provider a second time.
//
// Only results that saved library artifacts are kept, and a hit is used only
// while every one of those artifacts is still in the library. Entries live in
// `<home>/paid-cache.json` (0600, atomically replaced), newest first, capped
// at MAX_ENTRIES. A caller opts out per call with `cache: false` (input field
// or run option); the cached result says `cached: true` and costs nothing.

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceSync, writeFileAtomicSync } from "../../lib/platform.js";

/** Set to "0" to turn the cache off. */
export const PAID_CACHE_ENV = "PLUGHIVE_PAID_CACHE";
export const PAID_CACHE_FILE = "paid-cache.json";
export const DEFAULT_PAID_CACHE_TTL_MS = 24 * 60 * 60_000;
export const MAX_ENTRIES = 500;

export interface PaidCacheEntry {
  key: string;
  capability: string;
  provider: string;
  pack: string;
  at: number;
  result: Record<string, unknown>;
}

interface CacheFile {
  version: 1;
  entries: PaidCacheEntry[];
}

export interface PaidCacheOptions {
  home: string;
  /** True while the library still holds this artifact id. */
  artifactExists: (id: string) => boolean;
  ttlMs?: number;
  now?: () => number;
}

/** JSON with object keys sorted, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function paidCacheKey(parts: {
  capability: string;
  provider: string | undefined;
  model: string | undefined;
  input: unknown;
  profile?: string | undefined;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        c: parts.capability,
        p: parts.provider ?? null,
        m: parts.model ?? null,
        i: parts.input,
        r: parts.profile ?? "default",
      }),
    )
    .digest("hex");
}

/**
 * Takes `cache` out of a raw input object: `cache: false` opts out of the
 * paid-call cache. Any other value of the field is left for the schema.
 */
export function splitCacheFlag(rawInput: unknown): { input: unknown; noCache: boolean } {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { input: rawInput, noCache: false };
  }
  if (!("cache" in rawInput)) return { input: rawInput, noCache: false };
  const { cache, ...rest } = rawInput as Record<string, unknown>;
  if (cache === false) return { input: rest, noCache: true };
  if (cache === true || cache === undefined) return { input: rest, noCache: false };
  return { input: rawInput, noCache: false };
}

function artifactIds(result: Record<string, unknown>): string[] | null {
  const list = result.artifacts;
  if (!Array.isArray(list) || list.length === 0) return null;
  const ids: string[] = [];
  for (const a of list) {
    const id = a && typeof a === "object" ? (a as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || id === "") return null;
    ids.push(id);
  }
  return ids;
}

export class PaidCallCache {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private memo: { mtimeMs: number; file: CacheFile } | null = null;

  constructor(private readonly opts: PaidCacheOptions) {
    this.path = join(opts.home, PAID_CACHE_FILE);
    this.ttlMs = opts.ttlMs ?? DEFAULT_PAID_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** A saved result for `key` whose artifacts all still exist, else null. */
  get(key: string): PaidCacheEntry | null {
    const file = this.read();
    const entry = file.entries.find((e) => e.key === key);
    if (!entry) return null;
    if (this.now() - entry.at > this.ttlMs) return null;
    const ids = artifactIds(entry.result);
    if (!ids) return null;
    try {
      if (!ids.every((id) => this.opts.artifactExists(id))) return null;
    } catch {
      return null;
    }
    return entry;
  }

  /** Saves a paid result that produced artifacts; anything else is ignored. */
  put(entry: Omit<PaidCacheEntry, "at">): void {
    if (!artifactIds(entry.result)) return;
    const now = this.now();
    const file = this.read();
    const kept = file.entries.filter((e) => e.key !== entry.key && now - e.at <= this.ttlMs);
    const next: CacheFile = {
      version: 1,
      entries: [{ ...entry, at: now }, ...kept].slice(0, MAX_ENTRIES),
    };
    writeFileAtomicSync(this.path, `${JSON.stringify(next)}\n`);
    this.memo = null;
  }

  private read(): CacheFile {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      return { version: 1, entries: [] };
    }
    if (this.memo && this.memo.mtimeMs === mtimeMs) return this.memo.file;
    let file: CacheFile = { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CacheFile>;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        file = {
          version: 1,
          entries: parsed.entries.filter(
            (e): e is PaidCacheEntry =>
              !!e &&
              typeof e.key === "string" &&
              typeof e.provider === "string" &&
              typeof e.pack === "string" &&
              typeof e.at === "number" &&
              !!e.result &&
              typeof e.result === "object",
          ),
        };
      }
    } catch {
      // A broken cache file is an empty cache; the next put rewrites it.
    }
    this.memo = { mtimeMs, file };
    return file;
  }
}
