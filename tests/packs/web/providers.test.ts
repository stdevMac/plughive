// The web pack's capability providers: firecrawl (web.search, web.fetch) and
// the local browser (web.fetch). Request shape, output normalization, and
// retryable refusals versus final errors once a paid request was sent.
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PackContext } from "plughive/pack";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  firecrawlProviderHooks,
  makeProviders,
  providers,
} from "../../../packs/web/capabilities.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import { routerFetch } from "../provider-support.js";
import { fakeCtx, jsonResponse } from "../support.js";

firecrawlProviderHooks.retryBaseMs = 1;

type Cap = "web.search" | "web.fetch";
type Runnable = {
  id: string;
  priority?: number;
  isConfigured(ctx: PackContext): boolean | Promise<boolean>;
  run(input: unknown, ctx: PackContext): Promise<unknown>;
};
type Failure = {
  name?: string;
  retryable?: boolean;
  code?: string;
  message?: string;
  mayHaveCharged?: boolean;
};

const UNSUPPORTED = { name: "CapabilityError", retryable: true, code: "UNSUPPORTED_OPTION" };
const KEY = "fc-test-not-real";

function pick(list: readonly unknown[], cap: Cap, id: string): Runnable {
  const p = (list as { capability: string; id: string }[]).find(
    (x) => x.capability === cap && x.id === id,
  );
  if (!p) throw new Error(`no ${cap}:${id}`);
  return p as unknown as Runnable;
}

async function call(p: Runnable, cap: Cap, input: unknown, ctx: PackContext) {
  const out = await p.run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx);
  return CAPABILITY_SCHEMAS[cap].output.parse(out) as Record<string, unknown>;
}

async function failure(p: Runnable, cap: Cap, input: unknown, ctx: PackContext) {
  return (await p
    .run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx)
    .catch((e: unknown) => e)) as Failure;
}

const ctxWith = (
  fetch: PackContext["fetch"],
  secrets: Record<string, string> = { FIRECRAWL_API_KEY: KEY },
) => fakeCtx({ packId: "web", secrets, fetch });

const posted = (fetch: ReturnType<typeof routerFetch>) => {
  const post = fetch.calls.find((c) => c.method === "POST");
  if (!post?.body) throw new Error("no POST");
  return JSON.parse(post.body);
};

describe("web providers", () => {
  it("firecrawl serves web.search and web.fetch at 40, the browser web.fetch at 10", () => {
    expect(providers.map((p) => `${p.capability}:${p.id}:${p.priority}`).sort()).toEqual([
      "web.fetch:browser:10",
      "web.fetch:firecrawl:40",
      "web.search:firecrawl:40",
    ]);
  });

  it("firecrawl is configured exactly when FIRECRAWL_API_KEY is set", async () => {
    const p = pick(providers, "web.search", "firecrawl");
    expect(await p.isConfigured(ctxWith(routerFetch([]), {}))).toBe(false);
    expect(await p.isConfigured(ctxWith(routerFetch([])))).toBe(true);
  });
});

