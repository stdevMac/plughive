/**
 * End-to-end walk through the web dashboard.
 *
 * Starts a throwaway daemon on port 7793 (temp PLUGHIVE_HOME, in-memory
 * secrets, no .env, provider keys removed from the environment), drives the
 * dashboard with Playwright, and writes screenshots of every screen in both
 * themes and at three widths to web/e2e-screenshots/. No provider is ever
 * called: the fake key is only stored, the tools run are built in
 * (gateway_status, import_artifact), and the running jobs are mocked at the
 * network layer. The run fails if two screenshots are identical.
 *
 * Needs `pnpm build:web` first. Run with `pnpm e2e:dashboard`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type Page, chromium } from "playwright";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 7793;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = join(ROOT, "web", "e2e-screenshots");
// A throwaway admin token for this run only; the daemon reads it from its environment.
const ADMIN = `e2e-${randomBytes(24).toString("base64url")}`;
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const SECRET_NAME = /(_API_KEY|_TOKEN|_KEY|_SECRET|PASSPHRASE)$/;
const KEEP = new Set([
  "PLUGHIVE_PORT",
  "PLUGHIVE_BIND_HOST",
  "PLUGHIVE_HOME",
  "PLUGHIVE_NO_DOTENV",
  "PLUGHIVE_SECRETS",
  "PLUGHIVE_IMPORT_ROOTS",
]);

function log(msg: string) {
  process.stdout.write(`[e2e] ${msg}\n`);
}

function daemonEnv(home: string, importRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k)) continue;
    if (k.startsWith("PLUGHIVE_") && !KEEP.has(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    PLUGHIVE_PORT: String(PORT),
    PLUGHIVE_BIND_HOST: "127.0.0.1",
    PLUGHIVE_HOME: home,
    PLUGHIVE_NO_DOTENV: "1",
    PLUGHIVE_SECRETS: "memory",
    PLUGHIVE_IMPORT_ROOTS: importRoot,
    PLUGHIVE_LOG_LEVEL: "warn",
    PLUGHIVE_ADMIN_TOKEN: ADMIN,
  };
}

async function waitForHealth(child: ChildProcess, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`daemon exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("daemon did not become healthy in time");
}

async function stopDaemon(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const pid = child.pid;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  process.kill(pid, "SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) process.kill(pid, "SIGKILL");
  }, 5000);
  await exited;
  clearTimeout(timer);
}

async function settle(page: Page) {
  // The event stream keeps a request open, so "networkidle" never fires; cap it.
  await page.waitForLoadState("networkidle", { timeout: 1500 }).catch(() => undefined);
  // Let skeletons resolve and transitions finish.
  await page
    .waitForFunction(
      () => !document.querySelector(".skeleton, [aria-busy='true'] .skeleton"),
      undefined,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(200);
}

async function shot(page: Page, theme: Theme, name: string) {
  await settle(page);
  const file = join(SHOTS, `${name}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log(`screenshot ${file}`);
}

/**
 * Open the link the daemon prints: the page trades the token for a session cookie.
 * No reload: from "/" this only changes the #hash, which is what the menu-bar app
 * does to an open window after the daemon restarts.
 */
async function signInByLink(page: Page) {
  await page.goto(`${BASE}/#token=${ADMIN}`);
  await page.getByRole("navigation").first().waitFor({ timeout: 10_000 });
  await settle(page);
}

async function go(page: Page, path: string) {
  await page.goto(`${BASE}${path}`);
  await settle(page);
}

/**
 * Collect page errors and failed requests. A 404 from /api/session is expected
 * on daemons without the session API (the dashboard treats it as signed in).
 */
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource"))
      errors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const url = new URL(r.url());
    if (url.pathname === "/api/session" && r.status() === 404) return;
    // The wrong-token check in the walk is answered with 401 on purpose.
    if (url.pathname === "/api/session" && r.request().method() === "POST" && r.status() === 401)
      return;
    if (url.pathname === "/favicon.ico") return;
    errors.push(`${r.status()} ${r.request().method()} ${url.pathname}`);
  });
  return errors;
}

function expectNoErrors(errors: string[], where: string) {
  if (errors.length) throw new Error(`errors on ${where}:\n${errors.join("\n")}`);
}

/** Fails unless keyboard focus is on a button with this exact text. */
async function expectFocus(page: Page, text: string, where: string) {
  const got = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? "",
  );
  if (got !== text) throw new Error(`${where}: expected focus on "${text}", got "${got}"`);
}

