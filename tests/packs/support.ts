// Shared helpers for pack tests: a fake PackContext and a real loader harness.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyToolDefinition, ArtifactRef, PackContext, PackDefinition } from "plughive/pack";
import { PackLoader } from "../../src/core/packs/loader.js";
import { createSecretStore } from "../../src/core/secrets/index.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

export const silent = { debug() {}, info() {}, warn() {}, error() {} };

export function toolOf(pack: PackDefinition, name: string): AnyToolDefinition {
  const tools = pack.tools;
  if (!Array.isArray(tools)) throw new Error("expected a static tool list");
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} missing`);
  return tool;
}

export function toolNames(pack: PackDefinition): string[] {
  const tools = pack.tools;
  if (!Array.isArray(tools)) throw new Error("expected a static tool list");
  return tools.map((t) => t.name);
}

export interface FakeCtxOptions {
  packId: string;
  dataDir?: string;
  secrets?: Record<string, string>;
  settings?: Record<string, unknown>;
  fetch?: PackContext["fetch"];
  spawn?: PackContext["spawn"];
  library?: Partial<PackContext["library"]>;
  daemonPorts?: readonly number[];
  signal?: AbortSignal;
}

export function fakeCtx(opts: FakeCtxOptions): PackContext {
  const deny = () => {
    throw new Error("not used in this test");
  };
  const secrets = opts.secrets ?? {};
  return {
    pack: {
      id: opts.packId,
      version: "0.1.0",
      dataDir: opts.dataDir ?? "/nowhere",
      daemonPorts: opts.daemonPorts ?? [7777],
    },
    secrets: {
      get: async (name: string) => {
        const v = secrets[name];
        if (v === undefined) throw new Error(`secret ${name} not set`);
        return v;
      },
      has: async (name: string) => secrets[name] !== undefined,
    },
    settings: opts.settings ?? {},
    fetch: opts.fetch ?? (deny as never),
    spawn: opts.spawn ?? (deny as never),
    library: {
      get: deny,
      list: deny,
      read: deny,
      save: deny,
      importFile: deny,
      ...opts.library,
    },
    llm: { chat: deny },
    tools: { call: deny },
    logger: silent,
    signal: opts.signal ?? new AbortController().signal,
    progress: () => {},
  } as unknown as PackContext;
}

export function artifactRef(id = "art_1"): ArtifactRef {
  return { id, url: `http://127.0.0.1:7777/a/${id}`, mime: "text/markdown" };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Load the real packs/ folder with an in-memory secret store and no secrets set. */
export async function loadBuiltinPacks() {
  const dir = mkdtempSync(join(tmpdir(), "plughive-pack-"));
  const registry = new ToolRegistry();
  const store = createSecretStore({ home: dir, env: {}, backend: "memory" });
  const loader = new PackLoader({
    home: dir,
    registry,
    host: { store, logger: silent },
    userDir: join(dir, "packs"),
  });
  await loader.loadAll();
  return {
    registry,
    loader,
    async close() {
      await loader.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
