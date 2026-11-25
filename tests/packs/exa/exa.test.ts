import { fileURLToPath } from "node:url";
import { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import exaPack, { PROVIDER_ID, provider } from "../../../packs/exa/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/exa", import.meta.url));
const KEY = "exa-test-key-0123456789";
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(routes: Route[], secrets: Record<string, string> = { EXA_API_KEY: KEY }) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  return { ctx: t.forTool("search_web"), fetch };
}

describe("exa pack", () => {
  it("exports one web.search provider", () => {
    expect(exaPack.providers).toEqual([provider]);
    expect(provider).toMatchObject({ id: "exa", capability: "web.search", priority: 50 });
  });

  it("isConfigured follows EXA_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("maps the input onto POST /search and normalizes results", async () => {
    const { ctx, fetch } = setup([
      {
        match: /^POST https:\/\/api\.exa\.ai\/search$/,
        reply: () =>
          json({
            results: [
              {
                title: "One",
                url: "https://a.example/1",
                publishedDate: "2026-01-02T00:00:00.000Z",
                highlights: ["first bit", "second bit"],
              },
              { title: "", url: "https://b.example/2", text: "x".repeat(900) },
              { title: "no url" },
            ],
            costDollars: { total: 0.005 },
          }),
      },
    ]);
    const before = Date.now();
    const out = await provider.run(
      {
        query: "mcp servers",
        max_results: 5,
        include_domains: ["a.example"],
        exclude_domains: ["c.example"],
        recency: "week",
        country: "de",
        model: "deep",
      },
      ctx,
    );
    const call = fetch.calls[0];
    expect(call?.headers["x-api-key"]).toBe(KEY);
    expect(call?.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(call?.body ?? "{}");
    expect(body).toMatchObject({
      query: "mcp servers",
      type: "deep",
      numResults: 5,
      includeDomains: ["a.example"],
      excludeDomains: ["c.example"],
      userLocation: "DE",
      contents: { highlights: { maxCharacters: 600 } },
    });
    const start = Date.parse(body.startPublishedDate);
    expect(before - start).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(before - start).toBeLessThan(7 * 86_400_000 + 1000);
    expect(out).toEqual({
      provider: PROVIDER_ID,
      model: "deep",
      cost_usd: 0.005,
      results: [
        {
          title: "One",
          url: "https://a.example/1",
          snippet: "first bit ... second bit",
          published_at: "2026-01-02T00:00:00.000Z",
        },
        { title: "https://b.example/2", url: "https://b.example/2", snippet: "x".repeat(600) },
      ],
    });
  });

  it("defaults to type auto and 10 results without optional fields", async () => {
    const { ctx, fetch } = setup([{ match: /api\.exa\.ai/, reply: () => json({ results: [] }) }]);
    const out = await provider.run({ query: "q" }, ctx);
    const body = JSON.parse(fetch.calls[0]?.body ?? "{}");
    expect(body).toEqual({
      query: "q",
      type: "auto",
      numResults: 10,
      contents: { highlights: { maxCharacters: 600 } },
    });
    expect(out).toEqual({ results: [], provider: "exa", model: "auto" });
  });

  it("refuses an unknown type before any request, retryably", async () => {
    const { ctx, fetch } = setup([]);
    const e = await failure(provider.run({ query: "q", model: "neural" }, ctx));
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e).toMatchObject({ retryable: true, code: "UNSUPPORTED_OPTION" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("a missing key is a retryable NOT_CONFIGURED", async () => {
    const e = await failure(provider.run({ query: "q" }, setup([], {}).ctx));
    expect(e).toMatchObject({ retryable: true, code: "NOT_CONFIGURED" });
  });

  it("classifies HTTP errors and redacts the key", async () => {
    const cases: [number, boolean, string][] = [
      [400, false, "PROVIDER_ERROR"],
      [401, true, "AUTH_FAILED"],
      [429, true, "RATE_LIMITED"],
      [503, true, "PROVIDER_ERROR"],
    ];
    for (const [status, retryable, code] of cases) {
      const { ctx } = setup([
        {
          match: /api\.exa\.ai/,
          reply: () => json({ error: `bad key ${KEY}` }, status, { "retry-after": "2" }),
        },
      ]);
      const e = (await failure(provider.run({ query: "q" }, ctx))) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status, retryAfterMs: 2000 });
      expect(e.message).toBe(`Exa ${status}: bad key [key]`);
    }
  });
});

describe("exa estimate", () => {
  const est = (input: Parameters<NonNullable<typeof provider.estimate>>[0]) =>
    provider.estimate?.(input, setup([]).ctx);

  it("prices an auto search with highlights on 10 results", async () => {
    expect(await est({ query: "q" })).toEqual({
      usd: 0.017,
      basis: "static price table (2026-11): auto search, 10 results with highlights",
    });
  });

  it("adds results above 10 and follows the search type", async () => {
    // 0.004 + 15 extra x 0.001 + 25 highlights x 0.001
    expect((await est({ query: "q", model: "lite", max_results: 25 }))?.usd).toBe(0.044);
    expect((await est({ query: "q", model: "deep", max_results: 1 }))?.usd).toBe(0.013);
  });

  it("prices an unknown type as deep", async () => {
    expect(await est({ query: "q", model: "nope" })).toMatchObject({
      usd: 0.022,
      basis: expect.stringContaining("deep search"),
    });
  });
});