/** Pretend to be an MCP client: an initialize is what the dashboard counts as "connected". */
async function mcpInitialize(name: string) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name, version: "1.0.0" },
      },
    }),
  });
  if (!res.ok) throw new Error(`MCP initialize failed: ${res.status} ${await res.text()}`);
  await res.body?.cancel();
}

/** The full interactive walk, done once in the light theme. */
async function walk(page: Page, pngPath: string) {
  // Not signed in: the sign-in screen, a wrong token, then the sign-in link.
  await go(page, "/");
  await page.getByRole("heading", { name: "Sign in to the dashboard" }).waitFor();
  await shot(page, "light", "00-sign-in");
  await page.locator("#admin-token").fill("not-the-right-token-0123456789abcdef");
  await page.locator("#admin-token").press("Enter");
  await page.getByRole("alert").first().waitFor({ timeout: 10_000 });
  await shot(page, "light", "00-sign-in-error");
  await signInByLink(page);
  if (page.url().includes("token=")) throw new Error("the token stayed in the address bar");

  // First run: a four-item checklist. 1. Connect an agent (live count).
  await go(page, "/");
  await page.getByRole("heading", { name: "Get started" }).waitFor();
  await page.getByText("Connected agents: 0").first().waitFor();
  await shot(page, "light", "01-home-step-connect");
  await page.getByRole("button", { name: "Connect an agent" }).first().click();
  const connect = page.getByRole("dialog", { name: "Connect an agent" });
  await connect.waitFor();
  await connect.getByText("Connected agents: 0").waitFor();
  await shot(page, "light", "02-home-connect");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if (!(await page.getByRole("heading", { name: "Get started" }).count()))
    throw new Error("closing Connect left the checklist");
  // An agent connects (an MCP initialize); the count updates by itself and the list moves on.
  await mcpInitialize("Claude Code");
  await page.getByText("Claude Code is connected.").first().waitFor({ timeout: 10_000 });

  // 2. Say what you want to do: picking a goal shows its setup plan under the cards.
  const goals = page.getByRole("list", { name: "Goals" });
  await goals.waitFor();
  await shot(page, "light", "01-home-step-goal");
  await goals.getByRole("button", { name: /Transcribe meetings/ }).click();
  await page.getByRole("button", { name: "Next", exact: true }).waitFor();
  await page.locator(".plan-steps .plan-step").first().waitFor();
  await shot(page, "light", "01-home-step-goal-plan");
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // 3. Add one key: the key item is open now.
  await page
    .getByRole("button", { name: /^Add key for fal/i })
    .first()
    .click();
  const keyField = page.getByPlaceholder("Paste the key").first();
  await keyField.waitFor();
  await page
    .getByRole("link", { name: /Get a key/ })
    .first()
    .waitFor();
  await shot(page, "light", "01-home-step-key-open");
  await keyField.fill("test-not-a-real-key");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();

  // 4. Run a tool: saving the key opened this item by itself.
  const openPlayground = page.getByRole("link", { name: "Open the playground" });
  await openPlayground.waitFor({ timeout: 10_000 });
  await page.getByText("Key added for fal.").first().waitFor();
  await shot(page, "light", "01-home-step-try");
  await openPlayground.click();
  await page.waitForURL(/\/playground\?tool=/);
  await go(page, "/playground?tool=gateway_status");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page
    .locator(".runner-result")
    .getByText(/ok|status|packs/i)
    .first()
    .waitFor({ timeout: 15_000 });
  await go(page, "/");
  await page.getByText("You're set.").waitFor();
  await shot(page, "light", "01-home-done");
  await page.getByRole("button", { name: "Hide this guide" }).click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await settle(page);

  // Tool access: create a profile, turn on Core from the keyboard, check the guard and the save bar.
  await go(page, "/exposure");
  await page.getByRole("button", { name: "New profile" }).first().click();
  await page.locator("#np-name").fill("Image work");
  await page.getByRole("button", { name: "Create profile" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  const core = page.getByRole("treeitem", { name: /^Core,/ });
  await core.focus();
  await page.keyboard.press("Space");
  const savebar = page.getByRole("region", { name: "Unsaved changes" });
  await savebar.waitFor();
  await page.getByText("What the agent sees").first().waitFor();
  await shot(page, "light", "03-exposure-unsaved");

  // Leaving with unsaved changes asks first; the safe button has focus; Escape stays.
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^Keys & packs/ })
    .click();
  await page.getByRole("alertdialog", { name: "Discard unsaved changes?" }).waitFor();
  await expectFocus(page, "Keep editing", "leave guard");
  await shot(page, "light", "03-exposure-leave-guard");
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  if (!new URL(page.url()).pathname.startsWith("/exposure"))
    throw new Error("the leave guard did not keep the page");
  await savebar.getByRole("button", { name: "Save" }).click();
  await savebar.waitFor({ state: "detached", timeout: 10_000 });

  // A destructive confirm: Cancel-first focus, and Enter there does not delete.
  await page.getByRole("button", { name: "Delete Image work" }).click();
  await page.getByRole("alertdialog", { name: "Delete Image work?" }).waitFor();
  await expectFocus(page, "Keep it", "delete confirm");
  await shot(page, "light", "03-exposure-delete-confirm");
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Delete Image work" }).waitFor();

  // Playground: gateway_status, then import a local PNG into the library.
  await go(page, "/playground?tool=gateway_status");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page
    .locator(".runner-result")
    .getByText(/ok|status|packs/i)
    .first()
    .waitFor({ timeout: 15_000 });
  await shot(page, "light", "05-playground-result");

  await go(page, "/playground?tool=import_artifact");
  const jsonMode = page.getByRole("radio", { name: "JSON" });
  if (await jsonMode.count()) await jsonMode.click();
  else await page.getByRole("button", { name: "JSON" }).click();
  await page
    .locator("#raw-args")
    .fill(JSON.stringify({ source_path: pngPath, kind: "image", meta: { note: "e2e" } }, null, 2));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.locator(".runner-result img").first().waitFor({ timeout: 15_000 });
  await page.locator(".runner-result").getByText("Saved to the Library.").waitFor();
  await shot(page, "light", "05-playground-import");

  // Library, reached from the result: the imported image shows up; open its detail.
  await page.locator(".runner-result").getByRole("link", { name: "Open the Library" }).click();
  await page.waitForURL(/\/library/);
  const tile = page.locator(".tile-btn").first();
  await tile.waitFor({ timeout: 10_000 });
  await tile.click();
  await page.getByRole("dialog").first().waitFor({ timeout: 5000 });
  const download = page.getByRole("link", { name: /Download/ });
  await download.waitFor();
  if (!/[?&]download=1(&|$)/.test((await download.getAttribute("href")) ?? ""))
    throw new Error("the Download link does not ask for an attachment");
  await expectFocus(page, "Download", "library lightbox");
  await shot(page, "light", "08-library-detail");

  // Deleting asks first, with Keep it focused; Escape closes only the confirm.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete this file?" }).waitFor();
  await expectFocus(page, "Keep it", "library delete confirm");
  await shot(page, "light", "08-library-delete-confirm");
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  await page.getByRole("dialog").first().waitFor();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete this file?" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  await page.getByRole("dialog").first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if ((await page.locator(".tile-btn").count()) < 1)
    throw new Error("the file was deleted without confirming");
}

