// packs/web/screenshot.ts
//
// screenshot_url: capture a page with headless Chromium (Playwright).
//
// SSRF: the browser opens its own sockets, so `ctx.fetch` does not protect it.
// Two layers, sharing one policy (`Gate`):
//  - The browser is launched behind the local proxy in pin-proxy.ts. It
//    resolves no names itself; the proxy checks each target and connects to
//    the address it checked, so a DNS answer cannot change between the check
//    and the connection (rebinding). Loopback is not exempt from the proxy.
//  - A context-level route handler sees every request with its frame, refuses
//    blocked ones early with a readable reason, and decides whether local
//    addresses are in play at all.
// Local addresses (only with the `allowLocalUrls` setting): reachable when the
// URL the caller typed is itself local, and then only from documents that are
// themselves local. A public page, or a public frame inside a local page, can
// never reach a local address, by redirect, iframe or sub-resource.
// The daemon's own port is refused always. WebSockets follow the same rules;
// a Playwright without `routeWebSocket` is refused rather than left unguarded.
// Service workers are disabled so no worker makes requests the route handler
// never sees. The whole call has one deadline.
import { type PackContext, defineTool, z } from "plughive/pack";
import { type PinDecision, startPinProxy } from "./pin-proxy.js";
import { type Resolver, type UrlPolicy, type Verdict, checkUrl } from "./ssrf.js";

