import { fileURLToPath } from "node:url";
import type { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import parallelPack, { provider } from "../../../packs/parallel/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/parallel", import.meta.url));
const KEY = "par-test-0123456789";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(routes: Route[], secrets: Record<string, string> = { PARALLEL_API_KEY: KEY }) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  return { ctx: t.forTool("search_web"), fetch };
}

describe("parallel pack", () => {
  it("exports one web.search provider", () => {
    expect(parallelPack.providers).toEqual([provider]);
    expect(provider).toMatchObject({ id: "parallel", capability: "web.search", priority: 46 });
  });

  it("isConfigured follows PARALLEL_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("maps the input onto POST /v1/search and normalizes results", async () => {
    const { ctx, fetch } = setup([
      {
        match: /^POST https:\/\/api\.parallel\.ai\/v1\/search$/,
        reply: () =>
          json({
            search_id: "search_1",
            results: [
              {
                url: "https://a.example",
                title: "A",
                publish_date: "2026-04-01",
                excerpts: ["one", " ", "two"],
              },
              { url: "https://b.example", title: null, publish_date: null, excerpts: [] },
              { title: "no url" },
            ],
            usage: [{ name: "sku_search", count: 1 }],
          }),
      },
    ]);
    const today = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const out = await provider.run(
      {
        query: "mcp servers",
        max_results: 7,
        include_domains: ["a.example"],
        exclude_domains: ["c.example"],
        recency: "year",
        country: "US",
        model: "fast",
      },
      ctx,
    );
    const call = fetch.calls[0];
    expect(call?.headers["x-api-key"]).toBe(KEY);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      objective: "mcp servers",
      search_queries: ["mcp servers"],
      mode: "fast",
      advanced_settings: {
        max_results: 7,
        location: "us",
        source_policy: {
          include_domains: ["a.example"],
          exclude_domains: ["c.example"],
          after_date: today,
        },
      },
    });
    expect(out).toEqual({
      provider: "parallel",
      model: "fast",
      search_id: "search_1",
      results: [
        { title: "A", url: "https://a.example", snippet: "one\n\ntwo", published_at: "2026-04-01" },
        { title: "https://b.example", url: "https://b.example" },
      ],
    });
  });

  it("sends no mode or source policy when not asked", async () => {
    const { ctx, fetch } = setup([{ match: /parallel/, reply: () => json({ results: [] }) }]);
    await provider.run({ query: "q" }, ctx);
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toEqual({
      objective: "q",
      search_queries: ["q"],
      advanced_settings: { max_results: 10 },
    });
  });

  it("refuses an unknown mode and a missing key retryably", async () => {
    const a = setup([]);
    expect(await failure(provider.run({ query: "q", model: "pro" }, a.ctx))).toMatchObject({
      retryable: true,
      code: "UNSUPPORTED_OPTION",
    });
    expect(a.fetch.calls).toHaveLength(0);
    expect(await failure(provider.run({ query: "q" }, setup([], {}).ctx))).toMatchObject({
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  });

  it("classifies HTTP errors", async () => {
    const cases: [number, boolean, string][] = [
      [422, false, "PROVIDER_ERROR"],
      [403, true, "AUTH_FAILED"],
      [429, true, "RATE_LIMITED"],
      [500, true, "PROVIDER_ERROR"],
    ];
    for (const [status, retryable, code] of cases) {
      const { ctx } = setup([
        {
          match: /parallel/,
          reply: () => json({ type: "error", error: { ref_id: "r", message: "bad" } }, status),
        },
      ]);
      const e = (await failure(provider.run({ query: "q" }, ctx))) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status });
      expect(e.message).toBe(`Parallel ${status}: bad`);
    }
  });
});

describe("parallel estimate", () => {
  const est = (input: Parameters<NonNullable<typeof provider.estimate>>[0]) =>
    provider.estimate?.(input, setup([]).ctx);

  it("prices no mode as basic with 10 results", async () => {
    expect(await est({ query: "q" })).toEqual({
      usd: 0.005,
      basis: "static price table (2026-11): basic search, 10 results",
    });
  });

  it("follows the mode and adds results beyond 10", async () => {
    expect((await est({ query: "q", model: "turbo" }))?.usd).toBe(0.001);
    expect((await est({ query: "q", model: "fast", max_results: 30 }))?.usd).toBe(0.021);
    expect((await est({ query: "q", model: "advanced", max_results: 50 }))?.usd).toBe(0.045);
    expect((await est({ query: "q", model: "nope" }))?.usd).toBe(0.005);
  });
});