const SCREENS: Array<[string, string]> = [
  ["/", "02-home"],
  ["/exposure", "03-exposure"],
  ["/packs", "04-packs"],
  ["/playground?tool=gateway_status", "05-playground"],
  ["/mounts", "06-mounts"],
  ["/capabilities", "07-capabilities"],
  ["/library", "08-library"],
  ["/jobs", "09-jobs"],
  ["/usage", "10-usage"],
  ["/approvals", "10-approvals-empty"],
  ["/software", "15-software"],
  ["/triggers", "16-triggers-empty"],
  ["/settings", "11-settings"],
];

async function themedPage(browser: Browser, theme: Theme, width: number, height: number) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    ([t]) => {
      try {
        localStorage.setItem("plughive.theme", t as string);
        localStorage.setItem("plughive.onboarded", "1");
      } catch {
        // ignore
      }
    },
    [theme],
  );
  const page = await ctx.newPage();
  const errors = watch(page);
  await signInByLink(page);
  return { ctx, page, errors };
}

async function tour(browser: Browser, theme: Theme, width: number, height: number, suffix = "") {
  const { ctx, page, errors } = await themedPage(browser, theme, width, height);
  for (const [path, name] of SCREENS) {
    await go(page, path);
    const actual = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
    if (actual && actual !== theme)
      throw new Error(`expected theme ${theme} on ${path}, got ${actual}`);
    await shot(page, theme, `${name}${suffix}`);
    expectNoErrors(errors, `${path} (${theme})`);
  }
  // Cmd-K palette: opens from the keyboard, filters, Enter navigates, Esc closes.
  if (!suffix) {
    await go(page, "/");
    await page.keyboard.press("ControlOrMeta+k");
    const input = page.getByRole("combobox");
    await input.waitFor();
    await shot(page, theme, "13-palette");
    await input.fill("libr");
    await page
      .getByRole("option", { name: /Library/ })
      .first()
      .waitFor();
    await shot(page, theme, "13-palette-search");
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/library/);
    await page.keyboard.press("ControlOrMeta+k");
    await input.waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "detached" });
    expectNoErrors(errors, `palette (${theme})`);
  }
  // A different pack than the default selection.
  await go(page, "/packs?pack=fal");
  await page.locator(".pack-item-on").first().waitFor();
  await shot(page, theme, `04-packs-detail${suffix}`);
  expectNoErrors(errors, `/packs?pack=fal (${theme})`);
  // A "needs a key" link lands with the key field open and focused.
  await go(page, "/packs?missing=1");
  await page.locator(".secret-form input").first().waitFor();
  if (!(await page.evaluate(() => document.activeElement?.closest(".secret-form") != null)))
    throw new Error("?missing=1 did not focus the key field");
  await shot(page, theme, `04-packs-add-key${suffix}`);
  await ctx.close();
}

