// Profiles: management API, per-profile MCP endpoints, search surface.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProtocolError } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ADMIN_AUTH,
  type LiteHarness,
  adminFetch,
  bootLite,
  jsonBody,
  legacyClient,
  mockTool,
  modernClient,
  toolJson,
} from "./harness.js";

// /api needs the admin token: requests below carry it unless they set a
// credential themselves. The authentication tests use globalThis.fetch.
const fetch = adminFetch;

const CSRF = { "x-plughive-csrf": "1" };
const JSON_CSRF = { ...CSRF, "content-type": "application/json" };

function packs() {
  return {
    alpha: [
      mockTool("alpha_search", async (input) => ({ echoed: input.n }), {
        description: "Search the web for pages. Extra detail.",
        tags: ["research"],
      }),
      mockTool("alpha_strict", async (input) => input, { input: z.object({ q: z.string() }) }),
    ],
    beta: [mockTool("beta_send", async () => "sent", { description: "Send a message." })],
  };
}

const put = (
  h: LiteHarness,
  id: string,
  body: unknown,
  headers: Record<string, string> = JSON_CSRF,
) => fetch(`${h.base}/api/profiles/${id}`, { method: "PUT", headers, body: JSON.stringify(body) });

describe("profiles API", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ packs: packs() });
  });
  afterEach(() => h.close());

  it("CRUD round trip, persisted to profiles.json", async () => {
    const initial = await jsonBody(await fetch(`${h.base}/api/profiles`));
    expect(initial).toMatchObject({ ok: true, profiles: [{ id: "default", mode: "auto" }] });

    const created = await put(h, "research", {
      name: "Research",
      mode: "list",
      include: ["pack:alpha"],
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ok: true,
      profile: {
        id: "research",
        name: "Research",
        mode: "list",
        include: ["pack:alpha"],
        exclude: [],
        pinned: [],
      },
    });
    const replaced = await put(h, "research", { id: "research", name: "Research 2" });
    expect(replaced.status).toBe(200);
    expect((await jsonBody(replaced)).profile).toMatchObject({
      name: "Research 2",
      mode: "auto",
      include: ["*"],
    });

    const one = await jsonBody(await fetch(`${h.base}/api/profiles/research`));
    expect(one.profile.name).toBe("Research 2");
    const onDisk = JSON.parse(readFileSync(join(h.home, "profiles.json"), "utf8"));
    expect(onDisk.profiles.map((p: { id: string }) => p.id)).toEqual(["default", "research"]);

    const del = await fetch(`${h.base}/api/profiles/research`, { method: "DELETE", headers: CSRF });
    expect(del.status).toBe(200);
    expect((await fetch(`${h.base}/api/profiles/research`)).status).toBe(404);
    expect(
      (await fetch(`${h.base}/api/profiles/research`, { method: "DELETE", headers: CSRF })).status,
    ).toBe(404);
    const protectedDefault = await fetch(`${h.base}/api/profiles/default`, {
      method: "DELETE",
      headers: CSRF,
    });
    expect(protectedDefault.status).toBe(409);
    expect(await protectedDefault.json()).toMatchObject({
      ok: false,
      error: { code: "PROFILE_PROTECTED" },
    });
  });

  it("validates input and answers with JSON errors", async () => {
    const cases: Array<[string, unknown]> = [
      ["Bad_ID", { name: "x" }],
      ["ok-id", { name: "x", mode: "nope" }],
      ["ok-id", { name: "x", include: ["everything"] }],
      ["ok-id", { name: "x", unknown_field: 1 }],
      ["ok-id", { id: "other-id", name: "x" }],
      ["ok-id", ["not", "an", "object"]],
      ["ok-id", {}],
    ];
    for (const [id, body] of cases) {
      const res = await put(h, id, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "INVALID_PROFILE" } });
    }
    const malformed = await fetch(`${h.base}/api/profiles/ok-id`, {
      method: "PUT",
      headers: JSON_CSRF,
      body: "{nope",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const huge = await put(h, "ok-id", {
      name: "x",
      include: Array(20000).fill("pack:aaaaaaaaaaaa"),
    });
    // M1: over the 256 kB limit of /api.
    expect(huge.status).toBe(413);
    expect(existsSync(join(h.home, "profiles.json"))).toBe(false);
    expect((await fetch(`${h.base}/api/profiles/ok-id/preview`)).status).toBe(404);
  });

  it("mutating routes need a same-origin Origin or the CSRF header", async () => {
    const body = { name: "X" };
    const noHeader = await put(h, "csrf-test", body, { "content-type": "application/json" });
    expect(noHeader.status).toBe(403);
    expect(await noHeader.json()).toMatchObject({ ok: false, error: { code: "CSRF_REJECTED" } });
    // Another local origin (a different port) is not the daemon's origin.
    const otherPort = await put(h, "csrf-test", body, {
      "content-type": "application/json",
      origin: "http://127.0.0.1:1",
    });
    expect(otherPort.status).toBe(403);
    const crossSite = await put(h, "csrf-test", body, {
      ...JSON_CSRF,
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    expect((await fetch(`${h.base}/api/profiles/default`, { method: "DELETE" })).status).toBe(403);
    expect(h.profiles.get("csrf-test")).toBeUndefined();

    const sameOrigin = await put(h, "csrf-test", body, {
      "content-type": "application/json",
      origin: h.base,
    });
    expect(sameOrigin.status).toBe(201);
  });

  it("preview is exactly what a client gets from tools/list", async () => {
    await put(h, "listed", { name: "Listed", mode: "list", exclude: ["pack:beta"] });
    await put(h, "searchy", { name: "Searchy", mode: "search", pinned: ["beta_send"] });
    for (const id of ["default", "listed", "searchy"]) {
      const preview = await jsonBody(await fetch(`${h.base}/api/profiles/${id}/preview`));
      const client = await modernClient(h.base, {
        path: id === "default" ? "/mcp" : `/p/${id}/mcp`,
      });
      try {
        const { tools } = await client.listTools();
        expect(JSON.parse(JSON.stringify(tools))).toEqual(preview.tools);
        expect(preview.cost.totalTokens).toBe(
          preview.tools.reduce(
            (s: number, t: unknown) => s + Math.ceil(JSON.stringify(t).length / 4),
            0,
          ),
        );
        expect(preview.cost.perTool.map((t: { name: string }) => t.name)).toEqual(
          tools.map((t) => t.name),
        );
      } finally {
        await client.close();
      }
    }
    const searchy = await jsonBody(await fetch(`${h.base}/api/profiles/searchy/preview`));
    expect(searchy).toMatchObject({
      ok: true,
      profile: "searchy",
      mode: "search",
      exposed_tools: 3,
    });
    expect(searchy.tools.map((t: { name: string }) => t.name)).toEqual([
      "search_tools",
      "describe_tool",
      "execute_tool",
      "beta_send",
    ]);
  });
});