describe("firecrawl web.search", () => {
  const p = pick(providers, "web.search", "firecrawl");
  const route = (reply: () => Response) => ({
    match: /^POST https:\/\/api\.firecrawl\.dev\/v2\/search$/,
    reply,
  });

  it("posts the documented body and maps data.web to results", async () => {
    const fetch = routerFetch([
      route(() =>
        jsonResponse({
          success: true,
          data: {
            web: [
              { url: "https://a.example/x", title: "A", description: "about a" },
              { url: "https://b.example/y" },
              { title: "no url" },
            ],
          },
          creditsUsed: 2,
        }),
      ),
    ]);
    const out = await call(
      p,
      "web.search",
      {
        query: "mcp servers",
        max_results: 5,
        recency: "week",
        country: "de",
        include_domains: ["a.example"],
      },
      ctxWith(fetch),
    );
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(posted(fetch)).toEqual({
      query: "mcp servers",
      limit: 5,
      sources: ["web"],
      tbs: "qdr:w",
      country: "DE",
      includeDomains: ["a.example"],
    });
    expect(out).toEqual({
      results: [
        { title: "A", url: "https://a.example/x", snippet: "about a" },
        { title: "https://b.example/y", url: "https://b.example/y" },
      ],
      provider: "firecrawl",
      credits_used: 2,
      cost_usd: 0.00166,
      cost_estimated: true,
    });
  });

  it("refuses what Firecrawl cannot do, before any request", async () => {
    const fetch = routerFetch([]);
    const ctx = ctxWith(fetch);
    expect(await failure(p, "web.search", { query: "x", model: "sonar" }, ctx)).toMatchObject(
      UNSUPPORTED,
    );
    expect(await failure(p, "web.search", { query: "x".repeat(501) }, ctx)).toMatchObject(
      UNSUPPORTED,
    );
    expect(
      await failure(
        p,
        "web.search",
        { query: "x", include_domains: ["a.com"], exclude_domains: ["b.com"] },
        ctx,
      ),
    ).toMatchObject(UNSUPPORTED);
    expect(fetch.calls).toHaveLength(0);
  });

  it("a refused request (401, 402, 429 without Retry-After) is retryable", async () => {
    for (const status of [401, 402, 429]) {
      const fetch = routerFetch([
        route(() => jsonResponse({ success: false, error: "nope" }, status)),
      ]);
      const err = await failure(p, "web.search", { query: "x" }, ctxWith(fetch));
      expect(err).toMatchObject({ name: "CapabilityError", retryable: true });
    }
  });

  it("a 5xx after the request was sent is final and says it may have been billed", async () => {
    const fetch = routerFetch([route(() => jsonResponse({ error: "boom" }, 502))]);
    const err = await failure(p, "web.search", { query: "x" }, ctxWith(fetch));
    expect(err.name).not.toBe("CapabilityError");
    expect(err.mayHaveCharged).toBe(true);
    expect(err.retryable).toBe(false);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("firecrawl web.fetch", () => {
  const p = pick(providers, "web.fetch", "firecrawl");
  const route = (reply: () => Response) => ({
    match: /^POST https:\/\/api\.firecrawl\.dev\/v2\/scrape$/,
    reply,
  });

  it("scrapes markdown (main content) and cuts it to max_chars", async () => {
    const md = `# Title\n\n${"word ".repeat(100)}`;
    const fetch = routerFetch([
      route(() =>
        jsonResponse({
          success: true,
          data: {
            markdown: md,
            metadata: { title: "Title", sourceURL: "https://e.example/p", statusCode: 200 },
          },
        }),
      ),
    ]);
    const out = await call(
      p,
      "web.fetch",
      { url: "https://e.example/p", max_chars: 100 },
      ctxWith(fetch),
    );
    expect(posted(fetch)).toEqual({
      url: "https://e.example/p",
      formats: ["markdown"],
      onlyMainContent: true,
    });
    expect(out).toEqual({
      url: "https://e.example/p",
      title: "Title",
      content: md.slice(0, 100),
      format: "markdown",
      truncated: true,
      provider: "firecrawl",
      credits_used: 1,
      cost_usd: 0.00083,
      cost_estimated: true,
    });
  });

  it("asks for the whole html when format is html", async () => {
    const fetch = routerFetch([
      route(() => jsonResponse({ success: true, data: { html: "<p>hi</p>", metadata: {} } })),
    ]);
    const out = await call(
      p,
      "web.fetch",
      { url: "https://e.example/", format: "html" },
      ctxWith(fetch),
    );
    expect(posted(fetch)).toEqual({
      url: "https://e.example/",
      formats: ["html"],
      onlyMainContent: false,
    });
    expect(out).toMatchObject({ content: "<p>hi</p>", format: "html", url: "https://e.example/" });
    expect(out.truncated).toBeUndefined();
  });

  it("refuses plain text and a model before any request", async () => {
    const fetch = routerFetch([]);
    expect(
      await failure(p, "web.fetch", { url: "https://e.example/", format: "text" }, ctxWith(fetch)),
    ).toMatchObject(UNSUPPORTED);
    expect(
      await failure(p, "web.fetch", { url: "https://e.example/", model: "x" }, ctxWith(fetch)),
    ).toMatchObject(UNSUPPORTED);
    expect(fetch.calls).toHaveLength(0);
  });

  it("an accepted scrape without content, or with success false, is final", async () => {
    for (const body of [
      { success: true, data: { metadata: {} } },
      { success: false, error: "blocked site" },
    ]) {
      const fetch = routerFetch([route(() => jsonResponse(body))]);
      const err = await failure(p, "web.fetch", { url: "https://e.example/" }, ctxWith(fetch));
      expect(err).toBeInstanceOf(Error);
      expect(err.name).not.toBe("CapabilityError");
      expect(err.retryable).not.toBe(true);
    }
  });
});

// --- browser ------------------------------------------------------------------------------

function fakePlaywright(
  page: { html?: string; text?: string; title?: string; status?: number; url?: string } = {},
) {
  const pg = {
    goto: vi.fn(async () => ({ status: () => page.status ?? 200 })),
    waitForLoadState: vi.fn(async () => {}),
    content: vi.fn(async () => page.html ?? "<html><body><p>Hello</p></body></html>"),
    evaluate: vi.fn(async () => page.text ?? "Hello"),
    title: vi.fn(async () => page.title ?? "Hi"),
    url: vi.fn(() => page.url ?? "https://example.com/"),
  };
  const context = {
    route: vi.fn(async () => {}),
    routeWebSocket: vi.fn(async () => {}),
    newPage: vi.fn(async () => pg),
  };
  const browser = {
    newContext: vi.fn(async (_o: unknown) => context),
    close: vi.fn(async () => {}),
  };
  const launch = vi.fn(async (_o?: unknown) => browser);
  return { pw: { chromium: { launch } }, launch, browser, context, page: pg };
}

const publicResolve = async () => ["93.184.216.34"];

function browserProvider(load: () => Promise<unknown>) {
  return pick(
    makeProviders({ loadPlaywright: load, resolve: publicResolve }),
    "web.fetch",
    "browser",
  );
}

describe("browser web.fetch", () => {
  const ctx = fakeCtx({ packId: "web" });

  it("returns the visible text behind the SSRF guards, and answers markdown requests as text", async () => {
    const fake = fakePlaywright({ text: "Hello world", title: "Example" });
    const p = browserProvider(async () => fake.pw);
    const out = await call(p, "web.fetch", { url: "https://example.com/" }, ctx);
    expect(out).toEqual({
      url: "https://example.com/",
      title: "Example",
      content: "Hello world",
      format: "text",
      provider: "browser",
    });
    const launchOpts = fake.launch.mock.calls[0]![0] as { proxy: { server: string } };
    expect(launchOpts.proxy.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(fake.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ serviceWorkers: "block", acceptDownloads: false }),
    );
    expect(fake.context.route).toHaveBeenCalledTimes(1);
    expect(fake.context.routeWebSocket).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("returns the rendered html as is and truncates to max_chars", async () => {
    const html = `<html><body>${"x".repeat(500)}</body></html>`;
    const fake = fakePlaywright({ html });
    const p = browserProvider(async () => fake.pw);
    const out = await call(
      p,
      "web.fetch",
      { url: "https://example.com/", format: "html", max_chars: 100 },
      ctx,
    );
    expect(out).toMatchObject({ content: html.slice(0, 100), format: "html", truncated: true });
    expect(fake.page.evaluate).not.toHaveBeenCalled();
  });

  it("refuses a local address before launching a browser", async () => {
    const fake = fakePlaywright();
    const p = pick(
      makeProviders({ loadPlaywright: async () => fake.pw, resolve: async () => ["127.0.0.1"] }),
      "web.fetch",
      "browser",
    );
    const err = await failure(p, "web.fetch", { url: "http://localhost:3000/" }, ctx);
    expect(err.message).toMatch(/blocked/);
    expect(err.retryable).not.toBe(true);
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it("an error page is an error", async () => {
    const fake = fakePlaywright({ status: 404 });
    const err = await failure(
      browserProvider(async () => fake.pw),
      "web.fetch",
      { url: "https://example.com/" },
      ctx,
    );
    expect(err.message).toMatch(/HTTP 404/);
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("without Playwright it is not configured and refuses with a retryable install hint", async () => {
    const p = browserProvider(async () => {
      throw new Error("Cannot find package 'playwright'");
    });
    expect(await p.isConfigured(ctx)).toBe(false);
    const err = await failure(p, "web.fetch", { url: "https://example.com/" }, ctx);
    expect(err).toMatchObject({ name: "CapabilityError", retryable: true, code: "NOT_CONFIGURED" });
    expect(err.message).toMatch(/npx playwright install chromium/);
  });

  it("a missing Chromium is a retryable install hint too", async () => {
    const fake = fakePlaywright();
    fake.launch.mockRejectedValueOnce(
      new Error("browserType.launch: Executable doesn't exist at /x"),
    );
    const p = browserProvider(async () => fake.pw);
    expect(await p.isConfigured(ctx)).toBe(true);
    const err = await failure(p, "web.fetch", { url: "https://example.com/" }, ctx);
    expect(err).toMatchObject({ name: "CapabilityError", retryable: true, code: "NOT_CONFIGURED" });
  });

  it("a model choice is refused before anything starts", async () => {
    const fake = fakePlaywright();
    const err = await failure(
      browserProvider(async () => fake.pw),
      "web.fetch",
      { url: "https://example.com/", model: "x" },
      ctx,
    );
    expect(err).toMatchObject(UNSUPPORTED);
    expect(fake.launch).not.toHaveBeenCalled();
  });
});

// One real-Chromium check against a local server; skipped when Chromium cannot launch.
describe("browser web.fetch (real Chromium, local server)", () => {
  let server: Server;
  let port = 0;
  let daemon: Server;
  let daemonPort = 0;
  let daemonHits: string[] = [];
  let chromiumOk = false;

  beforeAll(async () => {
    daemon = createServer((req, res) => {
      daemonHits.push(req.url ?? "");
      res.end("daemon");
    });
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
    daemonPort = (daemon.address() as AddressInfo).port;
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<html><head><title>Local page</title></head><body><h1>Hello</h1><p>from the test</p>
          <img src="http://127.0.0.1:${daemonPort}/api/secrets"></body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    try {
      const { chromium } = await import("playwright");
      const b = await chromium.launch({ headless: true });
      await b.close();
      chromiumOk = true;
    } catch {
      chromiumOk = false;
    }
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => daemon.close(() => r()));
  });

  it("is blocked by default; with allowLocalUrls it reads the page but never the daemon's port", async (t) => {
    if (!chromiumOk) return t.skip();
    const p = pick(providers, "web.fetch", "browser");
    const url = `http://127.0.0.1:${port}/`;
    const blockedErr = await failure(
      p,
      "web.fetch",
      { url },
      fakeCtx({ packId: "web", daemonPorts: [daemonPort] }),
    );
    expect(blockedErr.message).toMatch(/blocked/);

    daemonHits = [];
    const local = fakeCtx({
      packId: "web",
      settings: { allowLocalUrls: true },
      daemonPorts: [daemonPort],
    });
    const text = await call(p, "web.fetch", { url, format: "text" }, local);
    expect(text).toMatchObject({ url, title: "Local page", format: "text", provider: "browser" });
    expect(String(text.content)).toMatch(/Hello\s+from the test/);
    const html = await call(p, "web.fetch", { url, format: "html" }, local);
    expect(String(html.content)).toContain("<h1>Hello</h1>");
    expect(daemonHits).toEqual([]);
  }, 60_000);
});
