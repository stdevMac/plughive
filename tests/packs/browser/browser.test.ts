import { describe, expect, it } from "vitest";
import browserPack from "../../../packs/browser/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = { BROWSERBASE_API_KEY: "bb_secret_123", STEEL_API_KEY: "steel_secret_456" };
const VALUES = Object.values(SECRETS);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

describe("browser pack", () => {
  it("marks billable session starts and closes as destructive", () => {
    expect(toolNames(browserPack)).toEqual([
      "browserbase_create_session",
      "browserbase_get_session",
      "browserbase_close_session",
      "browserbase_fetch",
      "steel_create_session",
      "steel_navigate",
      "steel_screenshot",
      "steel_release_session",
    ]);
    for (const n of [
      "browserbase_create_session",
      "browserbase_close_session",
      "steel_create_session",
      "steel_release_session",
    ]) {
      expect(toolOf(browserPack, n).annotations?.destructiveHint, n).toBe(true);
    }
    expect(toolOf(browserPack, "browserbase_fetch").annotations?.readOnlyHint).toBe(true);
  });

  it("creates a Browserbase session without returning the connect URL", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.browserbase\.com\/v1\/sessions$/,
        reply: () =>
          jsonResponse({
            id: "sess_1",
            status: "RUNNING",
            region: "us-west-2",
            expiresAt: "2026-11-24T01:00:00Z",
            connectUrl: "wss://connect.browserbase.com?signingKey=sk_live_abc",
          }),
      },
      {
        match: /^GET https:\/\/api\.browserbase\.com\/v1\/sessions\/sess_1\/debug$/,
        reply: () => jsonResponse({ debuggerFullscreenUrl: "https://www.browserbase.com/live/x" }),
      },
    ]);
    const h = harness(browserPack, "browser", "browserbase_create_session", {
      secrets: SECRETS,
      fetch,
      settings: { browserbaseProjectId: "proj_9" },
    });
    const out = await h.call({ timeout_s: 300 });
    expect(out).toMatchObject({
      id: "sess_1",
      status: "RUNNING",
      live_view_url: "https://www.browserbase.com/live/x",
    });
    expect(JSON.stringify(out)).not.toContain("signingKey");
    expect(fetch.calls[0]!.headers["x-bb-api-key"]).toBe("bb_secret_123");
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({ projectId: "proj_9", timeout: 300 });
    expectNoSecrets(out, VALUES);
  });

  it("closes a Browserbase session with REQUEST_RELEASE", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.browserbase\.com\/v1\/sessions\/sess_1$/,
        reply: () => jsonResponse({ id: "sess_1", status: "COMPLETED" }),
      },
    ]);
    const h = harness(browserPack, "browser", "browserbase_close_session", {
      secrets: SECRETS,
      fetch,
    });
    expect(await h.call({ session_id: "sess_1" })).toEqual({ id: "sess_1", status: "COMPLETED" });
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({ status: "REQUEST_RELEASE" });
  });

  it("fetches a page through Browserbase and caps the content", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.browserbase\.com\/v1\/fetch$/,
        reply: () =>
          jsonResponse({
            statusCode: 200,
            contentType: "text/markdown",
            content: "a".repeat(300_000),
          }),
      },
    ]);
    const h = harness(browserPack, "browser", "browserbase_fetch", { secrets: SECRETS, fetch });
    const out = (await h.call({ url: "https://example.com" })) as { content: string };
    expect(out.content.length).toBe(200_003);
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({
      url: "https://example.com",
      format: "markdown",
    });
  });

  it("starts a Steel session without returning the websocket URL", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.steel\.dev\/v1\/sessions$/,
        reply: () =>
          jsonResponse({
            id: "st_1",
            status: "live",
            sessionViewerUrl: "https://app.steel.dev/sessions/st_1",
            debugUrl: "https://api.steel.dev/v1/sessions/st_1/player",
            websocketUrl: "wss://connect.steel.dev?apiKey=steel_secret_456&sessionId=st_1",
          }),
      },
    ]);
    const h = harness(browserPack, "browser", "steel_create_session", { secrets: SECRETS, fetch });
    const out = await h.call({});
    expect(out).toMatchObject({ id: "st_1", viewer_url: "https://app.steel.dev/sessions/st_1" });
    expect(JSON.stringify(out)).not.toContain("wss://");
    expect(fetch.calls[0]!.headers["steel-api-key"]).toBe("steel_secret_456");
    expectNoSecrets(out, VALUES);
  });

  it("navigates and screenshots with Steel commands into the library", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.steel\.dev\/v1\/sessions\/st_1\/commands$/,
        reply: () =>
          jsonResponse({
            id: "st_1",
            page: { url: "https://example.com/", title: "Example" },
            execution: { id: "ex", state: "completed" },
            results: [
              { command: "navigate", ok: true },
              { command: "screenshot", ok: true, data: PNG, format: "png" },
            ],
          }),
      },
    ]);
    const h = harness(browserPack, "browser", "steel_screenshot", { secrets: SECRETS, fetch });
    const out = await h.call({ session_id: "st_1", url: "https://example.com", full_page: true });
    expect(out).toMatchObject({
      bytes: 7,
      page: { url: "https://example.com/", title: "Example" },
    });
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({
      commands: [
        { command: "navigate", url: "https://example.com" },
        { command: "screenshot", format: "png", fullPage: true },
      ],
    });
    const saved = h.t.library!.all();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("fails a Steel command that reports ok false despite HTTP 200, scrubbed", async () => {
    const fetch = routerFetch([
      {
        match: /commands$/,
        reply: () =>
          jsonResponse({
            execution: { state: "failed" },
            results: [
              {
                command: "navigate",
                ok: false,
                error: { code: "NAV", message: "timeout for steel_secret_456" },
              },
            ],
          }),
      },
    ]);
    const h = harness(browserPack, "browser", "steel_navigate", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ session_id: "st_1", url: "https://example.com" }));
    expect(err.message).toBe("Steel navigate: timeout for [redacted]");
    expectNoSecrets(err, VALUES);
  });

  it("scrubs keys from provider errors and rejects unsafe session ids", async () => {
    const fetch = routerFetch([
      { match: /browserbase/, reply: () => jsonResponse({ message: "bad bb_secret_123" }, 401) },
    ]);
    const h = harness(browserPack, "browser", "browserbase_get_session", {
      secrets: SECRETS,
      fetch,
    });
    const err = await failure(h.call({ session_id: "s1" }));
    expect(err.message).toBe("Browserbase 401: bad [redacted]");
    expectNoSecrets(err, VALUES);
    const tool = toolOf(browserPack, "steel_release_session");
    expect(tool.input.safeParse({ session_id: "../x" }).success).toBe(false);
    expect(
      toolOf(browserPack, "steel_navigate").input.safeParse({
        session_id: "a",
        url: "file:///etc/passwd",
      }).success,
    ).toBe(false);
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(browserPack, "browser", "steel_navigate", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://connect.steel.dev/x");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      {
        tool: "browserbase_fetch",
        args: { url: "https://example.com" },
        pack: "browser",
        secret: "BROWSERBASE_API_KEY",
      },
      { tool: "steel_create_session", args: {}, pack: "browser", secret: "STEEL_API_KEY" },
    ]);
  });
});