/** Preferred services: open a job, move a service with focus following it, undo, and the phone layout. */
async function servicesFlow(browser: Browser) {
  const { ctx, page, errors } = await themedPage(browser, "light", 1100, 720);
  await go(page, "/capabilities?cap=audio.transcribe");
  const open = page.locator('.cap-summary[aria-expanded="true"]');
  await open.waitFor();
  if ((await open.count()) !== 1) throw new Error("?cap= did not open exactly one job");
  const names = () => page.locator(".cap-panel .cap-name").allInnerTexts();
  const before = await names();
  if (before.length < 2) throw new Error("transcription should list several services");
  await open.scrollIntoViewIfNeeded();
  await shot(page, "light", "07-capabilities-open");
  const first = (before[0] as string).replace(/Used now$/, "").trim();
  const down = page.getByRole("button", { name: `Move ${first} down for transcribe audio` });
  await down.focus();
  await page.keyboard.press("Enter");
  await page.getByText(`${first} is now number 2 of ${before.length}`).first().waitFor();
  const label = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  if (label !== `Move ${first} down for transcribe audio`)
    throw new Error(`focus did not follow the moved service (it is on ${label ?? "nothing"})`);
  const moved = await names();
  if (!moved[1]?.startsWith(first))
    throw new Error(`${first} did not move down: ${moved.join(", ")}`);
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByText("back to the order it had").first().waitFor();
  const after = await names();
  if (after.join("|") !== before.join("|"))
    throw new Error(`undo did not restore the order: ${after.join(", ")}`);
  // Filters: "Needs setup" and "Free" only show matching jobs.
  await page.getByRole("radio", { name: "Free" }).click();
  if ((await page.locator(".cap-item").count()) < 1)
    throw new Error("the Free filter shows nothing");
  await page.getByRole("radio", { name: "All" }).click();
  expectNoErrors(errors, "preferred services");
  await ctx.close();
  // Phone: no sideways scroll, actions under the title.
  const phone = await themedPage(browser, "dark", 390, 844);
  await go(phone.page, "/capabilities?cap=audio.transcribe");
  await phone.page.locator(".cap-panel").scrollIntoViewIfNeeded();
  const wide = await phone.page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  if (wide) throw new Error("the preferred services page scrolls sideways on a phone");
  await shot(phone.page, "dark", "07-capabilities-phone");
  expectNoErrors(phone.errors, "preferred services (phone)");
  await phone.ctx.close();
}

