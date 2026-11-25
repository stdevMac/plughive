import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import type { CliIo } from "../../src/cli/args.js";
import { runConnect } from "../../src/cli/connect.js";
import { cursorDeeplink, cursorServerConfig } from "../../src/cli/cursor-link.js";
import { checkHome, checkNode, checkPort } from "../../src/cli/doctor.js";
import { browserCommand } from "../../src/cli/open.js";
import { isGitUrl } from "../../src/cli/pack.js";
import { applyStartFlags } from "../../src/cli/start.js";
import { loadOrCreateAdminToken } from "../../src/lib/admin-token.js";

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

/** A port nothing listens on: bind, read it, close. */
async function unusedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((done) => srv.close(() => done()));
  return port;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plughive-cli-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("plughive CLI: commands and exit codes", () => {
  it("prints the main help with --help and help", async () => {
    for (const argv of [["--help"], ["help"], ["-h"]]) {
      const io = capture();
      expect(await runCli(argv, io)).toBe(0);
      expect(io.stdout.join("\n")).toContain("Usage: plughive [command]");
    }
  });

  it("every command has --help and exits 0 on it", async () => {
    for (const cmd of [
      "start",
      "dashboard",
      "doctor",
      "status",
      "pack",
      "cursor-link",
      "connect",
      "clients",
    ]) {
      const io = capture();
      expect(await runCli([cmd, "--help"], io), cmd).toBe(0);
      expect(io.stdout.join("\n"), cmd).toMatch(/Usage: plughive/);
    }
  });

  it("rejects an unknown command with exit code 2", async () => {
    const io = capture();
    expect(await runCli(["frobnicate"], io)).toBe(2);
    expect(io.stderr.join("\n")).toContain('unknown command "frobnicate"');
  });

  it("rejects an unknown flag with exit code 2 and points at --help", async () => {
    const io = capture();
    expect(await runCli(["status", "--nope"], io)).toBe(2);
    expect(io.stderr.join("\n")).toContain("plughive status --help");
  });

  it("prints the package version", async () => {
    const io = capture();
    expect(await runCli(["version"], io)).toBe(0);
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(io.stdout).toEqual([pkg.version]);
  });
});

describe("start flags", () => {
  it("applies --port, --host and --home to the environment", () => {
    const env: NodeJS.ProcessEnv = {};
    applyStartFlags(["--port", "9123", "--host", "127.0.0.1", "--home", home], env);
    expect(env.PLUGHIVE_PORT).toBe("9123");
    expect(env.PLUGHIVE_BIND_HOST).toBe("127.0.0.1");
    expect(env.PLUGHIVE_HOME).toBe(home);
    expect(env.PLUGHIVE_ROOT).toBe(home);
  });

  it("rejects a bad port with exit code 2", async () => {
    for (const port of ["0", "70000", "abc", "12.5"]) {
      const io = capture({ PLUGHIVE_HOME: home });
      expect(await runCli(["start", "--port", port], io), port).toBe(2);
      expect(io.stderr.join("\n")).toContain("--port must be a port number");
    }
  });

  it("refuses a non-loopback host without an access key, before booting", async () => {
    const io = capture({ PLUGHIVE_HOME: home });
    expect(await runCli(["start", "--host", "0.0.0.0", "--port", "9124"], io)).toBe(1);
    expect(io.stderr.join("\n")).toMatch(/PLUGHIVE_ACCESS_KEY/);
    // Nothing was created: the daemon never started.
    expect(readdirSync(home)).toEqual([]);
  });

  it("accepts a non-loopback host when an access key is set", () => {
    const env: NodeJS.ProcessEnv = { PLUGHIVE_ACCESS_KEY: "k".repeat(32) };
    expect(() => applyStartFlags(["--host", "0.0.0.0"], env)).not.toThrow();
  });
});

