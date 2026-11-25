// The web dashboard: static serving, client-side route fallback, security headers,
// and the page shown before the app is built. Also GET /api/info.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_CSP, defaultWebDir } from "../../src/core/http/dashboard.js";
import { mountInfoApi } from "../../src/core/http/info-api.js";
import { createOriginPolicy } from "../../src/core/http/origin.js";
import { createSecretStore } from "../../src/core/secrets/store.js";
import type { SecretBackend } from "../../src/core/secrets/types.js";
import { ADMIN_TOKEN, type LiteHarness, bootLite, jsonBody, mockTool } from "./harness.js";

const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };

const INDEX =
  '<!doctype html><html><head><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>';

/** What a browser sends for a page navigation. */
const PAGE = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

let tmpRoot: string;
let webDir: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mcp-web-"));
  // Under a dot directory, like an install in ~/.local or a .claude worktree:
  // only dotfiles inside the build are hidden, not the build itself.
  webDir = join(tmpRoot, ".hidden", "web");
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), INDEX);
  writeFileSync(join(webDir, "assets", "app-abc123.js"), "console.log('app')");
  writeFileSync(join(webDir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
});
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function expectSecurityHeaders(res: Response, csp = DASHBOARD_CSP) {
  expect(res.headers.get("content-security-policy")).toBe(csp);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
}