describe("profiles API with an access key", () => {
  let h: LiteHarness;
  const KEY = "test-access-key-0123456789";
  beforeEach(async () => {
    h = await bootLite({ packs: packs(), accessKey: KEY });
  });
  afterEach(() => h.close());

  it("profile routes need the admin token, /p/<id>/mcp needs the access key, and neither opens the other", async () => {
    const key = { authorization: `Bearer ${KEY}` };
    const raw = globalThis.fetch;
    const body = (method: string) =>
      method === "GET" ? {} : { body: JSON.stringify({ name: "K" }) };
    for (const [method, path] of [
      ["GET", "/api/profiles"],
      ["GET", "/api/profiles/default"],
      ["GET", "/api/profiles/default/preview"],
      ["PUT", "/api/profiles/keyed"],
      ["DELETE", "/api/profiles/keyed"],
    ] as const) {
      const creds: Array<Record<string, string>> = [
        {},
        { authorization: "Bearer wrong" },
        key,
        { "x-api-key": KEY },
      ];
      for (const cred of creds) {
        const res = await raw(`${h.base}${path}`, {
          method,
          headers: { ...JSON_CSRF, ...cred },
          ...body(method),
        });
        expect(res.status, `${method} ${path} ${JSON.stringify(Object.keys(cred))}`).toBe(401);
      }
    }
    for (const path of ["/p/default/mcp", "/p/nope/mcp", "/mcp"]) {
      for (const cred of [{}, { authorization: "Bearer wrong" }, ADMIN_AUTH]) {
        const res = await raw(`${h.base}${path}`, {
          method: "POST",
          headers: { ...JSON_CSRF, ...cred },
          body: "{}",
        });
        expect(res.status, `POST ${path}`).toBe(401);
      }
    }
    expect((await put(h, "keyed", { name: "K" }, { ...JSON_CSRF, ...ADMIN_AUTH })).status).toBe(
      201,
    );
    expect((await raw(`${h.base}/api/profiles`, { headers: ADMIN_AUTH })).status).toBe(200);
    const client = await modernClient(h.base, { path: "/p/keyed/mcp", headers: key });
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
  });
});