describe("connect and clients", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plughive-cli-clients-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const deps = () => ({
    clientEnv: { home, env: {}, platform: "darwin" as const, applicationsDirs: [] },
  });

  it("lists every client with its config path", () => {
    const io = capture();
    expect(runConnect("clients", [], io, deps())).toBe(0);
    const text = io.stdout.join("\n");
    for (const id of ["claude-desktop", "claude-code", "cursor", "codex", "hermes"]) {
      expect(text).toContain(id);
    }
    expect(text).toContain(home);
  });

  it("a dry run writes nothing and masks the access key", () => {
    const key = "k".repeat(32);
    const io = capture({ PLUGHIVE_ACCESS_KEY: key, PLUGHIVE_NO_DOTENV: "1" });
    expect(runConnect("connect", ["cursor", "--dry-run"], io, deps())).toBe(0);
    const text = io.stdout.join("\n");
    expect(text).toContain("/mcp");
    expect(text).not.toContain(key);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  it("connects, is idempotent, and removes", () => {
    const env = { PLUGHIVE_NO_DOTENV: "1", PLUGHIVE_PORT: "7791" };
    let io = capture(env);
    expect(runConnect("connect", ["cursor", "--profile", "images"], io, deps())).toBe(0);
    const file = join(home, ".cursor", "mcp.json");
    const cfg = JSON.parse(readFileSync(file, "utf8"));
    expect(cfg.mcpServers.plughive.url).toBe("http://127.0.0.1:7791/p/images/mcp");
    io = capture(env);
    expect(runConnect("connect", ["cursor", "--profile", "images"], io, deps())).toBe(0);
    expect(io.stdout.join("\n")).toContain("Already connected");
    io = capture(env);
    expect(runConnect("connect", ["cursor", "--remove"], io, deps())).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers?.plughive).toBeUndefined();
  });

  it("refuses a config file that does not parse and leaves it alone", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const file = join(home, ".cursor", "mcp.json");
    writeFileSync(file, "{ not json");
    const io = capture({ PLUGHIVE_NO_DOTENV: "1" });
    expect(runConnect("connect", ["cursor"], io, deps())).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("rejects an unknown client, --url with credentials, and --url with --profile", async () => {
    expect(await runCli(["connect", "nope"], capture())).toBe(2);
    expect(
      await runCli(["connect", "cursor", "--url", "http://a:b@127.0.0.1/mcp"], capture()),
    ).toBe(2);
    expect(
      await runCli(
        ["connect", "cursor", "--url", "http://127.0.0.1/mcp", "--profile", "x"],
        capture(),
      ),
    ).toBe(2);
  });
});

describe("cursor-link", () => {
  function decode(link: string) {
    const url = new URL(link);
    expect(url.protocol).toBe("cursor:");
    expect(url.host).toBe("anysphere.cursor-deeplink");
    expect(url.pathname).toBe("/mcp/install");
    const config = url.searchParams.get("config");
    expect(config).toBeTruthy();
    return {
      name: url.searchParams.get("name"),
      config: JSON.parse(Buffer.from(config ?? "", "base64").toString("utf8")) as unknown,
    };
  }

  it("prints the default link, which decodes to the local endpoint", async () => {
    const io = capture();
    expect(await runCli(["cursor-link"], io)).toBe(0);
    expect(io.stdout).toHaveLength(1);
    expect(decode(io.stdout[0] ?? "")).toEqual({
      name: "plughive",
      config: { url: "http://127.0.0.1:7777/mcp" },
    });
  });

  it("matches the link in the README", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      cursorDeeplink("plughive", cursorServerConfig("http://127.0.0.1:7777/mcp")),
    );
  });

  it("names an environment variable for the access key, never a value", async () => {
    const io = capture({ PLUGHIVE_ACCESS_KEY: "secret-value-that-must-not-leak" });
    expect(
      await runCli(
        [
          "cursor-link",
          "--url",
          "http://127.0.0.1:9000/p/media/mcp",
          "--access-key-env",
          "PLUGHIVE_ACCESS_KEY",
        ],
        io,
      ),
    ).toBe(0);
    const out = io.stdout[0] ?? "";
    expect(out).not.toContain("secret-value");
    expect(decode(out).config).toEqual({
      url: "http://127.0.0.1:9000/p/media/mcp",
      headers: { Authorization: "Bearer ${env:PLUGHIVE_ACCESS_KEY}" },
    });
  });

  it("rejects a URL with credentials or a query", async () => {
    for (const url of [
      "http://u:p@127.0.0.1:7777/mcp",
      "http://127.0.0.1:7777/mcp?key=x",
      "ftp://x/mcp",
      "nope",
    ]) {
      const io = capture();
      expect(await runCli(["cursor-link", "--url", url], io), url).toBe(2);
    }
  });
});

