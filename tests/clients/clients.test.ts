import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClientConfigError,
  ConfigParseError,
  MCP_REMOTE_VERSION,
  connectClient,
  disconnectClient,
  listClients,
  planConnect,
} from "../../src/clients/index.js";
import { getJsonSection } from "../../src/clients/json-edit.js";
import { getTomlSection, parseToml } from "../../src/clients/toml-edit.js";
import { getYamlSection } from "../../src/clients/yaml-edit.js";
import { expectMode, itSymlink } from "../support/platform.js";

const URL1 = "http://127.0.0.1:7801/mcp";
const URL2 = "http://127.0.0.1:7802/mcp";
const KEY = "test-access-key-123";

let home: string;
let outside: string;
const env = () => ({ home, env: {}, platform: "darwin" as NodeJS.Platform, applicationsDirs: [] });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plughive-clients-home-"));
  outside = mkdtempSync(join(tmpdir(), "plughive-clients-outside-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const p = join(home, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}
const read = (rel: string) => readFileSync(join(home, rel), "utf8");
const backups = (rel: string) => {
  const dir = join(home, rel, "..");
  const base = rel.split("/").pop() as string;
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.plughive-backup-`));
};

const DESKTOP = "Library/Application Support/Claude/claude_desktop_config.json";

describe("listClients", () => {
  it("lists every client with paths under the injected home and nothing installed", () => {
    const list = listClients(env());
    expect(list.map((c) => c.id)).toEqual([
      "claude-desktop",
      "claude-code",
      "cursor",
      "codex",
      "hermes",
    ]);
    for (const c of list) {
      expect(c.configPath.startsWith(home)).toBe(true);
      expect(c.installed).toBe(false);
      expect(c.connected).toBe(false);
    }
  });

  it("honours CODEX_HOME, HERMES_HOME and CLAUDE_CONFIG_DIR", () => {
    const list = listClients({
      ...env(),
      env: {
        CODEX_HOME: join(home, "cx"),
        HERMES_HOME: join(home, "hm"),
        CLAUDE_CONFIG_DIR: join(home, "cc"),
      },
    });
    const byId = Object.fromEntries(list.map((c) => [c.id, c.configPath]));
    expect(byId.codex).toBe(join(home, "cx", "config.toml"));
    expect(byId.hermes).toBe(join(home, "hm", "config.yaml"));
    expect(byId["claude-code"]).toBe(join(home, "cc", ".claude.json"));
  });

  it("reports installed, connected and the current url", () => {
    mkdirSync(join(home, ".cursor"));
    connectClient("cursor", { ...env(), url: URL1 });
    const cursor = listClients(env()).find((c) => c.id === "cursor");
    expect(cursor).toMatchObject({ installed: true, connected: true, url: URL1 });
  });

  it("reports a parse error instead of throwing", () => {
    write(".cursor/mcp.json", "{ not json");
    const cursor = listClients(env()).find((c) => c.id === "cursor");
    expect(cursor?.connected).toBe(false);
    expect(cursor?.error).toMatch(/not valid JSON/);
  });
});

describe("JSON clients", () => {
  it("creates a new file with mode 0600 and no backup", () => {
    const r = connectClient("claude-code", { ...env(), url: URL1, accessKey: KEY });
    expect(r.changed).toBe(true);
    expect(r.backupPath).toBeUndefined();
    expect(JSON.parse(read(".claude.json"))).toEqual({
      mcpServers: {
        plughive: { type: "http", url: URL1, headers: { Authorization: `Bearer ${KEY}` } },
      },
    });
    expectMode(join(home, ".claude.json"), 0o600);
  });

  it("keeps other keys, their order and formatting byte for byte", () => {
    const original = `{
    "numStartups": 12,
    "mcpServers": {
        "other": { "command": "x", "args": ["a"] }
    },
    "zeta": [1, 2, 3],
    "projects": {"a": {"b": true}}
}
`;
    write(".claude.json", original);
    connectClient("claude-code", { ...env(), url: URL1 });
    const after = read(".claude.json");
    expect(after).toBe(`{
    "numStartups": 12,
    "mcpServers": {
        "other": { "command": "x", "args": ["a"] },
        "plughive": {
            "type": "http",
            "url": "${URL1}"
        }
    },
    "zeta": [1, 2, 3],
    "projects": {"a": {"b": true}}
}
`);
    expect(Object.keys(JSON.parse(after))).toEqual([
      "numStartups",
      "mcpServers",
      "zeta",
      "projects",
    ]);
    // Removing it restores the original exactly.
    disconnectClient("claude-code", env());
    expect(read(".claude.json")).toBe(original);
  });

  it("adds mcpServers when missing and replaces an existing entry in place", () => {
    write(".cursor/mcp.json", '{\n  "a": 1\n}\n');
    connectClient("cursor", { ...env(), url: URL1 });
    expect(read(".cursor/mcp.json")).toBe(
      `{\n  "a": 1,\n  "mcpServers": {\n    "plughive": {\n      "url": "${URL1}"\n    }\n  }\n}\n`,
    );
    connectClient("cursor", { ...env(), url: URL2 });
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.plughive.url).toBe(URL2);
    expect(read(".cursor/mcp.json").startsWith('{\n  "a": 1,\n')).toBe(true);
  });

  it("is idempotent and makes exactly one backup", () => {
    write(".cursor/mcp.json", '{"mcpServers": {}}\n');
    const first = connectClient("cursor", { ...env(), url: URL1, accessKey: KEY });
    expect(first.changed).toBe(true);
    expect(first.backupPath).toBeDefined();
    expect(readFileSync(first.backupPath as string, "utf8")).toBe('{"mcpServers": {}}\n');
    const snapshot = read(".cursor/mcp.json");
    const second = connectClient("cursor", { ...env(), url: URL1, accessKey: KEY });
    expect(second).toEqual({ path: join(home, ".cursor/mcp.json"), changed: false });
    expect(read(".cursor/mcp.json")).toBe(snapshot);
    connectClient("cursor", { ...env(), url: URL2 });
    expect(backups(".cursor/mcp.json")).toHaveLength(1);
  });

  it("refuses a file that does not parse and leaves it alone", () => {
    const bad = '{ "mcpServers": { "a": 1, } }';
    write(".cursor/mcp.json", bad);
    expect(() => connectClient("cursor", { ...env(), url: URL1 })).toThrow(ConfigParseError);
    expect(read(".cursor/mcp.json")).toBe(bad);
    expect(backups(".cursor/mcp.json")).toHaveLength(0);
  });

  it("refuses duplicate keys and a non-object root", () => {
    write(".cursor/mcp.json", '{"mcpServers": {"plughive": {}, "plughive": {}}}');
    expect(() => connectClient("cursor", { ...env(), url: URL1 })).toThrow(/more than once/);
    write(".cursor/mcp.json", "[1, 2]");
    expect(() => connectClient("cursor", { ...env(), url: URL1 })).toThrow(ConfigParseError);
  });

  it("keeps CRLF line endings, tab indentation and an existing file mode", () => {
    const p = write(".cursor/mcp.json", '{\r\n\t"mcpServers": {\r\n\t\t"x": 1\r\n\t}\r\n}\r\n');
    chmodSync(p, 0o640);
    connectClient("cursor", { ...env(), url: URL1 });
    const after = read(".cursor/mcp.json");
    expect(after).toBe(
      `{\r\n\t"mcpServers": {\r\n\t\t"x": 1,\r\n\t\t"plughive": {\r\n\t\t\t"url": "${URL1}"\r\n\t\t}\r\n\t}\r\n}\r\n`,
    );
    expectMode(p, 0o640);
  });

  it("puts the access key in a header, never in the URL", () => {
    const plan = planConnect("cursor", { ...env(), url: URL1, accessKey: KEY });
    const entry = JSON.parse(plan.after).mcpServers.plughive;
    expect(entry.url).toBe(URL1);
    expect(entry.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("writes an mcp-remote bridge for Claude Desktop with the key in env, and explains it", () => {
    const plan = planConnect("claude-desktop", { ...env(), url: URL1, accessKey: KEY });
    expect(plan.path).toBe(join(home, DESKTOP));
    expect(plan.before).toBeNull();
    expect(plan.note).toMatch(/mcp-remote/);
    const entry = JSON.parse(plan.after).mcpServers.plughive;
    expect(entry).toEqual({
      command: "npx",
      args: [
        "-y",
        `mcp-remote@${MCP_REMOTE_VERSION}`,
        URL1,
        "--transport",
        "http-only",
        "--header",
        "Authorization:${AUTH_HEADER}",
      ],
      env: { AUTH_HEADER: `Bearer ${KEY}` },
    });
    expect(entry.args.join(" ")).not.toContain(KEY);
    connectClient("claude-desktop", { ...env(), url: URL1, accessKey: KEY });
    expect(listClients(env()).find((c) => c.id === "claude-desktop")).toMatchObject({
      connected: true,
      url: URL1,
    });
  });

  it("pins mcp-remote to one exact version and still reads entries older versions wrote (M5)", () => {
    expect(MCP_REMOTE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const entry = JSON.parse(planConnect("claude-desktop", { ...env(), url: URL1 }).after)
      .mcpServers.plughive;
    expect(entry.args.filter((a: string) => a.startsWith("mcp-remote"))).toEqual([
      `mcp-remote@${MCP_REMOTE_VERSION}`,
    ]);
    expect(planConnect("claude-desktop", { ...env(), url: URL1 }).note).toContain(
      `mcp-remote@${MCP_REMOTE_VERSION}`,
    );
    write(
      DESKTOP,
      JSON.stringify({
        mcpServers: { plughive: { command: "npx", args: ["-y", "mcp-remote", URL2] } },
      }),
    );
    expect(listClients(env()).find((c) => c.id === "claude-desktop")).toMatchObject({
      connected: true,
      url: URL2,
    });
    // Connecting again replaces the unpinned entry with the pinned one.
    connectClient("claude-desktop", { ...env(), url: URL2 });
    expect(JSON.parse(read(DESKTOP)).mcpServers.plughive.args[1]).toBe(
      `mcp-remote@${MCP_REMOTE_VERSION}`,
    );
  });

  it("writes 0600 whenever the file carries the access key, even over a 0644 file (M4)", () => {
    for (const [id, rel] of [
      ["cursor", ".cursor/mcp.json"],
      ["claude-desktop", DESKTOP],
    ] as const) {
      const p = write(rel, '{"mcpServers": {}}\n');
      chmodSync(p, 0o644);
      connectClient(id, { ...env(), url: URL1, accessKey: KEY });
      expect(read(rel)).toContain(KEY);
      expectMode(p, 0o600, id);
      // Already connected with the same key: nothing to rewrite, but the mode is still narrowed.
      chmodSync(p, 0o644);
      expect(connectClient(id, { ...env(), url: URL1, accessKey: KEY }).changed).toBe(false);
      expectMode(p, 0o600, id);
    }
    // TOML and YAML clients too.
    const toml = write(".codex/config.toml", 'model = "x"\n');
    chmodSync(toml, 0o644);
    connectClient("codex", { ...env(), url: URL1, accessKey: KEY });
    expectMode(toml, 0o600);
    // Without a key an existing mode is kept (see the CRLF test).
  });

  it("makes every backup 0600, whatever the original's mode (M4)", () => {
    const p = write(
      ".cursor/mcp.json",
      '{"mcpServers": {"other": {"url": "http://x", "headers": {"Authorization": "Bearer other-token"}}}}\n',
    );
    chmodSync(p, 0o644);
    const r = connectClient("cursor", { ...env(), url: URL1 });
    expect(r.backupPath).toBeDefined();
    expectMode(r.backupPath as string, 0o600);
    expect(readFileSync(r.backupPath as string, "utf8")).toContain("other-token");
    // The TOML writer goes through the same backup.
    const q = write(".codex/config.toml", 'model = "x"\n');
    chmodSync(q, 0o664);
    connectClient("codex", { ...env(), url: URL1 });
    const b = backups(".codex/config.toml");
    expect(b).toHaveLength(1);
    expectMode(join(home, ".codex", b[0] as string), 0o600);
  });

  it("planConnect writes nothing", () => {
    planConnect("cursor", { ...env(), url: URL1 });
    expect(() => lstatSync(join(home, ".cursor"))).toThrow();
  });

  it("disconnect of the only entry leaves an empty object, and is a no-op when absent", () => {
    write(".cursor/mcp.json", '{\n  "mcpServers": {}\n}\n');
    connectClient("cursor", { ...env(), url: URL1 });
    expect(disconnectClient("cursor", env()).changed).toBe(true);
    expect(JSON.parse(read(".cursor/mcp.json"))).toEqual({ mcpServers: {} });
    expect(disconnectClient("cursor", env()).changed).toBe(false);
    expect(disconnectClient("codex", env())).toEqual({
      path: join(home, ".codex/config.toml"),
      changed: false,
    });
  });
});

describe("Codex (TOML)", () => {
  const P = ".codex/config.toml";
  const ORIGINAL = `# Codex config
model = "gpt-5"   # trailing comment

[mcp_servers.other]
command = "npx"
args = ["-y", "thing"]

# comment that belongs to the next table
[profiles.fast]
model = "x"
`;

  it("appends one table and keeps everything else, comments included", () => {
    write(P, ORIGINAL);
    connectClient("codex", { ...env(), url: URL1, accessKey: KEY });
    expect(read(P)).toBe(
      `${ORIGINAL}\n[mcp_servers.plughive]\nurl = "${URL1}"\nhttp_headers = { Authorization = "Bearer ${KEY}" }\n`,
    );
    disconnectClient("codex", env());
    expect(read(P)).toBe(ORIGINAL);
  });

  it("replaces the table and its subtables in place", () => {
    write(
      P,
      `a = 1

[mcp_servers.plughive]
url = "http://old/mcp"
startup_timeout_sec = 5

[mcp_servers.plughive.http_headers]
X = "y"

# keep me
[mcp_servers.after]
url = "http://after/mcp"
`,
    );
    const r = connectClient("codex", { ...env(), url: URL1 });
    expect(r.changed).toBe(true);
    expect(read(P)).toBe(`a = 1

[mcp_servers.plughive]
url = "${URL1}"

# keep me
[mcp_servers.after]
url = "http://after/mcp"
`);
    expect(connectClient("codex", { ...env(), url: URL1 }).changed).toBe(false);
    expect(listClients(env()).find((c) => c.id === "codex")).toMatchObject({
      connected: true,
      url: URL1,
    });
  });

  it("creates the file when missing", () => {
    connectClient("codex", { ...env(), url: URL1 });
    expect(read(P)).toBe(`[mcp_servers.plughive]\nurl = "${URL1}"\n`);
  });

  it("refuses invalid TOML and inline definitions", () => {
    write(P, "a = \n");
    expect(() => connectClient("codex", { ...env(), url: URL1 })).toThrow(ConfigParseError);
    write(P, "[x]\na = 1\n[x]\nb = 2\n");
    expect(() => connectClient("codex", { ...env(), url: URL1 })).toThrow(/defined twice/);
    write(P, '[mcp_servers]\nplughive = { url = "http://x" }\n');
    expect(() => connectClient("codex", { ...env(), url: URL1 })).toThrow(ClientConfigError);
    write(P, 'mcp_servers = { other = { url = "http://x" } }\n');
    expect(() => connectClient("codex", { ...env(), url: URL1 })).toThrow(ClientConfigError);
    expect(read(P)).toBe('mcp_servers = { other = { url = "http://x" } }\n');
  });

  it("parses the TOML forms config files use", () => {
    write(
      P,
      `title = 'lit'
multi = """
two
lines"""
lit = '''raw \\n'''
n = 1_000
f = -3.5e2
hex = 0xff
d = 1979-05-27T07:32:00Z
d2 = 1979-05-27 07:32:00
arr = [
  1, # comment
  2,
]
"quoted key" = { a.b = 1, c = [ { d = true } ] }
[[fruits]]
name = "apple"
[[fruits]]
name = "pear"
`,
    );
    connectClient("codex", { ...env(), url: URL1 });
    expect(read(P)).toContain(`[mcp_servers.plughive]\nurl = "${URL1}"\n`);
  });
});

describe("Hermes (YAML)", () => {
  const P = ".hermes/config.yaml";
  const ORIGINAL = `# Hermes config
model:
  default: some-model   # comment
mcp_servers:
  other:
    command: "npx"
    args: ["-y", "x"]

# trailing section comment
terminal:
  backend: local
`;

  it("adds one entry and keeps other lines and comments", () => {
    write(P, ORIGINAL);
    connectClient("hermes", { ...env(), url: URL1, accessKey: KEY });
    expect(read(P)).toBe(`# Hermes config
model:
  default: some-model   # comment
mcp_servers:
  other:
    command: "npx"
    args: ["-y", "x"]
  plughive:
    url: "${URL1}"
    headers:
      Authorization: "Bearer ${KEY}"

# trailing section comment
terminal:
  backend: local
`);
    expect(connectClient("hermes", { ...env(), url: URL1, accessKey: KEY }).changed).toBe(false);
    expect(listClients(env()).find((c) => c.id === "hermes")).toMatchObject({
      connected: true,
      url: URL1,
    });
    disconnectClient("hermes", env());
    expect(read(P)).toBe(ORIGINAL);
  });

  it("replaces an existing entry, matching the file's indentation", () => {
    write(
      P,
      `mcp_servers:\n    plughive:\n        url: "http://old"\n        timeout: 30\n    b:\n        url: "http://b"\nx: 1\n`,
    );
    connectClient("hermes", { ...env(), url: URL2 });
    expect(read(P)).toBe(
      `mcp_servers:\n    plughive:\n        url: "${URL2}"\n    b:\n        url: "http://b"\nx: 1\n`,
    );
  });

  it("D-M16: keeps a # inside a quoted value", () => {
    expect(
      getYamlSection('mcp_servers:\n  a:\n    url: "http://x/ #frag"  # note\n', "mcp_servers"),
    ).toEqual({
      a: { url: "http://x/ #frag" },
    });
  });

  it("D-M16: refuses to splice a section that uses anchors, aliases or merge keys", () => {
    for (const text of [
      'mcp_servers:\n  base: &base\n    url: "http://b"\n  other: *base\n',
      'mcp_servers:\n  other:\n    <<: *base\n    url: "http://o"\n',
    ]) {
      write(P, text);
      expect(() => connectClient("hermes", { ...env(), url: URL1 })).toThrow(ClientConfigError);
      expect(read(P)).toBe(text);
    }
    const quoted = 'mcp_servers:\n  other:\n    url: "http://o/&x*y"  # &not *an alias\n';
    write(P, quoted);
    connectClient("hermes", { ...env(), url: URL1 });
    expect(read(P)).toContain("plughive:");
  });

  it("creates the section, and turns an empty flow mapping into a block", () => {
    write(P, "a: 1\n");
    connectClient("hermes", { ...env(), url: URL1 });
    expect(read(P)).toBe(`a: 1\nmcp_servers:\n  plughive:\n    url: "${URL1}"\n`);
    write(P, "mcp_servers: {}  # none yet\nb: 2\n");
    connectClient("hermes", { ...env(), url: URL1 });
    expect(read(P)).toBe(`mcp_servers:  # none yet\n  plughive:\n    url: "${URL1}"\nb: 2\n`);
    disconnectClient("hermes", env());
    expect(read(P)).toBe("mcp_servers: {}  # none yet\nb: 2\n");
  });

  it("refuses what it cannot edit safely", () => {
    write(P, "mcp_servers: { a: { url: x } }\n");
    expect(() => connectClient("hermes", { ...env(), url: URL1 })).toThrow(ClientConfigError);
    write(P, "a:\n\tb: 1\n");
    expect(() => connectClient("hermes", { ...env(), url: URL1 })).toThrow(ConfigParseError);
    write(P, "- a\n- b\n");
    expect(() => connectClient("hermes", { ...env(), url: URL1 })).toThrow(ConfigParseError);
    write(P, "mcp_servers:\n  a: 1\nmcp_servers:\n  b: 2\n");
    expect(() => connectClient("hermes", { ...env(), url: URL1 })).toThrow(/twice/);
    expect(read(P)).toBe("mcp_servers:\n  a: 1\nmcp_servers:\n  b: 2\n");
  });
});

