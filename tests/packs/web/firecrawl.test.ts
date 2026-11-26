import { afterEach, describe, expect, it, vi } from "vitest";
import { FirecrawlClient } from "../../../packs/web/firecrawl.js";
import webPack, { crawlHooks } from "../../../packs/web/index.js";
import { failure } from "../provider-support.js";

afterEach(() => {
  crawlHooks.pollRetryMs = undefined;
  crawlHooks.retryBaseMs = undefined;
});
import {
  artifactRef,
  fakeCtx,
  jsonResponse,
  loadBuiltinPacks,
  toolNames,
  toolOf,
} from "../support.js";

const SECRETS = { FIRECRAWL_API_KEY: "fc-key" };

const call = (f: ReturnType<typeof vi.fn>, i = 0) =>
  f.mock.calls[i] as unknown as [string, RequestInit];

const saveSpy = () => vi.fn(async (_a: unknown) => artifactRef("md_1"));

describe("FirecrawlClient", () => {
  it("POSTs scrape with bearer auth and unwraps data", async () => {
    const f = vi.fn(async () => jsonResponse({ success: true, data: { markdown: "# hi" } }));
    const doc = await new FirecrawlClient(f as never, "k").scrape({ url: "https://a.com" });
    expect(doc.markdown).toBe("# hi");
    const [url, init] = call(f);
    expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("maps string and object links from map", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ success: true, links: ["https://a.com/1", { url: "https://a.com/2" }] }),
    );
    const r = await new FirecrawlClient(f as never, "k").map({ url: "https://a.com" });
    expect(r.links).toEqual(["https://a.com/1", "https://a.com/2"]);
  });

  it("retries a 429 with a short Retry-After, and does not retry a 401", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: {} }));
    await new FirecrawlClient(f as never, "k", { retryBaseMs: 1 }).search({ query: "x" });
    expect(f).toHaveBeenCalledTimes(2);

    const g = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(
      new FirecrawlClient(g as never, "k", { retryBaseMs: 1 }).search({ query: "x" }),
    ).rejects.toThrow(/Firecrawl \/v2\/search returned 401/);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 5xx or a timeout on credit-consuming endpoints", async () => {
    for (const run of [
      (c: FirecrawlClient) => c.scrape({ url: "https://a.com" }),
      (c: FirecrawlClient) => c.search({ query: "x" }),
      (c: FirecrawlClient) => c.map({ url: "https://a.com" }),
      (c: FirecrawlClient) => c.submitCrawl({ url: "https://a.com" }),
    ]) {
      const f = vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 502 }))
        .mockResolvedValue(jsonResponse({ success: true, id: "j", data: {} }));
      await expect(run(new FirecrawlClient(f as never, "k", { retryBaseMs: 1 }))).rejects.toThrow(
        /may already have been processed and charged/,
      );
      expect(f).toHaveBeenCalledTimes(1);
      const t = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
        .mockResolvedValue(jsonResponse({ success: true, id: "j", data: {} }));
      await expect(run(new FirecrawlClient(t as never, "k", { retryBaseMs: 1 }))).rejects.toThrow(
        /failed after the request was sent/,
      );
      expect(t).toHaveBeenCalledTimes(1);
    }
  });

  it("retries the free crawl-status GET on a 5xx", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ status: "scraping" }));
    const s = await new FirecrawlClient(f as never, "k", { retryBaseMs: 1 }).crawlStatus("j1");
    expect(s.status).toBe("scraping");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("follows same-origin `next` pages of a completed crawl, never another origin", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          status: "completed",
          data: [{ markdown: "a" }],
          next: "https://api.firecrawl.dev/v2/crawl/j1?skip=1",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "completed",
          data: [{ markdown: "b" }],
          next: "https://evil.test/steal",
        }),
      );
    const s = await new FirecrawlClient(f as never, "k").crawlStatus("j1");
    expect(s.data?.map((d) => d.markdown)).toEqual(["a", "b"]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(call(f, 1)[0]).toBe("https://api.firecrawl.dev/v2/crawl/j1?skip=1");
  });

  it("follows `next` only within the same crawl job, once per page", async () => {
    const page = (markdown: string, next?: string) =>
      jsonResponse({ status: "completed", data: [{ markdown }], ...(next ? { next } : {}) });
    const other = vi
      .fn()
      .mockResolvedValueOnce(page("a", "https://api.firecrawl.dev/v2/crawl/j2?skip=1"))
      .mockResolvedValueOnce(page("x", "https://api.firecrawl.dev/v1/team/credit-usage"));
    const s1 = await new FirecrawlClient(other as never, "k").crawlStatus("j1");
    expect(s1.data?.map((d) => d.markdown)).toEqual(["a"]);
    expect(other).toHaveBeenCalledTimes(1);

    const loop = vi
      .fn()
      .mockResolvedValueOnce(page("a", "https://api.firecrawl.dev/v2/crawl/j1?skip=1"))
      .mockResolvedValueOnce(page("b", "https://api.firecrawl.dev/v2/crawl/j1?skip=1"))
      .mockResolvedValue(page("c", "https://api.firecrawl.dev/v2/crawl/j1?skip=1"));
    const s2 = await new FirecrawlClient(loop as never, "k").crawlStatus("j1");
    expect(s2.data?.map((d) => d.markdown)).toEqual(["a", "b"]);
    expect(loop).toHaveBeenCalledTimes(2);
  });

  it("refuses a crawl result over the total byte cap", async () => {
    const big = "x".repeat(600);
    const f = vi.fn(async (url: string) => {
      const skip = Number(new URL(url).searchParams.get("skip") ?? "0");
      return jsonResponse({
        status: "completed",
        data: [{ markdown: big }],
        next: `https://api.firecrawl.dev/v2/crawl/j1?skip=${skip + 1}`,
      });
    });
    const err = await failure(
      new FirecrawlClient(f as never, "k", { maxCrawlBytes: 2000 }).crawlStatus("j1"),
    );
    expect(err.message).toMatch(/over 2000 bytes; crawl fewer pages/);
    expect(f.mock.calls.length).toBeLessThan(5);
  });

  it("passes the signal and a timeout to fetch", async () => {
    const f = vi.fn(async () => jsonResponse({ success: true, data: {} }));
    const ac = new AbortController();
    await new FirecrawlClient(f as never, "k", { signal: ac.signal }).scrape({ url: "https://a" });
    const init = call(f)[1] as RequestInit & { timeoutMs?: number };
    expect(init.signal).toBe(ac.signal);
    expect(init.timeoutMs).toBe(360_000);
  });

  it("throws on success:false", async () => {
    const f = vi.fn(async () => jsonResponse({ success: false, error: "quota" }));
    await expect(
      new FirecrawlClient(f as never, "k").scrape({ url: "https://a.com" }),
    ).rejects.toThrow(/Firecrawl \/v2\/scrape: quota/);
  });
});