describe("per-profile MCP endpoints", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ packs: packs() });
  });
  afterEach(() => h.close());

  const names = async (path: string, legacy = false) => {
    const client = await (legacy ? legacyClient : modernClient)(h.base, { path });
    try {
      return (await client.listTools()).tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  };

  it("/p/<id>/mcp exposes that profile, for modern and legacy clients", async () => {
    await put(h, "only-alpha", { name: "A", mode: "list", include: ["pack:alpha"] });
    await put(h, "only-beta", { name: "B", mode: "list", include: ["tool:beta_send"] });
    expect(await names("/mcp")).toEqual(["alpha_search", "alpha_strict", "beta_send"]);
    expect(await names("/p/default/mcp")).toEqual(["alpha_search", "alpha_strict", "beta_send"]);
    expect(await names("/p/only-alpha/mcp")).toEqual(["alpha_search", "alpha_strict"]);
    expect(await names("/p/only-beta/mcp")).toEqual(["beta_send"]);
    expect(await names("/p/only-beta/mcp", true)).toEqual(["beta_send"]);

    // A tool outside the profile is unknown there, exactly like a tool that does not exist.
    const client = await modernClient(h.base, { path: "/p/only-beta/mcp" });
    try {
      const hidden = await client
        .callTool({ name: "alpha_search", arguments: {} })
        .catch((e: unknown) => e);
      const missing = await client
        .callTool({ name: "no_such", arguments: {} })
        .catch((e: unknown) => e);
      expect(hidden).toBeInstanceOf(ProtocolError);
      expect((hidden as ProtocolError).code).toBe(-32602);
      expect((hidden as Error).message).toContain("unknown tool: alpha_search");
      expect((missing as ProtocolError).code).toBe(-32602);
      expect(toolJson(await client.callTool({ name: "beta_send", arguments: {} }))).toEqual({
        ok: true,
        result: "sent",
      });
    } finally {
      await client.close();
    }
  });

  it("unknown or malformed profile ids answer 404 JSON for every method", async () => {
    for (const id of ["nope", "UPPER", "a", "..%2f..", "x".repeat(40)]) {
      for (const method of ["POST", "GET", "DELETE"]) {
        const res = await fetch(`${h.base}/p/${id}/mcp`, {
          method,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          ...(method === "POST"
            ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }
            : {}),
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "UNKNOWN_PROFILE" } });
      }
    }
  });

  it("a profile change applies to the next request", async () => {
    await put(h, "live", { name: "L", mode: "list", include: ["pack:beta"] });
    const client = await modernClient(h.base, { path: "/p/live/mcp" });
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["beta_send"]);
      await put(h, "live", { name: "L", mode: "list", include: ["pack:alpha"] });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        "alpha_search",
        "alpha_strict",
      ]);
    } finally {
      await client.close();
    }
  });
});

