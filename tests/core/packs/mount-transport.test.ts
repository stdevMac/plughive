// M3: http mounts go through the guarded fetch; only the user's own mounts may be local.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MOUNT_MAX_RESPONSE_BYTES,
  MountPolicyError,
  PackMounts,
  mountFetchPolicy,
  scrubMountUrls,
} from "../../../src/core/packs/mounts.js";

const silent = { info() {}, warn() {} };

let server: Server;
let port = 0;
let hits: Array<{ url: string | undefined; marker: unknown }> = [];
let mounts: PackMounts | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push({ url: req.url, marker: req.headers["x-plughive-pack"] });
    res.statusCode = 500;
    res.end("not an MCP server");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(async () => {
  await mounts?.stop();
  mounts = null;
  hits = [];
});

const httpMount = (pack: string, url: string) => ({
  id: `${pack}/svc`,
  pack,
  prefix: "svc",
  url,
  headers: {},
});

async function connect(
  mount: ReturnType<typeof httpMount>,
  opts: {
    daemonPorts?: number[];
    lookup?: (h: string) => Promise<{ address: string; family: number }[]>;
  } = {},
) {
  mounts = new PackMounts({ logger: silent, ...opts });
  await mounts.sync({ resolvedMounts: async () => [mount] });
  return mounts.connection(mount.id);
}

describe("mountFetchPolicy", () => {
  it("never lets a pack's mount name this machine or the LAN", () => {
    for (const url of [
      "http://127.0.0.1:8080/mcp",
      "http://localhost:8080/mcp",
      "https://app.localhost/mcp",
      "http://[::1]:8080/mcp",
      "http://10.0.0.5/mcp",
      "http://192.168.1.20:9000/mcp",
      "http://0.0.0.0:8080/mcp",
    ]) {
      expect(() => mountFetchPolicy({ pack: "evil", url }), url).toThrow(MountPolicyError);
    }
    const publicPolicy = mountFetchPolicy({ pack: "evil", url: "https://mcp.example.com/mcp" });
    expect(publicPolicy.allowLocal).toBeUndefined();
    expect(publicPolicy.allowHosts).toEqual(["mcp.example.com:443"]);
    expect(publicPolicy.maxRedirects).toBe(0);
    expect(publicPolicy.maxResponseBytes).toBe(MOUNT_MAX_RESPONSE_BYTES);
  });

  it("lets the user's own mount be local, but never the daemon, link-local or metadata", () => {
    const local = mountFetchPolicy(
      { pack: "user", url: "http://127.0.0.1:8080/mcp" },
      { daemonPorts: [7777] },
    );
    expect(local.allowLocal).toEqual(["127.0.0.1:8080"]);
    for (const pack of ["user", "evil"]) {
      for (const url of [
        "http://127.0.0.1:7777/mcp",
        "http://localhost:7777/mcp",
        "http://[::1]:7777/mcp",
        "http://169.254.169.254/latest/meta-data",
        "http://metadata.google.internal/mcp",
      ]) {
        expect(() => mountFetchPolicy({ pack, url }, { daemonPorts: [7777] }), url).toThrow(
          MountPolicyError,
        );
      }
    }
  });
});

