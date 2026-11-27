import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeScreenshotTool } from "../../../packs/web/screenshot.js";
import { artifactRef, fakeCtx } from "../support.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function fakePlaywright(
  opts: { launchError?: Error; gotoError?: Error; hang?: boolean; noWebSockets?: boolean } = {},
) {
  let closed: (() => void) | null = null;
  const page = {
    goto: vi.fn(async () => {
      if (opts.gotoError) throw opts.gotoError;
      if (opts.hang) {
        await new Promise<void>((r) => {
          closed = r;
        });
        throw new Error("Target page, context or browser has been closed");
      }
    }),
    waitForSelector: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    screenshot: vi.fn(async () => PNG),
  };
  const context = {
    route: vi.fn(async (_pattern: unknown, _handler: unknown) => {}),
    ...(opts.noWebSockets ? {} : { routeWebSocket: vi.fn(async () => {}) }),
    newPage: vi.fn(async () => page),
  } as {
    route: ReturnType<typeof vi.fn>;
    routeWebSocket: ReturnType<typeof vi.fn>;
    newPage: ReturnType<typeof vi.fn>;
  };
  const browser = {
    newContext: vi.fn(async (_o: unknown) => context),
    close: vi.fn(async () => {
      closed?.();
    }),
  };
  const launch = vi.fn(async (_o?: unknown) => {
    if (opts.launchError) throw opts.launchError;
    return browser;
  });
  return { pw: { chromium: { launch } }, launch, browser, context, page };
}

const publicResolve = async () => ["93.184.216.34"];

function setup(fake: ReturnType<typeof fakePlaywright>, settings: Record<string, unknown> = {}) {
  const tool = makeScreenshotTool({ loadPlaywright: async () => fake.pw, resolve: publicResolve });
  const save = vi.fn(async (_a: unknown) => artifactRef("img_1"));
  const ctx = fakeCtx({ packId: "web", settings, library: { save: save as never } });
  return { tool, ctx, save };
}