describe("without a profile store", () => {
  it("/mcp lists everything, /p and /api/profiles do not exist", async () => {
    const h = await bootLite({ packs: packs(), profiles: false });
    try {
      const client = await modernClient(h.base);
      expect((await client.listTools()).tools).toHaveLength(3);
      await client.close();
      const res = await fetch(`${h.base}/p/default/mcp`, {
        method: "POST",
        headers: JSON_CSRF,
        body: "{}",
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "UNKNOWN_PROFILE" } });
      expect((await fetch(`${h.base}/api/profiles`)).status).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe("search surface", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ packs: packs() });
    await put(h, "srch", { name: "S", mode: "search", exclude: ["pack:beta"] });
  });
  afterEach(() => h.close());

  it.each([["modern"], ["legacy"]])("search -> describe -> execute (%s client)", async (era) => {
    const client = await (era === "legacy" ? legacyClient : modernClient)(h.base, {
      path: "/p/srch/mcp",
    });
    try {
      const listed = (await client.listTools()).tools;
      expect(listed.map((t) => t.name)).toEqual(["search_tools", "describe_tool", "execute_tool"]);
      for (const t of listed) expect(t.inputSchema.type).toBe("object");

      const found = toolJson(
        await client.callTool({ name: "search_tools", arguments: { query: "search web" } }),
      );
      expect(found.ok).toBe(true);
      expect(found.result.tools).toEqual([
        { name: "alpha_search", description: "Search the web for pages.", pack: "alpha" },
      ]);

      const described = toolJson(
        await client.callTool({
          name: "describe_tool",
          arguments: { name: ["alpha_search", "beta_send", "nope"] },
        }),
      );
      expect(described.result.not_found).toEqual(["beta_send", "nope"]);
      expect(described.result.tools).toHaveLength(1);
      expect(described.result.tools[0]).toMatchObject({
        name: "alpha_search",
        description: "Search the web for pages. Extra detail.",
        pack: "alpha",
        long_running: false,
        inputSchema: { type: "object", properties: { n: { type: "number", default: 1 } } },
      });

      const ran = toolJson(
        await client.callTool({
          name: "execute_tool",
          arguments: { name: "alpha_search", arguments: { n: 7 } },
        }),
      );
      expect(ran).toEqual({ ok: true, result: { echoed: 7 } });
    } finally {
      await client.close();
    }
  });

  it("the meta tools only reach tools the profile exposes", async () => {
    const client = await modernClient(h.base, { path: "/p/srch/mcp" });
    try {
      const none = toolJson(
        await client.callTool({ name: "search_tools", arguments: { query: "send message" } }),
      );
      expect(none.result).toMatchObject({ tools: [], total_matches: 0 });

      const rejects = async (args: Record<string, unknown>, text: string) => {
        const err = await client.callTool(args as never).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProtocolError);
        expect((err as ProtocolError).code).toBe(-32602);
        expect((err as Error).message).toContain(text);
      };
      // Outside the profile, non-existent, and the meta tools themselves.
      await rejects(
        { name: "execute_tool", arguments: { name: "beta_send" } },
        "unknown tool: beta_send",
      );
      await rejects({ name: "execute_tool", arguments: { name: "nope" } }, "unknown tool: nope");
      await rejects(
        { name: "execute_tool", arguments: { name: "execute_tool" } },
        "unknown tool: execute_tool",
      );
      await rejects({ name: "beta_send", arguments: {} }, "unknown tool: beta_send");
      // Bad arguments, for the meta tool and for the tool behind it.
      await rejects({ name: "search_tools", arguments: {} }, "invalid arguments for search_tools");
      await rejects(
        { name: "execute_tool", arguments: { name: "alpha_search", arguments: "x" } },
        "invalid arguments for execute_tool",
      );
      await rejects(
        { name: "execute_tool", arguments: { name: "alpha_strict", arguments: { q: 1 } } },
        "invalid arguments for alpha_strict",
      );
      // An exposed tool that is not listed is still callable directly.
      expect(
        toolJson(await client.callTool({ name: "alpha_search", arguments: { n: 2 } })).result,
      ).toEqual({ echoed: 2 });
    } finally {
      await client.close();
    }
  });

  it("auto: lists directly under the threshold and switches to search above it", async () => {
    const list = async () => {
      const client = await modernClient(h.base, { path: "/p/auto/mcp" });
      try {
        return (await client.listTools()).tools.map((t) => t.name);
      } finally {
        await client.close();
      }
    };
    await put(h, "auto", { name: "Auto", pinned: ["beta_send"] });
    expect(await list()).toEqual(["alpha_search", "alpha_strict", "beta_send"]);

    h.registry.registerPack(
      "bulk",
      Array.from({ length: 38 }, (_, i) => mockTool(`bulk_${i}`, async () => i)),
    );
    expect(h.registry.list()).toHaveLength(41);
    expect(await list()).toEqual(["search_tools", "describe_tool", "execute_tool", "beta_send"]);
    const preview = await jsonBody(await fetch(`${h.base}/api/profiles/auto/preview`));
    expect(preview.mode).toBe("search");
    expect(preview.cost.totalTokens).toBeLessThan(preview.direct_tokens);

    // Raising the tool threshold brings the list back; a low token threshold removes it again.
    await put(h, "auto", { name: "Auto", autoThresholdTools: 100 });
    expect(await list()).toHaveLength(41);
    await put(h, "auto", { name: "Auto", autoThresholdTools: 100, autoThresholdTokens: 500 });
    expect(await list()).toEqual(["search_tools", "describe_tool", "execute_tool"]);
  });
});

