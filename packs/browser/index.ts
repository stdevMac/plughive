// packs/browser/index.ts
//
// Remote browsers: Browserbase and Steel sessions, page fetches, and Steel
// navigation and screenshots saved to the library.
//   Browserbase: https://docs.browserbase.com/reference/api
//   Steel:       https://steel.dev/docs/reference/api
//                https://steel.dev/docs/reference/commands
// Connection URLs (Browserbase connectUrl, Steel websocketUrl) carry a
// credential and are never returned. Browserbase has no REST call to drive a
// page inside a session (that is CDP only), so in-session navigation and
// screenshots are offered for Steel only.
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { arr, isPathSegment, num, obj, requestJson, scrub, str } from "./http.js";

const BROWSERBASE = "https://api.browserbase.com/v1";
const STEEL = "https://api.steel.dev/v1";
/** Most characters of fetched page content returned. */
const MAX_CONTENT_CHARS = 200_000;
/** Largest screenshot accepted. */
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024;
// Sessions are billed per minute (and the fetch API per call) directly on the
// provider APIs, so the policy gate needs the "paid" tag on these tools.
const PAID = ["browser", "paid"] as const;

const sessionId = z
  .string()
  .min(1)
  .max(200)
  .refine(isPathSegment, "a session id has no spaces, slashes or control characters");
