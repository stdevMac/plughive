// H1: the management API has its own credential. Everything under /api needs
// the admin token (or a dashboard session opened with it) in every
// configuration; the access key is the agents' credential and does not open
// /api, and the admin token does not open /mcp.
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FAILED_LOGINS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createAdminAuth,
} from "../../src/core/http/admin-auth.js";
import type { OriginPolicy } from "../../src/core/http/origin.js";
import { type FullHarness, bootFull } from "./full-harness.js";
import { ADMIN_AUTH, ADMIN_TOKEN, type LiteHarness, bootLite, mockTool } from "./harness.js";

const CSRF = { "x-plughive-csrf": "1", "content-type": "application/json" };
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
});

/** Every route express serves under /api, read from the app itself. */
function apiRoutes(app: express.Express): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const prefixOf = (regexp: RegExp): string =>
    regexp.source
      .replace(/^\^/, "")
      .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
      .replace(/\\\//g, "/");
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths: string[] = Array.isArray(layer.route.path)
          ? layer.route.path
          : [layer.route.path];
        for (const p of paths) {
          for (const method of Object.keys(layer.route.methods)) {
            const full = `${prefix}${p === "/" ? "" : p}`.replace(/:[A-Za-z_]+/g, "x");
            out.push([method.toUpperCase(), full]);
          }
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + prefixOf(layer.regexp));
      }
    }
  };
  walk((app as any)._router.stack, "");
  return out.filter(([, path]) => path === "/api" || path.startsWith("/api/"));
}

const cookieOf = (res: Response): string =>
  (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

describe("H1: /api on a loopback daemon without an access key", () => {
  let h: FullHarness;
  beforeEach(async () => {
    h = await bootFull({ accessKey: null });
  });
  afterEach(() => h.close());

  it("every /api route answers 401 without a credential", async () => {
    const routes = apiRoutes(h.app.app).filter(([, path]) => path !== "/api/session");
    // The walk found the API: reads, writes, the event stream and the playground call.
    const names = routes.map(([m, p]) => `${m} ${p}`);
    expect(routes.length).toBeGreaterThanOrEqual(30);
    for (const expected of [
      "GET /api/packs",
      "POST /api/mounts",
      "PUT /api/secrets/x/x",
      "GET /api/events",
      "POST /api/tools/x/call",
      "PUT /api/profiles/x",
      "GET /api/artifacts",
      "GET /api/usage",
    ]) {
      expect(names, expected).toContain(expected);
    }
    const refused: Array<Record<string, string>> = [
      {},
      { authorization: "Bearer wrong-token-wrong-token-wrong" },
      { cookie: `${SESSION_COOKIE}=nope` },
    ];
    for (const [method, path] of routes) {
      for (const cred of refused) {
        const res = await fetch(`${h.base}${path}`, {
          method,
          headers: { ...CSRF, ...cred },
          ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
        });
        expect(res.status, `${method} ${path}`).toBe(401);
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
      }
    }
  });

  it("the review's proof of concept: an unauthenticated POST /api/mounts creates nothing", async () => {
    const body = JSON.stringify({
      id: "poc",
      prefix: "poc",
      transport: "stdio",
      command: "/usr/bin/touch",
      args: ["/nonexistent-dir/poc"],
    });
    const res = await fetch(`${h.base}/api/mounts`, { method: "POST", headers: CSRF, body });
    expect(res.status).toBe(401);
    const mounts = (await (
      await fetch(`${h.base}/api/mounts`, { headers: ADMIN_AUTH })
    ).json()) as {
      mounts: Array<{ id: string }>;
    };
    expect(mounts.mounts.map((m) => m.id)).not.toContain("poc");
  });

  it("the event stream needs the credential", async () => {
    const none = await fetch(`${h.base}/api/events`);
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/json");
    const abort = new AbortController();
    const stream = await fetch(`${h.base}/api/events`, {
      headers: ADMIN_AUTH,
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    abort.abort();
  });

  it("/health and /mcp stay open on loopback without an access key", async () => {
    expect((await fetch(`${h.base}/health`)).status).toBe(200);
    const mcp = await fetch(`${h.base}/mcp`, { method: "POST", headers: MCP_HEADERS, body: INIT });
    expect(mcp.status).toBe(200);
    await mcp.body?.cancel();
  });
});

describe("H1: the access key and the admin token are different credentials", () => {
  const KEY = "agents-access-key-0123456789abcdef";
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ accessKey: KEY, packs: { demo: [mockTool("quick", async () => 1)] } });
  });
  afterEach(() => h.close());

  it("the access key alone gets 401 on /api, in either header", async () => {
    for (const cred of [{ authorization: `Bearer ${KEY}` }, { "x-api-key": KEY }] as Array<
      Record<string, string>
    >) {
      for (const [method, path] of [
        ["GET", "/api/tools"],
        ["GET", "/api/profiles"],
        ["GET", "/api/events"],
        ["PUT", "/api/profiles/p1"],
        ["POST", "/api/tools/quick/call"],
        ["POST", "/api/session"],
      ] as const) {
        const res = await fetch(`${h.base}${path}`, {
          method,
          headers: { ...CSRF, ...cred },
          ...(method === "GET" ? {} : { body: JSON.stringify({ token: KEY, name: "P" }) }),
        });
        expect(res.status, `${method} ${path}`).toBe(401);
        await res.body?.cancel();
      }
    }
    expect((await fetch(`${h.base}/api/tools`, { headers: ADMIN_AUTH })).status).toBe(200);
  });

  it("the admin token does not open /mcp, /p or /artifacts when an access key is set", async () => {
    for (const path of ["/mcp", "/p/default/mcp"]) {
      const res = await fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { ...MCP_HEADERS, ...ADMIN_AUTH },
        body: INIT,
      });
      expect(res.status, path).toBe(401);
      await res.body?.cancel();
      const keyed = await fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { ...MCP_HEADERS, authorization: `Bearer ${KEY}` },
        body: INIT,
      });
      expect(keyed.status, path).toBe(200);
      await keyed.body?.cancel();
    }
    expect((await fetch(`${h.base}/artifacts/abc`, { headers: ADMIN_AUTH })).status).toBe(401);
  });

  it("a session cookie does not open /mcp either", async () => {
    const login = await fetch(`${h.base}/api/session`, {
      method: "POST",
      headers: CSRF,
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const cookie = cookieOf(login);
    expect(cookie).toContain(SESSION_COOKIE);
    const res = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, cookie },
      body: INIT,
    });
    expect(res.status).toBe(401);
  });
});

