import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BlockedRequestError,
  ResponseTooLargeError,
  type SafeFetch,
  type SafeFetchPolicy,
  SafeFetchTimeoutError,
  type SafeLookup,
  assertPublicUrl,
  createSafeFetch,
} from "../../../src/core/net/safe-fetch.js";

const T = 60_000;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface TestServer {
  server: Server;
  port: number;
  hits: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }>;
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function startServer(handler: Handler, host = "127.0.0.1", port = 0): Promise<TestServer> {
  const hits: TestServer["hits"] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  await listen(server, host, port);
  return {
    server,
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Resolver backed by a table. Unknown names fail, so no test ever hits real DNS. */
function tableLookup(table: Record<string, string[]>): SafeLookup & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (hostname: string) => {
    calls.push(hostname);
    const addresses = table[hostname];
    if (!addresses) throw new Error("ENOTFOUND");
    return addresses.map((address) => ({ address }));
  };
  return Object.assign(fn, { calls });
}

const noDns: SafeLookup = async () => {
  throw new Error("ENOTFOUND");
};

const servers: TestServer[] = [];
const fetchers: SafeFetch[] = [];

async function serve(handler: Handler, host?: string, port?: number): Promise<TestServer> {
  const started = await startServer(handler, host, port);
  servers.push(started);
  return started;
}

function fetcher(policy: SafeFetchPolicy): SafeFetch {
  const created = createSafeFetch(policy);
  fetchers.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(fetchers.splice(0).map((f) => f.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function blockedReason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof BlockedRequestError) return err.reason;
    throw err;
  }
  return "NOT_BLOCKED";
}

// ---------------------------------------------------------------------------

describe("assertPublicUrl: literal address forms", () => {
  const open: SafeFetchPolicy = {
    allowHosts: ["*"],
    allowedProtocols: ["http:", "https:"],
    lookup: tableLookup({
      localhost: ["127.0.0.1"],
      "evil.test": ["10.0.0.5"],
      "mixed.test": ["93.184.216.34", "192.168.1.10"],
      "v6private.test": ["fd00::1"],
      "mapped.test": ["::ffff:127.0.0.1"],
      "public.test": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
      "junk.test": ["not-an-ip"],
    }),
  };

  const privateUrls = [
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/admin",
    "http://2130706433/", // decimal
    "http://0x7f000001/", // hex
    "http://0x7f.0x0.0x0.0x1/", // hex octets
    "http://0177.0.0.1/", // octal
    "http://017700000001/", // octal whole
    "http://127.1/", // short form
    "http://127.0.1/",
    "http://0/",
    "http://0.0.0.0/",
    "http://127.0.0.1./", // trailing dot
    "http://１２７.０.０.１/", // fullwidth digits
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://224.0.0.1/",
    "http://255.255.255.255/",
    "http://[::1]/",
    "http://[::]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::FFFF:169.254.169.254]/",
    "http://[0:0:0:0:0:ffff:a00:1]/",
    "http://[64:ff9b::a00:1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[ff02::1]/",
    "http://[2001:db8::1]/",
    "http://[2002:7f00:1::]/",
    "http://LOCALHOST/",
    "http://localhost./",
    "http://evil.test/",
    "http://mixed.test/", // one private answer poisons the whole set
    "http://v6private.test/",
    "http://mapped.test/",
  ];
  for (const url of privateUrls) {
    it(`rejects ${JSON.stringify(url)}`, async () => {
      expect(await blockedReason(assertPublicUrl(url, open))).toBe("private_address");
    });
  }

  it("accepts public literals and names", async () => {
    for (const url of [
      "https://8.8.8.8/",
      "http://1.1.1.1/x",
      "https://172.32.0.1/",
      "https://[2606:4700:4700::1111]/",
      "https://public.test/path?q=1",
    ]) {
      await expect(assertPublicUrl(url, open)).resolves.toBeInstanceOf(URL);
    }
  });

  it("returns the normalised URL", async () => {
    const url = await assertPublicUrl("HTTPS://Public.Test./a", open);
    expect(url.href).toBe("https://public.test/a");
  });

  it("rejects unresolvable names and junk answers as dns_failure", async () => {
    expect(await blockedReason(assertPublicUrl("https://nx.test/", open))).toBe("dns_failure");
    expect(await blockedReason(assertPublicUrl("https://junk.test/", open))).toBe("dns_failure");
  });

  it("rejects non-http protocols", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://public.test/",
      "gopher://public.test/",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "ws://public.test/",
    ]) {
      expect(await blockedReason(assertPublicUrl(url, open))).toBe("protocol_not_allowed");
    }
  });

  it("rejects malformed URLs", async () => {
    for (const url of ["", "not a url", "http://", "//public.test/", "http://[::1/"]) {
      expect(await blockedReason(assertPublicUrl(url, open))).toBe("invalid_url");
    }
  });

  it("rejects embedded credentials without echoing them", async () => {
    try {
      await assertPublicUrl("https://user:hunter2secret@public.test/", open);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedRequestError);
      expect((err as BlockedRequestError).reason).toBe("credentials_in_url");
      expect((err as Error).message).not.toContain("hunter2secret");
      expect((err as Error).message).not.toContain("user");
    }
    // The classic parser-confusion form: the real host is the private one.
    expect(await blockedReason(assertPublicUrl("http://public.test@127.0.0.1/", open))).toBe(
      "credentials_in_url",
    );
  });

  it("error messages carry the host and reason only", async () => {
    try {
      await assertPublicUrl("http://10.0.0.1/secret/path?token=abcdef123456", open);
      expect.unreachable();
    } catch (err) {
      const blocked = err as BlockedRequestError;
      expect(blocked.host).toBe("10.0.0.1");
      expect(blocked.message).toContain("10.0.0.1");
      expect(blocked.message).not.toContain("secret/path");
      expect(blocked.message).not.toContain("abcdef123456");
    }
  });
});

