import { fileURLToPath } from "node:url";
import type { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import bravePack, { plain, provider } from "../../../packs/brave/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/brave", import.meta.url));
const KEY = "BSA-test-0123456789";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(routes: Route[], secrets: Record<string, string> = { BRAVE_API_KEY: KEY }) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  return { ctx: t.forTool("search_web"), fetch };
}

describe("brave pack", () => {
  it("exports one web.search provider", () => {
    expect(bravePack.providers).toEqual([provider]);
    expect(provider).toMatchObject({ id: "brave", capability: "web.search", priority: 44 });
  });

  it("isConfigured follows BRAVE_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("maps the input onto GET /res/v1/web/search and normalizes results", async () => {
    const { ctx, fetch } = setup([
      {
        match: /^GET https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?/,
        reply: () =>
          json({
            type: "search",
            web: {
              results: [
                {
                  title: "The <strong>MCP</strong> spec",
                  url: "https://a.example/spec",
                  description: "Tom&#x27;s &quot;notes&quot; &amp; more",
                  page_age: "2026-05-01T00:00:00",
                },
                { title: "", url: "https://b.example" },
                { title: "no url" },
              ],
            },
          }),
      },
    ]);
    const out = await provider.run(
      {
        query: "mcp",
        max_results: 30,
        include_domains: ["a.example"],
        exclude_domains: ["c.example", "d.example"],
        recency: "day",
        country: "gb",
      },
      ctx,
    );
    const call = fetch.calls[0];
    expect(call?.headers["x-subscription-token"]).toBe(KEY);
    expect(call?.headers.accept).toBe("application/json");
    const u = new URL(call?.url ?? "");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q: "mcp site:a.example NOT site:c.example NOT site:d.example",
      count: "20",
      freshness: "pd",
      country: "GB",
    });
    expect(out).toEqual({
      provider: "brave",
      results: [
        {
          title: "The MCP spec",
          url: "https://a.example/spec",
          snippet: `Tom's "notes" & more`,
          published_at: "2026-05-01T00:00:00",
        },
        { title: "https://b.example", url: "https://b.example" },
      ],
    });
  });

  it("plain() strips tags and decodes entities once", () => {
    expect(plain("<b>a</b> &amp;lt; &lt;x&gt; &#39;")).toBe("a &lt; <x> '");
  });

  it("refuses a model, several include domains and a missing key retryably", async () => {
    const a = setup([]);
    for (const input of [
      { query: "q", model: "x" },
      { query: "q", include_domains: ["a.example", "b.example"] },
    ]) {
      expect(await failure(provider.run(input, a.ctx))).toMatchObject({
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    expect(a.fetch.calls).toHaveLength(0);
    expect(await failure(provider.run({ query: "q" }, setup([], {}).ctx))).toMatchObject({
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  });

  it("classifies HTTP errors", async () => {
    const cases: [number, boolean, string][] = [
      [422, false, "PROVIDER_ERROR"],
      [401, true, "AUTH_FAILED"],
      [429, true, "RATE_LIMITED"],
      [502, true, "PROVIDER_ERROR"],
    ];
    for (const [status, retryable, code] of cases) {
      const { ctx } = setup([
        { match: /brave/, reply: () => json({ error: { detail: "Invalid token" } }, status) },
      ]);
      const e = (await failure(provider.run({ query: "q" }, ctx))) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status });
      expect(e.message).toBe(`Brave Search ${status}: Invalid token`);
    }
  });
});

describe("brave estimate", () => {
  it("prices one request at $5 per 1,000, whatever the count", async () => {
    const ctx = setup([]).ctx;
    const want = { usd: 0.005, basis: "static price table (2026-11): $5 per 1,000 requests" };
    expect(await provider.estimate?.({ query: "q" }, ctx)).toEqual(want);
    expect(await provider.estimate?.({ query: "q", max_results: 20 }, ctx)).toEqual(want);
  });
});
