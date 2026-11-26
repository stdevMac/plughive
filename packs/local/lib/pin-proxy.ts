// packs/local/lib/pin-proxy.ts
//
// A copy of packs/web/pin-proxy.ts (packs do not import from each other);
// keep the two in step. Here yt-dlp is pointed at it with --proxy.
//
// A forward proxy on 127.0.0.1 that a client (the headless browser in the web
// pack, yt-dlp here) is launched behind.
// A browser behind a proxy resolves no names itself: every HTTP request and
// every CONNECT tunnel (https and WebSockets) arrives here with the host name,
// this proxy asks `decide` for a verdict, and then connects to the exact
// address the verdict classified. That closes the DNS-rebinding window between
// "the address was checked" and "the browser connected", and it also covers
// requests no page-level hook ever sees.
//
// The proxy lives for one screenshot and listens on an ephemeral loopback
// port. It only reaches what `decide` allows, so it gives a local process
// nothing it could not already reach.
import { type IncomingMessage, type Server, createServer, request as httpRequest } from "node:http";
import { type AddressInfo, type Socket, connect, isIP } from "node:net";

export type PinDecision = { ok: true; address: string } | { ok: false; reason: string };

/** Verdict for an absolute http(s) URL the browser wants to reach. */
export type PinDecide = (url: string) => Promise<PinDecision>;

export interface PinProxy {
  /** `http://127.0.0.1:<port>`, for the browser's proxy setting. */
  url: string;
  port: number;
  close(): Promise<void>;
}

const HOP_HEADERS = new Set([
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

const CONNECT_TIMEOUT_MS = 15_000;

function refuse(socket: Socket, status: string, reason: string): void {
  const body = `Blocked: ${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/**
 * The end-to-end headers of a message: without the standard hop-by-hop ones
 * and without the ones its Connection header names (they are for this hop only).
 */
function endToEnd(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const listed = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_HEADERS.has(name) || listed.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function forwardHeaders(req: IncomingMessage, host: string): Record<string, string | string[]> {
  const out = endToEnd(req.headers);
  out.host = host;
  out.connection = "close";
  return out;
}

export async function startPinProxy(decide: PinDecide): Promise<PinProxy> {
  const sockets = new Set<Socket>();
  const track = (s: Socket): void => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(req.url ?? "");
        if (target.protocol !== "http:") throw new Error("not http");
      } catch {
        res.writeHead(400, { "content-type": "text/plain" }).end("Bad proxy request\n");
        return;
      }
      const verdict = await decide(target.href).catch(
        (): PinDecision => ({ ok: false, reason: "the address check failed" }),
      );
      if (!verdict.ok) {
        res
          .writeHead(403, { "content-type": "text/plain; charset=utf-8" })
          .end(`Blocked: ${verdict.reason}\n`);
        return;
      }
      const upstream = httpRequest({
        host: verdict.address,
        family: isIP(verdict.address) === 6 ? 6 : 4,
        port: target.port !== "" ? Number(target.port) : 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: forwardHeaders(req, target.host),
        setHost: false,
        timeout: CONNECT_TIMEOUT_MS,
      });
      upstream.on("socket", track);
      upstream.on("timeout", () => upstream.destroy(new Error("upstream timed out")));
      upstream.on("response", (up) => {
        res.writeHead(up.statusCode ?? 502, endToEnd(up.headers));
        up.pipe(res);
        up.on("error", () => res.destroy());
      });
      upstream.on("error", () => {
        if (res.headersSent) res.destroy();
        else res.writeHead(502, { "content-type": "text/plain" }).end("Upstream failed\n");
      });
      req.pipe(upstream);
      req.on("error", () => upstream.destroy());
    })();
  });

  server.on("connection", track);

  server.on("connect", (req, clientSocket: Socket, head: Buffer) => {
    void (async () => {
      clientSocket.on("error", () => {});
      let target: URL;
      try {
        target = new URL(`http://${req.url ?? ""}`);
        if (
          target.pathname !== "/" ||
          target.search !== "" ||
          target.username !== "" ||
          target.password !== "" ||
          target.hash !== ""
        ) {
          throw new Error("not an authority");
        }
      } catch {
        refuse(clientSocket, "400 Bad Request", "malformed CONNECT target");
        return;
      }
      const port = target.port !== "" ? Number(target.port) : 80;
      const verdict = await decide(target.href).catch(
        (): PinDecision => ({ ok: false, reason: "the address check failed" }),
      );
      if (!verdict.ok) {
        refuse(clientSocket, "403 Forbidden", verdict.reason);
        return;
      }
      if (clientSocket.destroyed) return;
      const upstream = connect({ host: verdict.address, port });
      track(upstream);
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
      let connected = false;
      upstream.once("connect", () => {
        connected = true;
        upstream.setTimeout(0);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => {
        if (clientSocket.writable && !connected) {
          refuse(clientSocket, "502 Bad Gateway", "the connection failed");
        } else {
          clientSocket.destroy();
        }
      });
      upstream.on("close", () => clientSocket.destroy());
      clientSocket.on("close", () => upstream.destroy());
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
