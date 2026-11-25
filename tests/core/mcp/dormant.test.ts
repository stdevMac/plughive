// Parked and hidden tools over MCP: search_tools still finds them (marked
// parked), and describe_tool or a call brings them back. In wake "ask" mode
// the agent is told how instead, and an unknown tool is still an error.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMcpServer } from "../../../src/core/mcp/server.js";
import type { MountInfo } from "../../../src/core/mounts/manager.js";
import { SmartMounts } from "../../../src/core/mounts/smart.js";
import { type Profile, ProfileSchema, ProfileStore } from "../../../src/core/profiles.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";
import { mockTool } from "../../http/harness.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

const exaMount = (enabled: boolean): MountInfo => ({
  id: "mounts/exa",
  pack: "mounts",
  mountId: "exa",
  name: "Exa",
  description: "Web search",
  url: "https://mcp.exa.ai/mcp",
  transport: "http",
  prefix: "exa",
  auth: "header",
  docsUrl: null,
  enabled,
  mountable: true,
  note: null,
  secrets: [],
  source: "pack",
  command: null,
  connected: enabled,
  tools: enabled ? 1 : 0,
  error: null,
  oauth: null,
});

type Body = { ok: boolean; result?: Record<string, unknown>; error?: Record<string, unknown> };
const body = (r: unknown): Body =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]?.text ?? "{}");

describe("dormant tools over MCP", () => {
  let home: string;
  let now: number;
  let registry: ToolRegistry;
  let enabled: boolean;
  let smart: SmartMounts;
  let profiles: ProfileStore;
  let closers: Array<() => Promise<void>>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-dormant-"));
    now = T0;
    closers = [];
    registry = new ToolRegistry();
    registry.registerPack("demo", [mockTool("echo", async (i) => i)]);
    enabled = true;
    // The mount's tools are listed while it is on, as the real connections do.
    registry.attachMounts({
      list: () =>
        enabled
          ? [
              {
                qualifiedName: "exa__search",
                mountId: "mounts/exa",
                prefix: "exa",
                upstreamName: "search",
                description: "Search the web for pages",
                inputSchema: { type: "object", properties: { n: { type: "number" } } },
              },
            ]
          : [],
      call: async (_id, _name, args) => ({ searched: args }),
    });
    const setOn = (on: boolean) => {
      enabled = on;
    };
    profiles = new ProfileStore();
    profiles.put({ id: "agent", name: "Agent", mode: "search" });
    profiles.put({ id: "narrow", name: "Narrow", mode: "search", include: ["pack:demo"] });
    smart = new SmartMounts({
      home,
      mounts: {
        listMounts: async () => [exaMount(enabled)],
        setMountEnabled: async (_id, on) => setOn(on),
      },
      usage: { lastUseByVendor: () => new Map(), useByTool: () => [] },
      tools: () => registry.list(),
      profiles,
      logger: { info() {}, warn() {} },
      now: () => now,
    });
    await smart.report();
    now = T0 + 20 * DAY;
    expect((await smart.park(["mounts/exa"])).parked).toEqual(["mounts/exa"]);
    expect(registry.get("exa__search")).toBeUndefined();
  });
  afterEach(async () => {
    for (const c of closers) await c();
    rmSync(home, { recursive: true, force: true });
  });

  async function connect(profileId: string) {
    const server = buildMcpServer(
      {
        registry,
        profile: (id) => profiles.get(id) as Profile | undefined,
        dormant: {
          list: (p) => smart.dormantTools(p),
          wake: (p, n) => smart.wake(p, n),
        },
      },
      "legacy",
      { profileId },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    return (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args });
  }

  it("finds a parked tool and switches its mount back on when it is called", async () => {
    const call = await connect("agent");
    const found = body(await call("search_tools", { query: "search the web" }));
    expect(found.result?.tools).toEqual([
      expect.objectContaining({ name: "exa__search", parked: true, mount: "mounts/exa" }),
    ]);
    expect(String(found.result?.next)).toMatch(/switched back on/);

    const ran = body(await call("execute_tool", { name: "exa__search", arguments: { n: 2 } }));
    expect(ran).toMatchObject({ ok: true, result: { searched: { n: 2 } } });
    expect(enabled).toBe(true);
    expect(smart.dormantTools(profiles.get("agent") as Profile)).toEqual([]);

    // Awake now: search shows it as an ordinary tool.
    const again = body(await call("search_tools", { query: "search the web" }));
    expect(again.result?.tools).toEqual([expect.not.objectContaining({ parked: true })]);
    expect((await smart.report()).summary).toMatchObject({ parked: 1, woken: 1 });
  });

  it("describe_tool wakes a parked tool too", async () => {
    const call = await connect("agent");
    const d = body(await call("describe_tool", { name: ["exa__search", "nope"] }));
    expect(d.result).toMatchObject({
      tools: [expect.objectContaining({ name: "exa__search" })],
      not_found: ["nope"],
    });
    expect(enabled).toBe(true);
  });

  it("in ask mode says how to switch it on instead of doing it", async () => {
    smart.setSettings({ wake: "ask" });
    const call = await connect("agent");
    const r = body(await call("execute_tool", { name: "exa__search", arguments: {} }));
    expect(r).toMatchObject({ ok: false, error: { code: "TOOL_PARKED", retryable: true } });
    expect(String(r.error?.message)).toMatch(/enable_mount/);
    expect(enabled).toBe(false);

    const d = body(await call("describe_tool", { name: "exa__search" }));
    expect(d.result).toMatchObject({
      tools: [],
      not_found: ["exa__search"],
      notices: [expect.objectContaining({ code: "TOOL_PARKED" })],
    });
  });

  it("keeps parked tools out of profiles that would not see them", async () => {
    const call = await connect("narrow");
    const found = body(await call("search_tools", { query: "search the web" }));
    expect(found.result?.tools).toEqual([]);
    await expect(call("execute_tool", { name: "exa__search", arguments: {} })).rejects.toThrow(
      /unknown tool: exa__search/,
    );
    expect(enabled).toBe(false);
  });

  it("still rejects tools nobody parked", async () => {
    const call = await connect("agent");
    await expect(call("execute_tool", { name: "ghost", arguments: {} })).rejects.toThrow(
      /unknown tool: ghost/,
    );
  });
});
