import { describe, expect, it, vi } from "vitest";
import { DataForSEOClient } from "../../../packs/seo/client.js";
import seoPack from "../../../packs/seo/index.js";
import { fakeCtx, jsonResponse, loadBuiltinPacks, toolNames, toolOf } from "../support.js";

const SECRETS = { DATAFORSEO_LOGIN: "lo", DATAFORSEO_PASSWORD: "pw" };

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async (_url: unknown, _init?: RequestInit) => jsonResponse(body, status));
}

function client(fetchFn: ReturnType<typeof mockFetch>, opts = {}) {
  return new DataForSEOClient(fetchFn as never, "lo", "pw", { retryBaseMs: 1, ...opts });
}

const call = (fetchFn: ReturnType<typeof vi.fn>, i = 0) =>
  fetchFn.mock.calls[i] as unknown as [string, RequestInit];

describe("DataForSEOClient", () => {
  const empty = { status_code: 20000, tasks: [] };

  it("uses Basic auth from login:password", async () => {
    const f = mockFetch(empty);
    await client(f).serpGoogleOrganicLive({ keyword: "ops automation" });
    // base64("lo:pw") = "bG86cHc="
    expect((call(f)[1].headers as Record<string, string>).Authorization).toBe("Basic bG86cHc=");
  });

  it("serpGoogleOrganicLive POSTs an array of tasks with defaults", async () => {
    const f = mockFetch(empty);
    await client(f).serpGoogleOrganicLive({ keyword: "ops automation" });
    const [url, init] = call(f);
    expect(url).toBe("https://api.dataforseo.com/v3/serp/google/organic/live/regular");
    const payload = JSON.parse(String(init.body));
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0]).toMatchObject({
      keyword: "ops automation",
      location_name: "United States",
      language_name: "English",
      depth: 20,
    });
  });

  it("keywordsSearchVolumeLive defaults location_code 2840 + language_code en", async () => {
    const f = mockFetch(empty);
    await client(f).keywordsSearchVolumeLive({ keywords: ["ops automation", "runbook"] });
    const payload = JSON.parse(String(call(f)[1].body));
    expect(payload[0]).toEqual({
      keywords: ["ops automation", "runbook"],
      location_code: 2840,
      language_code: "en",
    });
  });

  it("keywordsForSiteLive, backlinksSummaryLive and onPageInstant hit their endpoints", async () => {
    const f = mockFetch(empty);
    const c = client(f);
    await c.keywordsForSiteLive({ target: "example.com" });
    await c.backlinksSummaryLive({ target: "example.com" });
    await c.onPageInstant({ url: "https://example.com" });
    expect(call(f, 0)[0]).toBe(
      "https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_site/live",
    );
    expect(JSON.parse(String(call(f, 0)[1].body))[0].target).toBe("example.com");
    expect(call(f, 1)[0]).toBe("https://api.dataforseo.com/v3/backlinks/summary/live");
    expect(call(f, 2)[0]).toBe("https://api.dataforseo.com/v3/on_page/instant_pages");
    expect(JSON.parse(String(call(f, 2)[1].body))[0]).toEqual({
      url: "https://example.com",
      enable_javascript: true,
    });
  });

  it("throws on app-level status_code >= 40000", async () => {
    const f = mockFetch({ status_code: 40400, status_message: "Not Found", tasks: [] });
    await expect(client(f).serpGoogleOrganicLive({ keyword: "x" })).rejects.toThrow(
      /DataForSEO 40400.*Not Found/,
    );
  });

  it("throws on HTTP non-2xx without retrying a 401", async () => {
    const f = vi.fn(async () => jsonResponse({ status_message: "auth failed" }, 401));
    await expect(client(f as never).serpGoogleOrganicLive({ keyword: "x" })).rejects.toThrow(
      /DataForSEO \/v3\/serp\/google\/organic\/live\/regular returned 401: auth failed/,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 5xx on a billed live endpoint, and says it may have charged", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse(empty));
    await expect(client(f as never).serpGoogleOrganicLive({ keyword: "x" })).rejects.toThrow(
      /returned 503\. The request may already have been processed and charged/,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry a timeout after send on a billed endpoint", async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(jsonResponse(empty));
    await expect(client(f as never).backlinksSummaryLive({ target: "a.test" })).rejects.toThrow(
      /failed after the request was sent/,
    );
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 with a short Retry-After once", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse(empty));
    await client(f as never).serpGoogleOrganicLive({ keyword: "x" });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("passes the signal and a timeout to fetch", async () => {
    const f = mockFetch(empty);
    const ac = new AbortController();
    await client(f, { signal: ac.signal }).serpGoogleOrganicLive({ keyword: "x" });
    const init = call(f)[1] as RequestInit & { timeoutMs?: number };
    expect(init.signal).toBe(ac.signal);
    expect(init.timeoutMs).toBe(120_000);
  });

  it("surfaces a task-level error instead of an empty result", async () => {
    const f = mockFetch({
      status_code: 20000,
      tasks: [{ status_code: 40501, status_message: "Invalid Field: 'keyword'." }],
    });
    await expect(client(f).serpGoogleOrganicLive({ keyword: "x" })).rejects.toThrow(
      /DataForSEO task 40501: Invalid Field/,
    );
  });

  it("never echoes the raw error body", async () => {
    const f = vi.fn(async () => new Response("login=lo password=pw secret", { status: 400 }));
    const err = await client(f as never)
      .serpGoogleOrganicLive({ keyword: "x" })
      .catch((e) => e);
    expect(String(err.message)).not.toContain("secret");
  });
});

describe("seo pack tools", () => {
  it("exposes the five legacy tool names", () => {
    expect(toolNames(seoPack)).toEqual([
      "seo_serp",
      "seo_keyword_volume",
      "seo_keywords_for_site",
      "seo_backlinks",
      "seo_onpage",
    ]);
  });

  it("seo_serp flattens tasks, result, items into a ranked list", async () => {
    const f = mockFetch({
      status_code: 20000,
      tasks: [
        {
          result: [
            {
              total_count: 2,
              se_results_count: 12345,
              items: [
                {
                  type: "organic",
                  rank_absolute: 1,
                  url: "https://acme.com",
                  title: "Acme",
                  description: "homepage",
                  domain: "acme.com",
                },
                { type: "organic", rank_absolute: 2, url: "https://beta.io", title: "Beta" },
              ],
            },
          ],
        },
      ],
    });
    const tool = toolOf(seoPack, "seo_serp");
    const out = (await tool.run(
      tool.input.parse({ keyword: "ops automation" }),
      fakeCtx({ packId: "seo", secrets: SECRETS, fetch: f as never }),
    )) as {
      items_count: number;
      items: Array<{ url: string; rank: number; description: unknown }>;
      raw_summary: unknown;
    };
    expect(JSON.parse(String(call(f)[1].body))[0].keyword).toBe("ops automation");
    expect(out.items_count).toBe(2);
    expect(out.items[0]).toMatchObject({ url: "https://acme.com", rank: 1 });
    expect(out.items[1]?.description).toBeNull();
    expect(out.raw_summary).toEqual({ se_results_count: 12345 });
  });

  it("seo_serp survives an empty response", async () => {
    const f = mockFetch({ status_code: 20000, tasks: [] });
    const tool = toolOf(seoPack, "seo_serp");
    const out = (await tool.run(
      tool.input.parse({ keyword: "x" }),
      fakeCtx({ packId: "seo", secrets: SECRETS, fetch: f as never }),
    )) as { items_count: number; total_count: number };
    expect(out).toMatchObject({ items_count: 0, total_count: 0 });
  });

  it("seo_keyword_volume maps rows", async () => {
    const f = mockFetch({
      status_code: 20000,
      tasks: [{ result: [{ keyword: "runbook", search_volume: 900, competition: 0.2, cpc: 1.5 }] }],
    });
    const tool = toolOf(seoPack, "seo_keyword_volume");
    const out = await tool.run(
      tool.input.parse({ keywords: ["runbook"] }),
      fakeCtx({ packId: "seo", secrets: SECRETS, fetch: f as never }),
    );
    expect(out).toEqual({
      count: 1,
      keywords: [
        {
          keyword: "runbook",
          search_volume: 900,
          competition: 0.2,
          competition_level: null,
          cpc: 1.5,
          low_top_of_page_bid: null,
          high_top_of_page_bid: null,
        },
      ],
    });
  });

  it("seo_keywords_for_site passes target and limit", async () => {
    const f = mockFetch({
      status_code: 20000,
      tasks: [{ result: [{ keyword: "sre", search_volume: 10 }] }],
    });
    const tool = toolOf(seoPack, "seo_keywords_for_site");
    const out = (await tool.run(
      tool.input.parse({ target: "example.com", limit: 5 }),
      fakeCtx({ packId: "seo", secrets: SECRETS, fetch: f as never }),
    )) as { count: number };
    expect(JSON.parse(String(call(f)[1].body))[0]).toMatchObject({
      target: "example.com",
      limit: 5,
    });
    expect(out.count).toBe(1);
  });

  it("seo_backlinks returns the summary and fetches the list only on request", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status_code: 20000,
          tasks: [
            {
              result: [
                { rank: 55, backlinks: 100, referring_domains: 12, backlinks_spam_score: 3 },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status_code: 20000,
          tasks: [
            {
              result: [
                {
                  items: [
                    {
                      url_from: "https://a.com/p",
                      url_to: "https://example.com",
                      dofollow: true,
                      rank: 40,
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
    const tool = toolOf(seoPack, "seo_backlinks");
    const ctx = fakeCtx({ packId: "seo", secrets: SECRETS, fetch: f as never });
    const plain = (await tool.run(tool.input.parse({ target: "example.com" }), ctx)) as Record<
      string,
      unknown
    >;
    expect(plain).toMatchObject({ domain_rank: 55, total_backlinks: 100, referring_domains: 12 });
    expect(plain.list).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);

    f.mockReset();
    f.mockResolvedValueOnce(
      jsonResponse({ status_code: 20000, tasks: [{ result: [{}] }] }),
    ).mockResolvedValueOnce(
      jsonResponse({
        status_code: 20000,
        tasks: [{ result: [{ items: [{ url_from: "https://a.com/p", dofollow: true }] }] }],
      }),
    );
    const withList = (await tool.run(
      tool.input.parse({ target: "example.com", include_list: true, list_limit: 5 }),
      ctx,
    )) as { list: Array<{ url_from: string; is_dofollow: boolean }> };
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(call(f, 1)[1].body))[0]).toMatchObject({
      mode: "one_per_domain",
      limit: 5,
    });
    expect(withList.list[0]).toMatchObject({ url_from: "https://a.com/p", is_dofollow: true });
  });

  it("seo_onpage reports failed checks", async () => {
    const f = mockFetch({
      status_code: 20000,
      tasks: [
        {
          result: [
            {
              items: [
                {
                  status_code: 200,
                  onpage_score: 91.5,
                  meta: { title: "T", h1: ["a", "b"], content: { plain_text_word_count: 321 } },
                  checks: { seo_friendly_url: false, broken_links: 0, is_https: true },
                },
              ],
            },
          ],
        },
      ],
    });
    const tool = toolOf(seoPack, "seo_onpage");
    const out = (await tool.run(
      tool.input.parse({ url: "https://example.com" }),
      fakeCtx({ packId: "seo", secrets: SECRETS, fetch: f as never }),
    )) as { page_metrics: Record<string, unknown>; checks_failed: string[] };
    expect(out.page_metrics).toMatchObject({
      title: "T",
      h1_count: 2,
      word_count: 321,
      onpage_score: 91.5,
    });
    expect(out.checks_failed).toEqual(["seo_friendly_url"]);
  });

  it("seo_onpage rejects non-http URLs", () => {
    const tool = toolOf(seoPack, "seo_onpage");
    expect(tool.input.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
  });
});

describe("seo pack via the loader", () => {
  it("loads and reports MISSING_SECRET for the DataForSEO login", async () => {
    const h = await loadBuiltinPacks();
    try {
      for (const name of toolNames(seoPack)) expect(h.registry.get(name)).toBeDefined();
      const res = await h.registry.call("seo_serp", { keyword: "x" });
      expect(res).toMatchObject({
        ok: false,
        error: { code: "MISSING_SECRET", pack: "seo", secret: "DATAFORSEO_LOGIN" },
      });
    } finally {
      await h.close();
    }
  });
});

describe("seo tools: cancellation and input bounds", () => {
  it("passes ctx.signal through to the request", async () => {
    const f = mockFetch({ status_code: 20000, tasks: [] });
    const tool = toolOf(seoPack, "seo_serp");
    const ctx = fakeCtx({ packId: "seo", secrets: SECRETS, fetch: f as never });
    await tool.run(tool.input.parse({ keyword: "x" }), ctx);
    expect(call(f)[1].signal).toBe(ctx.signal);
  });

  it("rejects oversized free-text inputs before any billed call", () => {
    const serp = toolOf(seoPack, "seo_serp");
    expect(() => serp.input.parse({ keyword: "k".repeat(701) })).toThrow();
    const vol = toolOf(seoPack, "seo_keyword_volume");
    expect(() => vol.input.parse({ keywords: ["k".repeat(81)] })).toThrow();
    expect(() => vol.input.parse({ keywords: ["ok"], language_code: "x".repeat(50) })).toThrow();
    const site = toolOf(seoPack, "seo_keywords_for_site");
    expect(() => site.input.parse({ target: "t".repeat(3000) })).toThrow();
  });
});
