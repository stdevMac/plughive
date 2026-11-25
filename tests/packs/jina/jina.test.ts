import { fileURLToPath } from "node:url";
import type { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import jinaPack, { embedProvider, provider, rerankProvider } from "../../../packs/jina/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/jina", import.meta.url));
const KEY = "jina_test0123456789";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(routes: Route[], secrets: Record<string, string> = { JINA_API_KEY: KEY }) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  return { ctx: t.forTool("fetch_web"), fetch };
}

const page = (content: string) =>
  json({
    code: 200,
    status: 20000,
    data: { title: "Example", url: "https://example.com/final", content },
  });

describe("jina pack", () => {
  it("exports web.fetch, text.rerank and text.embed providers", () => {
    expect(jinaPack.providers).toEqual([provider, rerankProvider, embedProvider]);
    expect(rerankProvider).toMatchObject({ id: "jina", capability: "text.rerank" });
    expect(embedProvider).toMatchObject({ id: "jina", capability: "text.embed" });
    expect(provider).toMatchObject({ id: "jina", capability: "web.fetch", priority: 40 });
  });

  it("isConfigured follows JINA_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("POSTs the URL to r.jina.ai with the return format and normalizes the page", async () => {
    const { ctx, fetch } = setup([
      { match: /^POST https:\/\/r\.jina\.ai\/$/, reply: () => page("# Hello\n\nworld") },
    ]);
    const out = await provider.run({ url: "https://example.com", format: "text" }, ctx);
    const call = fetch.calls[0];
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call?.headers.accept).toBe("application/json");
    expect(call?.headers["x-return-format"]).toBe("text");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ url: "https://example.com" });
    expect(out).toEqual({
      provider: "jina",
      url: "https://example.com/final",
      title: "Example",
      content: "# Hello\n\nworld",
      format: "text",
    });
  });

  it("defaults to markdown and cuts content at max_chars", async () => {
    const { ctx, fetch } = setup([{ match: /jina/, reply: () => page("a".repeat(500)) }]);
    const out = await provider.run({ url: "https://example.com", max_chars: 100 }, ctx);
    expect(fetch.calls[0]?.headers["x-return-format"]).toBe("markdown");
    expect(out).toMatchObject({ format: "markdown", truncated: true, content: "a".repeat(100) });
  });

  it("a reply without content is a non-retryable BAD_RESPONSE", async () => {
    const { ctx } = setup([{ match: /jina/, reply: () => json({ code: 200, data: {} }) }]);
    expect(await failure(provider.run({ url: "https://example.com" }, ctx))).toMatchObject({
      retryable: false,
      code: "BAD_RESPONSE",
    });
  });

  it("refuses a model and a missing key retryably", async () => {
    const a = setup([]);
    expect(
      await failure(provider.run({ url: "https://example.com", model: "x" }, a.ctx)),
    ).toMatchObject({ retryable: true, code: "UNSUPPORTED_OPTION" });
    expect(a.fetch.calls).toHaveLength(0);
    expect(
      await failure(provider.run({ url: "https://example.com" }, setup([], {}).ctx)),
    ).toMatchObject({ retryable: true, code: "NOT_CONFIGURED" });
  });

  it("classifies HTTP errors", async () => {
    const cases: [number, boolean, string][] = [
      [422, false, "PROVIDER_ERROR"],
      [401, true, "AUTH_FAILED"],
      [402, true, "QUOTA_EXCEEDED"],
      [429, true, "RATE_LIMITED"],
      [503, true, "PROVIDER_ERROR"],
    ];
    for (const [status, retryable, code] of cases) {
      const { ctx } = setup([
        {
          match: /jina/,
          reply: () => json({ code: status, name: "E", readableMessage: "cannot read" }, status),
        },
      ]);
      const e = (await failure(
        provider.run({ url: "https://example.com" }, ctx),
      )) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status });
      expect(e.message).toBe(`Jina Reader ${status}: cannot read`);
    }
  });

  it("reranks through /v1/rerank and returns results best first", async () => {
    const { ctx, fetch } = setup([
      {
        match: /^POST https:\/\/api\.jina\.ai\/v1\/rerank$/,
        reply: () =>
          json({
            model: "jina-reranker-v2-base-multilingual",
            usage: { total_tokens: 42 },
            results: [
              { index: 2, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.4 },
              { index: 7, relevance_score: 0.99 },
            ],
          }),
      },
    ]);
    const out = await rerankProvider.run(
      { query: "cats", documents: ["a", "b", "c"], top_n: 2 },
      ctx,
    );
    expect(fetch.calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toEqual({
      model: "jina-reranker-v2-base-multilingual",
      query: "cats",
      documents: ["a", "b", "c"],
      top_n: 2,
      return_documents: false,
    });
    expect(out).toEqual({
      results: [
        { index: 2, score: 0.9 },
        { index: 0, score: 0.4 },
      ],
      model: "jina-reranker-v2-base-multilingual",
      provider: "jina",
      tokens_used: 42,
    });
  });

  it("refuses an unknown rerank or embedding model and too many dimensions, without a request", async () => {
    const { ctx, fetch } = setup([]);
    expect(
      await failure(rerankProvider.run({ query: "q", documents: ["a"], model: "x" }, ctx)),
    ).toMatchObject({ retryable: true, code: "UNSUPPORTED_OPTION" });
    expect(await failure(embedProvider.run({ texts: ["a"], dimensions: 2048 }, ctx))).toMatchObject(
      { retryable: true, code: "UNSUPPORTED_OPTION" },
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it("embeds through /v1/embeddings with the retrieval task, in input order", async () => {
    const { ctx, fetch } = setup([
      {
        match: /^POST https:\/\/api\.jina\.ai\/v1\/embeddings$/,
        reply: () =>
          json({
            usage: { total_tokens: 6 },
            data: [
              { index: 1, embedding: [0, 1, 0] },
              { index: 0, embedding: [1, 0, 0] },
            ],
          }),
      },
    ]);
    const out = await embedProvider.run(
      { texts: ["x", "y"], input_type: "query", dimensions: 3 },
      ctx,
    );
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toEqual({
      model: "jina-embeddings-v3",
      input: ["x", "y"],
      task: "retrieval.query",
      dimensions: 3,
      embedding_type: "float",
    });
    expect(out).toEqual({
      embeddings: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      model: "jina-embeddings-v3",
      dimensions: 3,
      provider: "jina",
      tokens_used: 6,
    });
  });

  it("refuses a short embedding reply and names Jina in API errors", async () => {
    const short = setup([
      {
        match: /embeddings$/,
        reply: () => json({ data: [{ index: 0, embedding: [1] }] }),
      },
    ]);
    expect(await failure(embedProvider.run({ texts: ["a", "b"] }, short.ctx))).toMatchObject({
      code: "BAD_RESPONSE",
    });
    const denied = setup([{ match: /rerank$/, reply: () => json({ detail: "bad key" }, 401) }]);
    const e = await failure(rerankProvider.run({ query: "q", documents: ["a"] }, denied.ctx));
    expect(e).toMatchObject({ retryable: true, code: "AUTH_FAILED", status: 401 });
    expect(e.message).toBe("Jina 401: bad key");
  });
});

describe("jina estimates", () => {
  it("reports a Reader fetch as cost unknown (Jina bills the whole page before max_chars)", async () => {
    const ctx = setup([]).ctx;
    // max_chars must not shrink the estimate: the upstream page is billed whole.
    expect(await provider.estimate?.({ url: "https://example.com" }, ctx)).toBeNull();
    expect(
      await provider.estimate?.({ url: "https://example.com", max_chars: 100 }, ctx),
    ).toBeNull();
    expect(
      await provider.estimate?.({ url: "https://example.com", max_chars: 1_000_000 }, ctx),
    ).toBeNull();
  });

  it("prices a rerank by the query read with every document", async () => {
    const ctx = setup([]).ctx;
    const documents = ["a".repeat(9_990), "b".repeat(9_990)];
    // (10 + 9990) x 2 = 20,000 chars -> 10,000 tokens -> $0.0005
    expect(await rerankProvider.estimate?.({ query: "q".repeat(10), documents }, ctx)).toEqual({
      usd: 0.0005,
      basis: "static price table (2026-11): $0.05/M tokens, 20000 input chars",
    });
  });

  it("prices embeddings by input length, never 0", async () => {
    const ctx = setup([]).ctx;
    expect((await embedProvider.estimate?.({ texts: ["x".repeat(40_000)] }, ctx))?.usd).toBe(0.001);
    const tiny = await embedProvider.estimate?.({ texts: ["hi"] }, ctx);
    expect(tiny?.usd).toBeGreaterThan(0);
    expect(tiny?.basis).toBe("static price table (2026-11): $0.05/M tokens, 2 input chars");
  });
});
