import { fileURLToPath } from "node:url";
import type { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import tavilyPack, { countryName, provider } from "../../../packs/tavily/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/tavily", import.meta.url));
const KEY = "tvly-test-0123456789";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(routes: Route[], secrets: Record<string, string> = { TAVILY_API_KEY: KEY }) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  return { ctx: t.forTool("search_web"), fetch };
}

describe("tavily pack", () => {
  it("exports one web.search provider", () => {
    expect(tavilyPack.providers).toEqual([provider]);
    expect(provider).toMatchObject({ id: "tavily", capability: "web.search", priority: 48 });
  });

  it("isConfigured follows TAVILY_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("maps the input onto POST /search and normalizes results", async () => {
    const { ctx, fetch } = setup([
      {
        match: /^POST https:\/\/api\.tavily\.com\/search$/,
        reply: () =>
          json({
            query: "q",
            results: [
              {
                title: "T",
                url: "https://a.example",
                content: "snippet",
                score: 0.9,
                published_date: "Mon, 01 Jun 2026 00:00:00 GMT",
              },
              { title: "", url: "https://b.example", content: "" },
              { title: "no url" },
            ],
          }),
      },
    ]);
    const out = await provider.run(
      {
        query: "q",
        max_results: 40,
        include_domains: ["a.example"],
        exclude_domains: ["c.example"],
        recency: "month",
        country: "us",
        model: "advanced",
      },
      ctx,
    );
    const call = fetch.calls[0];
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      query: "q",
      search_depth: "advanced",
      max_results: 20,
      include_published_date: true,
      include_domains: ["a.example"],
      exclude_domains: ["c.example"],
      time_range: "month",
      country: "united states",
    });
    expect(out).toEqual({
      provider: "tavily",
      model: "advanced",
      results: [
        {
          title: "T",
          url: "https://a.example",
          snippet: "snippet",
          published_at: "Mon, 01 Jun 2026 00:00:00 GMT",
          score: 0.9,
        },
        { title: "https://b.example", url: "https://b.example" },
      ],
    });
  });

  it("countryName turns ISO codes into Tavily's lowercase English names", () => {
    expect(countryName("gb")).toBe("united kingdom");
    expect(countryName("DE")).toBe("germany");
    expect(countryName("zz")).toBeUndefined();
    expect(countryName("usa")).toBeUndefined();
    expect(countryName(undefined)).toBeUndefined();
  });

  it("defaults to basic depth and 10 results", async () => {
    const { ctx, fetch } = setup([{ match: /tavily/, reply: () => json({ results: [] }) }]);
    const out = await provider.run({ query: "q" }, ctx);
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toMatchObject({
      search_depth: "basic",
      max_results: 10,
    });
    expect(out.model).toBe("basic");
  });

  it("refuses an unknown depth and a missing key retryably, without a request", async () => {
    const a = setup([]);
    expect(await failure(provider.run({ query: "q", model: "deep" }, a.ctx))).toMatchObject({
      retryable: true,
      code: "UNSUPPORTED_OPTION",
    });
    expect(a.fetch.calls).toHaveLength(0);
    expect(await failure(provider.run({ query: "q" }, setup([], {}).ctx))).toMatchObject({
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  });

  it("classifies HTTP errors, including Tavily's 432/433 limits", async () => {
    const cases: [number, boolean, string][] = [
      [400, false, "PROVIDER_ERROR"],
      [401, true, "AUTH_FAILED"],
      [429, true, "RATE_LIMITED"],
      [432, true, "RATE_LIMITED"],
      [433, true, "RATE_LIMITED"],
      [500, true, "PROVIDER_ERROR"],
    ];
    for (const [status, retryable, code] of cases) {
      const { ctx } = setup([
        { match: /tavily/, reply: () => json({ detail: { error: `nope ${KEY}` } }, status) },
      ]);
      const e = (await failure(provider.run({ query: "q" }, ctx))) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status });
      expect(e.message).toBe(`Tavily ${status}: nope [key]`);
    }
  });
});

describe("tavily estimate", () => {
  const est = (input: Parameters<NonNullable<typeof provider.estimate>>[0]) =>
    provider.estimate?.(input, setup([]).ctx);

  it("prices basic, fast and ultra-fast at 1 credit and advanced at 2", async () => {
    expect(await est({ query: "q" })).toEqual({
      usd: 0.008,
      basis: "static price table (2026-11): 1 credit at $0.008",
    });
    expect((await est({ query: "q", model: "fast" }))?.usd).toBe(0.008);
    expect((await est({ query: "q", model: "ultra-fast", max_results: 20 }))?.usd).toBe(0.008);
    expect(await est({ query: "q", model: "advanced" })).toEqual({
      usd: 0.016,
      basis: "static price table (2026-11): 2 credits at $0.008",
    });
  });

  it("prices an unknown depth as advanced", async () => {
    expect((await est({ query: "q", model: "nope" }))?.usd).toBe(0.016);
  });
});