// Minimal structural types for the parts of Playwright used here, so this file
// does not depend on Playwright's own typings.
interface PwFrame {
  url(): string;
  parentFrame(): PwFrame | null;
}
interface PwRequest {
  url(): string;
  isNavigationRequest?(): boolean;
  frame?(): PwFrame;
}
interface PwRoute {
  request(): PwRequest;
  abort(code?: string): Promise<void>;
  continue(): Promise<void>;
}
interface PwWebSocketRoute {
  url(): string;
  close(opts?: { code?: number; reason?: string }): Promise<void>;
  connectToServer(): unknown;
}
interface PwPage {
  frames(): PwFrame[];
  on?(event: "framenavigated", cb: (frame: PwFrame) => void): unknown;
}
export interface PwContext {
  pages?(): PwPage[];
  on?(event: "page", cb: (page: PwPage) => void): unknown;
  route(url: string | RegExp, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  routeWebSocket?(
    url: string | RegExp,
    handler: (ws: PwWebSocketRoute) => Promise<void> | void,
  ): Promise<void>;
}

export interface BlockedRequest {
  url: string;
  reason: string;
}

/**
 * The policy for one screenshot. `localTop` says whether the top-level
 * document is local: it starts as "the typed URL is local" and can only turn
 * off (a navigation of the main frame to a public page). `publicFrame` turns
 * on once any frame has loaded a public page: from then on, requests that
 * cannot be traced to a frame (WebSockets, workers) may be that page's, so they
 * no longer get the local top-level allowance.
 */
export interface Gate {
  policy: UrlPolicy;
  localTop: boolean;
  publicFrame: boolean;
  /**
   * Where the route handler let a local navigation through, as "host:port"
   * (see `hostKey`): the same key for a page URL and for the proxy's CONNECT
   * target, which carries no scheme.
   */
  localOrigins: Set<string>;
  /**
   * Every local "host:port" the route handler or the WebSocket guard let
   * through. The proxy connects to a local address only for these: a redirect
   * is followed without the route handler seeing it, so a public resource that
   * redirects to a LAN host never reaches it.
   */
  localTargets: Set<string>;
  blocked: BlockedRequest[];
}

export function makeGate(policy: UrlPolicy, typedIsLocal: boolean): Gate {
  return {
    policy,
    localTop: policy.allowLocal && typedIsLocal,
    publicFrame: false,
    localOrigins: new Set(),
    localTargets: new Set(),
    blocked: [],
  };
}

/** May a request that has no frame to attribute it to reach a local address? */
function untracedMayBeLocal(gate: Gate): boolean {
  return gate.policy.allowLocal && gate.localTop && !gate.publicFrame;
}

/**
 * Extra Chromium flags for every guarded launch: no QUIC or WebRTC UDP (they
 * would leave outside the pinning proxy), and no DNS of Chromium's own (every
 * name is resolved by the proxy, after the policy check).
 */
export const GUARDED_LAUNCH_ARGS = [
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
];

/** "host:port" with the scheme's default port filled in, or null for non-http(s) URLs. */
export function hostKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

const NOT_FROM_PUBLIC = "local addresses are reachable only from a local page the caller opened";

function frameOf(req: PwRequest): PwFrame | null {
  try {
    return typeof req.frame === "function" ? req.frame() : null;
  } catch {
    return null; // a request with no frame (a worker)
  }
}

/** Is the document that issued this request itself on a local address? */
async function issuerIsLocal(gate: Gate, req: PwRequest): Promise<boolean> {
  if (!gate.localTop) return false;
  const navigation = typeof req.isNavigationRequest === "function" && req.isNavigationRequest();
  let frame = frameOf(req);
  // A request with no frame (a worker, a service worker) cannot be traced.
  if (!frame) return untracedMayBeLocal(gate);
  // A frame being navigated is issued by its parent; the main frame by the caller.
  if (navigation) frame = frame.parentFrame();
  for (let hops = 0; frame && hops < 32; hops++) {
    const url = frame.url();
    if (/^https?:/i.test(url)) {
      // Decided from what was let through as local, not a fresh DNS answer.
      const key = hostKey(url);
      return key !== null && gate.localOrigins.has(key);
    }
    frame = frame.parentFrame(); // about:blank, srcdoc, data: inherit from the parent
  }
  return gate.localTop;
}

/**
 * Classify a URL a frame has committed. A local URL that redirects to a public
 * page is seen by the route handler only as its first hop, so the committed
 * URLs also decide `publicFrame` / `localTop`. Local means "an origin the route
 * handler let through as a local navigation"; nothing is resolved again (a
 * fresh DNS answer could differ). about:blank / srcdoc inherit and are skipped;
 * blob: is judged by its inner origin; data: and any other scheme count as
 * public (fail closed).
 */
function noteCommitted(gate: Gate, url: string, isMain: boolean): void {
  if (/^about:/i.test(url)) return;
  const key = hostKey(/^blob:/i.test(url) ? url.slice(5) : url);
  if (key !== null && gate.localOrigins.has(key)) return;
  gate.publicFrame = true;
  if (isMain) gate.localTop = false;
}

/** Re-read every frame's committed URL (a backstop for the framenavigated events). */
function notePublicFrames(context: PwContext, gate: Gate): void {
  if (!untracedMayBeLocal(gate) || typeof context.pages !== "function") return;
  for (const page of context.pages()) {
    for (const frame of page.frames())
      noteCommitted(gate, frame.url(), frame.parentFrame() === null);
  }
}

/** Verdict for one browser request, applying the "local only from local" rule. */
async function gateRequest(gate: Gate, req: PwRequest): Promise<Verdict> {
  const open = await checkUrl(req.url(), { ...gate.policy, allowLocal: true });
  if (!open.ok) return open;
  const navigation = typeof req.isNavigationRequest === "function" && req.isNavigationRequest();
  const frame = frameOf(req);
  const mainNavigation = navigation && frame !== null && frame.parentFrame() === null;
  if (open.local) {
    if (!gate.policy.allowLocal) return checkUrl(req.url(), gate.policy);
    if (!(await issuerIsLocal(gate, req))) return { ok: false, reason: NOT_FROM_PUBLIC };
    const target = hostKey(req.url());
    if (target !== null) gate.localTargets.add(target);
  }
  if (navigation && open.local) {
    const key = hostKey(req.url());
    if (key !== null) gate.localOrigins.add(key);
  }
  if (navigation && !open.local) gate.publicFrame = true;
  if (mainNavigation && !open.local) gate.localTop = false;
  return open;
}

/** The proxy's verdict: same policy, and the address the connection is pinned to. */
export async function gateConnection(gate: Gate, url: string): Promise<PinDecision> {
  const verdict = await checkUrl(url, {
    ...gate.policy,
    allowLocal: gate.policy.allowLocal && gate.localTop,
  });
  if (!verdict.ok) {
    gate.blocked.push({ url, reason: verdict.reason });
    return verdict;
  }
  const address = verdict.addresses[0];
  if (address === undefined) return { ok: false, reason: "the URL has no network address" };
  const key = hostKey(url);
  if (
    verdict.local &&
    (key === null || !(gate.localTargets.has(key) || gate.localOrigins.has(key)))
  ) {
    const reason = "a local address the page did not request directly (a redirect) is blocked";
    gate.blocked.push({ url, reason });
    return { ok: false, reason };
  }
  // A host let through as local that now connects to a public address (a
  // rebinding answer) ends the local allowance for the rest of the capture.
  if (!verdict.local) {
    if (key !== null && gate.localOrigins.has(key)) {
      gate.localOrigins.clear();
      gate.localTargets.clear();
      gate.publicFrame = true;
      gate.localTop = false;
    }
  }
  return { ok: true, address };
}

/** Install the request guards on a browser context. Blocked requests land in `gate.blocked`. */
export async function installGuards(context: PwContext, gate: Gate): Promise<BlockedRequest[]> {
  if (typeof context.routeWebSocket !== "function") {
    throw new Error(
      "screenshot_url needs a Playwright that can intercept WebSockets (routeWebSocket, 1.48 or later). Update it: pnpm add playwright@latest && npx playwright install chromium",
    );
  }
  const blocked = gate.blocked;

  // Every frame commit is classified as it happens, so a frame that later
  // navigates itself to data: or blob: has already been counted.
  const watch = (page: PwPage) =>
    page.on?.("framenavigated", (frame) =>
      noteCommitted(gate, frame.url(), frame.parentFrame() === null),
    );
  if (typeof context.on === "function") context.on("page", watch);
  if (typeof context.pages === "function") for (const page of context.pages()) watch(page);

  await context.route("**/*", async (route) => {
    const req = route.request();
    if (frameOf(req) === null) notePublicFrames(context, gate);
    const verdict = await gateRequest(gate, req);
    if (!verdict.ok) {
      blocked.push({ url: req.url(), reason: verdict.reason });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  await context.routeWebSocket(/.*/, async (ws) => {
    // ws:// and wss:// follow the same rules as http:// and https://. A socket
    // has no frame to attribute it to: it may reach a local address only while
    // every page loaded so far is local.
    notePublicFrames(context, gate);
    const asHttp = ws.url().replace(/^ws(s?):/i, "http$1:");
    const verdict = await checkUrl(asHttp, {
      ...gate.policy,
      allowLocal: untracedMayBeLocal(gate),
    });
    if (!verdict.ok) {
      blocked.push({ url: ws.url(), reason: verdict.reason });
      await ws.close({ code: 1008, reason: "blocked" });
      return;
    }
    const target = hostKey(asHttp);
    if (verdict.local && target !== null) gate.localTargets.add(target);
    ws.connectToServer();
  });
  return blocked;
}

/** Longest a whole screenshot_url call may take, on top of the caller's own delay_ms. */
export const SCREENSHOT_DEADLINE_MS = 90_000;

const MISSING_BROWSER =
  "Chromium is not installed for Playwright. Install it once with: npx playwright install chromium";

/** A launch failure that means Chromium is missing, as an install hint; else null. */
export function installError(e: unknown): Error | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Executable doesn't exist|playwright install|browserType\.launch.*install/i.test(msg)) {
    return new Error(MISSING_BROWSER);
  }
  return null;
}

// biome-ignore lint/suspicious/noExplicitAny: Playwright module shape, loaded lazily
type PlaywrightModule = any;

export interface ScreenshotDeps {
  loadPlaywright?: () => Promise<PlaywrightModule>;
  /** DNS resolver for the SSRF check (tests). */
  resolve?: Resolver;
  /** Overall deadline in ms (tests). Default SCREENSHOT_DEADLINE_MS. */
  deadlineMs?: number;
}

const defaultLoad = (): Promise<PlaywrightModule> => import("playwright");

export function makeScreenshotTool(deps: ScreenshotDeps = {}) {
  return defineTool({
    name: "screenshot_url",
    description:
      "Capture a screenshot of a URL via headless chromium (Playwright). Only public http(s) pages by " +
      "default; local and private addresses are blocked unless the web pack setting allowLocalUrls is on. " +
      "Requires: npx playwright install chromium.",
    capability: "web_screenshot",
    annotations: { readOnlyHint: true, openWorldHint: true },
    input: z.object({
      url: z.url({ protocol: /^https?$/ }).max(8192),
      viewport: z
        .object({
          width: z.number().int().min(100).max(4096),
          height: z.number().int().min(100).max(4096),
        })
        .optional(),
      full_page: z.boolean().optional(),
      wait_for: z.string().min(1).max(1024).optional(),
      delay_ms: z.number().int().min(0).max(60_000).optional(),
      format: z.enum(["png", "jpeg", "webp"]).optional(),
    }),
    async run(input, ctx: PackContext) {
      const policy: UrlPolicy = {
        allowLocal: ctx.settings.allowLocalUrls === true,
        resolve: deps.resolve,
        daemonPorts: ctx.pack.daemonPorts ?? [],
      };

      // Refuse before launching a browser at all.
      const first = await checkUrl(input.url, policy, { topLevel: true });
      if (!first.ok) throw new Error(`screenshot_url blocked: ${first.reason}`);

      let pw: PlaywrightModule;
      try {
        pw = await (deps.loadPlaywright ?? defaultLoad)();
      } catch (e) {
        throw new Error(
          `The playwright package is not installed (${e instanceof Error ? e.message : String(e)}). Run: pnpm add playwright && npx playwright install chromium`,
        );
      }

      const viewport = input.viewport ?? { width: 1280, height: 800 };
      const format = input.format ?? "png";
      const fullPage = input.full_page ?? false;

      const gate = makeGate(policy, first.local);
      const blocked = gate.blocked;
      const proxy = await startPinProxy((url) => gateConnection(gate, url));

      let browser: PlaywrightModule;
      try {
        browser = await pw.chromium.launch({
          headless: true,
          args: GUARDED_LAUNCH_ARGS,
          // Everything goes through the pinning proxy, loopback included.
          proxy: { server: proxy.url, bypass: "<-loopback>" },
        });
      } catch (e) {
        await proxy.close();
        throw installError(e) ?? e;
      }

      // One deadline for the whole call; closing the browser fails whatever is pending.
      const budget = (deps.deadlineMs ?? SCREENSHOT_DEADLINE_MS) + (input.delay_ms ?? 0);
      let expired: Error | null = null;
      const stop = (why: string) => () => {
        expired = new Error(why);
        void browser.close().catch(() => {});
      };
      const onTime = stop(`screenshot_url gave up after ${Math.round(budget / 1000)} s`);
      const onAbort = stop("screenshot_url was cancelled");
      const timer = setTimeout(onTime, budget);
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();

      try {
        const browserCtx = await browser.newContext({
          viewport,
          serviceWorkers: "block",
          acceptDownloads: false,
        });
        await installGuards(browserCtx, gate);
        const page = await browserCtx.newPage();

        try {
          await page.goto(input.url, { waitUntil: "networkidle", timeout: 30_000 });
        } catch (e) {
          const hit = blocked[0];
          if (hit) throw new Error(`screenshot_url blocked: ${hit.reason}`);
          throw e;
        }
        if (input.wait_for) await page.waitForSelector(input.wait_for, { timeout: 15_000 });
        if (input.delay_ms) await page.waitForTimeout(input.delay_ms);

        let shot: Uint8Array;
        let mime: string;
        if (format === "png") {
          shot = await page.screenshot({ type: "png", fullPage });
          mime = "image/png";
        } else if (format === "jpeg") {
          shot = await page.screenshot({ type: "jpeg", fullPage, quality: 90 });
          mime = "image/jpeg";
        } else {
          // webp: capture as png, convert via sharp
          const png = await page.screenshot({ type: "png", fullPage });
          const sharp = (await import("sharp")).default;
          shot = await sharp(png).webp({ quality: 90 }).toBuffer();
          mime = "image/webp";
        }

        const artifact = await ctx.library.save({
          kind: "image",
          mime,
          bytes: shot,
          tool: "screenshot_url",
          prompt: input.url,
          meta: { url: input.url, viewport, full_page: fullPage, format },
        });
        ctx.logger.info("screenshot captured", {
          id: artifact.id,
          bytes: shot.length,
          url: input.url,
          blocked: blocked.length,
        });
        return { artifact, blocked_requests: blocked.length };
      } catch (e) {
        throw expired ?? e;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        await browser.close().catch(() => {});
        await proxy.close();
      }
    },
  });
}
