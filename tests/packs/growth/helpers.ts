import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyToolDefinition, PackContext } from "plughive/pack";
import { MissingSecretError } from "plughive/pack";
import { vi } from "vitest";
import growthPack from "../../../packs/growth/index.js";
import { SenderStore } from "../../../packs/growth/sender.js";
import { LeadsStore } from "../../../packs/growth/store.js";
import { providerHooks } from "../../../packs/growth/tools/provider.js";

providerHooks.retryBaseMs = 1;

export function tool(name: string): AnyToolDefinition<any> {
  const tools = growthPack.tools;
  if (!Array.isArray(tools)) throw new Error("expected a static tool list");
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} missing`);
  return t as AnyToolDefinition<any>;
}

export type FetchHandler = (
  path: string,
  body: any,
) => { status?: number; json?: unknown; headers?: Record<string, string>; throws?: unknown };

export interface Env {
  ctx: PackContext & { leads: LeadsStore; sender: SenderStore };
  fetch: ReturnType<typeof vi.fn>;
  llm: ReturnType<typeof vi.fn>;
  toolCall: ReturnType<typeof vi.fn>;
  saved: Array<Record<string, any>>;
  cleanup(): void;
  call(name: string, args: unknown): Promise<any>;
}

export function makeEnv(
  opts: {
    key?: boolean;
    handler?: FetchHandler;
    llm?: string[];
    tools?: (name: string, args: any) => unknown;
  } = {},
): Env {
  const dir = mkdtempSync(join(tmpdir(), "growth-"));
  const leads = new LeadsStore({ root: dir });
  const sender = new SenderStore({ root: dir });
  const handler: FetchHandler = opts.handler ?? (() => ({ json: {} }));
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const r = handler(path, JSON.parse(String(init.body ?? "{}")));
    if (r.throws !== undefined) throw r.throws;
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      ...(r.headers ? { headers: r.headers } : {}),
    });
  });
  const queue = [...(opts.llm ?? [])];
  const llm = vi.fn(async () => {
    const text = queue.shift();
    if (text === undefined) throw new Error("llm queue exhausted");
    return { text, model: "test-model", costUsd: 0.001 };
  });
  const toolCall = vi.fn(async (name: string, args: any) => {
    if (!opts.tools) throw new Error(`tool ${name} unavailable`);
    return opts.tools(name, args);
  });
  const saved: Array<Record<string, any>> = [];
  let n = 0;
  const library = {
    async save(a: Record<string, any>) {
      const id = `art${++n}`;
      const rec = {
        ...a,
        id,
        path: `/lib/${id}`,
        createdAt: new Date(Date.now() + n).toISOString(),
      };
      saved.push(rec);
      return { id, path: rec.path, url: `http://x/${id}`, mime: a.mime };
    },
    async get(id: string) {
      return saved.find((s) => s.id === id) ?? null;
    },
    async list(f: { tool?: string; limit?: number }) {
      return saved.filter((s) => !f.tool || s.tool === f.tool).slice(0, f.limit ?? 50);
    },
    async read(id: string) {
      const s = saved.find((x) => x.id === id);
      if (!s) throw new Error("missing");
      return s.bytes as Uint8Array;
    },
  };
  const ctx = {
    pack: { id: "growth", version: "0.1.0", dataDir: dir },
    secrets: {
      has: async () => opts.key !== false,
      get: async (name: string) => {
        if (opts.key === false) {
          throw new MissingSecretError({ pack: "growth", name, label: "Apollo API key" });
        }
        return "test-key";
      },
    },
    settings: {},
    fetch,
    library,
    llm: { chat: llm },
    tools: { call: toolCall },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    leads,
    sender,
  } as unknown as Env["ctx"];
  return {
    ctx,
    fetch,
    llm,
    toolCall,
    saved,
    cleanup() {
      try {
        leads.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
    async call(name, args) {
      const t = tool(name);
      return t.run(t.input.parse(args), ctx);
    },
  };
}

export const apolloPerson = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  first_name: "Ada",
  last_name: "Lovelace",
  title: "CTO",
  seniority: "c_suite",
  email: `${id}@acme.test`,
  email_status: "verified",
  organization_id: "org1",
  organization: {
    id: "org1",
    name: "Acme",
    primary_domain: "acme.test",
    industry: "software",
    estimated_num_employees: 50,
  },
  ...extra,
});

export const SENDER = {
  name: "Sam Sender",
  email: "sam@sender.test",
  pitch: "We build reliable widgets for teams.",
};

export const DRAFT_JSON = JSON.stringify({
  subject: "Quick question",
  body: "Hi Ada",
  follow_up_1: { subject: "Re", body: "b1" },
  follow_up_2: { subject: "Re2", body: "b2" },
});