describe("open", () => {
  it("uses the platform opener without a shell", () => {
    expect(browserCommand("http://x/#token=t", "darwin")).toEqual({
      file: "open",
      args: ["http://x/#token=t"],
    });
    expect(browserCommand("http://x/", "linux")).toEqual({ file: "xdg-open", args: ["http://x/"] });
    expect(browserCommand("http://x/?a=%41&b", "win32")).toEqual({
      file: "rundll32",
      args: ["url.dll,FileProtocolHandler", "http://x/?a=%41&b"],
    });
  });
});

describe("doctor checks", () => {
  it("requires Node 22", () => {
    expect(checkNode("20.11.0").level).toBe("fail");
    expect(checkNode("22.0.0").level).toBe("ok");
  });

  it("checks the home directory", () => {
    expect(checkHome(join(home, "missing")).level).toBe("ok");
    expect(checkHome(home).level).toBe("ok");
    writeFileSync(join(home, "file"), "x");
    expect(checkHome(join(home, "file")).level).toBe("fail");
  });

  it("reports a free port", async () => {
    const port = await unusedPort();
    expect((await checkPort({ bindHost: "127.0.0.1", port, publicUrl: null })).level).toBe("ok");
  });

  it("runs and never prints the passphrase or keys", async () => {
    const port = await unusedPort();
    const io = capture({
      PLUGHIVE_HOME: home,
      PLUGHIVE_PORT: String(port),
      PLUGHIVE_SECRETS: "file",
      PLUGHIVE_SECRETS_PASSPHRASE: "do-not-print-this-passphrase",
      PLUGHIVE_ACCESS_KEY: "do-not-print-this-access-key",
    });
    const code = await runCli(["doctor"], io);
    const text = [...io.stdout, ...io.stderr].join("\n");
    expect(text).toContain("plughive doctor");
    expect(text).toMatch(/node: v/);
    expect(text).not.toContain("do-not-print");
    expect([0, 1]).toContain(code);
  });
});