const pageUrl = z
  .url()
  .max(4000)
  .refine((u) => /^https?:\/\//i.test(u), "an http or https URL");

function cap(text: string | null): string | null {
  if (text === null) return null;
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}...` : text;
}

// ---------------------------------------------------------------------------
// Browserbase
// ---------------------------------------------------------------------------

async function bb(
  ctx: PackContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const key = await ctx.secrets.get("BROWSERBASE_API_KEY");
  return obj(
    await requestJson(
      ctx.fetch,
      "Browserbase",
      `${BROWSERBASE}${path}`,
      {
        method,
        headers: {
          "X-BB-API-Key": key,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: 120_000,
      },
      [key],
    ),
  );
}

function bbSession(s: Record<string, unknown>) {
  return {
    id: str(s.id),
    status: str(s.status),
    region: str(s.region),
    created_at: str(s.createdAt),
    expires_at: str(s.expiresAt),
    keep_alive: typeof s.keepAlive === "boolean" ? s.keepAlive : null,
  };
}

const bbCreate = defineTool({
  name: "browserbase_create_session",
  description:
    "Start a Browserbase cloud browser session (billed per minute until closed or timed out). Returns the session id and a live view URL to watch it. Close it with browserbase_close_session.",
  tags: PAID,
  secrets: ["BROWSERBASE_API_KEY"],
  annotations: {
    title: "Start Browserbase session",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    timeout_s: z.number().int().min(60).max(21_600).optional(),
    keep_alive: z.boolean().optional(),
  }),
  async run(input, ctx) {
    const projectId = str(ctx.settings.browserbaseProjectId);
    const s = await bb(ctx, "POST", "/sessions", {
      ...(projectId ? { projectId } : {}),
      ...(input.timeout_s !== undefined ? { timeout: input.timeout_s } : {}),
      ...(input.keep_alive !== undefined ? { keepAlive: input.keep_alive } : {}),
    });
    const id = str(s.id);
    if (!id) throw new Error("Browserbase created a session but returned no id.");
    const debug = await bb(ctx, "GET", `/sessions/${encodeURIComponent(id)}/debug`).catch(
      () => ({}) as Record<string, unknown>,
    );
    return { ...bbSession(s), live_view_url: str(debug.debuggerFullscreenUrl) };
  },
});

const bbGet = defineTool({
  name: "browserbase_get_session",
  description:
    "Status of a Browserbase session (RUNNING, COMPLETED, ERROR, TIMED_OUT) with its live view URL while it runs.",
  secrets: ["BROWSERBASE_API_KEY"],
  annotations: { title: "Browserbase session status", readOnlyHint: true, openWorldHint: true },
  input: z.object({ session_id: sessionId }),
  async run(input, ctx) {
    const id = encodeURIComponent(input.session_id);
    const s = await bb(ctx, "GET", `/sessions/${id}`);
    let live: string | null = null;
    if (str(s.status) === "RUNNING") {
      const debug = await bb(ctx, "GET", `/sessions/${id}/debug`).catch(
        () => ({}) as Record<string, unknown>,
      );
      live = str(debug.debuggerFullscreenUrl);
    }
    return { ...bbSession(s), live_view_url: live };
  },
});

const bbClose = defineTool({
  name: "browserbase_close_session",
  description: "End a Browserbase session so it stops billing.",
  secrets: ["BROWSERBASE_API_KEY"],
  annotations: {
    title: "Close Browserbase session",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ session_id: sessionId }),
  async run(input, ctx) {
    const s = await bb(ctx, "POST", `/sessions/${encodeURIComponent(input.session_id)}`, {
      status: "REQUEST_RELEASE",
    });
    return { id: str(s.id) ?? input.session_id, status: str(s.status) };
  },
});

const bbFetch = defineTool({
  name: "browserbase_fetch",
  description:
    "Fetch a web page through Browserbase's Fetch API (no session needed) and return its content as markdown, raw HTML or JSON (capped at 200k characters).",
  tags: PAID,
  secrets: ["BROWSERBASE_API_KEY"],
  annotations: { title: "Fetch page (Browserbase)", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    url: pageUrl,
    format: z.enum(["markdown", "raw", "json"]).default("markdown"),
  }),
  async run(input, ctx) {
    const out = await bb(ctx, "POST", "/fetch", { url: input.url, format: input.format });
    const content = out.content;
    return {
      url: input.url,
      status_code: num(out.statusCode),
      content_type: str(out.contentType),
      content: cap(typeof content === "string" ? content : JSON.stringify(content ?? null)),
    };
  },
});

// ---------------------------------------------------------------------------
// Steel
// ---------------------------------------------------------------------------

async function steel(
  ctx: PackContext,
  path: string,
  body?: unknown,
): Promise<{ out: Record<string, unknown>; key: string }> {
  const key = await ctx.secrets.get("STEEL_API_KEY");
  const out = obj(
    await requestJson(
      ctx.fetch,
      "Steel",
      `${STEEL}${path}`,
      {
        method: "POST",
        headers: { "steel-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        timeoutMs: 120_000,
      },
      [key],
    ),
  );
  return { out, key };
}

/**
 * Runs Steel session commands. The endpoint answers 200 even when a command
 * fails, so each result's `ok` is checked and the first failure thrown.
 */
async function steelCommands(
  ctx: PackContext,
  id: string,
  commands: Record<string, unknown>[],
): Promise<{ results: Record<string, unknown>[]; page: Record<string, unknown> }> {
  const { out, key } = await steel(ctx, `/sessions/${encodeURIComponent(id)}/commands`, {
    commands,
  });
  const results = arr(out.results).map(obj);
  const failed = results.find((r) => r.ok === false || r.error !== undefined);
  const exec = obj(out.execution);
  if (failed) {
    const e = obj(failed.error);
    const msg = str(e.message) ?? str(e.code) ?? "command failed";
    throw new Error(`Steel ${str(failed.command) ?? "command"}: ${scrub(msg, [key])}`);
  }
  const state = str(exec.state);
  if (state && state !== "completed") {
    const msg = str(obj(exec.error).message) ?? state;
    throw new Error(`Steel: commands ${state}: ${scrub(msg, [key])}`);
  }
  if (results.length < commands.length) {
    throw new Error("Steel: fewer command results than commands sent.");
  }
  return { results, page: obj(out.page) };
}

function pageInfo(page: Record<string, unknown>) {
  return { url: str(page.url), title: str(page.title) };
}

const steelCreate = defineTool({
  name: "steel_create_session",
  description:
    "Start a Steel cloud browser session (billed per minute until released or timed out). Returns the session id and a viewer URL to watch it. Release it with steel_release_session.",
  tags: PAID,
  secrets: ["STEEL_API_KEY"],
  annotations: {
    title: "Start Steel session",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    timeout_ms: z.number().int().min(60_000).max(86_400_000).optional(),
    use_proxy: z.boolean().optional(),
    solve_captcha: z.boolean().optional(),
  }),
  async run(input, ctx) {
    const { out } = await steel(ctx, "/sessions", {
      ...(input.timeout_ms !== undefined ? { timeout: input.timeout_ms } : {}),
      ...(input.use_proxy !== undefined ? { useProxy: input.use_proxy } : {}),
      ...(input.solve_captcha !== undefined ? { solveCaptcha: input.solve_captcha } : {}),
    });
    return {
      id: str(out.id),
      status: str(out.status),
      created_at: str(out.createdAt),
      viewer_url: str(out.sessionViewerUrl),
      debug_url: str(out.debugUrl),
    };
  },
});

const steelNavigate = defineTool({
  name: "steel_navigate",
  description:
    "Open a URL in a running Steel session and wait for it to load. Returns the final URL and page title.",
  tags: PAID,
  secrets: ["STEEL_API_KEY"],
  annotations: { title: "Navigate (Steel)", readOnlyHint: false, openWorldHint: true },
  input: z.object({ session_id: sessionId, url: pageUrl }),
  async run(input, ctx) {
    const { page } = await steelCommands(ctx, input.session_id, [
      { command: "navigate", url: input.url },
    ]);
    return pageInfo(page);
  },
});

const steelScreenshot = defineTool({
  name: "steel_screenshot",
  description:
    "Take a PNG screenshot of the current page of a Steel session (after opening `url` when given) and save it to the artifact library.",
  tags: PAID,
  secrets: ["STEEL_API_KEY"],
  annotations: { title: "Screenshot (Steel)", readOnlyHint: false, openWorldHint: true },
  input: z.object({
    session_id: sessionId,
    url: pageUrl.optional(),
    full_page: z.boolean().default(false),
  }),
  async run(input, ctx) {
    const commands: Record<string, unknown>[] = [];
    if (input.url) commands.push({ command: "navigate", url: input.url });
    commands.push({ command: "screenshot", format: "png", fullPage: input.full_page });
    const { results, page } = await steelCommands(ctx, input.session_id, commands);
    const shot = results.at(-1) ?? {};
    const data = str(shot.data);
    if (!data) throw new Error("Steel returned no screenshot data.");
    if (data.length > (MAX_SCREENSHOT_BYTES * 4) / 3 + 4) {
      throw new Error("Steel: the screenshot is larger than the 25 MB limit.");
    }
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.byteLength === 0) throw new Error("Steel returned an empty screenshot.");
    const info = pageInfo(page);
    const ref = await ctx.library.save({
      kind: "image",
      mime: "image/png",
      bytes,
      prompt: info.url,
      meta: { provider: "steel", pageUrl: info.url, pageTitle: info.title },
    });
    return { artifact_id: ref.id, url: ref.url, bytes: bytes.byteLength, page: info };
  },
});

const steelRelease = defineTool({
  name: "steel_release_session",
  description: "Release (end) a Steel session so it stops billing.",
  secrets: ["STEEL_API_KEY"],
  annotations: {
    title: "Release Steel session",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ session_id: sessionId }),
  async run(input, ctx) {
    const { out } = await steel(ctx, `/sessions/${encodeURIComponent(input.session_id)}/release`);
    return { id: str(out.id) ?? input.session_id, status: str(out.status) ?? "released" };
  },
});

export default definePack({
  tools: [
    bbCreate,
    bbGet,
    bbClose,
    bbFetch,
    steelCreate,
    steelNavigate,
    steelScreenshot,
    steelRelease,
  ],
});
