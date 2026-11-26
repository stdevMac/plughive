// The CLI prints what the daemon and packs send, holds the admin token and
// writes files: these tests pin down what it refuses to do with them.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { apiUrl, assertTokenTransport, readBody } from "../../src/cli/api.js";
import { type CliIo, clean, cleanLine, jsonText } from "../../src/cli/args.js";
import { MAX_INPUT_BYTES, parseAssignments, readJsonInput } from "../../src/cli/common.js";
import { runConnect } from "../../src/cli/connect.js";
import { redactUrl } from "../../src/cli/pack.js";
import { sseFrames } from "../../src/cli/raw.js";
import { loadOrCreateAdminToken } from "../../src/lib/admin-token.js";
import { itPosix } from "../support/platform.js";

interface Captured extends CliIo {
  stdout: string[];
  stderr: string[];
}

function capture(env: NodeJS.ProcessEnv = {}): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    isTTY: false,
    env,
  };
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

// An OSC-52 clipboard write, a screen clear, a C1 CSI and a right-to-left override.
const EVIL = "a\x1b]52;c;ZXZpbA==\x07b\x1b[2Jc\u009b31md\u202ee\u2066f\x7fg";
/** True when the text still holds a character clean() drops. */
const hasRaw = (text: string) => clean(text) !== text;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plughive-cli-sec-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("terminal text cleaning", () => {
  it("strips control and bidi characters, keeps newlines and tabs", () => {
    expect(clean(EVIL)).toBe("a]52;c;ZXZpbA==b[2Jc31mdefg");
    expect(clean("one\ntwo\tthree")).toBe("one\ntwo\tthree");
    expect(cleanLine("one\ntwo\tthree\x1b")).toBe("one two three");
    expect(clean("plain ü 日本 🙂")).toBe("plain ü 日本 🙂");
  });

  it("jsonText is valid JSON with the same value, and unchanged for clean input", () => {
    const value = { name: EVIL, n: 1, nested: ["x\ny"] };
    const text = jsonText(value, 2);
    expect(hasRaw(text)).toBe(false);
    expect(JSON.parse(text)).toEqual(value);
    const plain = { a: "ü 日本", b: [1, 2], c: null };
    expect(jsonText(plain, 2)).toBe(JSON.stringify(plain, null, 2));
  });
});

