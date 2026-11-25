// OAuth mounts end to end, in process: a mock authorization server (metadata,
// dynamic client registration, PKCE code exchange, refresh) and a mock MCP
// server that wants a bearer token, both reached through the PackMounts fetch
// seam under public-looking names. The browser leg (the user approving at the
// vendor) is simulated by reading the authorization URL and minting a code.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { refuseOAuthNameClashes } from "../../../src/core/mounts/manager.js";
import {
  MountOAuth,
  MountOAuthProvider,
  OAuthNameCollisionError,
  oauthSecretNames,
} from "../../../src/core/mounts/oauth.js";
import { isDeniedSecretName } from "../../../src/core/packs/manifest.js";
import { MOUNT_NEEDS_SIGN_IN, PackMounts } from "../../../src/core/packs/mounts.js";
import { isValidSecretName } from "../../../src/core/secrets/index.js";
import { type LayeredSecretStore, createSecretStore } from "../../../src/core/secrets/index.js";

const MCP = "https://mcp.example.test";
const AS = "https://auth.example.test";
const SERVER_URL = `${MCP}/mcp`;
const REDIRECT = "http://127.0.0.1:7777/oauth/callback";
const silent = { info() {}, warn() {} };

const mount = {
  id: "vendor/svc",
  pack: "vendor",
  prefix: "svc",
  url: SERVER_URL,
  headers: {},
  oauth: true as const,
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** The mock vendor: authorization server and MCP server. */
class Vendor {
  clients = new Map<string, { redirect_uris: string[] }>();
  codes = new Map<string, { client: string; challenge: string; redirect: string }>();
  access = new Set<string>();
  refresh = new Set<string>();
  registrations = 0;
  tokenGrants: string[] = [];
  /** Hosts every request went to. */
  hosts: string[] = [];
  /** Authorization headers the MCP endpoint saw. */
  bearers: string[] = [];
  server: McpServer | null = null;
  transport: WebStandardStreamableHTTPServerTransport | null = null;

  async startMcp(): Promise<void> {
    const server = new McpServer({ name: "mock-vendor", version: "1.0.0" });
    server.registerTool(
      "echo",
      { description: "Echo", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: "text", text }] }),
    );
    this.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(8).toString("hex"),
    });
    await server.connect(this.transport);
    this.server = server;
  }

  issue(): { access_token: string; refresh_token: string; token_type: string; expires_in: number } {
    const a = `at-${randomBytes(12).toString("hex")}`;
    const r = `rt-${randomBytes(12).toString("hex")}`;
    this.access.add(a);
    this.refresh.add(r);
    return { access_token: a, refresh_token: r, token_type: "Bearer", expires_in: 3600 };
  }

  /** The user approves at the vendor: the code the browser carries back. */
  approve(authorizationUrl: string): URLSearchParams {
    const u = new URL(authorizationUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`${AS}/authorize`);
    const client = u.searchParams.get("client_id") as string;
    expect(this.clients.has(client)).toBe(true);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    const code = `code-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, {
      client,
      challenge: u.searchParams.get("code_challenge") as string,
      redirect: REDIRECT,
    });
    return new URLSearchParams({ code, state: u.searchParams.get("state") as string });
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    this.hosts.push(url.host);
    if (url.origin === AS) return this.authServer(req, url);
    if (url.origin === MCP) return this.resource(req, url);
    return new Response("no such host", { status: 502 });
  }) as typeof fetch;

  private async authServer(req: Request, url: URL): Promise<Response> {
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        registration_endpoint: `${AS}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const body = (await req.json()) as { redirect_uris: string[]; client_name?: string };
      expect(body.client_name).toBe("plughive");
      this.registrations++;
      const id = `client-${this.registrations}`;
      this.clients.set(id, { redirect_uris: body.redirect_uris });
      return json({ ...body, client_id: id }, 201);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const grant = form.get("grant_type") as string;
      this.tokenGrants.push(grant);
      if (grant === "authorization_code") {
        const entry = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !entry ||
          entry.client !== form.get("client_id") ||
          entry.challenge !== challenge ||
          entry.redirect !== form.get("redirect_uri")
        ) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json(this.issue());
      }
      if (grant === "refresh_token") {
        const r = form.get("refresh_token") ?? "";
        if (!this.refresh.has(r)) return json({ error: "invalid_grant" }, 400);
        this.refresh.delete(r);
        return json(this.issue());
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    return new Response("not found", { status: 404 });
  }

  private async resource(req: Request, url: URL): Promise<Response> {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: SERVER_URL, authorization_servers: [AS] });
    }
    if (url.pathname.startsWith("/.well-known/")) return new Response("", { status: 404 });
    const auth = req.headers.get("authorization") ?? "";
    this.bearers.push(auth);
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!this.access.has(token)) {
      return new Response("unauthorized", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    return (this.transport as WebStandardStreamableHTTPServerTransport).handleRequest(req);
  }
}

