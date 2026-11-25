// Connected agents: the MCP clients the daemon has heard from, as listed by
// GET /api/info for the dashboard's "Connected agents" count.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_AGENTS, RecentAgents } from "../../src/core/mcp/agents.js";
import { ADMIN_AUTH, type LiteHarness, bootLite, jsonBody, mockTool } from "./harness.js";

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function initialize(name: unknown, version: unknown = "1.0") {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name, version } },
  };
}

describe("RecentAgents", () => {
  it("reads legacy initialize and modern _meta client info, newest first", () => {
    let t = 1000;
    const a = new RecentAgents(() => t);
    a.note(initialize("Claude Desktop", "1.2"), "default");
    t = 2000;
    a.note(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/clientInfo": { name: "cursor", version: "3" } },
        },
      },
      "work",
    );
    expect(a.list()).toEqual([
      { name: "cursor", version: "3", profile: "work", first_seen: 2000, last_seen: 2000 },
      {
        name: "Claude Desktop",
        version: "1.2",
        profile: "default",
        first_seen: 1000,
        last_seen: 1000,
      },
    ]);
    t = 3000;
    a.note(initialize("Claude Desktop", "1.2"), "default");
    expect(a.list()[0]).toMatchObject({
      name: "Claude Desktop",
      first_seen: 1000,
      last_seen: 3000,
    });
  });

  it("ignores clientInfo outside initialize unless it is in _meta", () => {
    const a = new RecentAgents();
    a.note(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { clientInfo: { name: "x" } } },
      "default",
    );
    a.note(null, "default");
    a.note("text", "default");
    a.note(initialize(42), "default");
    a.note(initialize("   "), "default");
    expect(a.list()).toEqual([]);
  });

  it("cleans names and keeps the list bounded", () => {
    const a = new RecentAgents();
    a.note(initialize(`evil\u0000\u202e<b>${"x".repeat(200)}`, "\u0007v1"), "default");
    const [first] = a.list();
    expect(first?.name.length).toBe(64);
    expect(first?.name.includes("\u0000") || first?.name.includes("\u202e")).toBe(false);
    expect(first?.version).toBe("v1");
    for (let i = 0; i < MAX_AGENTS + 10; i++) a.note(initialize(`client-${i}`), "default");
    const list = a.list();
    expect(list).toHaveLength(MAX_AGENTS);
    expect(list[0]?.name).toBe(`client-${MAX_AGENTS + 9}`);
    expect(list.some((x) => x.name.startsWith("evil"))).toBe(false);
  });
});

describe("GET /api/info agents", () => {
  let h: LiteHarness;
  afterEach(() => h.close());

  it("lists a client after it calls /mcp, behind the admin token only", async () => {
    h = await bootLite({ packs: { demo: [mockTool("demo_echo", async () => ({ ok: true }))] } });
    const before = await jsonBody(await fetch(`${h.base}/api/info`, { headers: ADMIN_AUTH }));
    expect(before.agents).toEqual([]);

    const res = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(initialize("Test Agent", "0.1")),
    });
    expect(res.status).toBe(200);
    await res.text();

    const after = await jsonBody(await fetch(`${h.base}/api/info`, { headers: ADMIN_AUTH }));
    expect(after.agents).toEqual([
      expect.objectContaining({ name: "Test Agent", version: "0.1", profile: "default" }),
    ]);
    expect((await fetch(`${h.base}/api/info`)).status).toBe(401);
  });

  it("does not record a request that failed the access-key check", async () => {
    h = await bootLite({ packs: {}, config: { accessKey: "k".repeat(40) } });
    const res = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(initialize("Intruder")),
    });
    expect(res.status).toBe(401);
    const info = await jsonBody(await fetch(`${h.base}/api/info`, { headers: ADMIN_AUTH }));
    expect(info.agents).toEqual([]);
  });
});