describe("dashboard serving", () => {
  let h: LiteHarness;
  afterEach(() => h.close());

  it("serves index.html at / with a strict CSP", async () => {
    h = await bootLite({ packs: {}, webDir });
    const res = await fetch(`${h.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expectSecurityHeaders(res);
    expect(await res.text()).toBe(INDEX);
    const csp = DASHBOARD_CSP;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it("serves fingerprinted assets with long caching and the same headers", async () => {
    h = await bootLite({ packs: {}, webDir });
    const res = await fetch(`${h.base}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expectSecurityHeaders(res);
    const icon = await fetch(`${h.base}/favicon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves a precompressed copy when the client accepts it, the plain file otherwise", async () => {
    const css = `body{color:red}${" ".repeat(2000)}`;
    writeFileSync(join(webDir, "assets", "style-def456.css"), css);
    writeFileSync(join(webDir, "assets", "style-def456.css.br"), brotliCompressSync(css));
    writeFileSync(join(webDir, "assets", "style-def456.css.gz"), gzipSync(css));
    h = await bootLite({ packs: {}, webDir });
    const url = `${h.base}/assets/style-def456.css`;
    for (const [accept, encoding] of [
      ["br, gzip", "br"],
      ["gzip", "gzip"],
    ] as const) {
      const res = await fetch(url, { headers: { "accept-encoding": accept } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe(encoding);
      expect(res.headers.get("content-type")).toMatch(/text\/css/);
      expect(res.headers.get("vary")).toMatch(/accept-encoding/i);
      expect(res.headers.get("cache-control")).toContain("immutable");
      expectSecurityHeaders(res);
      expect(await res.text()).toBe(css);
    }
    const plain = await fetch(url, { headers: { "accept-encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toMatch(/accept-encoding/i);
    expect(await plain.text()).toBe(css);
    // No copy on disk: the plain file, whatever the client accepts.
    const js = await fetch(`${h.base}/assets/app-abc123.js`, {
      headers: { "accept-encoding": "br" },
    });
    expect(js.headers.get("content-encoding")).toBeNull();
    expect(await js.text()).toBe("console.log('app')");
    // A path that climbs out of the build is never resolved to a copy.
    const out = await fetch(`${h.base}/assets/..%2F..%2Fetc%2Fpasswd.css`, {
      headers: { "accept-encoding": "br" },
    });
    expect(out.headers.get("content-encoding")).toBeNull();
    // A dotfile inside the build is never served, compressed or not.
    writeFileSync(join(webDir, "assets", ".secret.css"), css);
    writeFileSync(join(webDir, "assets", ".secret.css.br"), brotliCompressSync(css));
    const dot = await fetch(`${h.base}/assets/.secret.css`, {
      headers: { "accept-encoding": "br" },
    });
    expect(dot.status).toBe(404);
    expect(dot.headers.get("content-encoding")).toBeNull();
  });

  it("falls back to index.html for client routes, never for files or daemon paths", async () => {
    h = await bootLite({ packs: { alpha: [mockTool("alpha_one", async () => "x")] }, webDir });
    for (const path of [
      "/composer",
      "/packs",
      "/jobs/01ABC",
      "/library?kind=image",
      "/settings/",
    ]) {
      const res = await fetch(`${h.base}${path}`, { headers: PAGE });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toBe(INDEX);
    }
    // An API client (no Accept: text/html) asking for an unknown path gets the JSON 404.
    const apiClient = await fetch(`${h.base}/composer`);
    expect(apiClient.status).toBe(404);
    expect(await apiClient.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const missingAsset = await fetch(`${h.base}/assets/gone-123.js`, { headers: PAGE });
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    for (const path of ["/api/nope", "/mcp/x", "/p/x", "/artifacts/nope", "/setup/x"]) {
      const res = await fetch(`${h.base}${path}`, { headers: PAGE });
      expect(res.headers.get("content-type"), path).toMatch(/json/);
      expect(res.headers.get("content-security-policy"), path).not.toBe(DASHBOARD_CSP);
    }
    const health = await (await fetch(`${h.base}/health`)).json();
    expect(health).toMatchObject({ ok: true });
    const api = await jsonBody(await fetch(`${h.base}/api/tools`, { headers: ADMIN }));
    expect(api.tools.map((t: { name: string }) => t.name)).toContain("alpha_one");
  });

  it("does not answer writes with the app", async () => {
    h = await bootLite({ packs: {}, webDir });
    const res = await fetch(`${h.base}/composer`, {
      method: "POST",
      headers: { ...PAGE, "x-plughive-csrf": "1" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("static files are public, the API needs the admin token (the access key does not open it)", async () => {
    h = await bootLite({ packs: {}, webDir, accessKey: "k".repeat(40) });
    expect((await fetch(`${h.base}/`)).status).toBe(200);
    expect((await fetch(`${h.base}/assets/app-abc123.js`)).status).toBe(200);
    const api = await fetch(`${h.base}/api/info`);
    expect(api.status).toBe(401);
    const agentKey = await fetch(`${h.base}/api/info`, {
      headers: { authorization: `Bearer ${"k".repeat(40)}` },
    });
    expect(agentKey.status).toBe(401);
    const ok = await fetch(`${h.base}/api/info`, { headers: ADMIN });
    expect(ok.status).toBe(200);
    expect((await jsonBody(ok)).auth_required).toBe(true);
  });

  it("explains how to build the app when web/dist is missing", async () => {
    h = await bootLite({ packs: {} });
    const res = await fetch(`${h.base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pnpm build:web");
    expect(html).not.toMatch(/<script/i);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${h.base}/composer`, { headers: PAGE })).status).toBe(200);
    expect((await fetch(`${h.base}/assets/app.js`)).status).toBe(404);
  });

  it("PLUGHIVE_WEB_DIR overrides the default location", () => {
    expect(defaultWebDir({ PLUGHIVE_WEB_DIR: "/tmp/somewhere" })).toBe(resolve("/tmp/somewhere"));
    expect(defaultWebDir({})).toMatch(/web[/\\]dist$/);
  });
});

describe("GET /api/info", () => {
  let h: LiteHarness;
  afterEach(() => h.close());

  it("describes the daemon without secrets", async () => {
    h = await bootLite({ packs: {} });
    const res = await fetch(`${h.base}/api/info`, { headers: ADMIN });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body).toMatchObject({
      ok: true,
      base_url: h.base,
      mcp_url: `${h.base}/mcp`,
      profile_url_template: `${h.base}/p/{profile}/mcp`,
      bind_host: "127.0.0.1",
      port: h.port,
      auth_required: false,
    });
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime_s).toBe("number");
  });
});

describe("GET /api/info: where secrets are stored", () => {
  let home: string;
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const info = async (secrets?: Parameters<typeof mountInfoApi>[1]["secrets"]) => {
    const app = express();
    let port = 0;
    const origin = createOriginPolicy({
      publicUrl: null,
      bindHost: "127.0.0.1",
      allowedOrigins: [],
      port: () => port,
    });
    mountInfoApi(app, {
      origin,
      version: "0.0.0",
      bindHost: "127.0.0.1",
      port: () => port,
      authRequired: false,
      ...(secrets ? { secrets } : {}),
    });
    await new Promise<void>((r) => {
      server = app.listen(0, "127.0.0.1", () => r());
    });
    const addr = server!.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    port = addr.port;
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()) as Record<
      string,
      unknown
    >;
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    return body;
  };

  it("reports keychain, encrypted file, plain file and memory, and never a passphrase", async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-info-"));
    const PASS = "info-test-passphrase-24680";

    const encrypted = createSecretStore({ home, env: {}, backend: "file", passphrase: PASS });
    expect(await info(encrypted)).toMatchObject({
      secrets_backend: "file",
      secrets_storage: "file-encrypted",
      secrets_keychain_service: null,
    });
    await encrypted.set("DEMO_KEY", "value-1");
    const body = await info(encrypted);
    expect(body.secrets_storage).toBe("file-encrypted");
    expect(JSON.stringify(body)).not.toContain(PASS);

    const plainHome = join(home, "plain");
    mkdirSync(plainHome);
    const plain = createSecretStore({ home: plainHome, env: {}, backend: "file" });
    expect((await info(plain)).secrets_storage).toBe("file-plain");
    await plain.set("DEMO_KEY", "value-2");
    expect((await info(plain)).secrets_storage).toBe("file-plain");

    const memory = createSecretStore({ home, env: {}, backend: "memory" });
    expect(await info(memory)).toMatchObject({
      secrets_backend: "memory",
      secrets_storage: "memory",
    });

    // A keychain backend (a stand-in: no keychain is touched here).
    const keychain = createSecretStore({
      home,
      env: {},
      backend: {
        kind: "keychain",
        service: "plughive-info-test",
        get: async () => null,
        set: async () => undefined,
        delete: async () => undefined,
        list: async () => [],
        has: async () => false,
      } as unknown as SecretBackend,
    });
    expect(await info(keychain)).toMatchObject({
      secrets_backend: "keychain",
      secrets_storage: "keychain",
      secrets_keychain_service: "plughive-info-test",
    });

    // No store at all: nulls, not a guess.
    expect(await info()).toMatchObject({ secrets_backend: null, secrets_storage: null });
  });
});