describe("POST /api/profiles/preview (unsaved draft)", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ packs: packs() });
  });
  afterEach(() => h.close());

  const preview = (body: unknown, headers: Record<string, string> = JSON_CSRF) =>
    fetch(`${h.base}/api/profiles/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  it("resolves a draft without saving it", async () => {
    const res = await preview({
      mode: "list",
      include: ["pack:alpha"],
      exclude: ["tool:alpha_strict"],
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body).toMatchObject({
      ok: true,
      profile: "draft",
      mode: "list",
      exposed: ["alpha_search"],
      exposed_tools: 1,
    });
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["alpha_search"]);
    expect(body.cost.totalTokens).toBeGreaterThan(0);
    expect(body.cost.perTool).toHaveLength(1);
    expect(typeof body.direct_tokens).toBe("number");
    const all = await jsonBody(await fetch(`${h.base}/api/profiles`));
    expect(all.profiles.map((p: { id: string }) => p.id)).toEqual(["default"]);
  });

  it("matches the saved preview for the same profile", async () => {
    await put(h, "research", { name: "Research", mode: "list", include: ["pack:beta"] });
    const saved = await jsonBody(await fetch(`${h.base}/api/profiles/research/preview`));
    const draft = await jsonBody(
      await preview({ id: "research", name: "Research", mode: "list", include: ["pack:beta"] }),
    );
    expect(draft.tools).toEqual(saved.tools);
    expect(draft.cost).toEqual(saved.cost);
    expect(draft.profile).toBe("research");
  });

  it("rejects invalid drafts and cross-site writes", async () => {
    for (const body of [{ mode: "nope" }, { include: ["everything"] }, { extra: 1 }, ["x"]]) {
      const res = await preview(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "INVALID_PROFILE" } });
    }
    const withIssues = await jsonBody(await preview({ mode: "nope" }));
    expect(withIssues.error.issues[0].path).toBe("mode");
    const noCsrf = await preview({}, { "content-type": "application/json" });
    expect(noCsrf.status).toBe(403);
    const crossSite = await preview(
      {},
      { "content-type": "application/json", origin: "https://evil.example" },
    );
    expect(crossSite.status).toBe(403);
  });
});
