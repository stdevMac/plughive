// src/core/packs/testing.ts  (published as "plughive/pack/testing")
//
// Test harness for pack authors. `createTestContext` returns the REAL scoped
// PackContext, built by the same code the daemon runs, so a test sees the same
// permission checks, secret scoping, artifact attribution and spawn rules as
// production. Only the outside world is faked: secrets come from a plain
// object, the library is in memory, and fetch / spawn / llm / other tools are
// the functions you pass in.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArtifactKind,
  LlmChatRequest,
  LlmChatResult,
  PackContext,
  SpawnOptions,
  SpawnResult,
} from "../pack-api.js";
import { MissingSecretError, createSecretStore } from "../secrets/index.js";
import type { CallContext, ToolEnvelope } from "../tools/registry.js";
import {
  type HostArtifact,
  type HostCapabilities,
  type HostLibrary,
  type PackHost,
  type ScopedPackContext,
  createPackContext,
  localEndpointEntry,
} from "./context.js";
import { endpointSettings, spawnRootsFromSettings } from "./loader.js";
import {
  type PackManifest,
  type PackSource,
  parseManifest,
  parseManifestText,
} from "./manifest.js";

export interface TestLogLine {
  level: "debug" | "info" | "warn" | "error";
  obj: Record<string, unknown>;
  msg: string;
}

export type TestToolHandler = (args: unknown, callCtx: CallContext) => unknown;

export interface CreateTestContextOptions {
  /** The pack.json content (validated like the loader does). Or pass `packDir`. */
  manifest?: unknown;
  /** Folder holding pack.json. */
  packDir?: string;
  /** Default "builtin". With "user", only `grants` are readable. */
  source?: PackSource;
  grants?: readonly string[];
  /** Secret values by name. Only declared (and granted) names are readable. */
  secrets?: Record<string, string>;
  settings?: Record<string, unknown>;
  /** Replaces the network. Host permissions are still checked first. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Replaces process spawning. `permissions.spawn`, env and cwd rules are still applied. */
  spawn?: (
    binary: string,
    args: readonly string[],
    opts: SpawnOptions,
  ) => Promise<Partial<SpawnResult>> | Partial<SpawnResult>;
  /** Replaces the in-memory library. */
  library?: HostLibrary;
  llm?: (req: LlmChatRequest, signal?: AbortSignal) => Promise<LlmChatResult> | LlmChatResult;
  /** Other tools the pack may call through ctx.tools.call, by name. */
  tools?: Record<string, TestToolHandler>;
  /** Capability → tool name, for `cap:<name>` grants. */
  capabilities?: Record<string, string>;
  /**
   * Stands in for the capability router behind `ctx.capabilities` (and
   * `ctx.llm.chat` when it has a chat provider). `cap:<name>` grants are still
   * checked first.
   */
  capabilityRouter?: HostCapabilities;
  /** Ports treated as the daemon's own (never reachable). Default [7777]. */
  daemonPorts?: readonly number[];
  /** Default: a fresh temp folder, removed by dispose(). */
  dataDir?: string;
  /**
   * PATH used to resolve `permissions.spawn` binaries when `spawn` is not
   * given (real processes, for example fake binaries a test wrote).
   */
  spawnPath?: string;
}

export interface MemoryLibrary extends HostLibrary {
  /** Every stored artifact, oldest first. */
  all(): HostArtifact[];
  /** Put an artifact in the library as if another tool had saved it. */
  seed(input: {
    id?: string;
    kind?: ArtifactKind;
    mime: string;
    bytes: Uint8Array | string;
    tool: string;
    meta?: Record<string, unknown> | null;
  }): HostArtifact;
}

export interface TestContext {
  /** The context setup() receives. */
  ctx: PackContext;
  /** The context a tool's run() receives (artifacts are attributed to `<pack>/<toolName>`). */
  forTool(toolName: string, callCtx?: CallContext): PackContext;
  manifest: PackManifest;
  dataDir: string;
  /** The in-memory library (null when you passed your own). */
  library: MemoryLibrary | null;
  logs: TestLogLine[];
  scoped: ScopedPackContext;
  /** Disposes the context (every capability throws afterwards) and removes temp files. */
  dispose(): Promise<void>;
}