describe("H1: dashboard sessions", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ packs: { demo: [mockTool("quick", async () => 1)] } });
  });
  afterEach(() => h.close());

  const login = (token: unknown, headers: Record<string, string> = CSRF) =>
    fetch(`${h.base}/api/session`, { method: "POST", headers, body: JSON.stringify({ token }) });

  it("GET /api/session answers without a credential", async () => {
    const res = await fetch(`${h.base}/api/session`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, authenticated: false });
    const bearer = await fetch(`${h.base}/api/session`, { headers: ADMIN_AUTH });
    expect(await bearer.json()).toEqual({ ok: true, authenticated: true });
  });

  it("login sets an HttpOnly SameSite=Strict cookie scoped to /api that opens the API; logout ends it", async () => {
    const res = await login(ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, authenticated: true });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; `));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api");
    expect(setCookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(setCookie).not.toContain("Secure");
    // The cookie is a session id, not the token.
    expect(setCookie).not.toContain(ADMIN_TOKEN);
    const cookie = cookieOf(res);

    expect((await fetch(`${h.base}/api/tools`, { headers: { cookie } })).status).toBe(200);
    expect(await (await fetch(`${h.base}/api/session`, { headers: { cookie } })).json()).toEqual({
      ok: true,
      authenticated: true,
    });
    // A cookie makes the browser rules matter: writes still need the CSRF rule.
    const noCsrf = await fetch(`${h.base}/api/profiles/p1`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "P" }),
    });
    expect(noCsrf.status).toBe(403);
    const foreign = await fetch(`${h.base}/api/tools`, {
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    const write = await fetch(`${h.base}/api/profiles/p1`, {
      method: "PUT",
      headers: { ...CSRF, cookie },
      body: JSON.stringify({ name: "P" }),
    });
    expect(write.status).toBe(201);

    const out = await fetch(`${h.base}/api/session`, {
      method: "DELETE",
      headers: { ...CSRF, cookie },
    });
    expect(await out.json()).toEqual({ ok: true, authenticated: false });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(`${h.base}/api/tools`, { headers: { cookie } })).status).toBe(401);
  });

  it("login needs the CSRF rule, a JSON body and the right token", async () => {
    expect((await login(ADMIN_TOKEN, { "content-type": "application/json" })).status).toBe(403);
    expect((await login(ADMIN_TOKEN, { ...CSRF, origin: "https://evil.example" })).status).toBe(
      403,
    );
    for (const bad of [undefined, 7, "", { nested: true }]) {
      const res = await login(bad);
      expect(res.status).toBe(400);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const malformed = await fetch(`${h.base}/api/session`, {
      method: "POST",
      headers: CSRF,
      body: "{nope",
    });
    expect(malformed.status).toBe(400);
    const wrong = await login("x".repeat(43));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(await wrong.json())).not.toContain(ADMIN_TOKEN);
  });

  it("L1: wrong tokens are rate-limited; the right token still opens a session while locked out", async () => {
    for (let i = 0; i < MAX_FAILED_LOGINS; i++)
      expect((await login(`wrong-${i}`)).status).toBe(401);
    const locked = await login("wrong-again");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await locked.json()).toMatchObject({ ok: false, error: { code: "TOO_MANY_ATTEMPTS" } });
    // Guessing cannot lock the holder of the token out of the dashboard.
    const right = await login(ADMIN_TOKEN);
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toContain(SESSION_COOKIE);
    expect((await login("wrong-after")).status).toBe(429);
    // A forwarded header does not make a new address.
    expect((await login("wrong-fwd", { ...CSRF, "x-forwarded-for": "203.0.113.9" })).status).toBe(
      429,
    );
    // The holder of the token is not locked out of the API itself.
    expect((await fetch(`${h.base}/api/tools`, { headers: ADMIN_AUTH })).status).toBe(200);
  });
});

describe("H1: session store (unit)", () => {
  const policy: OriginPolicy = {
    base: () => "http://127.0.0.1:1",
    isOwn: () => false,
    isAllowed: () => false,
  };
  const boot = (opts: Partial<Parameters<typeof createAdminAuth>[0]> = {}) => {
    let t = 1_000_000;
    const auth = createAdminAuth({ token: ADMIN_TOKEN, now: () => t, ...opts });
    const app = express();
    auth.mountSession(app, policy);
    return { auth, app, advance: (ms: number) => void (t += ms) };
  };
  const serve = async (app: express.Express) => {
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    return {
      base: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  };
  const req = (cookie?: string, bearer?: string) =>
    ({
      header: (name: string) =>
        name.toLowerCase() === "cookie"
          ? cookie
          : name.toLowerCase() === "authorization"
            ? bearer
            : undefined,
    }) as never;

  it("sessions slide for 30 days, expire, are capped, and the failure window reopens", async () => {
    const { auth, app, advance } = boot({ maxSessions: 2, maxFailedLogins: 2 });
    const s = await serve(app);
    try {
      const login = async (token = ADMIN_TOKEN) => {
        const res = await fetch(`${s.base}/api/session`, {
          method: "POST",
          headers: CSRF,
          body: JSON.stringify({ token }),
        });
        return { status: res.status, cookie: cookieOf(res) };
      };
      const a = await login();
      expect(auth.isAuthenticated(req(a.cookie))).toBe(true);
      advance(SESSION_TTL_MS - 1000);
      expect(auth.isAuthenticated(req(a.cookie))).toBe(true); // slides
      advance(SESSION_TTL_MS - 1000);
      expect(auth.isAuthenticated(req(a.cookie))).toBe(true);
      advance(SESSION_TTL_MS + 1);
      expect(auth.isAuthenticated(req(a.cookie))).toBe(false);
      expect(auth.sessions()).toBe(0);

      const b = await login();
      const c = await login();
      expect(auth.isAuthenticated(req(b.cookie))).toBe(true); // b is now the most recently used
      const d = await login();
      expect(auth.sessions()).toBe(2);
      expect(auth.isAuthenticated(req(c.cookie))).toBe(false); // the least recently used went
      expect(auth.isAuthenticated(req(b.cookie))).toBe(true);
      expect(auth.isAuthenticated(req(d.cookie))).toBe(true);

      expect((await login("wrong-1")).status).toBe(401);
      expect((await login("wrong-2")).status).toBe(401);
      expect((await login("wrong-3")).status).toBe(429);
      expect((await login()).status).toBe(200);
      advance(60_001);
      expect((await login("wrong-4")).status).toBe(401);

      expect(auth.isAuthenticated(req(undefined, `Bearer ${ADMIN_TOKEN}`))).toBe(true);
      expect(auth.isAuthenticated(req(undefined, `Bearer ${ADMIN_TOKEN}x`))).toBe(false);
      expect(auth.isAuthenticated(req(`${SESSION_COOKIE}=${ADMIN_TOKEN}`))).toBe(false);
      auth.close();
      expect(auth.isAuthenticated(req(d.cookie))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it("the cookie is Secure when the daemon is reached over https", async () => {
    const { app } = boot({ secureCookie: true });
    const s = await serve(app);
    try {
      const res = await fetch(`${s.base}/api/session`, {
        method: "POST",
        headers: CSRF,
        body: JSON.stringify({ token: ADMIN_TOKEN }),
      });
      expect(res.headers.get("set-cookie")).toContain("; Secure");
    } finally {
      await s.close();
    }
  });

  // L1: failures count per remote address, under a higher global ceiling, in a bounded map.
  const fromAddress = (opts: Partial<Parameters<typeof createAdminAuth>[0]> = {}) =>
    boot({ remoteAddress: (r) => r.header("x-test-address") ?? "none", ...opts });
  const loginFrom = (base: string, address: string, token: string) =>
    fetch(`${base}/api/session`, {
      method: "POST",
      headers: { ...CSRF, "x-test-address": address },
      body: JSON.stringify({ token }),
    }).then((r) => r.status);

  it("L1: one address locked out does not lock out another", async () => {
    const { app } = fromAddress({ maxFailedLogins: 3 });
    const s = await serve(app);
    try {
      for (let i = 0; i < 3; i++)
        expect(await loginFrom(s.base, "10.0.0.1", `wrong-${i}`)).toBe(401);
      expect(await loginFrom(s.base, "10.0.0.1", "wrong")).toBe(429);
      expect(await loginFrom(s.base, "10.0.0.2", "wrong")).toBe(401);
      expect(await loginFrom(s.base, "10.0.0.1", ADMIN_TOKEN)).toBe(200);
    } finally {
      await s.close();
    }
  });

  it("L1: the global ceiling locks every address out of wrong guesses, never the right token", async () => {
    const { app, advance } = fromAddress({ maxFailedLogins: 3, maxFailedLoginsGlobal: 5 });
    const s = await serve(app);
    try {
      for (let i = 0; i < 5; i++) expect(await loginFrom(s.base, `10.0.1.${i}`, "wrong")).toBe(401);
      expect(await loginFrom(s.base, "10.0.2.1", "wrong")).toBe(429);
      expect(await loginFrom(s.base, "10.0.2.1", ADMIN_TOKEN)).toBe(200);
      advance(60_001);
      expect(await loginFrom(s.base, "10.0.2.1", "wrong")).toBe(401);
    } finally {
      await s.close();
    }
  });

  it("L1: the failure map is bounded; the address with the oldest failure is forgotten first", async () => {
    const { auth, app, advance } = fromAddress({ maxFailedLogins: 2, maxTrackedAddresses: 4 });
    const s = await serve(app);
    try {
      for (let i = 0; i < 2; i++) expect(await loginFrom(s.base, "10.0.3.0", "wrong")).toBe(401);
      expect(await loginFrom(s.base, "10.0.3.0", "wrong")).toBe(429);
      for (let i = 1; i <= 20; i++) {
        advance(1);
        await loginFrom(s.base, `10.0.3.${i}`, "wrong");
        expect(auth.failedAddresses()).toBeLessThanOrEqual(4);
      }
      // The first address was evicted, so its count starts again.
      expect(await loginFrom(s.base, "10.0.3.0", "wrong")).toBe(401);
      // Expired entries go before live ones.
      advance(60_001);
      expect(await loginFrom(s.base, "10.0.4.0", "wrong")).toBe(401);
      expect(auth.failedAddresses()).toBe(1);
    } finally {
      await s.close();
    }
  });
});