describe("screenshot_url (fake browser)", () => {
  it("captures a public page, saves it and installs guards", async () => {
    const fake = fakePlaywright();
    const { tool, ctx, save } = setup(fake);
    const out = (await tool.run(tool.input.parse({ url: "https://example.com" }), ctx)) as {
      artifact: { id: string };
      blocked_requests: number;
    };
    expect(out).toEqual({
      artifact: expect.objectContaining({ id: "img_1" }),
      blocked_requests: 0,
    });
    expect(fake.context.route).toHaveBeenCalledTimes(1);
    expect(fake.context.routeWebSocket).toHaveBeenCalledTimes(1);
    expect(fake.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ serviceWorkers: "block", acceptDownloads: false }),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", mime: "image/png" }),
    );
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("refuses private, loopback and metadata targets before launching a browser", async () => {
    for (const url of [
      "http://127.0.0.1:8080/",
      "http://localhost/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
    ]) {
      const fake = fakePlaywright();
      const { tool, ctx } = setup(fake);
      // localhost resolves through the stub resolver to a public address; use a loopback resolver for it
      const t = url.includes("localhost")
        ? makeScreenshotTool({
            loadPlaywright: async () => fake.pw,
            resolve: async () => ["127.0.0.1"],
          })
        : tool;
      await expect(t.run(t.input.parse({ url }), ctx)).rejects.toThrow(/screenshot_url blocked/);
      expect(fake.launch).not.toHaveBeenCalled();
    }
  });

  it("allowLocalUrls opens loopback but never metadata", async () => {
    const fake = fakePlaywright();
    const { tool, ctx } = setup(fake, { allowLocalUrls: true });
    await tool.run(tool.input.parse({ url: "http://127.0.0.1:3000/" }), ctx);
    expect(fake.launch).toHaveBeenCalledTimes(1);
    await expect(
      tool.run(tool.input.parse({ url: "http://169.254.169.254/" }), ctx),
    ).rejects.toThrow(/always blocked/);
    expect(fake.launch).toHaveBeenCalledTimes(1);
  });

  // M2 -----------------------------------------------------------------------

  it("launches the browser behind the pinning proxy, loopback included", async () => {
    const fake = fakePlaywright();
    const { tool, ctx } = setup(fake);
    await tool.run(tool.input.parse({ url: "https://example.com" }), ctx);
    const arg = fake.launch.mock.calls[0]?.[0] as { proxy: { server: string; bypass: string } };
    expect(arg.proxy.server).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(arg.proxy.bypass).toBe("<-loopback>");
    // No traffic that skips the proxy: QUIC, WebRTC UDP, Chromium's own DNS.
    const args = (arg as unknown as { args: string[] }).args;
    expect(args).toContain("--disable-quic");
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(args.some((a) => a.startsWith("--host-resolver-rules=MAP * ~NOTFOUND"))).toBe(true);
    // The proxy is gone once the call is over.
    const port = Number(new URL(arg.proxy.server).port);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("never opens the daemon's own port, even with allowLocalUrls", async () => {
    const fake = fakePlaywright();
    const tool = makeScreenshotTool({ loadPlaywright: async () => fake.pw });
    const ctx = fakeCtx({
      packId: "web",
      settings: { allowLocalUrls: true },
      daemonPorts: [7794],
    });
    for (const url of ["http://127.0.0.1:7794/api/secrets", "http://[::1]:7794/"]) {
      await expect(tool.run(tool.input.parse({ url }), ctx)).rejects.toThrow(/daemon itself/);
    }
    expect(fake.launch).not.toHaveBeenCalled();
  });

  it("closes any popup the page opens (R4-M7)", async () => {
    const fake = fakePlaywright();
    const listeners: ((p: unknown) => void)[] = [];
    Object.assign(fake.context, {
      on: vi.fn((event: string, cb: (p: unknown) => void) => {
        if (event === "page") listeners.push(cb);
      }),
    });
    const popup = { close: vi.fn(async () => {}), frames: () => [] };
    fake.page.goto.mockImplementation(async () => {
      for (const cb of listeners) cb(popup);
    });
    const { tool, ctx } = setup(fake);
    await tool.run(tool.input.parse({ url: "https://example.com" }), ctx);
    expect(popup.close).toHaveBeenCalled();
  });

  it("fails closed when Playwright cannot intercept WebSockets", async () => {
    const fake = fakePlaywright({ noWebSockets: true });
    const { tool, ctx } = setup(fake);
    await expect(tool.run(tool.input.parse({ url: "https://example.com" }), ctx)).rejects.toThrow(
      /routeWebSocket/,
    );
    expect(fake.page.goto).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("gives up at the overall deadline and closes the browser", async () => {
    const fake = fakePlaywright({ hang: true });
    const tool = makeScreenshotTool({
      loadPlaywright: async () => fake.pw,
      resolve: publicResolve,
      deadlineMs: 40,
    });
    const ctx = fakeCtx({ packId: "web" });
    await expect(tool.run(tool.input.parse({ url: "https://example.com" }), ctx)).rejects.toThrow(
      /gave up after/,
    );
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("stops when the call is cancelled", async () => {
    const fake = fakePlaywright({ hang: true });
    const { tool } = setup(fake);
    const abort = new AbortController();
    const ctx = fakeCtx({ packId: "web", signal: abort.signal });
    const run = tool.run(tool.input.parse({ url: "https://example.com" }), ctx);
    setTimeout(() => abort.abort(), 20);
    await expect(run).rejects.toThrow(/cancelled/);
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("rejects non-http schemes at the input schema", () => {
    const { tool } = setup(fakePlaywright());
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)"]) {
      expect(tool.input.safeParse({ url }).success).toBe(false);
    }
  });

  it("bounds wait_for and the url length at the input schema (L6)", () => {
    const { tool } = setup(fakePlaywright());
    const url = "https://example.com/";
    expect(tool.input.safeParse({ url, wait_for: "#main" }).success).toBe(true);
    expect(tool.input.safeParse({ url, wait_for: "a".repeat(1024) }).success).toBe(true);
    expect(tool.input.safeParse({ url, wait_for: "a".repeat(1025) }).success).toBe(false);
    expect(tool.input.safeParse({ url, wait_for: "" }).success).toBe(false);
    expect(tool.input.safeParse({ url: `${url}?q=${"a".repeat(8200)}` }).success).toBe(false);
  });

  it("gives an install hint when Chromium is missing", async () => {
    const fake = fakePlaywright({
      launchError: new Error("browserType.launch: Executable doesn't exist at /x/chrome"),
    });
    const { tool, ctx } = setup(fake);
    await expect(tool.run(tool.input.parse({ url: "https://example.com" }), ctx)).rejects.toThrow(
      /npx playwright install chromium/,
    );
  });

  it("reports the block reason when a navigation was blocked", async () => {
    const fake = fakePlaywright({ gotoError: new Error("net::ERR_BLOCKED_BY_CLIENT") });
    // Simulate the guard recording a block during goto.
    fake.context.route.mockImplementation(async (_p: unknown, h: unknown) => {
      fake.page.goto.mockImplementation(async () => {
        const route = {
          request: () => ({ url: () => "http://10.0.0.1/" }),
          abort: async () => {},
          continue: async () => {},
        };
        await (h as (r: unknown) => Promise<void>)(route);
        throw new Error("net::ERR_BLOCKED_BY_CLIENT");
      });
    });
    const { tool, ctx } = setup(fake);
    await expect(tool.run(tool.input.parse({ url: "https://example.com" }), ctx)).rejects.toThrow(
      /screenshot_url blocked: .*10\.0\.0\.1/,
    );
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("explains a missing playwright package", async () => {
    const tool = makeScreenshotTool({
      loadPlaywright: async () => {
        throw new Error("Cannot find package 'playwright'");
      },
      resolve: publicResolve,
    });
    await expect(
      tool.run(tool.input.parse({ url: "https://example.com" }), fakeCtx({ packId: "web" })),
    ).rejects.toThrow(/playwright package is not installed/);
  });
});

// One real-Chromium test against a local server; skipped when Chromium cannot launch.
describe("screenshot_url (real Chromium, local server)", () => {
  let server: Server;
  let port = 0;
  let chromiumOk = false;
  let hits: string[] = [];
  let daemon: Server;
  let daemonPort = 0;
  let daemonHits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.setHeader("content-type", "text/html");
      if (req.url === "/page") {
        // Sub-resource request to the same local server: must also pass the guard.
        res.end('<html><body><h1>hello</h1><img src="/pixel.png"></body></html>');
      } else if (req.url === "/embeds") {
        // A local page that tries the daemon (image, iframe, fetch) and a name only the proxy knows.
        res.end(
          `<html><body><img src="http://127.0.0.1:${daemonPort}/api/secrets">` +
            `<iframe src="http://localhost:${daemonPort}/"></iframe>` +
            `<img src="http://pinned.invalid:${port}/via-proxy.png">` +
            `<script>fetch("http://127.0.0.1:${daemonPort}/api/packs").catch(()=>{})</script></body></html>`,
        );
      } else {
        res.statusCode = 200;
        res.end("ok");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    daemon = createServer((req, res) => {
      daemonHits.push(req.url ?? "");
      res.end("daemon");
    });
    await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
    daemonPort = (daemon.address() as AddressInfo).port;
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

  // M2: end to end through real Chromium and the pinning proxy.
  it("a local page cannot reach the daemon's port, and names are resolved by the proxy only", async (t) => {
    if (!chromiumOk) return t.skip();
    const tool = makeScreenshotTool({
      resolve: async (host) => {
        if (host === "pinned.invalid" || host === "localhost") return ["127.0.0.1"];
        throw new Error(`unexpected lookup of ${host}`);
      },
    });
    const save = vi.fn(async (_a: unknown) => artifactRef("img_m2"));
    hits = [];
    daemonHits = [];
    const out = (await tool.run(
      tool.input.parse({ url: `http://127.0.0.1:${port}/embeds`, delay_ms: 300 }),
      fakeCtx({
        packId: "web",
        settings: { allowLocalUrls: true },
        library: { save: save as never },
        daemonPorts: [daemonPort],
      }),
    )) as { blocked_requests: number };
    expect(hits).toContain("/embeds");
    // pinned.invalid exists in no DNS: the request arrived because the proxy connected to the checked address.
    expect(hits).toContain("/via-proxy.png");
    expect(daemonHits).toEqual([]);
    expect(out.blocked_requests).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("blocks the local server by default and captures it when allowLocalUrls is on", async (t) => {
    if (!chromiumOk) return t.skip();
    const tool = makeScreenshotTool();
    const save = vi.fn(async (_a: unknown) => artifactRef("img_real"));
    const url = `http://127.0.0.1:${port}/page`;

    hits = [];
    await expect(
      tool.run(
        tool.input.parse({ url }),
        fakeCtx({ packId: "web", library: { save: save as never } }),
      ),
    ).rejects.toThrow(/screenshot_url blocked/);
    expect(hits).toEqual([]);

    const out = (await tool.run(
      tool.input.parse({ url, viewport: { width: 400, height: 300 } }),
      fakeCtx({
        packId: "web",
        settings: { allowLocalUrls: true },
        library: { save: save as never },
      }),
    )) as { artifact: { id: string } };
    expect(out.artifact.id).toBe("img_real");
    const saved = save.mock.calls[0]?.[0] as { bytes: Uint8Array; mime: string };
    expect(saved.mime).toBe("image/png");
    expect(Buffer.from(saved.bytes).subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(hits).toContain("/page");
  }, 60_000);
});
