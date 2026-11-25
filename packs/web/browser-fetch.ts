// packs/web/browser-fetch.ts
//
// web.fetch with the local headless Chromium (Playwright): the free, last
// resort provider (priority 10). It runs behind the same SSRF guards as
// screenshot_url (see screenshot.ts): the typed URL is checked before a
// browser starts, the browser goes through the address-pinning proxy, every
// request and WebSocket passes the route guards, service workers and
// downloads are off, and the whole call has one deadline. Local addresses
// follow the pack's allowLocalUrls setting, exactly as for screenshots.
//
// Output: html is the rendered document as is (page.content()). No
// HTML-to-markdown converter is a dependency, so text and markdown requests
// both return the page's visible text (document.body.innerText), and a
// markdown request says so by answering with format "text".
import { CapabilityError, type PackContext } from "plughive/pack";
import { startPinProxy } from "./pin-proxy.js";
import {
  GUARDED_LAUNCH_ARGS,
  gateConnection,
  installError,
  installGuards,
  makeGate,
} from "./screenshot.js";
import { type Resolver, type UrlPolicy, checkUrl } from "./ssrf.js";

export const BROWSER_PROVIDER_ID = "browser";
export const BROWSER_PRIORITY = 10;
export const BROWSER_SETUP_HINT =
  "install Playwright and Chromium: pnpm add playwright && npx playwright install chromium";
/** Longest a whole fetch may take. */
export const BROWSER_FETCH_DEADLINE_MS = 60_000;
const DEFAULT_MAX_CHARS = 100_000;

// biome-ignore lint/suspicious/noExplicitAny: Playwright module shape, loaded lazily
type PlaywrightModule = any;

export interface BrowserFetchDeps {
  loadPlaywright?: () => Promise<PlaywrightModule>;
  /** DNS resolver for the SSRF check (tests). */
  resolve?: Resolver;
  /** Overall deadline in ms (tests). Default BROWSER_FETCH_DEADLINE_MS. */
  deadlineMs?: number;
}

export interface BrowserFetchInput {
  url: string;
  format?: "markdown" | "text" | "html";
  max_chars?: number;
  model?: string;
}

export interface BrowserFetchOutput {
  url: string;
  title?: string;
  content: string;
  format: "text" | "html";
  truncated?: boolean;
  provider: typeof BROWSER_PROVIDER_ID;
}

const defaultLoad = (): Promise<PlaywrightModule> => import("playwright");

function notInstalled(detail: string): CapabilityError {
  return new CapabilityError(
    `The local browser cannot fetch pages: ${detail}. Install it with: pnpm add playwright && npx playwright install chromium`,
    { retryable: true, code: "NOT_CONFIGURED" },
  );
}

/** True when the playwright package can be imported (checked once per loader). */
export function playwrightAvailable(deps: BrowserFetchDeps = {}): () => Promise<boolean> {
  let known: Promise<boolean> | null = null;
  return () => {
    known ??= (deps.loadPlaywright ?? defaultLoad)().then(
      () => true,
      () => false,
    );
    return known;
  };
}

export async function browserFetch(
  input: BrowserFetchInput,
  ctx: PackContext,
  deps: BrowserFetchDeps = {},
): Promise<BrowserFetchOutput> {
  if (input.model) {
    throw new CapabilityError(
      `The local browser has no model choice ("${input.model.slice(0, 64)}").`,
      {
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      },
    );
  }
  const policy: UrlPolicy = {
    allowLocal: ctx.settings.allowLocalUrls === true,
    resolve: deps.resolve,
    daemonPorts: ctx.pack.daemonPorts ?? [],
  };
  // Refuse before launching a browser at all.
  const first = await checkUrl(input.url, policy, { topLevel: true });
  if (!first.ok) throw new Error(`web.fetch blocked: ${first.reason}`);

  let pw: PlaywrightModule;
  try {
    pw = await (deps.loadPlaywright ?? defaultLoad)();
  } catch (e) {
    throw notInstalled(
      `the playwright package is not installed (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  const gate = makeGate(policy, first.local);
  const blocked = gate.blocked;
  const proxy = await startPinProxy((url) => gateConnection(gate, url));

  let browser: PlaywrightModule;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: GUARDED_LAUNCH_ARGS,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
    });
  } catch (e) {
    await proxy.close();
    const missing = installError(e);
    if (missing) throw notInstalled(missing.message);
    throw e;
  }

  const budget = deps.deadlineMs ?? BROWSER_FETCH_DEADLINE_MS;
  let expired: Error | null = null;
  const stop = (why: string) => () => {
    expired = new Error(why);
    void browser.close().catch(() => {});
  };
  const onTime = stop(`web.fetch gave up after ${Math.round(budget / 1000)} s`);
  const onAbort = stop("web.fetch was cancelled");
  const timer = setTimeout(onTime, budget);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();

  try {
    const browserCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await installGuards(browserCtx, gate);
    const page = await browserCtx.newPage();

    let response: { status(): number } | null;
    try {
      response = await page.goto(input.url, { waitUntil: "load", timeout: 30_000 });
    } catch (e) {
      const hit = blocked[0];
      if (hit) throw new Error(`web.fetch blocked: ${hit.reason}`);
      throw e;
    }
    const status = response?.status();
    if (status !== undefined && status >= 400) {
      throw new Error(`web.fetch: ${input.url} answered HTTP ${status}`);
    }
    // Give script-rendered pages a moment; a page that never goes idle is read as it is.
    await page.waitForLoadState?.("networkidle", { timeout: 5_000 }).catch(() => {});

    const format = input.format === "html" ? "html" : "text";
    const raw: unknown =
      format === "html"
        ? await page.content()
        : await page.evaluate(() => {
            const doc = (globalThis as { document?: { body?: { innerText?: string } | null } })
              .document;
            return doc?.body?.innerText ?? "";
          });
    const content = typeof raw === "string" ? raw : "";
    const title: unknown = await page.title().catch(() => "");
    const finalUrl: unknown = page.url();
    const max = input.max_chars ?? DEFAULT_MAX_CHARS;
    const truncated = content.length > max;
    ctx.logger.info("browser fetched", {
      url: input.url,
      chars: content.length,
      blocked: blocked.length,
    });
    return {
      url: typeof finalUrl === "string" && /^https?:/i.test(finalUrl) ? finalUrl : input.url,
      ...(typeof title === "string" && title ? { title } : {}),
      content: truncated ? content.slice(0, max) : content,
      format,
      ...(truncated ? { truncated: true } : {}),
      provider: BROWSER_PROVIDER_ID,
    };
  } catch (e) {
    throw expired ?? e;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
    await proxy.close();
  }
}