/** The Usage page with calls reused from the paid-call cache, mocked at the network layer. */
async function usageCached(browser: Browser, theme: Theme) {
  const { ctx, page, errors } = await themedPage(browser, theme, 1100, 720);
  const today = new Date().toISOString().slice(0, 10);
  await page.route(/\/api\/usage(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        ok: true,
        since: null,
        summary: {
          total_calls: 14,
          ok_calls: 13,
          error_calls: 1,
          fallback_calls: 0,
          cached_calls: 5,
          total_cost_usd: 0.36,
          by_tool: [
            { tool: "generate_image", calls: 11, cost_usd: 0.24 },
            { tool: "generate_speech", calls: 3, cost_usd: 0.12 },
          ],
          by_vendor: [{ vendor: "fal", calls: 14, cost_usd: 0.36 }],
          by_capability: [{ capability: "image.generate", calls: 11, cost_usd: 0.24 }],
          rate_limits: [],
        },
        by_provider_day: [{ day: today, provider: "fal", calls: 14, errors: 1, cost_usd: 0.36 }],
      },
    }),
  );
  await go(page, "/usage");
  await page.getByText("Reused from cache").waitFor();
  await shot(page, theme, "10-usage-cached");
  expectNoErrors(errors, "usage (cached)");
  await ctx.close();
}

/** Running jobs, mocked at the network layer: the daemon runs nothing. */
async function runningJob(browser: Browser, theme: Theme) {
  const { ctx, page, errors } = await themedPage(browser, theme, 1100, 720);
  const job = {
    job_id: "job-e2e-running",
    tool: "fal_video_generate",
    status: "running",
    progress: 0.42,
    message: "Rendering frames",
    result: null,
    error: null,
    created_at: new Date(Date.now() - 83_000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  const queued = {
    ...job,
    job_id: "job-e2e-queued",
    tool: "elevenlabs_music",
    status: "queued",
    progress: null,
    message: null,
  };
  const failed = {
    ...job,
    job_id: "job-e2e-failed",
    tool: "fal_kling_video",
    status: "failed",
    progress: null,
    message: null,
    error: {
      code: "PROVIDER_ERROR",
      message:
        "fal.ai rejected the request: the prompt was flagged by its content filter. Request id 8f2c.",
    },
    created_at: new Date(Date.now() - 3_600_000).toISOString(),
    updated_at: new Date(Date.now() - 3_540_000).toISOString(),
  };
  await page.route(/\/api\/jobs(\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        jobs: [job, queued, failed],
        counts: { running: 1, queued: 1, failed: 1 },
        limit: 50,
        offset: 0,
      },
    }),
  );
  await page.route(/\/api\/jobs\/job-e2e-failed$/, (route) =>
    route.fulfill({ json: { job: failed } }),
  );
  await page.route(/\/api\/jobs\/job-e2e-(running|queued)$/, (route) =>
    route.fulfill({ json: { job } }),
  );
  // Never let a stop reach the daemon.
  await page.route(/\/api\/jobs\/[^/]+\/cancel$/, (route) => route.abort());
  await go(page, "/");
  await page.locator(".progress-text").first().waitFor();
  await shot(page, theme, "02-home-running-job");
  await go(page, "/jobs");
  await page.getByText("42%").first().waitFor();
  await shot(page, theme, "09-jobs-running");
  await page.getByRole("button", { name: /^Details of fal_video_generate/ }).click();
  const drawer = page.getByRole("dialog", { name: "fal_video_generate" });
  await drawer.waitFor();
  await page
    .getByText(/42% · /)
    .first()
    .waitFor();
  await shot(page, theme, "09-jobs-detail-running");
  await drawer.getByRole("button", { name: "Stop job" }).click();
  await page.getByRole("alertdialog", { name: "Stop this job?" }).waitFor();
  await expectFocus(page, "Keep it running", "stop confirm");
  await shot(page, theme, "09-jobs-stop-confirm");
  // Escape closes only the confirm; the job drawer stays open.
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  await drawer.waitFor();
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  // A failed job says why in one sentence on its row, and in plain words in its drawer.
  await page.locator(".row-error").first().waitFor();
  await page.getByRole("button", { name: /^Details of fal_kling_video/ }).click();
  await page.getByRole("dialog", { name: "fal_kling_video" }).getByRole("alert").waitFor();
  await shot(page, theme, "09-jobs-detail-failed");
  expectNoErrors(errors, `running job (${theme})`);
  await ctx.close();
}

