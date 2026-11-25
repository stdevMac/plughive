// Helpers shared by the provider pack tests (fal, replicate, openrouter).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnyToolDefinition,
  ArtifactRecord,
  LibrarySaveInput,
  PackContext,
  PackDefinition,
} from "plughive/pack";
import { PackLoader } from "../../src/core/packs/loader.js";
import { createSecretStore } from "../../src/core/secrets/index.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { silent } from "./support.js";

export function tempDir(prefix = "plughive-prov-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface MemLibrary {
  library: PackContext["library"];
  saved: (LibrarySaveInput & { id: string })[];
  /** Add an artifact; `tool` is who made it (default a user upload, "user/upload"). */
  put(id: string, mime: string, bytes: Uint8Array, tool?: string): void;
}

export type LibraryPermission = "none" | "read" | "write" | "read-all" | "full";

/** The library permission a builtin pack declares in its pack.json. */
export function declaredLibraryPermission(packId: string): LibraryPermission {
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "packs", packId, "pack.json"), "utf8"),
  );
  return (manifest.permissions?.library ?? "none") as LibraryPermission;
}

/**
 * An in-memory artifact library that applies the host's visibility rule: a
 * pack sees every artifact with "read-all" or "full", otherwise only those its
 * own tools made (`<packId>/<tool>`). With a `packId` and no `permission`, the
 * permission is read from that pack's pack.json, so tests follow the manifest.
 */
export function memLibrary(
  opts: { packId?: string; permission?: LibraryPermission } = {},
): MemLibrary {
  const records = new Map<string, ArtifactRecord>();
  const blobs = new Map<string, Uint8Array>();
  const saved: (LibrarySaveInput & { id: string })[] = [];
  const packId = opts.packId ?? null;
  const permission = opts.permission ?? (packId ? declaredLibraryPermission(packId) : "full");
  const canReadAll = permission === "read-all" || permission === "full";
  const visible = (r: ArtifactRecord): boolean =>
    canReadAll || (packId !== null && r.tool.startsWith(`${packId}/`));
  let n = 0;
  const put = (id: string, mime: string, bytes: Uint8Array, tool = "user/upload") => {
    records.set(id, {
      id,
      kind: "other",
      mime,
      url: `http://127.0.0.1:7777/a/${id}`,
      bytes: bytes.byteLength,
      tool,
      model: null,
      prompt: null,
      meta: null,
      costUsd: null,
      createdAt: new Date(0).toISOString(),
    });
    blobs.set(id, bytes);
  };
  return {
    saved,
    put,
    library: {
      async get(id) {
        const r = records.get(id);
        return r && visible(r) ? r : null;
      },
      async list() {
        return [...records.values()].filter(visible);
      },
      async read(id) {
        const r = records.get(id);
        const b = blobs.get(id);
        if (!r || !b || !visible(r)) throw new Error(`no artifact ${id}`);
        return b;
      },
      async save(input) {
        const id = `art_${++n}`;
        put(id, input.mime, input.bytes, `${packId ?? "test"}/tool`);
        saved.push({ ...input, id });
        return { id, path: `/lib/${id}`, url: `http://127.0.0.1:7777/a/${id}`, mime: input.mime };
      },
      async importFile() {
        throw new Error("not used");
      },
      async materialize() {
        throw new Error("not used");
      },
    },
  };
}

/** The Error a promise rejects with; fails the test if it resolves instead. */
export async function failure(p: unknown): Promise<Error> {
  let value: unknown;
  try {
    value = await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`rejected with a non-Error: ${String(e)}`);
  }
  throw new Error(`expected a rejection, got ${JSON.stringify(value)?.slice(0, 200)}`);
}

export interface Route {
  method?: string;
  /** Matched against `METHOD url`. */
  match: RegExp;
  reply: (req: { url: string; init?: RequestInit }) => Response | Promise<Response>;
  /** Times this route may answer (default: unlimited). */
  times?: number;
}

export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

/** A fetch mock that answers from `routes` (first match wins) and records each call. */
export function routerFetch(routes: Route[]): PackContext["fetch"] & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const used = new Map<Route, number>();
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({ method, url, headers, body: typeof init?.body === "string" ? init.body : null });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    for (const r of routes) {
      if (r.method && r.method !== method) continue;
      if (!r.match.test(`${method} ${url}`)) continue;
      const count = used.get(r) ?? 0;
      if (r.times !== undefined && count >= r.times) continue;
      used.set(r, count + 1);
      return r.reply({ url, init });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
  return Object.assign(fn, { calls });
}

export interface LogLine {
  level: string;
  msg: string;
  data?: unknown;
}

/** A logger that records every line. */
export function captureLogger(): PackContext["logger"] & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (msg: string, data?: unknown) => {
    lines.push({ level, msg, data });
  };
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  } as never;
}

/**
 * The host's per-call fetch: every request is bound to the call's signal, so
 * once the call is cancelled the call fetch can no longer reach anything.
 */
export function boundFetch(
  fetch: PackContext["fetch"],
  signal: AbortSignal | undefined,
): PackContext["fetch"] {
  if (!signal) return fetch;
  return (input, init = {}) =>
    fetch(input, {
      ...init,
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
}

export function bytesResponse(bytes: Uint8Array, mime: string, status = 200): Response {
  return new Response(bytes, { status, headers: { "content-type": mime } });
}

/** Static or function-form tool list of a pack, built with `ctx` (and setup's services). */
export async function packTools(
  pack: PackDefinition,
  ctx: PackContext,
): Promise<{ tools: AnyToolDefinition[]; ctx: PackContext }> {
  const services = (await pack.setup?.(ctx)) ?? {};
  const full = { ...ctx, ...services } as PackContext;
  const tools =
    typeof pack.tools === "function" ? await pack.tools(full as never) : (pack.tools ?? []);
  return { tools: [...tools], ctx: full };
}

export function findTool(tools: AnyToolDefinition[], name: string): AnyToolDefinition {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} missing; have ${tools.map((x) => x.name).join(", ")}`);
  return t;
}

/**
 * The real packs/ folder with DNS resolution failing for every host: a model
 * of starting the daemon offline. No secrets are set.
 */
export async function loadPacksOffline(
  settingsOverrides: Record<string, Record<string, unknown>> = {},
) {
  const dir = tempDir("plughive-offline-");
  const registry = new ToolRegistry();
  const store = createSecretStore({ home: dir, env: {}, backend: "memory" });
  const lookups: string[] = [];
  const loader = new PackLoader({
    home: dir,
    registry,
    host: {
      store,
      logger: silent,
      fetchPolicy: {
        lookup: async (host: string) => {
          lookups.push(host);
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
        },
      },
    },
    userDir: join(dir, "packs"),
    settingsOverrides,
  });
  const started = Date.now();
  await loader.loadAll();
  return {
    registry,
    loader,
    lookups,
    loadMs: Date.now() - started,
    async close() {
      await loader.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
