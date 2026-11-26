// M2: the browser's connections are made by this proxy, to the address that was checked.
import { type Server, createServer, request } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type PinDecide, type PinProxy, startPinProxy } from "../../../packs/web/pin-proxy.js";

let origin: Server;
let originPort = 0;
let seen: Array<{ host: string | undefined; url: string | undefined; proxyHeader: unknown }> = [];
let proxy: PinProxy | null = null;

beforeAll(async () => {
  origin = createServer((req, res) => {
    seen.push({
      host: req.headers.host,
      url: req.url,
      proxyHeader: req.headers["proxy-connection"],
    });
    res.setHeader("content-type", "text/plain");
    res.end("origin says hi");
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => origin.close(() => r()));
});

afterEach(async () => {
  await proxy?.close();
  proxy = null;
  seen = [];
});

function viaProxy(p: PinProxy, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: p.port,
        method: "GET",
        path: url,
        headers: { host: new URL(url).host, "proxy-connection": "keep-alive" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function tunnel(p: PinProxy, authority: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: p.port });
    let data = "";
    let sent = false;
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
    );
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (!sent && data.includes("\r\n\r\n") && data.startsWith("HTTP/1.1 200")) {
        sent = true;
        socket.write(payload);
      }
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

describe("pinning proxy", () => {
  it("connects to the address the check returned, never resolving the name itself", async () => {
    const asked: string[] = [];
    // The name exists nowhere: only the verdict's address can reach the origin.
    const decide: PinDecide = async (url) => {
      asked.push(url);
      return { ok: true, address: "127.0.0.1" };
    };
    proxy = await startPinProxy(decide);
    const res = await viaProxy(proxy, `http://rebind.invalid:${originPort}/page?x=1`);
    expect(res).toEqual({ status: 200, body: "origin says hi" });
    expect(asked).toEqual([`http://rebind.invalid:${originPort}/page?x=1`]);
    expect(seen).toEqual([
      { host: `rebind.invalid:${originPort}`, url: "/page?x=1", proxyHeader: undefined },
    ]);
  });

  // D-L1: headers the Connection header names are for one hop only, in both directions.
  it("drops the headers a Connection header names, on the request and the response", async () => {
    let got: Record<string, unknown> = {};
    const hop = createServer((req, res) => {
      got = req.headers;
      res.writeHead(200, { connection: "x-up-hop", "x-up-hop": "1", "x-up-kept": "1" });
      res.end("ok");
    });
    await new Promise<void>((r) => hop.listen(0, "127.0.0.1", r));
    const port = (hop.address() as AddressInfo).port;
    try {
      proxy = await startPinProxy(async () => ({ ok: true, address: "127.0.0.1" }));
      const p = proxy;
      const url = `http://hop.test:${port}/x`;
      const resHeaders = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: p.port,
            path: url,
            headers: {
              host: `hop.test:${port}`,
              connection: "X-Down-Hop, keep-alive",
              "x-down-hop": "1",
              "x-down-kept": "1",
            },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.headers));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(got["x-down-hop"]).toBeUndefined();
      expect(got["x-down-kept"]).toBe("1");
      expect(resHeaders["x-up-hop"]).toBeUndefined();
      expect(resHeaders["x-up-kept"]).toBe("1");
    } finally {
      await new Promise<void>((r) => hop.close(() => r()));
    }
  });

  it("answers 403 with the reason and makes no connection when the check refuses", async () => {
    proxy = await startPinProxy(async () => ({ ok: false, reason: "loopback is blocked" }));
    const res = await viaProxy(proxy, `http://127.0.0.1:${originPort}/secret`);
    expect(res.status).toBe(403);
    expect(res.body).toMatch(/loopback is blocked/);
    expect(seen).toEqual([]);
  });

  it("treats a failing check as a refusal", async () => {
    proxy = await startPinProxy(async () => {
      throw new Error("resolver exploded");
    });
    const res = await viaProxy(proxy, `http://127.0.0.1:${originPort}/`);
    expect(res.status).toBe(403);
    expect(res.body).not.toMatch(/exploded/);
    expect(seen).toEqual([]);
  });

  it("pins CONNECT tunnels (https and WebSockets) the same way", async () => {
    const asked: string[] = [];
    proxy = await startPinProxy(async (url) => {
      asked.push(url);
      return url.includes("blocked.invalid")
        ? { ok: false, reason: "not allowed" }
        : { ok: true, address: "127.0.0.1" };
    });
    const ok = await tunnel(
      proxy,
      `tunnel.invalid:${originPort}`,
      "GET /through HTTP/1.1\r\nHost: tunnel.invalid\r\nConnection: close\r\n\r\n",
    );
    expect(ok).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(ok).toMatch(/origin says hi/);
    expect(seen.map((s) => s.url)).toEqual(["/through"]);

    const refused = await tunnel(proxy, `blocked.invalid:${originPort}`, "never sent");
    expect(refused).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    expect(refused).toMatch(/not allowed/);
    expect(seen).toHaveLength(1);
    expect(asked).toEqual([
      `http://tunnel.invalid:${originPort}/`,
      `http://blocked.invalid:${originPort}/`,
    ]);
  });

  it("rejects a CONNECT target that is not a plain host:port", async () => {
    proxy = await startPinProxy(async () => ({ ok: true, address: "127.0.0.1" }));
    for (const target of [
      `user@127.0.0.1:${originPort}`,
      `:pw@127.0.0.1:${originPort}`,
      `127.0.0.1:${originPort}#frag`,
      `127.0.0.1:${originPort}/path`,
      `127.0.0.1:${originPort}?q=1`,
    ]) {
      const res = await tunnel(proxy, target, "x");
      expect(res, target).toMatch(/^HTTP\/1\.1 400/);
    }
    expect(seen).toEqual([]);
  });
});
