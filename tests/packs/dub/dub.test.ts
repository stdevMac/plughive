import { describe, expect, it, vi } from "vitest";
import dubPack from "../../../packs/dub/index.js";
import { failure } from "../provider-support.js";
import { fakeCtx, jsonResponse, loadBuiltinPacks, toolNames, toolOf } from "../support.js";

const SECRETS = { DUB_API_KEY: "dub_key" };

describe("dub pack", () => {
  it("exposes dub_shorten_url", () => {
    expect(toolNames(dubPack)).toEqual(["dub_shorten_url"]);
  });

  it("POSTs to the links endpoint with bearer auth and maps the result", async () => {
    const f = vi.fn(async (_u: unknown, _i?: RequestInit) =>
      jsonResponse({ id: "link_1", shortLink: "https://dub.sh/abc", key: "abc" }),
    );
    const tool = toolOf(dubPack, "dub_shorten_url");
    const out = await tool.run(
      tool.input.parse({ url: "https://example.com/long", tags: ["x"] }),
      fakeCtx({ packId: "dub", secrets: SECRETS, fetch: f as never }),
    );
    expect(out).toEqual({ id: "link_1", short_url: "https://dub.sh/abc", key: "abc" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.dub.co/links");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dub_key");
    expect(JSON.parse(String(init.body))).toMatchObject({
      url: "https://example.com/long",
      tags: ["x"],
    });
  });

  it("throws with the status and body on an API error", async () => {
    const f = vi.fn(async () => new Response("bad key", { status: 401 }));
    const tool = toolOf(dubPack, "dub_shorten_url");
    await expect(
      tool.run(
        tool.input.parse({ url: "https://example.com" }),
        fakeCtx({ packId: "dub", secrets: SECRETS, fetch: f as never }),
      ),
    ).rejects.toThrow(/Dub 401: bad key/);
  });

  it("shows Dub's error message, not the raw body, and caps its length (L11)", async () => {
    const huge = JSON.stringify({
      error: { code: "bad_request", message: `${"m".repeat(5000)}\nsecond line` },
    });
    const f = vi.fn(async () => new Response(huge, { status: 400 }));
    const tool = toolOf(dubPack, "dub_shorten_url");
    const err = await failure(
      tool.run(
        tool.input.parse({ url: "https://example.com" }),
        fakeCtx({ packId: "dub", secrets: SECRETS, fetch: f as never }),
      ),
    );
    expect(err.message).toMatch(/^Dub 400: m+\.\.\.$/);
    expect(err.message.length).toBeLessThan(220);
    expect(err.message).not.toContain("bad_request");
  });

  it("never echoes the API key from an error body (L11)", async () => {
    const f = vi.fn(async () => new Response("invalid token dub_key", { status: 401 }));
    const tool = toolOf(dubPack, "dub_shorten_url");
    const err = await failure(
      tool.run(
        tool.input.parse({ url: "https://example.com" }),
        fakeCtx({ packId: "dub", secrets: SECRETS, fetch: f as never }),
      ),
    );
    expect(err.message).toBe("Dub 401: invalid token [key]");
  });

  it("limits key, domain and tags (L11)", () => {
    const tool = toolOf(dubPack, "dub_shorten_url");
    const ok = (v: object) => tool.input.safeParse({ url: "https://example.com", ...v }).success;
    expect(ok({ key: "spring-sale", domain: "dub.sh", tags: ["a", "b"] })).toBe(true);
    expect(ok({ key: "k".repeat(191) })).toBe(false);
    expect(ok({ key: "has space" })).toBe(false);
    expect(ok({ domain: "not a host" })).toBe(false);
    expect(ok({ domain: `${"a".repeat(250)}.com` })).toBe(false);
    expect(ok({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe(false);
    expect(ok({ tags: ["t".repeat(65)] })).toBe(false);
  });

  it("accepts only http(s) URLs", () => {
    const tool = toolOf(dubPack, "dub_shorten_url");
    expect(tool.input.safeParse({ url: "https://example.com/a" }).success).toBe(true);
    expect(tool.input.safeParse({ url: "http://example.com/a" }).success).toBe(true);
    for (const url of [
      "ftp://example.com/a",
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
    ]) {
      expect(tool.input.safeParse({ url }).success).toBe(false);
    }
  });

  it("rejects an invalid url", () => {
    const tool = toolOf(dubPack, "dub_shorten_url");
    expect(tool.input.safeParse({ url: "not a url" }).success).toBe(false);
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    const h = await loadBuiltinPacks();
    try {
      expect(h.registry.get("dub_shorten_url")).toBeDefined();
      const res = await h.registry.call("dub_shorten_url", { url: "https://example.com" });
      expect(res).toMatchObject({
        ok: false,
        error: { code: "MISSING_SECRET", pack: "dub", secret: "DUB_API_KEY" },
      });
    } finally {
      await h.close();
    }
  });
});