describe("web pack firecrawl tools", () => {
  it("exposes the five legacy tool names", () => {
    expect(toolNames(webPack)).toEqual([
      "firecrawl_scrape",
      "firecrawl_search",
      "firecrawl_map",
      "firecrawl_crawl",
      "screenshot_url",
    ]);
  });

  it("firecrawl_scrape saves markdown as an artifact", async () => {
    const f = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: { markdown: "# Acme", metadata: { title: "Acme", statusCode: 200 } },
      }),
    );
    const save = saveSpy();
    const tool = toolOf(webPack, "firecrawl_scrape");
    const out = (await tool.run(
      tool.input.parse({ url: "https://acme.com" }),
      fakeCtx({
        packId: "web",
        secrets: SECRETS,
        fetch: f as never,
        library: { save: save as never },
      }),
    )) as { title: string; markdown: string; artifact: { id: string } };
    expect(JSON.parse(String(call(f)[1].body))).toMatchObject({
      url: "https://acme.com",
      formats: ["markdown"],
    });
    expect(out).toMatchObject({ title: "Acme", markdown: "# Acme", artifact: { id: "md_1" } });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ tool: "firecrawl_scrape" }));
  });

  it("firecrawl_scrape skips the artifact when there is no markdown", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ success: true, data: { links: ["https://a.com/x"] } }),
    );
    const save = saveSpy();
    const tool = toolOf(webPack, "firecrawl_scrape");
    const out = (await tool.run(
      tool.input.parse({ url: "https://acme.com", formats: ["links"] }),
      fakeCtx({
        packId: "web",
        secrets: SECRETS,
        fetch: f as never,
        library: { save: save as never },
      }),
    )) as { artifact: unknown; links: string[] };
    expect(out.artifact).toBeNull();
    expect(out.links).toEqual(["https://a.com/x"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("firecrawl_search groups results", async () => {
    const f = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          web: [{ url: "https://a.com", title: "A" }],
          news: [],
          images: [{ url: "https://i/1.png" }],
        },
      }),
    );
    const tool = toolOf(webPack, "firecrawl_search");
    const out = (await tool.run(
      tool.input.parse({ query: "ops" }),
      fakeCtx({ packId: "web", secrets: SECRETS, fetch: f as never }),
    )) as { web: Array<{ url: string; description: unknown }>; images: unknown[] };
    expect(JSON.parse(String(call(f)[1].body))).toMatchObject({ query: "ops", limit: 10 });
    expect(out.web[0]).toEqual({ url: "https://a.com", title: "A", description: null });
    expect(out.images).toHaveLength(1);
  });

  it("firecrawl_map returns links and count", async () => {
    const f = vi.fn(async () =>
      jsonResponse({ success: true, links: ["https://a.com/1", "https://a.com/2"] }),
    );
    const tool = toolOf(webPack, "firecrawl_map");
    const out = await tool.run(
      tool.input.parse({ url: "https://a.com", search: "pricing" }),
      fakeCtx({ packId: "web", secrets: SECRETS, fetch: f as never }),
    );
    expect(out).toMatchObject({ count: 2 });
    expect(JSON.parse(String(call(f)[1].body))).toMatchObject({ search: "pricing", limit: 500 });
  });

  describe("firecrawl_crawl", () => {
    const crawlTool = () => toolOf(webPack, "firecrawl_crawl");

    it("submits, polls until completed and saves one combined artifact", async () => {
      const f = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, id: "job1" }))
        .mockResolvedValueOnce(jsonResponse({ status: "scraping" }))
        .mockResolvedValueOnce(
          jsonResponse({
            status: "completed",
            data: [
              {
                markdown: "page one",
                metadata: { sourceURL: "https://a.com/1", title: "One", statusCode: 200 },
              },
              { markdown: "", metadata: { sourceURL: "https://a.com/2" } },
            ],
          }),
        );
      const save = saveSpy();
      const out = (await crawlTool().run(
        crawlTool().input.parse({ url: "https://a.com", poll_interval_ms: 500 }),
        fakeCtx({
          packId: "web",
          secrets: SECRETS,
          fetch: f as never,
          library: { save: save as never },
        }),
      )) as { job_id: string; status: string; pages: number; artifact: { id: string } };
      expect(out).toMatchObject({
        job_id: "job1",
        status: "completed",
        pages: 2,
        artifact: { id: "md_1" },
      });
      expect(f).toHaveBeenCalledTimes(3);
      const saved = save.mock.calls[0]?.[0] as { bytes: Buffer };
      expect(saved.bytes.toString("utf8")).toContain("# One");
    });

    it("throws when the crawl fails", async () => {
      const f = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, id: "job2" }))
        .mockResolvedValueOnce(jsonResponse({ status: "failed", error: "blocked" }));
      await expect(
        crawlTool().run(
          crawlTool().input.parse({ url: "https://a.com" }),
          fakeCtx({ packId: "web", secrets: SECRETS, fetch: f as never }),
        ),
      ).rejects.toThrow(/firecrawl_crawl job job2 failed: blocked/);
    });

    it("stops polling when the signal aborts", async () => {
      const ac = new AbortController();
      const f = vi
        .fn()
        .mockImplementationOnce(async () => {
          ac.abort();
          return jsonResponse({ success: true, id: "job3" });
        })
        .mockResolvedValue(jsonResponse({ status: "scraping" }));
      const ctx = {
        ...fakeCtx({ packId: "web", secrets: SECRETS, fetch: f as never }),
        signal: ac.signal,
      };
      await expect(
        crawlTool().run(crawlTool().input.parse({ url: "https://a.com" }), ctx),
      ).rejects.toThrow();
      expect(f).toHaveBeenCalledTimes(1);
    });

    it("does not submit at all when the call is already cancelled", async () => {
      const f = vi.fn(async () => jsonResponse({ success: true, id: "j" }));
      const ac = new AbortController();
      ac.abort();
      const ctx = {
        ...fakeCtx({ packId: "web", secrets: SECRETS, fetch: f as never }),
        signal: ac.signal,
      };
      await expect(
        crawlTool().run(crawlTool().input.parse({ url: "https://a.com" }), ctx),
      ).rejects.toThrow();
      expect(f).not.toHaveBeenCalled();
    });

    it("an aborted poll wait ends promptly instead of sleeping out the interval", async () => {
      const ac = new AbortController();
      const f = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, id: "job4" }))
        .mockImplementationOnce(async () => {
          setTimeout(() => ac.abort(), 20);
          return jsonResponse({ status: "scraping" });
        });
      const ctx = {
        ...fakeCtx({ packId: "web", secrets: SECRETS, fetch: f as never }),
        signal: ac.signal,
      };
      const started = Date.now();
      await expect(
        crawlTool().run(
          crawlTool().input.parse({ url: "https://a.com", poll_interval_ms: 30_000 }),
          ctx,
        ),
      ).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("tolerates transient poll failures and finishes the crawl", async () => {
      Object.assign(crawlHooks, { pollRetryMs: 1, retryBaseMs: 1 });
      const down = () => Promise.reject(new TypeError("fetch failed"));
      const f = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, id: "job5" }))
        // one poll = up to 3 attempts of the free status GET; fail two whole polls
        .mockImplementationOnce(down)
        .mockImplementationOnce(down)
        .mockImplementationOnce(down)
        .mockImplementationOnce(down)
        .mockImplementationOnce(down)
        .mockImplementationOnce(down)
        .mockResolvedValueOnce(
          jsonResponse({ status: "completed", data: [{ markdown: "x", metadata: {} }] }),
        );
      const out = (await crawlTool().run(
        crawlTool().input.parse({ url: "https://a.com", poll_interval_ms: 500 }),
        fakeCtx({
          packId: "web",
          secrets: SECRETS,
          fetch: f as never,
          library: { save: saveSpy() as never },
        }),
      )) as { status: string };
      expect(out.status).toBe("completed");
      // exactly one submission
      expect(f.mock.calls.filter((c) => (c[1] as RequestInit).method === "POST")).toHaveLength(1);
    });

    it("on giving up, names the job id and says to resume instead of re-running", async () => {
      Object.assign(crawlHooks, { pollRetryMs: 1, retryBaseMs: 1 });
      const f = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ success: true, id: "job6" }))
        .mockRejectedValue(new TypeError("fetch failed"));
      const err = await failure(
        crawlTool().run(
          crawlTool().input.parse({ url: "https://a.com", poll_interval_ms: 500 }),
          fakeCtx({ packId: "web", secrets: SECRETS, fetch: f as never }),
        ),
      );
      expect(err.message).toMatch(/job6/);
      expect(err.message).toMatch(/do not run a new crawl/);
      expect(err.message).toMatch(/job_id "job6"/);
      expect(f.mock.calls.filter((c) => (c[1] as RequestInit).method === "POST")).toHaveLength(1);
    });

    it("resumes a submitted crawl by job_id without submitting again", async () => {
      const f = vi.fn(async () =>
        jsonResponse({ status: "completed", data: [{ markdown: "x", metadata: {} }] }),
      );
      const out = (await crawlTool().run(
        crawlTool().input.parse({ job_id: "job7" }),
        fakeCtx({
          packId: "web",
          secrets: SECRETS,
          fetch: f as never,
          library: { save: saveSpy() as never },
        }),
      )) as { job_id: string };
      expect(out.job_id).toBe("job7");
      expect(f).toHaveBeenCalledTimes(1);
      expect(call(f)[0]).toBe("https://api.firecrawl.dev/v2/crawl/job7");
      expect(call(f)[1].method).toBe("GET");
    });

    it("requires exactly one of url and job_id, and a safe job id", () => {
      expect(() => crawlTool().input.parse({})).toThrow();
      expect(() => crawlTool().input.parse({ url: "https://a.com", job_id: "j" })).toThrow();
      expect(() => crawlTool().input.parse({ job_id: "../../v1/team" })).toThrow();
    });
  });
});

describe("web pack via the loader", () => {
  it("loads all five tools; firecrawl tools report MISSING_SECRET", async () => {
    const h = await loadBuiltinPacks();
    try {
      for (const n of toolNames(webPack)) expect(h.registry.get(n)).toBeDefined();
      const res = await h.registry.call("firecrawl_map", { url: "https://a.com" });
      expect(res).toMatchObject({
        ok: false,
        error: { code: "MISSING_SECRET", pack: "web", secret: "FIRECRAWL_API_KEY" },
      });
    } finally {
      await h.close();
    }
  });
});