export function createMemoryLibrary(): MemoryLibrary {
  const rows: HostArtifact[] = [];
  const blobs = new Map<string, Uint8Array>();
  let n = 0;
  const add = (input: {
    id?: string;
    kind: ArtifactKind;
    mime: string;
    bytes: Uint8Array;
    tool: string;
    model?: string | null;
    prompt?: string | null;
    meta?: Record<string, unknown> | null;
    costUsd?: number | null;
  }): HostArtifact => {
    n++;
    const id = input.id ?? `art_${n}`;
    const row: HostArtifact = {
      id,
      kind: input.kind,
      mime: input.mime,
      path: `(memory)/${id}`,
      bytes: input.bytes.byteLength,
      tool: input.tool,
      model: input.model ?? null,
      prompt: input.prompt ?? null,
      meta: input.meta ?? null,
      costUsd: input.costUsd ?? null,
      createdAt: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(),
    };
    rows.push(row);
    blobs.set(id, new Uint8Array(input.bytes));
    return row;
  };
  return {
    get: (id) => rows.find((r) => r.id === id) ?? null,
    list: (filter, limit = 50) =>
      rows
        .filter(
          (r) =>
            (filter.tool === undefined || r.tool === filter.tool) &&
            (filter.kind === undefined || r.kind === filter.kind) &&
            (filter.model === undefined || r.model === filter.model) &&
            (filter.since === undefined || r.createdAt >= filter.since),
        )
        .reverse()
        .slice(0, limit),
    save: (input) => {
      const row = add(input);
      return {
        id: row.id,
        url: `http://127.0.0.1:7777/artifacts/${row.id}`,
        mime: row.mime,
        bytes: row.bytes,
        model: row.model,
        prompt: row.prompt,
        costUsd: row.costUsd,
      };
    },
    urlFor: (id) => `http://127.0.0.1:7777/artifacts/${id}`,
    readBytes: (id) => {
      const b = blobs.get(id);
      if (!b) throw new Error(`artifact not found: ${id}`);
      return b;
    },
    all: () => [...rows],
    seed: (input) =>
      add({
        ...(input.id !== undefined ? { id: input.id } : {}),
        kind: input.kind ?? "other",
        mime: input.mime,
        bytes:
          typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes,
        tool: input.tool,
        meta: input.meta ?? null,
      }),
  };
}

export function createTestContext(options: CreateTestContextOptions): TestContext {
  const source = options.source ?? "builtin";
  let manifest: PackManifest;
  if (options.manifest !== undefined) {
    manifest = parseManifest(options.manifest, { packSource: source });
  } else if (options.packDir !== undefined) {
    manifest = parseManifestText(readFileSync(join(options.packDir, "pack.json"), "utf8"), {
      packSource: source,
    });
  } else {
    throw new Error("createTestContext needs `manifest` or `packDir`");
  }

  const tmp = mkdtempSync(join(tmpdir(), "plughive-pack-test-"));
  const dataDir = options.dataDir ?? join(tmp, "data");
  const store = createSecretStore({
    home: tmp,
    env: { ...(options.secrets ?? {}) },
    backend: "memory",
  });
  const logs: TestLogLine[] = [];
  const log =
    (level: TestLogLine["level"]) =>
    (obj: Record<string, unknown>, msg: string): void => {
      logs.push({ level, obj, msg });
    };
  const memory = options.library ? null : createMemoryLibrary();
  const handlers = options.tools ?? {};
  const llm = options.llm;

  const host: PackHost = {
    store,
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    library: options.library ?? (memory as MemoryLibrary),
    ...(llm ? { llm: async (req: LlmChatRequest, signal?: AbortSignal) => llm(req, signal) } : {}),
    tools: {
      async call(name, args, callCtx): Promise<ToolEnvelope> {
        const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
        if (!handler) {
          return {
            ok: false,
            error: { code: "UNKNOWN_TOOL", message: `unknown tool: ${name}`, retryable: false },
          };
        }
        try {
          return { ok: true, result: await handler(args, callCtx) };
        } catch (e) {
          if (e instanceof MissingSecretError) {
            return {
              ok: false,
              error: {
                code: "MISSING_SECRET",
                message: e.message,
                retryable: false,
                pack: e.pack,
                secret: e.name,
              },
            };
          }
          return {
            ok: false,
            error: {
              code: "TOOL_ERROR",
              message: store.redactor.redact(e instanceof Error ? e.message : String(e)),
              retryable: false,
            },
          };
        }
      },
      get: (name) => (Object.hasOwn(handlers, name) ? { packId: "test" } : undefined),
      resolveCapability: (capability) => options.capabilities?.[capability],
    },
    ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    ...(options.spawn ? { spawnImpl: options.spawn } : {}),
    ...(options.spawnPath !== undefined ? { spawnPath: options.spawnPath } : {}),
    ...(options.capabilityRouter ? { capabilities: options.capabilityRouter } : {}),
    daemonPorts: options.daemonPorts ?? [7777],
  };

  // Same rule as the loader: a local-endpoint setting widens the network to
  // that host:port after the localNetwork checks.
  const settings = { ...(options.settings ?? {}) };
  const extraLocalNetwork: string[] = [];
  for (const key of endpointSettings(manifest)) {
    const value = settings[key];
    if (typeof value === "string" && value.trim() !== "") {
      extraLocalNetwork.push(localEndpointEntry(value.trim(), host.daemonPorts ?? []));
    }
  }

  // Same rule as the loader: folder-list settings name the folders a spawn
  // cwd may point into; entries that fail the checks are skipped with a warning.
  // `settings` here are only what the test passed (no manifest defaults).
  const extraSpawnRoots = spawnRootsFromSettings(manifest, settings, tmp, (key, msg) =>
    host.logger.warn({ setting: key }, `folder skipped: ${msg}`),
  );

  const scoped = createPackContext({
    manifest,
    dataDir,
    settings: Object.freeze(settings),
    host,
    source,
    grants: options.grants ?? [],
    ...(options.packDir !== undefined ? { packDir: options.packDir } : {}),
    home: tmp,
    extraLocalNetwork,
    extraSpawnRoots,
  });

  return {
    ctx: scoped.base,
    forTool: (toolName, callCtx = {}) => scoped.forCall(callCtx, toolName),
    manifest,
    dataDir,
    library: memory,
    logs,
    scoped,
    async dispose() {
      await scoped.dispose();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