describe("assertPublicUrl: allow-list and protocol policy", () => {
  const lookup = tableLookup({
    "api.example.com": ["93.184.216.34"],
    "example.com": ["93.184.216.34"],
    "a.b.example.com": ["93.184.216.34"],
    "notexample.com": ["93.184.216.34"],
    "example.com.evil.test": ["93.184.216.34"],
    "pinned.test": ["93.184.216.34"],
    localhost: ["127.0.0.1"],
    "lan.test": ["192.168.1.20"],
  });

  it("default policy: https only, exact host", async () => {
    const policy: SafeFetchPolicy = { allowHosts: ["api.example.com"], lookup };
    await expect(assertPublicUrl("https://api.example.com/v1", policy)).resolves.toBeDefined();
    await expect(assertPublicUrl("https://API.EXAMPLE.COM./v1", policy)).resolves.toBeDefined();
    expect(await blockedReason(assertPublicUrl("http://api.example.com/", policy))).toBe(
      "protocol_not_allowed",
    );
    expect(await blockedReason(assertPublicUrl("https://example.com/", policy))).toBe(
      "host_not_allowed",
    );
    expect(await blockedReason(assertPublicUrl("https://a.b.example.com/", policy))).toBe(
      "host_not_allowed",
    );
    expect(await blockedReason(assertPublicUrl("https://8.8.8.8/", policy))).toBe(
      "host_not_allowed",
    );
  });

  it("empty allow-list denies everything", async () => {
    const policy: SafeFetchPolicy = { allowHosts: [], lookup };
    expect(await blockedReason(assertPublicUrl("https://api.example.com/", policy))).toBe(
      "host_not_allowed",
    );
  });

  it("wildcards match subdomains, not the apex or look-alikes", async () => {
    const policy: SafeFetchPolicy = { allowHosts: ["*.example.com"], lookup };
    await expect(assertPublicUrl("https://api.example.com/", policy)).resolves.toBeDefined();
    await expect(assertPublicUrl("https://a.b.example.com/", policy)).resolves.toBeDefined();
    for (const url of [
      "https://example.com/",
      "https://notexample.com/",
      "https://example.com.evil.test/",
    ]) {
      expect(await blockedReason(assertPublicUrl(url, policy))).toBe("host_not_allowed");
    }
  });

  it("an entry with a port pins the port", async () => {
    const policy: SafeFetchPolicy = { allowHosts: ["pinned.test:8443"], lookup };
    await expect(assertPublicUrl("https://pinned.test:8443/", policy)).resolves.toBeDefined();
    expect(await blockedReason(assertPublicUrl("https://pinned.test/", policy))).toBe(
      "host_not_allowed",
    );
  });

  it("allowHosts never permits a private address, even when listed", async () => {
    const policy: SafeFetchPolicy = {
      allowHosts: ["127.0.0.1", "localhost", "lan.test", "*"],
      allowedProtocols: ["http:", "https:"],
      lookup,
    };
    for (const url of ["http://127.0.0.1/", "http://localhost/", "http://lan.test/"]) {
      expect(await blockedReason(assertPublicUrl(url, policy))).toBe("private_address");
    }
  });

  it("allowLocal permits exactly the listed host:port", async () => {
    const policy: SafeFetchPolicy = {
      allowHosts: [],
      allowLocal: ["127.0.0.1:11434", "localhost:8188", "[::1]:9000"],
      lookup,
    };
    await expect(assertPublicUrl("http://127.0.0.1:11434/api", policy)).resolves.toBeDefined();
    await expect(assertPublicUrl("http://localhost:8188/", policy)).resolves.toBeDefined();
    await expect(assertPublicUrl("http://[::1]:9000/", policy)).resolves.toBeDefined();
    // decimal form of the same address and port canonicalises to the entry
    await expect(assertPublicUrl("http://2130706433:11434/", policy)).resolves.toBeDefined();
    expect(await blockedReason(assertPublicUrl("http://127.0.0.1:11435/", policy))).toBe(
      "protocol_not_allowed",
    );
    expect(await blockedReason(assertPublicUrl("https://127.0.0.1:11435/", policy))).toBe(
      "private_address",
    );
    expect(await blockedReason(assertPublicUrl("https://127.0.0.2:11434/", policy))).toBe(
      "private_address",
    );
    // a different name that resolves to the allowed IP does not match the entry
    expect(await blockedReason(assertPublicUrl("https://lan.test:11434/", policy))).toBe(
      "host_not_allowed",
    );
  });

  it("rejects malformed policies", () => {
    expect(() => createSafeFetch({ allowHosts: ["exa mple.com"] })).toThrow(TypeError);
    expect(() => createSafeFetch({ allowHosts: [""] })).toThrow(TypeError);
    expect(() => createSafeFetch({ allowHosts: [], allowLocal: ["127.0.0.1"] })).toThrow(TypeError);
    expect(() => createSafeFetch({ allowHosts: [], allowedProtocols: ["file:" as never] })).toThrow(
      TypeError,
    );
    expect(() => createSafeFetch(undefined as never)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------

describe("createSafeFetch against local servers", () => {
  it(
    "fetches an allowLocal target and reports url/status/body",
    async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] });
        res.end("hello");
      });
      const f = fetcher({ allowHosts: [], allowLocal: [`127.0.0.1:${srv.port}`], lookup: noDns });
      const res = await f(`http://127.0.0.1:${srv.port}/x?y=1`);
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);
      expect(res.url).toBe(`http://127.0.0.1:${srv.port}/x?y=1`);
      expect(res.redirected).toBe(false);
      expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      expect(await res.text()).toBe("hello");
      expect(srv.hits[0]?.headers.host).toBe(`127.0.0.1:${srv.port}`);
    },
    T,
  );

  it(
    "never connects when the local port is not on the allow-list",
    async () => {
      const srv = await serve((_req, res) => res.end("nope"));
      const f = fetcher({
        allowHosts: ["*"],
        allowedProtocols: ["http:", "https:"],
        lookup: noDns,
      });
      expect(await blockedReason(f(`http://127.0.0.1:${srv.port}/`))).toBe("private_address");
      expect(await blockedReason(f(`http://[::1]:${srv.port}/`))).toBe("private_address");
      expect(await blockedReason(f(`http://2130706433:${srv.port}/`))).toBe("private_address");
      expect(await blockedReason(f(new URL(`http://0x7f.1:${srv.port}/`)))).toBe("private_address");
      expect(await blockedReason(f(new Request(`http://127.0.0.1:${srv.port}/`)))).toBe(
        "private_address",
      );
      expect(srv.hits).toHaveLength(0);
    },
    T,
  );

  it(
    "DNS rebinding: public answer at check time, private at connect time, is blocked",
    async () => {
      const srv = await serve((_req, res) => res.end("internal"));
      let call = 0;
      const lookup: SafeLookup = async () => {
        call += 1;
        return [{ address: call === 1 ? "93.184.216.34" : "127.0.0.1" }];
      };
      const connects: string[] = [];
      const f = fetcher({
        allowHosts: ["rebind.test"],
        allowedProtocols: ["http:"],
        lookup,
        onConnect: (info) => connects.push(info.address),
      });
      expect(await blockedReason(f(`http://rebind.test:${srv.port}/`))).toBe("private_address");
      expect(call).toBe(2); // pre-flight saw the public answer, the connector saw the private one
      expect(srv.hits).toHaveLength(0);
      expect(connects).toEqual([]);
    },
    T,
  );

  it(
    "the socket goes to the address the connector validated, not a later answer",
    async (ctx) => {
      // Same port on 127.0.0.1 and ::1, different servers.
      let v4: TestServer | undefined;
      let v6: TestServer | undefined;
      for (let attempt = 0; attempt < 5 && !v6; attempt++) {
        v4 = await serve((_req, res) => res.end("v4"));
        try {
          v6 = await serve((_req, res) => res.end("v6"), "::1", v4.port);
        } catch {
          v6 = undefined;
        }
      }
      if (!v4 || !v6) {
        ctx.skip();
        return;
      }
      // The name does not exist in real DNS, so success proves Node never
      // resolved it itself. Answers: call 1 (pre-flight) v4, call 2 (connector)
      // v6, every later call v4 again.
      let call = 0;
      const lookup: SafeLookup = async () => {
        call += 1;
        return [{ address: call === 2 ? "::1" : "127.0.0.1" }];
      };
      const connects: Array<{ host: string; port: number; address: string }> = [];
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`pin.invalid:${v4.port}`],
        lookup,
        onConnect: (info) => connects.push(info),
      });
      const res = await f(`http://pin.invalid:${v4.port}/who`);
      expect(await res.text()).toBe("v6");
      expect(call).toBe(2);
      expect(connects).toEqual([{ host: "pin.invalid", port: v4.port, address: "::1" }]);
      expect(v6.hits).toHaveLength(1);
      expect(v4.hits).toHaveLength(0);
      expect(v6.hits[0]?.headers.host).toBe(`pin.invalid:${v4.port}`);
    },
    T,
  );

  it(
    "prefers IPv4 and falls back to the next validated address",
    async () => {
      const srv = await serve((_req, res) => res.end("ok"));
      const connects: string[] = [];
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`multi.invalid:${srv.port}`],
        // ::1 is listed first but nothing may listen there; 127.0.0.1 must be tried first.
        lookup: async () => [{ address: "::1" }, { address: "127.0.0.1" }],
        onConnect: (info) => connects.push(info.address),
      });
      const res = await f(`http://multi.invalid:${srv.port}/`);
      expect(await res.text()).toBe("ok");
      expect(connects).toEqual(["127.0.0.1"]);
    },
    T,
  );

  it(
    "redirect to a private address is blocked and never followed",
    async () => {
      const internal = await serve((_req, res) => res.end("internal secret"));
      const targets = [
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/",
        `http://127.0.0.1:${internal.port}/`,
        `http://[::ffff:127.0.0.1]:${internal.port}/`,
        `http://2130706433:${internal.port}/`,
        `http://internal.test:${internal.port}/`,
      ];
      let next = "";
      const entry = await serve((_req, res) => {
        res.writeHead(302, { location: next });
        res.end();
      });
      const f = fetcher({
        allowHosts: ["*"],
        allowLocal: [`127.0.0.1:${entry.port}`],
        allowedProtocols: ["http:", "https:"],
        lookup: tableLookup({ "internal.test": ["127.0.0.1"] }),
      });
      for (const target of targets) {
        next = target;
        expect(await blockedReason(f(`http://127.0.0.1:${entry.port}/start`))).toBe(
          "private_address",
        );
      }
      next = "file:///etc/passwd";
      expect(await blockedReason(f(`http://127.0.0.1:${entry.port}/start`))).toBe(
        "protocol_not_allowed",
      );
      next = "http://user:pw@8.8.8.8/";
      expect(await blockedReason(f(`http://127.0.0.1:${entry.port}/start`))).toBe(
        "credentials_in_url",
      );
      expect(internal.hits).toHaveLength(0);
    },
    T,
  );

  it(
    "redirect to a host outside the allow-list is blocked",
    async () => {
      const entry = await serve((_req, res) => {
        res.writeHead(307, { location: "https://elsewhere.test/" });
        res.end();
      });
      const f = fetcher({
        allowHosts: ["api.example.com"],
        allowLocal: [`127.0.0.1:${entry.port}`],
        lookup: tableLookup({ "elsewhere.test": ["93.184.216.34"] }),
      });
      expect(await blockedReason(f(`http://127.0.0.1:${entry.port}/`))).toBe("host_not_allowed");
    },
    T,
  );

  it(
    "cross-origin redirects drop credentials, same-origin redirects keep them",
    async () => {
      const dest = await serve((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.headers));
      });
      const entry = await serve((req, res) => {
        if (req.url === "/cross") {
          res.writeHead(302, { location: `http://localhost:${dest.port}/landed` });
          res.end();
        } else if (req.url === "/same") {
          res.writeHead(302, { location: "/final" });
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(req.headers));
        }
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${entry.port}`, `localhost:${dest.port}`],
        lookup: tableLookup({ localhost: ["127.0.0.1"] }),
        sensitiveHeaders: ["X-Custom-Pass"],
      });
      const headers = {
        Authorization: "Bearer sk-live-abcdef0123456789",
        Cookie: "sid=abcdef0123456789",
        "Proxy-Authorization": "Basic Zm9vOmJhcg==",
        "X-Api-Key": "key-abcdef0123456789",
        "X-Goog-Api-Key": "goog-abcdef0123456789",
        "X-Auth-Token": "tok-abcdef0123456789",
        "X-Amz-Security-Token": "amz-abcdef0123456789",
        "X-Custom-Pass": "custom-abcdef0123456789",
        Accept: "application/json",
        "X-Trace": "keep-me",
      };

      const crossed = await f(`http://127.0.0.1:${entry.port}/cross`, { headers });
      expect(crossed.redirected).toBe(true);
      expect(crossed.url).toBe(`http://localhost:${dest.port}/landed`);
      const seen = (await crossed.json()) as Record<string, string>;
      for (const name of [
        "authorization",
        "cookie",
        "proxy-authorization",
        "x-api-key",
        "x-goog-api-key",
        "x-auth-token",
        "x-amz-security-token",
        "x-custom-pass",
      ]) {
        expect(seen[name], name).toBeUndefined();
      }
      expect(JSON.stringify(seen)).not.toContain("abcdef0123456789");
      expect(seen.accept).toBe("application/json");
      // Only safelisted headers survive a cross-origin hop by default.
      expect(seen["x-trace"]).toBeUndefined();
      expect(seen.host).toBe(`localhost:${dest.port}`);

      const allowing = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${entry.port}`, `localhost:${dest.port}`],
        lookup: tableLookup({ localhost: ["127.0.0.1"] }),
        redirectHeaderAllowlist: ["X-Trace", "Authorization"],
      });
      const allowed = (await (
        await allowing(`http://127.0.0.1:${entry.port}/cross`, { headers })
      ).json()) as Record<string, string>;
      expect(allowed["x-trace"]).toBe("keep-me");
      // sensitive headers are dropped even when allow-listed
      expect(allowed.authorization).toBeUndefined();

      const same = await f(`http://127.0.0.1:${entry.port}/same`, { headers });
      const kept = (await same.json()) as Record<string, string>;
      expect(kept.authorization).toBe("Bearer sk-live-abcdef0123456789");
      expect(kept["x-api-key"]).toBe("key-abcdef0123456789");
      expect(kept.cookie).toBe("sid=abcdef0123456789");
    },
    T,
  );

  it(
    "a different port is a different origin for header stripping",
    async () => {
      const dest = await serve((req, res) => res.end(JSON.stringify(req.headers)));
      const entry = await serve((_req, res) => {
        res.writeHead(308, { location: `http://127.0.0.1:${dest.port}/` });
        res.end();
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${entry.port}`, `127.0.0.1:${dest.port}`],
        lookup: noDns,
      });
      const res = await f(`http://127.0.0.1:${entry.port}/`, {
        headers: { authorization: "Bearer abcdef0123456789" },
      });
      const seen = (await res.json()) as Record<string, string>;
      expect(seen.authorization).toBeUndefined();
    },
    T,
  );

  it(
    "redirect method and body semantics",
    async () => {
      let status = 307;
      const srv = await serve((req, res) => {
        if (req.url === "/start") {
          res.writeHead(status, { location: "/end" });
          res.end();
        } else {
          res.end("done");
        }
      });
      const f = fetcher({ allowHosts: [], allowLocal: [`127.0.0.1:${srv.port}`], lookup: noDns });
      const post = (): Promise<Response> =>
        f(`http://127.0.0.1:${srv.port}/start`, {
          method: "POST",
          body: JSON.stringify({ a: 1 }),
          headers: { "content-type": "application/json" },
        });

      await (await post()).text();
      let last = srv.hits.at(-1);
      expect(last?.method).toBe("POST");
      expect(last?.body).toBe('{"a":1}');
      expect(last?.headers["content-type"]).toBe("application/json");

      for (const code of [301, 302, 303]) {
        status = code;
        await (await post()).text();
        last = srv.hits.at(-1);
        expect(last?.method, String(code)).toBe("GET");
        expect(last?.body).toBe("");
        expect(last?.headers["content-type"]).toBeUndefined();
      }
    },
    T,
  );

  it(
    "stops after maxRedirects and honours redirect: manual / error",
    async () => {
      const srv = await serve((req, res) => {
        const n = Number((req.url ?? "/0").slice(1)) || 0;
        res.writeHead(302, { location: `/${n + 1}` });
        res.end();
      });
      const base = `http://127.0.0.1:${srv.port}`;
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        maxRedirects: 3,
        lookup: noDns,
      });
      expect(await blockedReason(f(`${base}/0`))).toBe("too_many_redirects");
      expect(srv.hits).toHaveLength(4); // the original request plus 3 redirects

      const manual = await f(`${base}/0`, { redirect: "manual" });
      expect(manual.status).toBe(302);
      expect(manual.headers.get("location")).toBe("/1");
      await manual.body?.cancel();

      expect(await blockedReason(f(`${base}/0`, { redirect: "error" }))).toBe(
        "redirect_not_allowed",
      );

      const none = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        maxRedirects: 0,
        lookup: noDns,
      });
      expect(await blockedReason(none(`${base}/0`))).toBe("too_many_redirects");
    },
    T,
  );

  it(
    "enforces the size cap while streaming a chunked response",
    async () => {
      let sent = 0;
      const srv = await serve((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" }); // chunked
        const chunk = Buffer.alloc(16 * 1024, 0x61);
        const timer = setInterval(() => {
          if (res.destroyed || sent >= 64 * 1024 * 1024) {
            clearInterval(timer);
            res.end();
            return;
          }
          sent += chunk.length;
          res.write(chunk);
        }, 2);
        res.on("close", () => clearInterval(timer));
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        maxResponseBytes: 100_000,
        lookup: noDns,
      });
      const res = await f(`http://127.0.0.1:${srv.port}/big`);
      expect(res.headers.get("content-length")).toBeNull();
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      let received = 0;
      let failure: unknown;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          received += part.value.byteLength;
        }
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(ResponseTooLargeError);
      expect((failure as ResponseTooLargeError).limit).toBe(100_000);
      expect(received).toBeLessThanOrEqual(100_000);
      // The server was cut off long before it could send everything.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(sent).toBeLessThan(32 * 1024 * 1024);
    },
    T,
  );

  it(
    "size cap also applies to text() and to a declared Content-Length",
    async () => {
      const srv = await serve((req, res) => {
        const body = Buffer.alloc(5000, 0x62);
        if (req.url === "/declared") {
          res.writeHead(200, { "content-length": String(body.length) });
          res.end(body);
        } else {
          res.writeHead(200);
          res.write(body.subarray(0, 2500));
          setTimeout(() => res.end(body.subarray(2500)), 20);
        }
      });
      const base = `http://127.0.0.1:${srv.port}`;
      const small = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        maxResponseBytes: 4999,
        lookup: noDns,
      });
      await expect(small(`${base}/declared`)).rejects.toBeInstanceOf(ResponseTooLargeError);
      const chunked = await small(`${base}/chunked`);
      await expect(chunked.text()).rejects.toBeInstanceOf(ResponseTooLargeError);

      const exact = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        maxResponseBytes: 5000,
        lookup: noDns,
      });
      expect((await (await exact(`${base}/declared`)).arrayBuffer()).byteLength).toBe(5000);
      expect((await (await exact(`${base}/chunked`)).arrayBuffer()).byteLength).toBe(5000);
    },
    T,
  );

  it(
    "times out when the server never answers",
    async () => {
      const srv = await serve(() => {
        /* never respond */
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        timeoutMs: 400,
        lookup: noDns,
      });
      const started = Date.now();
      const err = await f(`http://127.0.0.1:${srv.port}/hang`).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SafeFetchTimeoutError);
      expect((err as SafeFetchTimeoutError).timeoutMs).toBe(400);
      expect((err as SafeFetchTimeoutError).host).toBe("127.0.0.1");
      expect((err as Error).message).not.toContain("/hang");
      expect(Date.now() - started).toBeLessThan(30_000);
    },
    T,
  );

  it(
    "the timeout covers a body that stalls after the headers",
    async () => {
      const srv = await serve((_req, res) => {
        res.writeHead(200);
        res.write("partial");
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        timeoutMs: 500,
        lookup: noDns,
      });
      const res = await f(`http://127.0.0.1:${srv.port}/stall`);
      await expect(res.text()).rejects.toBeInstanceOf(SafeFetchTimeoutError);
    },
    T,
  );

  it(
    "honours the caller's AbortSignal",
    async () => {
      const srv = await serve(() => {
        /* never respond */
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${srv.port}`],
        timeoutMs: 30_000,
        lookup: noDns,
      });
      const controller = new AbortController();
      const pending = f(`http://127.0.0.1:${srv.port}/hang`, { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      const err = (await pending.then(
        () => null,
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(SafeFetchTimeoutError);
      expect(err.name).toBe("AbortError");

      const already = AbortSignal.abort();
      await expect(
        f(`http://127.0.0.1:${srv.port}/hang`, { signal: already }),
      ).rejects.toMatchObject({ name: "AbortError" });
    },
    T,
  );

  it(
    "a caller-supplied Host header cannot redirect the request elsewhere",
    async () => {
      const srv = await serve((req, res) => res.end(req.headers.host));
      const f = fetcher({ allowHosts: [], allowLocal: [`127.0.0.1:${srv.port}`], lookup: noDns });
      const res = await f(`http://127.0.0.1:${srv.port}/`, {
        headers: { host: "169.254.169.254" },
      });
      expect(await res.text()).toBe(`127.0.0.1:${srv.port}`);
    },
    T,
  );
});