/** Below the 860px breakpoint: one column, a menu button, the composer preview inline. */
async function small(browser: Browser, theme: Theme) {
  const { ctx, page, errors } = await themedPage(browser, theme, 760, 900);
  const screens: Array<[string, string]> = [
    ["/", "02-home"],
    ["/packs?pack=fal", "04-packs-detail"],
    ["/jobs", "09-jobs"],
    ["/exposure", "03-exposure"],
  ];
  for (const [path, name] of screens) {
    await go(page, path);
    await shot(page, theme, `${name}-small`);
  }
  // The composer's preview is reachable below the tool list.
  const preview = page.getByText("What the agent sees").first();
  await preview.scrollIntoViewIfNeeded();
  await shot(page, theme, "03-exposure-small-preview");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: /^Keys & packs/ })
    .waitFor();
  await shot(page, theme, "00-menu-small");
  expectNoErrors(errors, `small (${theme})`);
  await ctx.close();
}

/**
 * Ask the daemon for a missing-key setup link the way a client with URL
 * elicitation does. firecrawl_search needs FIRECRAWL_API_KEY, which this daemon
 * does not have, so the call stops at the link: the tool never runs.
 */
async function setupLink(): Promise<string> {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": { elicitation: { url: {} } },
  };
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "execute_tool",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "execute_tool",
        arguments: { name: "firecrawl_search", arguments: { query: "x" } },
        _meta: meta,
      },
    }),
  });
  const text = await res.text();
  const match = text.match(/"url":"(http:[^"]+\/setup\/secret\?token=[^"]+)"/);
  if (!match?.[1]) throw new Error(`no setup link in the reply (HTTP ${res.status})`);
  return match[1];
}

/**
 * The missing-key setup page in a real browser (M1): a blind POST of the
 * handed-out token is refused, and the form the page renders posts with the
 * headers and the cookie the daemon requires.
 */
async function setupPage(browser: Browser) {
  const url = await setupLink();
  const token = new URL(url).searchParams.get("token") ?? "";
  // The reviewer's proof: the token posted without opening the page stores nothing.
  const blind = await fetch(`${BASE}/setup/secret`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, value: "blind-post-value" }).toString(),
  });
  if (blind.status !== 403)
    throw new Error(`a blind POST of the setup token got HTTP ${blind.status}`);

  const ctx = await browser.newContext({
    viewport: { width: 900, height: 720 },
    colorScheme: "light",
  });
  const page = await ctx.newPage();
  const errors = watch(page);
  await page.goto(url);
  await page.getByRole("heading", { name: "Set a key for plughive" }).waitFor();
  const body = await page.locator("main").innerText();
  if (!body.includes("web") || !body.includes("FIRECRAWL_API_KEY"))
    throw new Error("the setup page does not name the pack and the key");
  await shot(page, "light", "12-setup-secret");
  const posted = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith("/setup/secret"),
  );
  await page.locator("#value").fill("e2e-not-a-real-key");
  await page.getByRole("button", { name: "Save" }).click();
  const headers = await (await posted).allHeaders();
  log(
    `setup form posted with sec-fetch-site=${headers["sec-fetch-site"]} origin=${headers.origin} cookie=${headers.cookie ? "yes" : "no"}`,
  );
  await page.getByRole("heading", { name: "Key saved" }).waitFor({ timeout: 10_000 });
  await shot(page, "light", "12-setup-secret-saved");
  if (!headers.cookie?.includes("mcp_setup_"))
    throw new Error("the setup form was posted without its cookie");
  expectNoErrors(errors, "setup page");
  await ctx.close();
}

/** Every screenshot is a different picture; two identical files mean a step did nothing. */
async function checkDistinct() {
  const files = (await readdir(SHOTS)).filter((f) => f.endsWith(".png") && f !== "failure.png");
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const f of files) {
    const hash = createHash("sha256")
      .update(await readFile(join(SHOTS, f)))
      .digest("hex");
    const other = seen.get(hash);
    if (other) dupes.push(`${other} = ${f}`);
    else seen.set(hash, f);
  }
  if (dupes.length) throw new Error(`identical screenshots:\n${dupes.join("\n")}`);
  log(`${files.length} screenshots, all different`);
}

/** Same-origin JSON request from the signed-in page (session cookie + CSRF header). */
async function pageApi(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ([m, u, b]) => {
      const res = await fetch(u as string, {
        method: m as string,
        credentials: "include",
        headers: { "content-type": "application/json", "x-plughive-csrf": "1" },
        ...(b === undefined ? {} : { body: JSON.stringify(b) }),
      });
      return { status: res.status };
    },
    [method, path, body] as const,
  );
}