let home: string;
let store: LayeredSecretStore;
let vendor: Vendor;
let mounts: PackMounts;
let oauth: MountOAuth;
let clock = 0;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "plughive-oauth-"));
  store = createSecretStore({ home, env: {}, backend: "memory" });
  vendor = new Vendor();
  await vendor.startMcp();
  clock = Date.now();
  // Public-looking names: the policy checks run; the seam delivers in process.
  mounts = new PackMounts({
    logger: silent,
    fetch: vendor.fetch,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    reconnectBaseMs: 10,
    oauth: {
      provider: (m) => oauth.provider(m),
      signedIn: (m) => oauth.signedIn(m),
    },
  });
  oauth = new MountOAuth({
    store,
    fetchFor: (m) => mounts.oauthFetch(m),
    logger: silent,
    redirectUrl: () => REDIRECT,
    now: () => clock,
  });
});

afterEach(async () => {
  await mounts.stop();
  await vendor.server?.close();
  rmSync(home, { recursive: true, force: true });
});

const provider = { resolvedMounts: async () => [mount] };

async function signIn(): Promise<void> {
  const { authorizationUrl } = await oauth.start(mount);
  const result = await oauth.finish(vendor.approve(authorizationUrl));
  expect(result).toEqual({ ok: true, mountId: mount.id });
}