describe("PackMounts http transport", () => {
  it("a pack's mount whose name resolves to loopback never connects", async () => {
    const state = await connect(httpMount("evil", `http://mcp.example.test:${port}/mcp`), {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(state.connected).toBe(false);
    expect(hits).toEqual([]);
  });

  it("a pack's mount written as a loopback address never connects, and says why", async () => {
    const state = await connect(httpMount("evil", `http://127.0.0.1:${port}/mcp`));
    expect(state.connected).toBe(false);
    expect(state.error).toMatch(/cannot point at this machine/);
    expect(hits).toEqual([]);
  });

  it("the user's own mount reaches a local server, carrying the pack marker", async () => {
    const state = await connect(httpMount("user", `http://127.0.0.1:${port}/mcp`));
    // The test server is not an MCP server, so the session fails, but the request arrived.
    expect(state.connected).toBe(false);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toEqual({ url: "/mcp", marker: "user" });
  });

  it("no mount reaches the daemon's own port, by address or by name", async () => {
    const byAddress = await connect(httpMount("user", `http://127.0.0.1:${port}/mcp`), {
      daemonPorts: [port],
    });
    expect(byAddress.error).toMatch(/daemon itself/);
    await mounts?.stop();
    const byName = await connect(httpMount("user", `http://daemon.example.test:${port}/mcp`), {
      daemonPorts: [port],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    // The guarded fetch reports a refused lookup as a resolution failure.
    expect(byName.connected).toBe(false);
    expect(hits).toEqual([]);
  });

  it("a mount whose prefix another mount already uses is refused, deterministically", async () => {
    const a = {
      ...httpMount("packa", "https://a.example.test/mcp"),
      id: "packa/svc",
      prefix: "svc",
    };
    const b = {
      ...httpMount("packb", "https://b.example.test/mcp"),
      id: "packb/svc",
      prefix: "svc",
    };
    const fetchStub = (async () =>
      new Response("not an MCP server", { status: 500 })) as typeof fetch;
    mounts = new PackMounts({
      logger: silent,
      fetch: fetchStub,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    await mounts.sync({ resolvedMounts: async () => [a, b] });
    // The first mount in the provider's order wins the prefix; the second is
    // not connected and says why, whatever the connect outcome of the first.
    expect(mounts.connection(b.id).error).toMatch(/prefix "svc" is used by another mount/);
    expect(mounts.connection(a.id).error ?? "").not.toMatch(/prefix/);
    expect(mounts.list().every((t) => t.mountId === a.id)).toBe(true);
    // The other order: the other mount is refused.
    await mounts.stop();
    mounts = new PackMounts({
      logger: silent,
      fetch: fetchStub,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    await mounts.sync({ resolvedMounts: async () => [b, a] });
    expect(mounts.connection(a.id).error).toMatch(/prefix "svc" is used by another mount/);
    expect(mounts.connection(b.id).error ?? "").not.toMatch(/prefix/);
  });
});

// A minimal MCP server over stdio whose one tool answers with `BYTES` of text.
const BIG_SERVER = `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "big", version: "1" } } });
  }
  if (msg.method === "tools/list") {
    return send({ id: msg.id, result: { tools: [{ name: "blob", description: "big", inputSchema: { type: "object", properties: { bytes: { type: "number" } } } }] } });
  }
  if (msg.method === "tools/call") {
    return send({ id: msg.id, result: { content: [{ type: "text", text: "x".repeat(msg.params.arguments.bytes) }] } });
  }
  send({ id: msg.id, result: {} });
});
`;

describe("PackMounts result size", () => {
  it("refuses a stdio tool result larger than the http response cap", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plughive-bigmount-")));
    try {
      const script = join(dir, "server.mjs");
      writeFileSync(script, BIG_SERVER);
      mounts = new PackMounts({ logger: silent });
      const mount = {
        id: "user/big",
        prefix: "big",
        transport: "stdio" as const,
        command: process.execPath,
        args: [script],
        env: {},
      };
      await mounts.sync({ resolvedMounts: async () => [mount] });
      expect(mounts.connection("user/big")).toMatchObject({ connected: true, tools: 1 });
      const small = (await mounts.call("user/big", "blob", { bytes: 1000 })) as {
        content: { text: string }[];
      };
      expect(small.content[0]?.text).toHaveLength(1000);
      await expect(
        mounts.call("user/big", "blob", { bytes: MOUNT_MAX_RESPONSE_BYTES + 1024 }),
      ).rejects.toThrow(/too large/);
    } finally {
      await mounts?.stop();
      mounts = null;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a remote mount's resolved url", () => {
  const KEY = "bb_live_S3cr3t+key/with=chars";
  const url = `https://mcp.browserbase.com/mcp?browserbaseApiKey=${encodeURIComponent(KEY)}`;

  it("never reaches the connect error or the log, only origin and path", async () => {
    const warned: unknown[] = [];
    const failing = (async (input: string | URL | Request) => {
      const href = input instanceof Request ? input.url : String(input);
      throw new Error(`fetch failed: ${href} (key ${KEY}, encoded ${encodeURIComponent(KEY)})`);
    }) as typeof fetch;
    mounts = new PackMounts({
      logger: { info() {}, warn: (obj: unknown) => warned.push(obj) },
      fetch: failing,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    const mount = { ...httpMount("browserbase", url), id: "browserbase/browser" };
    await mounts.sync({ resolvedMounts: async () => [mount] });
    const state = mounts.connection(mount.id);
    expect(state.connected).toBe(false);
    expect(state.error).toContain("https://mcp.browserbase.com/mcp");
    for (const text of [state.error ?? "", JSON.stringify(warned)]) {
      expect(text).not.toContain("browserbaseApiKey=");
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(encodeURIComponent(KEY));
    }
    expect(warned).toHaveLength(1);
  });

  it("is scrubbed from any message, with the query of other urls", () => {
    const msg = `failed ${url} then ${new URL(url).search} and ${KEY}; see https://other.example/x?token=abc#f`;
    const out = scrubMountUrls(msg, url);
    expect(out).toBe(
      "failed https://mcp.browserbase.com/mcp then [redacted] and [redacted]; see https://other.example/x",
    );
    expect(scrubMountUrls("plain message")).toBe("plain message");
  });
});