/** An agent's call through execute_tool, without URL elicitation: a held call fails inline. */
async function agentCall(name: string): Promise<string> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "execute_tool",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "execute_tool",
        arguments: { name, arguments: {} },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  return res.text();
}

/**
 * Spend caps and approvals: caps with progress bars on Usage, the cap editor,
 * one call held for approval (gateway_status, free and built in, is put on
 * the always-ask list), the sidebar badge, and approving it on the Approvals
 * page. The policy is reset afterwards.
 */
async function approvalsFlow(browser: Browser) {
  for (const theme of THEMES) {
    const { ctx, page, errors } = await themedPage(browser, theme, 1100, 720);
    const put = await pageApi(page, "PUT", "/api/policy", {
      policy: {
        version: 1,
        caps: [
          { scope: "global", period: "daily", limit_usd: 5, mode: "ask" },
          { scope: "provider", id: "fal", period: "monthly", limit_usd: 20, mode: "block" },
        ],
        rules: { always_ask_tools: ["gateway_status"] },
      },
    });
    if (put.status !== 200) throw new Error(`PUT /api/policy: HTTP ${put.status}`);
    await go(page, "/usage");
    await page.locator(".spend-cap-row").nth(1).waitFor();
    await shot(page, theme, "10-usage-caps");
    if (theme === "light") {
      await page.getByRole("button", { name: "Edit caps" }).click();
      await page.getByRole("button", { name: "Add a cap" }).click();
      await page.getByLabel("Cap 3 applies to").selectOption("provider");
      await shot(page, theme, "10-usage-caps-edit");
      await page.getByRole("button", { name: "Save caps" }).click();
      await page.getByText("Cap 3: name the provider").waitFor();
      await page.getByRole("button", { name: "Cancel" }).click();
    }

    const text = await agentCall("gateway_status");
    if (!text.includes("APPROVAL_REQUIRED")) {
      throw new Error(`expected APPROVAL_REQUIRED, got: ${text.slice(0, 300)}`);
    }
    await page.locator(".nav-count").waitFor();
    await go(page, "/approvals");
    await page.locator(".approval").first().waitFor();
    await shot(page, theme, "14-approvals");
    await page.getByRole("button", { name: "Approve once" }).first().click();
    await page.locator(".nav-count").waitFor({ state: "detached" });
    // The agent's retry runs and uses the approval up (the page shows "Used").
    const retry = await agentCall("gateway_status");
    if (!retry.includes('\\"ok\\":true')) {
      throw new Error(`expected the retry to run, got: ${retry.slice(0, 300)}`);
    }
    await page.getByText("Used", { exact: true }).first().waitFor();
    await shot(page, theme, "14-approvals-decided");
    expectNoErrors(errors, `/approvals (${theme})`);
    const reset = await pageApi(page, "PUT", "/api/policy", { policy: { version: 1 } });
    if (reset.status !== 200) throw new Error(`reset policy: HTTP ${reset.status}`);
    await ctx.close();
  }
}

/**
 * Triggers: a webhook trigger made in the dashboard, its signing secret shown
 * once, then the hook called the way another service would. A signed request
 * starts a job; the same request again, a bad signature and no signature are
 * refused. The run shows on the trigger's row.
 */