describe("OAuth mounts", () => {
  it("a mount nobody signed in to needs sign-in and makes no request", async () => {
    await mounts.sync(provider);
    expect(mounts.connection(mount.id)).toEqual({
      connected: false,
      tools: 0,
      error: MOUNT_NEEDS_SIGN_IN,
    });
    expect(vendor.hosts).toEqual([]);
    expect(await oauth.signedIn(mount)).toBe(false);
  });

  it("discovers, registers, redirects with state, exchanges the code and stores the tokens", async () => {
    const { authorizationUrl } = await oauth.start(mount);
    expect(vendor.registrations).toBe(1);
    const u = new URL(authorizationUrl);
    const state = u.searchParams.get("state") as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("resource")).toBe(SERVER_URL);
    expect(oauth.pendingFor(mount.id)).toBe(true);
    // The verifier waits in the store; nothing else yet.
    const names = oauthSecretNames(mount.id);
    expect(await store.getStored(names.verifier)).toContain(mount.id);
    expect(await store.getStored(names.tokens)).toBeNull();

    const result = await oauth.finish(vendor.approve(authorizationUrl));
    expect(result).toEqual({ ok: true, mountId: mount.id });
    expect(vendor.tokenGrants).toEqual(["authorization_code"]);
    expect(oauth.pendingFor(mount.id)).toBe(false);

    const tokens = JSON.parse((await store.getStored(names.tokens)) as string);
    expect(tokens).toMatchObject({ v: 1, mount: mount.id, url: SERVER_URL });
    expect(tokens.data.access_token).toMatch(/^at-/);
    expect(JSON.parse((await store.getStored(names.client)) as string).data.info.client_id).toBe(
      "client-1",
    );
    // The verifier is gone once the sign-in completed.
    expect(await store.getStored(names.verifier)).toBeNull();
    // Token strings are redacted from logs.
    expect(store.redactor.redact(`token ${tokens.data.access_token}`)).not.toContain(
      tokens.data.access_token,
    );

    // The connection now carries the bearer token.
    await mounts.sync(provider);
    expect(mounts.connection(mount.id)).toMatchObject({ connected: true, tools: 1, error: null });
    expect(vendor.bearers.at(-1)).toBe(`Bearer ${tokens.data.access_token}`);
    const out = (await mounts.call(mount.id, "echo", { text: "hi" })) as {
      content: { text: string }[];
    };
    expect(out.content[0]?.text).toBe("hi");
  });

  it("the OAuth requests stay with the mount's server and its https authorization server", async () => {
    await signIn();
    expect(new Set(vendor.hosts)).toEqual(new Set(["mcp.example.test", "auth.example.test"]));
    const f = mounts.oauthFetch(mount);
    await expect(f.fetch("http://auth.example.test/token")).rejects.toThrow();
    await expect(f.fetch("https://127.0.0.1/token")).rejects.toThrow();
    await f.close();
  });

  it("refreshes an access token the server stopped accepting", async () => {
    await signIn();
    await mounts.sync(provider);
    const names = oauthSecretNames(mount.id);
    const before = JSON.parse((await store.getStored(names.tokens)) as string).data;
    vendor.access.clear(); // the access token expired
    const out = (await mounts.call(mount.id, "echo", { text: "again" })) as {
      content: { text: string }[];
    };
    expect(out.content[0]?.text).toBe("again");
    expect(vendor.tokenGrants).toEqual(["authorization_code", "refresh_token"]);
    const after = JSON.parse((await store.getStored(names.tokens)) as string).data;
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).not.toBe(before.refresh_token);
  });

  it("a refused refresh turns the mount to needs sign-in", async () => {
    await signIn();
    await mounts.sync(provider);
    vendor.access.clear();
    vendor.refresh.clear();
    await expect(mounts.call(mount.id, "echo", { text: "x" })).rejects.toThrow(MOUNT_NEEDS_SIGN_IN);
    expect(mounts.connection(mount.id)).toMatchObject({
      connected: false,
      error: MOUNT_NEEDS_SIGN_IN,
    });
  });

  it("refuses an unknown, reused or expired state, and a declined sign-in", async () => {
    const { authorizationUrl } = await oauth.start(mount);
    const good = vendor.approve(authorizationUrl);
    const forged = new URLSearchParams({ code: good.get("code") as string, state: "x".repeat(43) });
    expect(await oauth.finish(forged)).toEqual({ ok: false, reason: "invalid_state" });
    expect(await oauth.finish(new URLSearchParams({ code: "c" }))).toEqual({
      ok: false,
      reason: "invalid_state",
    });
    // The forged state did not burn the real one, and no code was exchanged.
    expect(vendor.tokenGrants).toEqual([]);
    expect((await oauth.finish(good)).ok).toBe(true);
    // Single use.
    expect(await oauth.finish(good)).toEqual({ ok: false, reason: "invalid_state" });

    // Expired.
    const late = await oauth.start(mount);
    const lateParams = vendor.approve(late.authorizationUrl);
    clock += 11 * 60_000;
    expect(await oauth.finish(lateParams)).toEqual({
      ok: false,
      reason: "expired",
      mountId: mount.id,
    });

    // Declined at the vendor.
    const declined = await oauth.start(mount);
    const state = new URL(declined.authorizationUrl).searchParams.get("state") as string;
    expect(await oauth.finish(new URLSearchParams({ state, error: "access_denied" }))).toEqual({
      ok: false,
      reason: "denied",
      mountId: mount.id,
    });
    expect(await store.getStored(oauthSecretNames(mount.id).verifier)).toBeNull();
    expect(vendor.tokenGrants).toEqual(["authorization_code"]);
  });

  it("a new sign-in replaces the state of the previous one for the same mount", async () => {
    const first = await oauth.start(mount);
    const firstParams = vendor.approve(first.authorizationUrl);
    const second = await oauth.start(mount);
    expect(await oauth.finish(firstParams)).toEqual({ ok: false, reason: "invalid_state" });
    expect((await oauth.finish(vendor.approve(second.authorizationUrl))).ok).toBe(true);
    // The client registered for this redirect is reused.
    expect(vendor.registrations).toBe(1);
  });

  it("records are bound to their mount and server url", async () => {
    await signIn();
    const moved = { ...mount, url: "https://mcp.example.test/other" };
    expect(await oauth.signedIn(mount)).toBe(true);
    expect(await oauth.signedIn(moved)).toBe(false);
    expect(await oauth.signedIn({ ...mount, id: "other/svc" })).toBe(false);
  });

  it("sign-out deletes the tokens and the registration; the mount needs sign-in again", async () => {
    await signIn();
    await mounts.sync(provider);
    expect(mounts.connection(mount.id).connected).toBe(true);
    await oauth.signOut(mount);
    const names = oauthSecretNames(mount.id);
    for (const name of Object.values(names)) expect(await store.getStored(name)).toBeNull();
    await mounts.reset(mount.id);
    await mounts.sync(provider);
    expect(mounts.connection(mount.id)).toEqual({
      connected: false,
      tools: 0,
      error: MOUNT_NEEDS_SIGN_IN,
    });
  });

  it("refreshes the mount's tools on tools/list_changed", async () => {
    await signIn();
    await mounts.sync(provider);
    expect(mounts.connection(mount.id).tools).toBe(1);
    vendor.server?.registerTool(
      "shout",
      { description: "Shout", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }),
    );
    await expect
      .poll(
        () =>
          mounts
            .list()
            .map((t) => t.upstreamName)
            .sort(),
        { timeout: 5000 },
      )
      .toEqual(["echo", "shout"]);
  });

  it("packs and user mounts cannot name the OAuth records", () => {
    for (const name of Object.values(oauthSecretNames(mount.id))) {
      expect(isDeniedSecretName(name)).toBe(true);
    }
  });

  it("derives distinct, valid names from the full mount id", () => {
    const long = "a".repeat(60);
    const ids = [
      "vendor/my-app",
      "vendor/my_app",
      "vendor-my/app",
      `${long}/one`,
      `${long}/two`,
      "x".repeat(64),
      "x".repeat(65),
    ];
    const seen = new Set<string>();
    for (const id of ids) {
      const names = oauthSecretNames(id);
      expect(names).toEqual(oauthSecretNames(id));
      for (const name of Object.values(names)) {
        expect(isValidSecretName(name)).toBe(true);
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
    expect(oauthSecretNames("vendor/my-app").tokens).toMatch(
      /^OAUTH_VENDOR_MY_APP_[0-9A-F]{12}_TOKENS$/,
    );
  });

  it("one mount cannot read another's sign-in when their ids look alike", async () => {
    await signIn();
    const twin = { ...mount, id: "vendor/svc".replace("/", "_") };
    expect(await oauth.signedIn(twin)).toBe(false);
    expect(await oauth.signedIn({ ...mount, id: "vendor/svc-" })).toBe(false);
    await oauth.signOut(twin);
    expect(await oauth.signedIn(mount)).toBe(true);
  });

  it("refuses a mount whose names would collide with another's", async () => {
    // Force a collision past the hash: a second mount claiming the same names.
    const names = oauth.claim(mount);
    (oauth as unknown as { owners: Map<string, string> }).owners.set(names.tokens, "other/svc");
    expect(() => oauth.provider(mount)).toThrow(OAuthNameCollisionError);
    await expect(oauth.start(mount)).rejects.toThrow(OAuthNameCollisionError);

    const warned: unknown[] = [];
    const kept = refuseOAuthNameClashes(
      [
        { id: "a/svc", oauth: true as const },
        { id: "a/svc", oauth: true as const },
        { id: "b/svc", oauth: true as const },
        { id: "c/plain" },
      ],
      { warn: (o: unknown) => warned.push(o) },
    );
    // Same id twice is the same mount, not a clash; different ids never clash.
    expect(kept.map((m) => m.id)).toEqual(["a/svc", "a/svc", "b/svc", "c/plain"]);
    expect(warned).toEqual([]);
    // Were two ids ever to map to the same names, the second is left out.
    const clash = refuseOAuthNameClashes(
      [
        { id: "a/svc", oauth: true as const },
        { id: "b/svc", oauth: true as const },
      ],
      { warn: (o: unknown) => warned.push(o) },
      () => "OAUTH_SAME_TOKENS",
    );
    expect(clash.map((m) => m.id)).toEqual(["a/svc"]);
    expect(warned).toEqual([{ mount: "b/svc", other: "a/svc" }]);
  });
});