describe("safety", () => {
  itSymlink("refuses a symlink that leaves the home directory", () => {
    const target = join(outside, "mcp.json");
    writeFileSync(target, "{}\n");
    mkdirSync(join(home, ".cursor"));
    symlinkSync(target, join(home, ".cursor", "mcp.json"));
    expect(() => connectClient("cursor", { ...env(), url: URL1 })).toThrow(/outside the home/);
    expect(readFileSync(target, "utf8")).toBe("{}\n");
  });

  itSymlink("refuses a symlinked directory that leaves the home directory", () => {
    symlinkSync(outside, join(home, ".cursor"));
    expect(() => connectClient("cursor", { ...env(), url: URL1 })).toThrow(/outside the home/);
    expect(readdirSync(outside)).toEqual([]);
  });

  itSymlink("follows a symlink that stays inside home and keeps the link", () => {
    write("dotfiles/mcp.json", "{}\n");
    mkdirSync(join(home, ".cursor"));
    symlinkSync(join(home, "dotfiles", "mcp.json"), join(home, ".cursor", "mcp.json"));
    connectClient("cursor", { ...env(), url: URL1 });
    expect(lstatSync(join(home, ".cursor", "mcp.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(read("dotfiles/mcp.json")).mcpServers.plughive.url).toBe(URL1);
  });

  it("refuses a config dir from env that is outside home", () => {
    expect(() =>
      connectClient("codex", { ...env(), env: { CODEX_HOME: outside }, url: URL1 }),
    ).toThrow(/outside the home/);
  });

  it("validates the name and the url", () => {
    expect(() => connectClient("cursor", { ...env(), url: URL1, name: "../x" })).toThrow(
      ClientConfigError,
    );
    expect(() => connectClient("cursor", { ...env(), url: "ftp://x" })).toThrow(ClientConfigError);
    expect(() => connectClient("cursor", { ...env(), url: "http://u:p@127.0.0.1/mcp" })).toThrow(
      ClientConfigError,
    );
    expect(() => connectClient("nope" as never, { ...env(), url: URL1 })).toThrow(/unknown client/);
  });

  it("refuses a url with spaces or control characters", () => {
    for (const url of [
      "http://127.0.0.1:7801/mcp x",
      "http://127.0.0.1:7801/mcp\n",
      "http://127.0.0.1:7801/\tmcp",
    ]) {
      expect(() => connectClient("cursor", { ...env(), url })).toThrow(
        /spaces or control characters/,
      );
    }
    expect(() => lstatSync(join(home, ".cursor", "mcp.json"))).toThrow();
  });

  it("on Windows refuses a Claude Desktop url that cmd would re-parse", () => {
    const win = { ...env(), platform: "win32" as NodeJS.Platform };
    for (const url of [
      "http://127.0.0.1:7801/mcp;calc",
      "http://127.0.0.1:7801/mcp,x",
      "http://127.0.0.1:7801/mcp&x",
    ]) {
      expect(() => planConnect("claude-desktop", { ...win, url })).toThrow(/on Windows/);
    }
    expect(planConnect("claude-desktop", { ...win, url: URL1 }).after).toContain('"cmd"');
  });

  it("leaves no temp files behind", () => {
    connectClient("cursor", { ...env(), url: URL1 });
    connectClient("cursor", { ...env(), url: URL2 });
    expect(readdirSync(join(home, ".cursor")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("prototype pollution (H-9)", () => {
  const protoUntouched = () => {
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "b")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  };

  it("a [__proto__] table in TOML is an own key, not Object.prototype", () => {
    const doc = parseToml("[__proto__]\npolluted = 1\n");
    protoUntouched();
    expect(Object.hasOwn(doc.data, "__proto__")).toBe(true);
    expect((doc.data as Record<string, unknown>).__proto__).toEqual({ polluted: 1 });
  });

  it("dotted and inline __proto__ keys in TOML cannot pollute", () => {
    parseToml("a.__proto__.b = 1\n");
    parseToml("x = { __proto__.b = 1 }\n");
    parseToml('[a."__proto__"]\nb = 1\n');
    protoUntouched();
  });

  it("reading a TOML section with a __proto__ entry keeps it an own key", () => {
    const sec = getTomlSection('[mcp_servers.__proto__]\nurl = "x"\n', "mcp_servers");
    protoUntouched();
    expect(Object.hasOwn(sec, "__proto__")).toBe(true);
  });

  it("a __proto__ member in JSON and YAML sections stays an own key", () => {
    const json = getJsonSection('{"mcpServers": {"__proto__": {"polluted": 1}}}', "mcpServers");
    protoUntouched();
    expect(Object.hasOwn(json, "__proto__")).toBe(true);
    const yaml = getYamlSection("mcp_servers:\n  __proto__:\n    polluted: 1\n", "mcp_servers");
    protoUntouched();
    expect(Object.hasOwn(yaml, "__proto__")).toBe(true);
  });

  it("connecting a client whose config already has a __proto__ table does not pollute", () => {
    write(".codex/config.toml", '[mcp_servers.__proto__]\nurl = "http://127.0.0.1:1/mcp"\n');
    planConnect("codex", { ...env(), url: URL1 });
    protoUntouched();
    expect(() => connectClient("codex", { ...env(), url: URL1, name: "__proto__" })).toThrow(
      /reserved/,
    );
    expect(() => connectClient("cursor", { ...env(), url: URL1, name: "constructor" })).toThrow(
      /reserved/,
    );
    expect(() => connectClient("cursor", { ...env(), url: URL1, name: "prototype" })).toThrow(
      /reserved/,
    );
  });
});