async function triggersFlow(browser: Browser) {
  const { ctx, page, errors } = await themedPage(browser, "light", 1100, 720);
  await go(page, "/triggers");
  await page.getByRole("button", { name: "New trigger" }).click();
  const dialog = page.getByRole("dialog", { name: "New trigger" });
  await dialog.waitFor();
  await dialog.getByRole("radio", { name: "A webhook arrives" }).click();
  await dialog.locator("#t-name").fill("Issue intake");
  const triage = await dialog
    .locator("#t-workflow option")
    .filter({ hasText: /triage/i })
    .first()
    .getAttribute("value");
  if (!triage) throw new Error("no issue triage workflow offered");
  await dialog.locator("#t-workflow").selectOption(triage);
  await shot(page, "light", "16-triggers-new");
  await dialog.getByRole("button", { name: "Create trigger" }).click();
  const secretDialog = page.getByRole("dialog", { name: /Signing secret for Issue intake/ });
  await secretDialog.waitFor();
  const url = await secretDialog
    .getByRole("textbox", { name: "Webhook address", exact: true })
    .inputValue();
  const secret = await secretDialog
    .getByRole("textbox", { name: "Signing secret", exact: true })
    .inputValue();
  if (!url.startsWith(`${BASE}/hooks/trg_`)) throw new Error(`unexpected webhook URL ${url}`);
  await shot(page, "light", "16-triggers-secret");
  await secretDialog.getByRole("button", { name: "I have copied it" }).click();

  const body = JSON.stringify({ source: "e2e" });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
  const call = (headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const signed = { "x-plughive-timestamp": ts, "x-plughive-signature": sig };
  const ok = await call(signed);
  const started = (await ok.json()) as { ok?: boolean; job_id?: string };
  if (ok.status !== 202 || !started.job_id) {
    throw new Error(`signed hook: HTTP ${ok.status} ${JSON.stringify(started)}`);
  }
  const replay = await call(signed);
  if (replay.status !== 409) throw new Error(`replayed hook: HTTP ${replay.status}, wanted 409`);
  const forged = await call({ ...signed, "x-plughive-signature": `sha256=${"0".repeat(64)}` });
  if (forged.status !== 401) throw new Error(`bad signature: HTTP ${forged.status}, wanted 401`);
  const unsigned = await call({});
  if (unsigned.status !== 401)
    throw new Error(`unsigned hook: HTTP ${unsigned.status}, wanted 401`);
  log(`webhook started job ${started.job_id}; replay 409, bad signature 401, unsigned 401`);

  await go(page, "/triggers");
  const row = page.getByRole("list", { name: "Triggers" }).locator("li").first();
  await row.waitFor();
  await row.getByText(/Not run yet/).waitFor({ state: "detached", timeout: 15_000 });
  await shot(page, "light", "16-triggers");
  expectNoErrors(errors, "/triggers");
  await ctx.close();
  for (const theme of ["dark"] as const) {
    const t = await themedPage(browser, theme, 1100, 720);
    await go(t.page, "/triggers");
    await t.page.getByRole("list", { name: "Triggers" }).waitFor();
    await shot(t.page, theme, "16-triggers");
    expectNoErrors(t.errors, `/triggers (${theme})`);
    await t.ctx.close();
  }
}

async function main() {
  if (!existsSync(join(ROOT, "web", "dist", "index.html"))) {
    throw new Error("web/dist is missing; run `pnpm build:web` first");
  }
  const tmp = await mkdtemp(join(tmpdir(), "plughive-e2e-"));
  const home = join(tmp, "home");
  const imports = join(tmp, "imports");
  await mkdir(home, { recursive: true });
  await mkdir(imports, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  // Start from an empty folder, so the duplicate check only sees this run.
  for (const f of await readdir(SHOTS)) if (f.endsWith(".png")) await unlink(join(SHOTS, f));
  const png = join(imports, "gradient.png");
  const w = 640;
  const h = 400;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = Math.round((x / w) * 200 + 30);
      raw[i + 1] = Math.round((y / h) * 120 + 60);
      raw[i + 2] = 200;
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(png);

  log(`starting daemon on ${BASE} with home ${home}`);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--conditions=plughive-source", "src/server.ts"],
    {
      cwd: ROOT,
      env: daemonEnv(home, imports),
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  log(`daemon pid ${child.pid}`);

  let browser: Browser | undefined;
  try {
    await waitForHealth(child);
    browser = await chromium.launch();

    // Interactive walk in light, at the target size.
    const ctx = await browser.newContext({
      viewport: { width: 1100, height: 720 },
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("plughive.theme", "light");
      } catch {
        // ignore
      }
    });
    const page = await ctx.newPage();
    const errors = watch(page);
    try {
      await walk(page, png);
    } catch (err) {
      await page.screenshot({ path: join(SHOTS, "failure.png") }).catch(() => undefined);
      throw err;
    }
    expectNoErrors(errors, "walk");
    await ctx.close();

    await setupPage(browser);

    // Every screen, both themes, at the target width and the narrowest two-column width.
    for (const theme of THEMES) {
      await tour(browser, theme, 1100, 720);
      await tour(browser, theme, 900, 720, "-narrow");
      await runningJob(browser, theme);
      await usageCached(browser, theme);
      await small(browser, theme);
    }
    await approvalsFlow(browser);
    await triggersFlow(browser);
    await servicesFlow(browser);
    await checkDistinct();
    log("done");
  } finally {
    await browser?.close().catch(() => undefined);
    await stopDaemon(child);
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(
    `[e2e] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