describe("the authorization page the server points at", () => {
  const metadataFetch = (authorizationEndpoint: string, resource: string): typeof fetch =>
    (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.includes("oauth-protected-resource")) {
        return json({ resource, authorization_servers: [AS] });
      }
      if (url.pathname.includes("oauth-authorization-server")) {
        return json({
          issuer: AS,
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: `${AS}/token`,
          registration_endpoint: `${AS}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register") {
        return json({ client_id: "client-1", redirect_uris: [REDIRECT] }, 201);
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

  let n = 0;
  // A fresh mount id per call: the discovery record is bound to the mount, and
  // a second start would reuse the first one's cached metadata.
  const startWith = (authorizationEndpoint: string, mountUrl: string, daemonPorts: number[]) => {
    n += 1;
    const o = new MountOAuth({
      store,
      fetchFor: () => ({
        fetch: metadataFetch(authorizationEndpoint, mountUrl),
        close: async () => {},
      }),
      logger: silent,
      redirectUrl: () => REDIRECT,
      now: () => clock,
      daemonPorts,
    });
    return o.start({ id: `vendor/svc-${n}`, pack: "vendor", prefix: "svc", url: mountUrl });
  };

  it("refuses a local sign-in page for a public mount, including the daemon's own port", async () => {
    for (const ep of [
      "http://127.0.0.1:8080/authorize",
      "http://localhost:8080/authorize",
      "http://127.0.0.1:7777/authorize",
      "https://192.168.0.10/authorize",
      "http://[::1]:8080/authorize",
    ]) {
      await expect(startWith(ep, SERVER_URL, [7777]), ep).rejects.toThrow(/not allowed/);
    }
  });

  it("allows a local sign-in page only for a loopback mount, never on the daemon's port", async () => {
    const localMount = "http://127.0.0.1:9999/mcp";
    const ok = await startWith("http://127.0.0.1:8080/authorize", localMount, [7777]);
    expect(ok.authorizationUrl.startsWith("http://127.0.0.1:8080/authorize")).toBe(true);
    await expect(startWith("http://127.0.0.1:7777/authorize", localMount, [7777])).rejects.toThrow(
      /not allowed/,
    );
  });
});

describe("redactor registration of sign-in values", () => {
  it("registers the registration access token, and a verifier reloaded by a fresh instance", async () => {
    const noopFetch = () => ({
      fetch: (async () => new Response("nf", { status: 404 })) as typeof fetch,
      close: async () => {},
    });
    const o = new MountOAuth({
      store,
      fetchFor: noopFetch,
      logger: silent,
      redirectUrl: () => REDIRECT,
    });
    const first = new MountOAuthProvider({
      mount,
      store,
      redirectUrl: REDIRECT,
      interactive: true,
    });
    await first.saveClientInformation({
      client_id: "client-1",
      registration_access_token: "reg-access-token-0123456789",
    } as never);
    await first.saveCodeVerifier("pkce-verifier-9876543210");
    // A fresh provider over the same store, as after a daemon restart.
    const restarted = new MountOAuthProvider({
      mount,
      store,
      redirectUrl: REDIRECT,
      interactive: false,
    });
    const info = (await restarted.clientInformation()) as Record<string, unknown>;
    expect(info?.registration_access_token).toBe("reg-access-token-0123456789");
    expect(await restarted.codeVerifier()).toBe("pkce-verifier-9876543210");
    const redacted = store.redactor.redact(
      "leak reg-access-token-0123456789 and pkce-verifier-9876543210",
    );
    expect(redacted).not.toContain("reg-access-token-0123456789");
    expect(redacted).not.toContain("pkce-verifier-9876543210");
    void o;
  });
});