describe("pack add and remove (no daemon running)", () => {
  function writePack(dir: string, manifest: Record<string, unknown>) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
    writeFileSync(
      join(dir, "index.js"),
      "export default (api) => api.definePack({ tools: [] });\n",
    );
  }

  it("recognises git URLs", () => {
    expect(isGitUrl("https://github.com/x/y.git")).toBe(true);
    expect(isGitUrl("git@github.com:x/y.git")).toBe(true);
    expect(isGitUrl("./local")).toBe(false);
    expect(isGitUrl("--upload-pack=x")).toBe(false);
  });

  it("copies a valid pack into the home, disabled, and tells the user to review it", async () => {
    const port = await unusedPort();
    const src = join(home, "src-pack");
    writePack(src, {
      id: "demo-pack",
      name: "Demo",
      version: "1.0.0",
      apiVersion: 1,
      entry: "index.js",
    });
    mkdirSync(join(src, "node_modules", "junk"), { recursive: true });
    const io = capture({ PLUGHIVE_HOME: join(home, "data"), PLUGHIVE_PORT: String(port) });
    expect(await runCli(["pack", "add", src], io)).toBe(0);
    const dest = join(home, "data", "packs", "demo-pack");
    expect(existsSync(join(dest, "pack.json"))).toBe(true);
    expect(existsSync(join(dest, "node_modules"))).toBe(false);
    const text = io.stdout.join("\n");
    expect(text).toContain("Review it before you enable it");
    expect(text).toContain("No daemon is running");

    // A second add of the same id is refused.
    const again = capture({ PLUGHIVE_HOME: join(home, "data"), PLUGHIVE_PORT: String(port) });
    expect(await runCli(["pack", "add", src], again)).toBe(1);
    expect(again.stderr.join("\n")).toContain("already installed");

    // remove moves it aside instead of deleting it.
    const rm = capture({ PLUGHIVE_HOME: join(home, "data"), PLUGHIVE_PORT: String(port) });
    expect(await runCli(["pack", "remove", "demo-pack"], rm)).toBe(0);
    expect(existsSync(dest)).toBe(false);
    const removed = readdirSync(join(home, "data", "packs", ".removed"));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^demo-pack-/);
  });

  it("refuses an invalid manifest, a bundled pack id and a missing folder", async () => {
    const port = await unusedPort();
    const env = { PLUGHIVE_HOME: join(home, "data"), PLUGHIVE_PORT: String(port) };
    const bad = join(home, "bad");
    writePack(bad, { id: "Bad Id", version: "1" });
    let io = capture(env);
    expect(await runCli(["pack", "add", bad], io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("Invalid pack manifest");

    const clash = join(home, "clash");
    writePack(clash, {
      id: "media",
      name: "Mine",
      version: "1.0.0",
      apiVersion: 1,
      entry: "index.js",
    });
    io = capture(env);
    expect(await runCli(["pack", "add", clash], io)).toBe(1);
    expect(io.stderr.join("\n")).toMatch(/bundled pack|reserved/);

    io = capture(env);
    expect(await runCli(["pack", "add", join(home, "nope")], io)).toBe(2);

    io = capture(env);
    expect(await runCli(["pack", "remove", "media"], io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("bundled pack");
  });
});

describe("status against a daemon", () => {
  let server: Server;
  let port: number;
  let seenAuth: (string | undefined)[];

  beforeEach(async () => {
    seenAuth = [];
    const token = loadOrCreateAdminToken(home, {}).token;
    server = createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/health") return json(200, { ok: true, version: "9.9.9" });
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { ok: false });
      if (req.url === "/api/info")
        return json(200, {
          ok: true,
          version: "9.9.9",
          mcp_url: `http://127.0.0.1:${port}/mcp`,
          auth_required: false,
          secrets_backend: "memory",
        });
      if (req.url === "/api/packs") {
        return json(200, {
          ok: true,
          packs: [
            {
              id: "media",
              version: "0.1.0",
              source: "builtin",
              enabled: true,
              state: "loaded",
              tools: ["a", "b"],
            },
            {
              id: "mine",
              version: "1.0.0",
              source: "user",
              enabled: false,
              state: "needs-review",
              tools: [],
            },
          ],
        });
      }
      if (req.url === "/api/tools") return json(200, { ok: true, tools: [{}, {}, {}] });
      json(404, { ok: false });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("reports version, packs and tools with the admin token", async () => {
    const io = capture({ PLUGHIVE_HOME: home, PLUGHIVE_PORT: String(port) });
    expect(await runCli(["status", "--json"], io)).toBe(0);
    const body = JSON.parse(io.stdout.join("\n")) as Record<string, unknown>;
    expect(body).toMatchObject({
      up: true,
      version: "9.9.9",
      tools: 3,
      packs: { total: 2, enabled: 1, loaded: 1, needs_review: ["mine"], failed: [] },
    });
    expect(seenAuth.filter(Boolean).length).toBeGreaterThan(0);
  });

  it("exits 1 when no daemon answers", async () => {
    const free = await unusedPort();
    const io = capture({ PLUGHIVE_HOME: home, PLUGHIVE_PORT: String(free) });
    expect(await runCli(["status"], io)).toBe(1);
    expect(io.stdout.join("\n")).toContain("not running");
  });

  it("pack list prints a table", async () => {
    const io = capture({ PLUGHIVE_HOME: home, PLUGHIVE_PORT: String(port) });
    expect(await runCli(["pack", "list"], io)).toBe(0);
    expect(io.stdout[0]).toMatch(/^ID\s+VERSION\s+SOURCE\s+STATE\s+TOOLS$/);
    expect(io.stdout.join("\n")).toContain("needs-review");
  });
});

describe("plughive service on a fresh home", () => {
  it("status needs no admin token: a first-time user gets an answer, not an error", async () => {
    const port = await unusedPort();
    const io = capture({ PLUGHIVE_HOME: home, PLUGHIVE_PORT: String(port) });
    const code = await runCli(["service", "status"], io);
    const text = [...io.stdout, ...io.stderr].join("\n");
    expect(text).not.toContain("no admin token");
    expect(text).toMatch(/daemon:\s+not answering/);
    expect([0, 1]).toContain(code);
  });
});