describe("prototype pollution", () => {
  it("parseAssignments refuses __proto__, constructor and prototype", () => {
    for (const pair of [
      "__proto__.polluted=1",
      "constructor.prototype.polluted=1",
      "a.__proto__=1",
    ]) {
      expect(() => parseAssignments([pair])).toThrow(/cannot be used as a key/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parseAssignments(["a.b=1", "a.c=x"])).toEqual({ a: { b: "1", c: "x" } });
  });
});

describe("bounded input", () => {
  // FIFOs are POSIX-only (Git for Windows' mkfifo makes no real one).
  itPosix("refuses a FIFO for @file", () => {
    const fifo = join(home, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(() => readJsonInput(`@${fifo}`, "--data")).toThrow(/not a regular file/);
  });

  it("refuses a file over the cap for @file", () => {
    const big = join(home, "big.json");
    writeFileSync(big, `"${"x".repeat(MAX_INPUT_BYTES)}"`);
    expect(() => readJsonInput(`@${big}`, "--data")).toThrow(/larger than/);
    const ok = join(home, "ok.json");
    writeFileSync(ok, '{"a":1}');
    expect(readJsonInput(`@${ok}`, "--data")).toEqual({ a: 1 });
  });

  it("refuses a daemon answer over the cap", async () => {
    await expect(readBody(new Response("x".repeat(100)), 10)).rejects.toThrow(/larger than/);
    expect(await readBody(new Response("hello"), 10)).toBe("hello");
  });
});

describe("api paths and token transport", () => {
  const base = "http://127.0.0.1:7791";
  it("keeps every path under /api", () => {
    expect(apiUrl(base, "/api/jobs?limit=1")).toBe(`${base}/api/jobs?limit=1`);
    expect(apiUrl(base, "/api")).toBe(`${base}/api`);
    for (const bad of [
      "/api/../mcp",
      "/api/%2e%2e/mcp",
      "/api/.%2E/mcp",
      "/api\\..\\mcp",
      "//evil.example/api/x",
      "/apix",
      "api/jobs",
    ]) {
      expect(() => apiUrl(base, bad), bad).toThrow(/not a path under \/api/);
    }
  });

  it("sends the admin token only over https or to this computer", () => {
    expect(() => assertTokenTransport("http://203.0.113.5:7777")).toThrow(/plain HTTP/);
    expect(() => assertTokenTransport("http://daemon.example.com:7777")).toThrow(/plain HTTP/);
    for (const ok of [
      "http://127.0.0.1:7777",
      "http://localhost:7777",
      "http://[::1]:7777",
      "https://daemon.example.com",
    ]) {
      expect(() => assertTokenTransport(ok), ok).not.toThrow();
    }
  });

  it("refuses before any request when the daemon is bound to a remote address", async () => {
    loadOrCreateAdminToken(home, {});
    const c = capture({
      PLUGHIVE_HOME: home,
      PLUGHIVE_BIND_HOST: "203.0.113.5",
      PLUGHIVE_ACCESS_KEY: "k".repeat(32),
    });
    expect(await runCli(["jobs", "list"], c)).toBe(1);
    expect(c.stderr.join("\n")).toContain("refusing to send the admin token over plain HTTP");
  });
});

describe("against a hostile daemon", () => {
  let server: Server;
  let other: Server;
  let port: number;
  let otherPort: number;
  let seen: string[];
  let otherHits: number;

  beforeEach(async () => {
    seen = [];
    otherHits = 0;
    const token = loadOrCreateAdminToken(home, {}).token;
    other = createServer((_req, res) => {
      otherHits++;
      res.end("{}");
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    otherPort = (other.address() as AddressInfo).port;
    server = createServer((req, res) => {
      const url = req.url ?? "";
      seen.push(`${req.method} ${url}`);
      const json = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (url.startsWith("/artifacts/")) return res.end("file-bytes");
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { ok: false });
      if (url === "/api/redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/api/jobs` });
        return res.end();
      }
      if (url.startsWith("/api/jobs"))
        return json(200, {
          ok: true,
          counts: {},
          jobs: [
            {
              job_id: "job_1",
              tool: `gen\nfake row${EVIL}`,
              status: "succeeded",
              created_at: new Date().toISOString(),
            },
          ],
        });
      if (url.startsWith("/api/artifacts"))
        return json(200, {
          ok: true,
          total: 2,
          artifacts: [
            { id: "a_local", name: "out.png", url: `http://127.0.0.1:${port}/artifacts/a_local` },
            { id: "a_far", name: "far.png", url: `http://127.0.0.1:${otherPort}/artifacts/a_far` },
          ],
        });
      json(404, { ok: false, error: { code: "NOT_FOUND", message: `nope ${EVIL}` } });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    await new Promise<void>((done) => other.close(() => done()));
  });

  const io = () => capture({ PLUGHIVE_HOME: home, PLUGHIVE_PORT: String(port) });

  it("prints no escape sequences from an error, a table or --json", async () => {
    const err = io();
    expect(await runCli(["approvals", "approve", "apr_x"], err)).toBe(1);
    expect(err.stderr.join("\n")).toContain("nope a]52;c;ZXZpbA==b");
    const raw = io();
    expect(await runCli(["api", "GET", "/api/nope"], raw)).toBe(1);
    expect(JSON.parse(raw.stderr.join("\n")).error.message).toBe(`nope ${EVIL}`);
    const table = io();
    expect(await runCli(["jobs", "list"], table)).toBe(0);
    const json = io();
    expect(await runCli(["jobs", "list", "--json"], json)).toBe(0);
    for (const c of [err, raw, table, json]) {
      expect(hasRaw([...c.stdout, ...c.stderr].join("\n"))).toBe(false);
    }
    // A newline in a cell cannot fake a second row.
    expect(table.stdout.join("\n")).not.toMatch(/^fake row/m);
    expect(JSON.parse(json.stdout.join("\n")).jobs[0].tool).toBe(`gen\nfake row${EVIL}`);
  });

  it("api refuses paths that leave /api, without a request", async () => {
    for (const path of ["/api/../mcp", "/api/%2e%2e/mcp", "..%2f..%2fmcp/../../mcp"]) {
      expect(await runCli(["api", "GET", path], io()), path).toBe(2);
    }
    expect(seen).toEqual([]);
  });

  it("does not follow a redirect with the token", async () => {
    expect(await runCli(["api", "GET", "/api/redirect"], io())).toBe(1);
    expect(otherHits).toBe(0);
  });

  it("api refuses a body on DELETE", async () => {
    expect(await runCli(["api", "DELETE", "/api/jobs/x", "--data", "{}"], io())).toBe(2);
    expect(seen).toEqual([]);
  });

  it("downloads from the daemon only, and never through a symlink", async () => {
    const out = join(home, "out.png");
    expect(await runCli(["artifacts", "download", "a_local", "-o", out], io())).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("file-bytes");

    const far = io();
    expect(await runCli(["artifacts", "download", "a_far", "-o", join(home, "far")], far)).toBe(1);
    expect(far.stderr.join("\n")).toContain("not this daemon");
    expect(otherHits).toBe(0);

    const victim = join(home, "victim");
    writeFileSync(victim, "keep me");
    const link = join(home, "link.png");
    symlinkSync(victim, link);
    const c = io();
    expect(await runCli(["artifacts", "download", "a_local", "-o", link, "--force"], c)).toBe(1);
    expect(c.stderr.join("\n")).toContain("symlink");
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });
});

describe("pack add validation", () => {
  function writePack(dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({
        id: "demo-pack",
        name: "Demo",
        version: "1.0.0",
        apiVersion: 1,
        entry: "index.js",
      }),
    );
    writeFileSync(
      join(dir, "index.js"),
      "export default (api) => api.definePack({ tools: [] });\n",
    );
  }
  const env = () => ({ PLUGHIVE_HOME: join(home, "data"), PLUGHIVE_PORT: "1" });
  const dest = () => join(home, "data", "packs", "demo-pack");

  itPosix("refuses a FIFO in the pack and leaves nothing behind", async () => {
    const src = join(home, "src");
    writePack(src);
    execFileSync("mkfifo", [join(src, "pipe")]);
    const c = capture(env());
    expect(await runCli(["pack", "add", src], c)).toBe(1);
    expect(c.stderr.join("\n")).toContain("not a regular file");
    expect(existsSync(dest())).toBe(false);
  });

  it("refuses a pack with too many files", async () => {
    const src = join(home, "src");
    writePack(src);
    mkdirSync(join(src, "many"));
    for (let i = 0; i < 2001; i++) writeFileSync(join(src, "many", `f${i}`), "");
    const c = capture(env());
    expect(await runCli(["pack", "add", src], c)).toBe(1);
    expect(c.stderr.join("\n")).toContain("more than 2000 files");
    expect(existsSync(dest())).toBe(false);
  });

  it("refuses a symlinked pack.json", async () => {
    const src = join(home, "src");
    writePack(src);
    const real = join(home, "real.json");
    writeFileSync(real, readFileSync(join(src, "pack.json")));
    rmSync(join(src, "pack.json"));
    symlinkSync(real, join(src, "pack.json"));
    const c = capture(env());
    expect(await runCli(["pack", "add", src], c)).not.toBe(0);
    expect(existsSync(join(dest(), "pack.json"))).toBe(false);
  });

  it("never prints the credentials of a git URL", () => {
    expect(redactUrl("https://user:secret@github.com/x/y.git")).toBe(
      "https://***@github.com/x/y.git",
    );
    expect(redactUrl("git@github.com:x/y.git")).toBe("git@github.com:x/y.git");
  });
});

describe("connect dry run", () => {
  it("masks an access key the config file escapes", () => {
    const key = `${"k".repeat(24)}"quote\\back`;
    const io = capture({ PLUGHIVE_ACCESS_KEY: key, PLUGHIVE_NO_DOTENV: "1" });
    const deps = {
      clientEnv: { home, env: {}, platform: "darwin" as const, applicationsDirs: [] },
    };
    expect(runConnect("connect", ["cursor", "--dry-run"], io, deps)).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("********");
    expect(text).not.toContain("k".repeat(24));
  });
});

describe("sseFrames limits", () => {
  it("handles a \\r\\n split across chunks", async () => {
    const frames = [];
    for await (const f of sseFrames(streamOf(['data: {"a":1}\r\n\r', '\ndata: {"b":2}\r\n\r\n'])))
      frames.push(f);
    expect(frames).toEqual([
      { event: "message", data: { a: 1 } },
      { event: "message", data: { b: 2 } },
    ]);
  });

  it("refuses an event that never ends", async () => {
    const run = async () => {
      for await (const _ of sseFrames(streamOf([`data: "${"x".repeat(200)}`]), 100)) {
        // never reached
      }
    };
    await expect(run()).rejects.toThrow(/too large/);
  });
});