// ---------------------------------------------------------------------------

describe("TLS with a pinned address", () => {
  let dir: string | undefined;
  let cert: Buffer | undefined;
  let key: Buffer | undefined;

  beforeAll(() => {
    try {
      dir = mkdtempSync(join(tmpdir(), "plughive-tls-"));
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          join(dir, "key.pem"),
          "-out",
          join(dir, "cert.pem"),
          "-days",
          "2",
          "-subj",
          "/CN=secure.invalid",
          "-addext",
          "subjectAltName=DNS:secure.invalid",
        ],
        { stdio: "ignore", timeout: 60_000 },
      );
      cert = readFileSync(join(dir, "cert.pem"));
      key = readFileSync(join(dir, "key.pem"));
    } catch {
      cert = undefined;
      key = undefined;
    }
  }, 90_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "verifies the certificate against the hostname while connecting to the validated IP",
    async (ctx) => {
      if (!cert || !key) {
        ctx.skip();
        return;
      }
      let sni: string | undefined;
      const server = createHttpsServer({ cert, key }, (req, res) => {
        sni = (req.socket as unknown as { servername?: string }).servername;
        res.end(`secure:${req.headers.host}`);
      });
      await listen(server as unknown as Server, "127.0.0.1", 0);
      const port = (server.address() as AddressInfo).port;
      try {
        const connects: string[] = [];
        const good = fetcher({
          allowHosts: [],
          allowLocal: [`secure.invalid:${port}`, `other.invalid:${port}`],
          lookup: async () => [{ address: "127.0.0.1" }],
          tls: { ca: cert },
          onConnect: (info) => connects.push(info.address),
        });
        const res = await good(`https://secure.invalid:${port}/`);
        expect(await res.text()).toBe(`secure:secure.invalid:${port}`);
        expect(sni).toBe("secure.invalid");
        expect(connects).toEqual(["127.0.0.1"]);

        // Same server, same IP, wrong name: the certificate must not verify.
        await expect(good(`https://other.invalid:${port}/`)).rejects.toThrow();

        // Without the CA the self-signed certificate is rejected.
        const untrusted = fetcher({
          allowHosts: [],
          allowLocal: [`secure.invalid:${port}`],
          lookup: async () => [{ address: "127.0.0.1" }],
        });
        await expect(untrusted(`https://secure.invalid:${port}/`)).rejects.toThrow();
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      }
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// Regression tests for the security review (F1-F6 and related hardening).

describe("review regressions", () => {
  it(
    "F1: a cross-origin 307 with a body is refused and nothing reaches the second origin",
    async () => {
      const b = await serve((_req, res) => res.end("ok"));
      const a = await serve((_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${b.port}/collect` });
        res.end();
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`],
        lookup: noDns,
      });
      const err = await f(`http://127.0.0.1:${a.port}/v1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: "BODYSECRET-444" }),
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BlockedRequestError);
      expect((err as BlockedRequestError).reason).toBe("cross_origin_body_replay");
      expect(String((err as Error).message)).not.toContain("BODYSECRET");
      expect(b.hits).toHaveLength(0);
    },
    T,
  );

  it(
    "F1: cross-origin hops drop non-safelisted key headers; replay opt-in still filters headers",
    async () => {
      const b = await serve((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.headers));
      });
      const a = await serve((_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${b.port}/collect` });
        res.end();
      });
      const headers = {
        authorization: "Bearer AUTHSECRET",
        "x-key": "BFLKEY-111",
        "ocp-apim-subscription-key": "AZUREKEY-222",
        "x-goog-api-key": "GOOGKEY-333",
        "content-type": "application/json",
      };
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`],
        lookup: noDns,
      });
      const seen = (await (await f(`http://127.0.0.1:${a.port}/v1`, { headers })).json()) as Record<
        string,
        string
      >;
      for (const name of [
        "authorization",
        "x-key",
        "ocp-apim-subscription-key",
        "x-goog-api-key",
      ]) {
        expect(seen[name], name).toBeUndefined();
      }
      expect(seen["content-type"]).toBe("application/json");

      const replay = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`],
        lookup: noDns,
        allowCrossOriginBodyReplay: true,
      });
      const res = await replay(`http://127.0.0.1:${a.port}/v1`, {
        method: "POST",
        headers,
        body: '{"x":1}',
      });
      const replayed = (await res.json()) as Record<string, string>;
      expect(replayed["x-key"]).toBeUndefined();
      expect(replayed.authorization).toBeUndefined();
      expect(b.hits.at(-1)?.body).toBe('{"x":1}');
    },
    T,
  );

  it(
    "F2: timeoutMs covers a DNS lookup that never resolves",
    async () => {
      const f = fetcher({
        allowHosts: ["slow.test"],
        timeoutMs: 200,
        lookup: () => new Promise(() => undefined),
      });
      const started = Date.now();
      const err = await f("https://slow.test/").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SafeFetchTimeoutError);
      expect((err as Error).name).toBe("TimeoutError");
      expect(Date.now() - started).toBeLessThan(5_000);
    },
    T,
  );

  it("F3: an invalid header value is reported by name, never by value", async () => {
    const f = fetcher({
      allowHosts: ["api.test"],
      lookup: async () => [{ address: "93.184.216.34" }],
    });
    const err = await f("https://api.test/", {
      headers: { authorization: "Bearer sk-live-SECRET\nvalue" },
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err?.message).toContain("authorization");
    expect(err?.message).not.toContain("sk-live-SECRET");
    expect(String(err?.stack)).not.toContain("sk-live-SECRET");
  });

  it(
    "F4: maxResponseBytes caps decoded bytes of a gzip bomb",
    async () => {
      const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024));
      const s = await serve((_req, res) => {
        res.writeHead(200, { "content-encoding": "gzip", "content-length": String(bomb.length) });
        res.end(bomb);
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${s.port}`],
        maxResponseBytes: 1024 * 1024,
        lookup: noDns,
      });
      const res = await f(`http://127.0.0.1:${s.port}/`);
      // decoded: the wire headers no longer describe the body
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).toBeNull();
      await expect(res.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLargeError);
    },
    T,
  );

  it(
    "D-M3: stacked encodings are decoded under the same byte cap",
    async () => {
      // gzip twice: about 1 KB on the wire, 64 MiB decoded, no Content-Length.
      const bomb = gzipSync(gzipSync(Buffer.alloc(64 * 1024 * 1024)));
      const s = await serve((_req, res) => {
        res.writeHead(200, { "content-encoding": "gzip, gzip" });
        res.end(bomb);
      });
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${s.port}`],
        maxResponseBytes: 1024 * 1024,
        lookup: noDns,
      });
      const res = await f(`http://127.0.0.1:${s.port}/`);
      expect(res.headers.get("content-encoding")).toBeNull();
      await expect(res.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLargeError);
    },
    T,
  );

  it(
    "F5: an encoding that was not decoded keeps its headers",
    async () => {
      const s = await serve((_req, res) => {
        res.writeHead(200, { "content-encoding": "x-custom", "content-length": "5" });
        res.end("AAAAA");
      });
      const f = fetcher({ allowHosts: [], allowLocal: [`127.0.0.1:${s.port}`], lookup: noDns });
      const res = await f(`http://127.0.0.1:${s.port}/`);
      expect(res.headers.get("content-encoding")).toBe("x-custom");
      expect(res.headers.get("content-length")).toBe("5");
      expect(await res.text()).toBe("AAAAA");

      const small = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${s.port}`],
        maxResponseBytes: 3,
        lookup: noDns,
      });
      await expect(
        small(`http://127.0.0.1:${s.port}/`).then((r) => r.arrayBuffer()),
      ).rejects.toBeInstanceOf(ResponseTooLargeError);
    },
    T,
  );

  it(
    "F6: connection errors carry neither the query string nor header values",
    async () => {
      const tmp = await startServer((_req, res) => res.end("x"));
      const port = tmp.port;
      await tmp.close();
      const f = fetcher({ allowHosts: [], allowLocal: [`127.0.0.1:${port}`], lookup: noDns });
      const err = (await f(`http://127.0.0.1:${port}/path?api_key=QUERYSECRET`, {
        headers: { authorization: "Bearer HDRSECRET" },
      }).catch((e: unknown) => e)) as Error & { cause?: Error };
      const dump = `${err.name}|${err.message}|${err.stack}|${err.cause?.message}|${err.cause?.stack}|${JSON.stringify(err.cause)}`;
      expect(dump).not.toContain("QUERYSECRET");
      expect(dump).not.toContain("HDRSECRET");
    },
    T,
  );

  it(
    "maxRequestBodyBytes refuses an oversized request body before sending",
    async () => {
      const s = await serve((_req, res) => res.end("ok"));
      const f = fetcher({
        allowHosts: [],
        allowLocal: [`127.0.0.1:${s.port}`],
        maxRequestBodyBytes: 10,
        lookup: noDns,
      });
      expect(
        await blockedReason(
          f(`http://127.0.0.1:${s.port}/`, { method: "POST", body: "x".repeat(11) }),
        ),
      ).toBe("request_too_large");
      expect(s.hits).toHaveLength(0);
      const ok = await f(`http://127.0.0.1:${s.port}/`, { method: "POST", body: "x".repeat(10) });
      expect(await ok.text()).toBe("ok");
    },
    T,
  );

  it("a bare TLD wildcard is rejected; subdomain and catch-all wildcards still work", () => {
    expect(() => createSafeFetch({ allowHosts: ["*.com"] })).toThrow(TypeError);
    expect(() => fetcher({ allowHosts: ["*.example.com"] })).not.toThrow();
    expect(() => fetcher({ allowHosts: ["*"] })).not.toThrow();
  });
});
