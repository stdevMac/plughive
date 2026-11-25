// End-to-end tests of the machines pack through PackLoader, with a fake `ssh`
// first on PATH. No real host is ever contacted: the fake runs the remote
// command with /bin/sh in a temp "remote" folder.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validAgentSocket } from "../../../packs/machines/index.js";
import { buildSshArgs, hostKeyFilePath } from "../../../packs/machines/providers/ssh.js";
import { hostKeyLineProblem } from "../../../packs/machines/shell.js";
import type { MachineRecord } from "../../../packs/machines/state.js";
import { requestScope } from "../../../src/core/mcp/scope.js";
import type { HostLibrary } from "../../../src/core/packs/context.js";
import { PackLoader } from "../../../src/core/packs/loader.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";
import { expectMode } from "../../support/platform.js";

/** A well-formed known_hosts line (the key bytes are fake but valid base64). */
const PIN =
  "vps.test ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** What the user has allow-listed in most tests (the shipped default is empty). */
const ALLOWED = {
  allowedHosts: ["vps.test", "other.test", "slow.test", "noisy.test", "down.test"],
  allowedIdentityFiles: ["~/.ssh/id_ed25519", "/Users/me/.ssh/id_ed25519", "~/.ssh/does-not-exist"],
  allowDefaultKeys: true,
};

const FAKE_SSH = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const here = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(here, "calls.jsonl"), JSON.stringify({ args, pid: process.pid, sock: process.env.SSH_AUTH_SOCK ?? null }) + "\\n");
const dd = args.indexOf("--");
const host = args[dd + 1];
const cmd = args[dd + 2];
if (dd < 0 || args.length !== dd + 3) { process.stderr.write("fake ssh: bad argv\\n"); process.exit(254); }
if (host === "down.test") { process.stderr.write("ssh: connect to host down.test port 22: Connection refused\\n"); process.exit(255); }
if (host === "slow.test") { fs.writeFileSync(path.join(here, "slow.pid"), String(process.pid)); setInterval(() => {}, 1000); return; }
if (host === "noisy.test") { const chunk = Buffer.alloc(64 * 1024, 120); for (let i = 0; i < 80; i++) fs.writeSync(1, chunk); process.exit(0); }
const remote = path.join(here, "..", "remote");
const r = spawnSync("/bin/sh", ["-c", cmd], {
  cwd: remote,
  stdio: "inherit",
  env: { PATH: path.join(remote, "bin") + ":" + process.env.PATH, HOME: remote },
});
process.exit(r.status === null ? 255 : r.status);
`;

const FAKE_GIT = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/git-calls.log"
echo "Already up to date."
`;

let root: string;
let binDir: string;
let remoteDir: string;
let savedPath: string | undefined;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "machines-pack-")));
  binDir = join(root, "bin");
  remoteDir = join(root, "remote");
  mkdirSync(binDir);
  mkdirSync(join(remoteDir, "bin"), { recursive: true });
  writeFileSync(join(binDir, "ssh"), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(remoteDir, "bin", "git"), FAKE_GIT, { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = [binDir, dirname(process.execPath), savedPath ?? "/usr/bin:/bin"].join(
    delimiter,
  );
});

afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

function memoryLibrary(dir: string): HostLibrary {
  const records = new Map<string, ReturnType<HostLibrary["get"]> & object>();
  return {
    get: (id) => records.get(id) ?? null,
    list: () => [...records.values()],
    save(input) {
      const id = randomUUID();
      const path = join(dir, id);
      writeFileSync(path, input.bytes);
      records.set(id, {
        id,
        kind: input.kind,
        mime: input.mime,
        path,
        bytes: input.bytes.byteLength,
        tool: input.tool,
        model: null,
        prompt: null,
        meta: input.meta ?? null,
        costUsd: null,
        createdAt: new Date().toISOString(),
      });
      return { id, path, url: `http://127.0.0.1/a/${id}`, mime: input.mime };
    },
  };
}

const calls = (): Array<{ args: string[]; pid: number; sock: string | null }> => {
  const f = join(binDir, "calls.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The fake ssh and git are "#!" scripts, which Windows cannot start (and a
// real OpenSSH ssh.exe would win the PATH lookup there).
describe.skipIf(process.platform === "win32")("machines pack", () => {
  let tmp: string;
  let home: string;
  let library: HostLibrary;
  let registry: ToolRegistry;
  let loader: PackLoader;
  const stateFile = () => join(home, "pack-data", "machines", "machines.json");

  async function boot(
    settings: Record<string, unknown> = {},
    base: Record<string, unknown> = ALLOWED,
  ) {
    registry = new ToolRegistry();
    loader = new PackLoader({
      home,
      registry,
      host: {
        store: createSecretStore({ home, env: {}, backend: "memory" }),
        logger: silent,
        library,
      },
      userDir: join(home, "packs"),
      settingsOverrides: { machines: { ...base, ...settings } },
    });
    await loader.loadAll();
    // The pack ships switched off; the user turns it on.
    if (!(await loader.listPacks()).find((p) => p.id === "machines")?.enabled) {
      await loader.enable("machines");
    }
  }

  const call = (name: string, args: unknown) => registry.call(name, args);
  async function ok(name: string, args: unknown): Promise<any> {
    const r = await call(name, args);
    if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
    return r.result;
  }
  async function fail(name: string, args: unknown): Promise<{ code: string; message: string }> {
    const r = await call(name, args);
    if (r.ok) throw new Error(`${name} unexpectedly succeeded: ${JSON.stringify(r.result)}`);
    return r.error as { code: string; message: string };
  }
  const addVps = (extra: Record<string, unknown> = {}) =>
    ok("machine_add", {
      name: "vps",
      host: "vps.test",
      user: "deploy",
      use_default_keys: true,
      ...extra,
    });

  beforeEach(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "machines-home-")));
    home = join(tmp, "home");
    mkdirSync(join(tmp, "lib"));
    library = memoryLibrary(join(tmp, "lib"));
    rmSync(join(binDir, "calls.jsonl"), { force: true });
    rmSync(join(remoteDir, "git-calls.log"), { force: true });
    await boot();
  });

  afterEach(async () => {
    await loader.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("loads through PackLoader with its tools, hints and skill", async () => {
    const status = (await loader.listPacks()).find((p) => p.id === "machines");
    expect(status).toMatchObject({
      state: "loaded",
      source: "builtin",
      skills: ["machines"],
      error: null,
    });
    expect(status?.tools.sort()).toEqual(
      [
        "machine_add",
        "machine_add_repo",
        "machine_get_file",
        "machine_put_file",
        "machine_remove",
        "machine_remove_repo",
        "machine_run",
        "machine_status",
        "machine_update_repo",
        "machines_list",
      ].sort(),
    );
    expect(status?.permissions).toMatchObject({ spawn: ["ssh"], library: "full" });
    const run = registry.get("machine_run")!;
    expect(run.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect(run.description).toMatch(/untrusted/i);
    expect(run.longRunning).toBe(false);
    expect(registry.get("machine_update_repo")!.longRunning).toBe(true);
    expect(registry.get("machines_list")!.annotations).toMatchObject({ readOnlyHint: true });
    expect(registry.get("machine_remove")!.annotations).toMatchObject({ destructiveHint: true });
  });

  describe("state", () => {
    it("adds, lists and replaces machines in a 0600 state file", async () => {
      await addVps({ port: 2222, identity_file: "~/.ssh/id_ed25519" });
      expectMode(stateFile(), 0o600);
      const list = await ok("machines_list", {});
      expect(list.machines).toHaveLength(1);
      expect(JSON.stringify(list)).toContain("deploy@vps.test:2222");
      expect(
        (await fail("machine_add", { name: "vps", host: "other.test", user: "x" })).message,
      ).toMatch(/already exists/);
      await ok("machine_add", { name: "VPS", host: "other.test", user: "x", replace: true });
      const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
      expect(saved.machines).toHaveLength(1);
      expect(saved.machines[0].ssh).toEqual({
        host: "other.test",
        user: "x",
        port: 22,
        identityFile: null,
        hostKey: null,
        useAgent: false,
        useDefaultKeys: false,
      });
      expect(calls()).toEqual([]);
    });

    it("never stores key material, only the path", async () => {
      await addVps({ identity_file: "/Users/me/.ssh/id_ed25519" });
      const raw = readFileSync(stateFile(), "utf8");
      expect(raw).toContain("/Users/me/.ssh/id_ed25519");
      expect(raw).not.toMatch(/PRIVATE KEY/);
    });

    it("tightens a loosened state file and refuses a corrupt one without resetting it", async () => {
      await addVps();
      chmodSync(stateFile(), 0o644);
      await ok("machines_list", {});
      expectMode(stateFile(), 0o600);

      writeFileSync(stateFile(), "{ not json");
      expect((await fail("machines_list", {})).message).toMatch(/not valid JSON/);
      writeFileSync(
        stateFile(),
        JSON.stringify({ version: 1, machines: [{ name: "x" }], repos: [] }),
      );
      expect((await fail("machine_run", { machine: "x", command: "true" })).code).toBe(
        "TOOL_ERROR",
      );
      expect(readFileSync(stateFile(), "utf8")).toContain('"name":"x"');
      expect(calls()).toEqual([]);
    });

    it("machine_remove cascades the machine's repos", async () => {
      await addVps();
      await ok("machine_add_repo", { name: "api", machine: "vps", path: "/srv/api" });
      expect(await ok("machine_remove", { name: "vps" })).toEqual({
        removed: true,
        removed_repos: ["api"],
      });
      expect(await ok("machines_list", {})).toEqual({ machines: [], repos: [] });
    });
  });

  describe("validation", () => {
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["host option", { host: "-oProxyCommand=touch /tmp/pwned" }],
      ["host with user", { host: "root@evil.test" }],
      ["host with spaces", { host: "a.test b.test" }],
      ["host with newline", { host: "a.test\n-oProxyCommand=x" }],
      ["host substitution", { host: "$(touch pwned).test" }],
      ["user option", { user: "-oProxyCommand=x" }],
      ["user token", { user: "%u" }],
      ["user with host", { user: "a@b" }],
      ["port zero", { port: 0 }],
      ["port too big", { port: 70000 }],
      ["port string", { port: "22 -oProxyCommand=x" }],
      ["port fraction", { port: 22.5 }],
      ["identity option", { identity_file: "-oProxyCommand=x" }],
      ["identity relative", { identity_file: "id_rsa" }],
      ["identity traversal", { identity_file: "/home/me/../../etc/shadow" }],
      ["identity token", { identity_file: "/home/%u/key" }],
      ["identity newline", { identity_file: "/k\n-oProxyCommand=x" }],
      ["name traversal", { name: "../x" }],
      ["name option", { name: "-x" }],
      ["unknown field", { password: "hunter2" }],
    ];
    it.each(hostile)("rejects %s before anything runs", async (_label, over) => {
      const err = await fail("machine_add", {
        name: "vps",
        host: "vps.test",
        user: "deploy",
        ...over,
      });
      expect(err.code).toBe("INVALID_ARGUMENTS");
      expect(existsSync(stateFile())).toBe(false);
      expect(calls()).toEqual([]);
    });

    it("only targets registered machines", async () => {
      for (const [tool, args] of [
        ["machine_run", { machine: "ghost", command: "true" }],
        ["machine_status", { machine: "ghost" }],
        ["machine_get_file", { machine: "ghost", remote_path: "/etc/hosts" }],
        ["machine_add_repo", { name: "r", machine: "ghost", path: "/srv/r" }],
      ] as const) {
        expect((await fail(tool, args)).message).toMatch(/no machine named/);
      }
      expect(calls()).toEqual([]);
    });

    it("rejects hostile cwd, env names, repo paths and branches", async () => {
      await addVps();
      for (const cwd of ["-rf", "~/x", "a\nb", "a\0b", ""]) {
        expect((await fail("machine_run", { machine: "vps", command: "true", cwd })).code).toBe(
          "INVALID_ARGUMENTS",
        );
      }
      for (const name of ["A;B", "1A", "A B", "$(x)", ""]) {
        expect(
          (await fail("machine_run", { machine: "vps", command: "true", env: { [name]: "1" } }))
            .code,
        ).toBe("INVALID_ARGUMENTS");
      }
      for (const path of ["srv/api", "-x", "~/api", "/srv/a\nb"]) {
        expect((await fail("machine_add_repo", { name: "r", machine: "vps", path })).code).toBe(
          "INVALID_ARGUMENTS",
        );
      }
      for (const branch of ["-x", "a..b", "a b", "$(x)", "a;b", "a\nb"]) {
        expect(
          (await fail("machine_add_repo", { name: "r", machine: "vps", path: "/srv/r", branch }))
            .code,
        ).toBe("INVALID_ARGUMENTS");
      }
      expect((await fail("machine_run", { machine: "vps", command: "a\0b" })).code).toBe(
        "INVALID_ARGUMENTS",
      );
      expect(calls()).toEqual([]);
    });

    it("accepts a socket path or the Windows OpenSSH agent pipe as sshAuthSock", () => {
      expect(validAgentSocket("/tmp/agent.sock")).toBe(true);
      expect(validAgentSocket("\\\\.\\pipe\\openssh-ssh-agent")).toBe(true);
      expect(validAgentSocket("//./pipe/openssh-ssh-agent")).toBe(true);
      expect(validAgentSocket("agent.sock")).toBe(false);
      expect(validAgentSocket("C:\\agent.sock")).toBe(false);
      expect(validAgentSocket("\\\\.\\pipe\\..\\x")).toBe(false);
      expect(validAgentSocket("/tmp/a\nb")).toBe(false);
    });

    it("rejects a relative sshAuthSock setting", async () => {
      await addVps();
      await loader.close();
      await boot({ sshAuthSock: "agent.sock" });
      expect((await fail("machine_run", { machine: "vps", command: "true" })).message).toMatch(
        /absolute path/,
      );
      expect(calls()).toEqual([]);
    });
  });

  describe("allow-lists (H1)", () => {
    const NONE = { allowedHosts: [], allowedIdentityFiles: [] };
    async function reboot(settings: Record<string, unknown>) {
      await loader.close();
      await boot({}, settings);
    }

    it("ships with empty lists: by default an agent can register nothing", async () => {
      const manifest = JSON.parse(
        readFileSync(new URL("../../../packs/machines/pack.json", import.meta.url), "utf8"),
      );
      expect(manifest.settings.properties.allowedHosts).toMatchObject({
        type: "array",
        items: { type: "string" },
        default: [],
      });
      expect(manifest.settings.properties.allowedIdentityFiles).toMatchObject({
        type: "array",
        default: [],
      });
      await reboot({});
      for (const host of ["vps.test", "localhost", "127.0.0.1", "evil.test"]) {
        const err = await fail("machine_add", { name: "m", host, user: "u" });
        expect(err.code).toBe("TOOL_ERROR");
        expect(err.message).toMatch(/allowedHosts/);
        expect(err.message).toMatch(/dashboard/);
      }
      await reboot(NONE);
      expect(
        (await fail("machine_add", { name: "m", host: "vps.test", user: "u" })).message,
      ).toMatch(/not allowed/);
      expect(existsSync(stateFile())).toBe(false);
      expect(calls()).toEqual([]);
    });

    it("matches host, user@host, host:port and user@host:port entries", async () => {
      await reboot({
        allowedHosts: ["deploy@vps.test:2222", "Any.Test", "box.test:2200", "[::1]:22"],
      });
      await ok("machine_add", { name: "a", host: "vps.test", user: "deploy", port: 2222 });
      for (const bad of [
        { host: "vps.test", user: "root", port: 2222 },
        { host: "vps.test", user: "deploy", port: 22 },
        { host: "box.test", user: "x", port: 22 },
        { host: "evil.test", user: "deploy", port: 2222 },
        { host: "::1", user: "x", port: 2222 },
      ]) {
        expect((await fail("machine_add", { name: "b", ...bad })).message).toMatch(/allowedHosts/);
      }
      await ok("machine_add", { name: "c", host: "any.test", user: "root" });
      await ok("machine_add", { name: "d", host: "box.test", user: "x", port: 2200 });
      await ok("machine_add", { name: "e", host: "::1", user: "x" });
      expect(calls()).toEqual([]);
    });

    it("rejects a malformed allowedHosts entry instead of guessing", async () => {
      await reboot({ allowedHosts: ["vps.test", "-oProxyCommand=x"] });
      expect(
        (await fail("machine_add", { name: "a", host: "vps.test", user: "u" })).message,
      ).toMatch(/allowedHosts entry/);
    });

    it("replace=true cannot re-point a machine at a host that is not listed", async () => {
      await addVps();
      const before = readFileSync(stateFile(), "utf8");
      const err = await fail("machine_add", {
        name: "vps",
        host: "attacker.test",
        user: "deploy",
        replace: true,
      });
      expect(err.message).toMatch(/attacker\.test.*not allowed/);
      expect(readFileSync(stateFile(), "utf8")).toBe(before);
    });

    it("refuses unlisted identity files without saying whether they exist (L5)", async () => {
      const real = join(tmp, "id_real");
      writeFileSync(real, "not a key", { mode: 0o600 });
      const missing = join(tmp, "id_missing");
      const a = await fail("machine_add", {
        name: "a",
        host: "vps.test",
        user: "u",
        identity_file: real,
      });
      const b = await fail("machine_add", {
        name: "a",
        host: "vps.test",
        user: "u",
        identity_file: missing,
      });
      expect(a.message).toMatch(/allowedIdentityFiles/);
      expect(a.message).toBe(b.message);
      expect(a.message).not.toContain(tmp);
      expect(existsSync(stateFile())).toBe(false);
      // "~/" and the expanded home path are the same entry.
      await reboot({ ...ALLOWED, allowedIdentityFiles: [`${homedir()}/.ssh/work_key`] });
      await addVps({ identity_file: "~/.ssh/work_key" });
      expect(calls()).toEqual([]);
    });

    it("refuses a stored machine whose host is no longer listed, before ssh runs", async () => {
      await addVps();
      await ok("machine_add_repo", { name: "api", machine: "vps", path: "/srv/api" });
      const art = library.save({
        kind: "other",
        mime: "text/plain",
        bytes: Buffer.from("x"),
        tool: "t",
      });
      await reboot({ allowedHosts: ["other.test"] });
      for (const [tool, args] of [
        ["machine_run", { machine: "vps", command: "true" }],
        ["machine_status", { machine: "vps" }],
        ["machine_get_file", { machine: "vps", remote_path: "/etc/hosts" }],
        ["machine_put_file", { machine: "vps", artifact_id: art.id, remote_path: "/tmp/x" }],
        ["machine_update_repo", { repo: "api" }],
        ["machine_add_repo", { name: "web", machine: "vps", path: "/srv/web" }],
      ] as const) {
        const err = await fail(tool, args);
        expect(err.message).toMatch(/machine "vps": host deploy@vps\.test:22 is not allowed/);
      }
      const list = await ok("machines_list", {});
      expect(list.machines[0].details.allowed).toBe(false);
      expect(calls()).toEqual([]);
    });

    it("refuses a stored machine whose identity file is no longer listed", async () => {
      await addVps({ identity_file: "~/.ssh/id_ed25519" });
      await reboot({ ...ALLOWED, allowedIdentityFiles: [] });
      expect((await fail("machine_run", { machine: "vps", command: "true" })).message).toMatch(
        /allowedIdentityFiles/,
      );
      expect(calls()).toEqual([]);
    });
  });

  describe("host keys", () => {
    // The real OpenSSH client evaluates the exact argv the pack builds (-G
    // prints the resulting configuration and connects to nothing).
    const realSsh = ["/usr/bin/ssh", "/bin/ssh"].find((p) => existsSync(p));
    it.skipIf(!realSsh)("real ssh reads only the pack's known_hosts, accept-new", () => {
      const dataDir = join(tmp, "pack data");
      const args = buildSshArgs(
        {
          name: "vps",
          provider: "ssh",
          ssh: {
            host: "vps.test",
            user: "deploy",
            port: 22,
            identityFile: null,
            hostKey: null,
            useAgent: false,
            useDefaultKeys: false,
          },
          createdAt: "",
          updatedAt: "",
        },
        "true",
        { dataDir, connectTimeoutSeconds: 5 },
      );
      const r = spawnSync(realSsh!, ["-G", ...args.slice(0, -1)], { encoding: "utf8", env: {} });
      expect(r.status).toBe(0);
      const conf = new Map(
        r.stdout
          .trim()
          .split("\n")
          .map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)] as const),
      );
      expect(conf.get("stricthostkeychecking")).toBe("accept-new");
      expect(conf.get("userknownhostsfile")).toBe(`${dataDir}/known_hosts`);
      expect(conf.get("globalknownhostsfile")).toBe("/dev/null");
      expect(conf.get("updatehostkeys")).toBe("false");
      expect(conf.get("proxycommand")).toBeUndefined();
    });

    it.skipIf(!realSsh)(
      "real ssh reads a pinned machine's key file with StrictHostKeyChecking=yes",
      () => {
        const dataDir = join(tmp, "pack data");
        const args = buildSshArgs(
          {
            name: "vps",
            provider: "ssh",
            ssh: {
              host: "vps.test",
              user: "deploy",
              port: 22,
              identityFile: null,
              hostKey: PIN,
              useAgent: false,
              useDefaultKeys: false,
            },
            createdAt: "",
            updatedAt: "",
          },
          "true",
          { dataDir, connectTimeoutSeconds: 5 },
        );
        const r = spawnSync(realSsh!, ["-G", ...args.slice(0, -1)], { encoding: "utf8", env: {} });
        expect(r.status).toBe(0);
        const conf = new Map(
          r.stdout
            .trim()
            .split("\n")
            .map((l) => [l.slice(0, l.indexOf(" ")), l.slice(l.indexOf(" ") + 1)] as const),
        );
        // ssh -G prints the yes/no option as a boolean; the argv itself carries "yes".
        expect(["yes", "true"]).toContain(conf.get("stricthostkeychecking"));
        expect(conf.get("userknownhostsfile")).toBe(hostKeyFilePath(dataDir, "vps"));
      },
    );

    it("buildSshArgs pins the key file only when hostKey is set", () => {
      const dataDir = join(tmp, "pack data");
      const base = {
        name: "vps",
        provider: "ssh" as const,
        ssh: {
          host: "vps.test",
          user: "deploy",
          port: 22,
          identityFile: null,
          hostKey: null,
          useAgent: false,
          useDefaultKeys: false,
        },
        createdAt: "",
        updatedAt: "",
      };
      const plain = buildSshArgs(base, "true", { dataDir, connectTimeoutSeconds: 5 });
      const i = plain.indexOf("StrictHostKeyChecking=accept-new");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(plain).toContain(`UserKnownHostsFile="${join(dataDir, "known_hosts")}"`);
      const pinned = buildSshArgs({ ...base, ssh: { ...base.ssh, hostKey: PIN } }, "true", {
        dataDir,
        connectTimeoutSeconds: 5,
      });
      expect(pinned).toContain("StrictHostKeyChecking=yes");
      expect(pinned).not.toContain("StrictHostKeyChecking=accept-new");
      expect(pinned).toContain(`UserKnownHostsFile="${hostKeyFilePath(dataDir, "vps")}"`);
    });
  });

  describe("host_key pinning", () => {
    it("accepts a known_hosts line, stores it and writes the pin file on first use", async () => {
      await addVps({ host_key: PIN });
      const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
      expect(saved.machines[0].ssh.hostKey).toBe(PIN);
      const list = await ok("machines_list", {});
      expect(list.machines[0].details.host_key).toBe("pinned");
      const r = await ok("machine_run", { machine: "vps", command: "true" });
      expect(r.ok).toBe(true);
      const args = calls().at(-1)!.args;
      expect(args).toContain("StrictHostKeyChecking=yes");
      const pinFile = hostKeyFilePath(join(home, "pack-data", "machines"), "vps");
      expect(readFileSync(pinFile, "utf8")).toBe(`${PIN}\n`);
      expectMode(pinFile, 0o600);
    });

    it("refuses malformed host_key values before storing anything", async () => {
      for (const bad of [
        "vps.test ssh-ed25519", // too few fields
        "@cert-authority vps.test ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA",
        "*.test ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA",
        "vps.test ssh-rot13 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA",
        "vps.test ssh-ed25519 not!base64!!",
        "vps.test ssh-ed25519 AAAA", // decodes to 3 bytes
      ]) {
        const err = await fail("machine_add", {
          name: "a",
          host: "vps.test",
          user: "u",
          host_key: bad,
        });
        expect(err.message).toMatch(/host_key/);
      }
      expect(existsSync(stateFile())).toBe(false);
    });

    it("replace without host_key clears the pin, and machine_remove deletes the pin file", async () => {
      await addVps({ host_key: PIN });
      await ok("machine_run", { machine: "vps", command: "true" });
      const pinFile = hostKeyFilePath(join(home, "pack-data", "machines"), "vps");
      expect(existsSync(pinFile)).toBe(true);
      await ok("machine_add", {
        name: "vps",
        host: "vps.test",
        user: "deploy",
        replace: true,
        use_default_keys: true,
      });
      const saved = JSON.parse(readFileSync(stateFile(), "utf8"));
      expect(saved.machines[0].ssh.hostKey).toBeNull();
      await ok("machine_run", { machine: "vps", command: "true" });
      expect(calls().at(-1)!.args).toContain("StrictHostKeyChecking=accept-new");
      // re-pin, then remove the machine
      await ok("machine_add", {
        name: "vps",
        host: "vps.test",
        user: "deploy",
        replace: true,
        host_key: PIN,
        use_default_keys: true,
      });
      await ok("machine_run", { machine: "vps", command: "true" });
      expect(existsSync(pinFile)).toBe(true);
      await ok("machine_remove", { name: "vps" });
      expect(existsSync(pinFile)).toBe(false);
    });

    it("validates known_hosts lines (hostKeyLineProblem)", () => {
      expect(hostKeyLineProblem(PIN)).toBeNull();
      expect(
        hostKeyLineProblem(
          "[vps.test]:2222 ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA extra comment",
        ),
      ).toBeNull();
      expect(hostKeyLineProblem("")).toMatch(/1-4096/);
      expect(hostKeyLineProblem("vps.test ssh-ed25519")).toMatch(/known_hosts line/);
      expect(
        hostKeyLineProblem(
          "@revoked vps.test ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA",
        ),
      ).toMatch(/@cert-authority/);
      expect(
        hostKeyLineProblem(
          "vps.test,*.test ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA",
        ),
      ).toMatch(/wildcards/);
      expect(hostKeyLineProblem("vps.test ssh-ed25519 AAAA")).toMatch(/base64/);
      expect(
        hostKeyLineProblem(
          "vps.test ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA\n",
        ),
      ).toMatch(/control/);
    });
  });

  describe("run", () => {
    it("spawns ssh with an argv array, fixed options and -- before the host", async () => {
      await addVps({ port: 2200 });
      const r = await ok("machine_run", {
        machine: "vps",
        command: "echo hello; echo oops >&2; exit 3",
      });
      expect(r).toMatchObject({
        ok: false,
        exit_code: 3,
        stdout: "hello\n",
        stderr: "oops\n",
        timed_out: false,
      });
      const [c] = calls();
      const args = c!.args;
      expect(args.slice(-3)).toEqual(["--", "vps.test", "echo hello; echo oops >&2; exit 3"]);
      for (const opt of [
        "BatchMode=yes",
        "StrictHostKeyChecking=accept-new",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ProxyCommand=none",
        "ConnectTimeout=10",
      ]) {
        expect(args[args.indexOf(opt) - 1]).toBe("-o");
      }
      expect(args).toEqual(expect.arrayContaining(["-T", "-p", "2200", "-l", "deploy"]));
      expect(args).not.toContain("-i");
      expect(c!.sock).toBeNull();
      // The pack's own known_hosts only: never the user's, never the system's.
      const knownHosts = args.find((a) => a.startsWith("UserKnownHostsFile="))!;
      expect(knownHosts).toBe(
        `UserKnownHostsFile="${join(home, "pack-data", "machines", "known_hosts")}"`,
      );
      expect(args.join(" ")).not.toContain("~/.ssh/known_hosts");
      expect(args[args.indexOf("GlobalKnownHostsFile=/dev/null") - 1]).toBe("-o");
      expect(args[args.indexOf("UpdateHostKeys=no") - 1]).toBe("-o");
    });

    it("passes the identity path and agent socket without reading either", async () => {
      await loader.close();
      await boot({ sshAuthSock: "/tmp/fake-agent.sock", connectTimeoutSeconds: 4 });
      await addVps({ identity_file: "~/.ssh/does-not-exist", use_agent: true });
      await ok("machine_run", { machine: "vps", command: "true" });
      const [c] = calls();
      expect(c!.args[c!.args.indexOf("-i") + 1]).toBe("~/.ssh/does-not-exist");
      expect(c!.args).toContain("IdentitiesOnly=yes");
      expect(c!.args).toContain("ConnectTimeout=4");
      expect(c!.sock).toBe("/tmp/fake-agent.sock");
    });

    it("quotes hostile cwd and env values so they arrive literally", async () => {
      await addVps();
      const weird = join(remoteDir, "it's $(touch pwned) `x`");
      mkdirSync(weird, { recursive: true });
      const value = "'; touch pwned; echo '$(touch pwned)`touch pwned`\"$HOME\"\n";
      const r = await ok("machine_run", {
        machine: "vps",
        command: 'pwd; printf "%s" "$V"',
        cwd: weird,
        env: { V: value },
      });
      expect(r.ok).toBe(true);
      expect(r.stdout).toBe(`${weird}\n${value}`);
      expect(existsSync(join(remoteDir, "pwned"))).toBe(false);
      expect(existsSync(join(weird, "pwned"))).toBe(false);
      rmSync(weird, { recursive: true, force: true });
    });

    it("fails before running the command when cwd does not exist", async () => {
      await addVps();
      const r = await ok("machine_run", {
        machine: "vps",
        command: "touch ran",
        cwd: "/definitely/not/here",
      });
      expect(r.ok).toBe(false);
      expect(r.exit_code).toBe(1);
      expect(existsSync(join(remoteDir, "ran"))).toBe(false);
    });

    it("kills the local ssh at the timeout and leaves no orphan", async () => {
      await ok("machine_add", {
        name: "slow",
        host: "slow.test",
        user: "u",
        use_default_keys: true,
      });
      rmSync(join(binDir, "slow.pid"), { force: true });
      const started = Date.now();
      const r = await ok("machine_run", {
        machine: "slow",
        command: "sleep 100",
        timeout_ms: 1000,
      });
      expect(Date.now() - started).toBeLessThan(8000);
      expect(r).toMatchObject({ ok: false, timed_out: true, exit_code: null });
      const pid = Number(readFileSync(join(binDir, "slow.pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      const deadline = Date.now() + 3000;
      while (alive(pid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
      expect(alive(pid)).toBe(false);
    }, 15_000);

    it("stops at the output cap and reports truncated", async () => {
      await ok("machine_add", {
        name: "noisy",
        host: "noisy.test",
        user: "u",
        use_default_keys: true,
      });
      const r = await ok("machine_run", {
        machine: "noisy",
        command: "yes",
        max_output_bytes: 4096,
      });
      // The partial output is returned, never more than the cap.
      expect(r).toMatchObject({ ok: false, truncated: true, exit_code: null });
      expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(4096);
      expect(r.stderr).toMatch(/output exceeded 4096 bytes/);
    });
  });

  describe("status", () => {
    it("reports reachable and unreachable machines", async () => {
      await addVps();
      await ok("machine_add", {
        name: "down",
        host: "down.test",
        user: "u",
        use_default_keys: true,
      });
      const up = await ok("machine_status", { machine: "vps" });
      expect(up).toMatchObject({ reachable: true });
      expect(typeof up.latencyMs).toBe("number");
      const down = await ok("machine_status", { machine: "down" });
      expect(down).toMatchObject({ reachable: false });
      expect(JSON.stringify(down)).toMatch(/Connection refused/);
    });
  });

  describe("files", () => {
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const allBytes = Buffer.from(Array.from({ length: 256 * 4 }, (_, i) => i % 256));

    it("uploads a library artifact byte for byte, with mode", async () => {
      await addVps();
      const art = library.save({
        kind: "other",
        mime: "application/octet-stream",
        bytes: allBytes,
        tool: "t",
      });
      const target = join(remoteDir, "up.bin");
      const r = await ok("machine_put_file", {
        machine: "vps",
        artifact_id: art.id,
        remote_path: target,
        mode: "600",
      });
      expect(r.bytes).toBe(allBytes.byteLength);
      expect(readFileSync(target).equals(allBytes)).toBe(true);
      expectMode(target, 0o600);
      rmSync(target);
    });

    it("writes to a hostile remote path literally", async () => {
      await addVps();
      const art = library.save({
        kind: "other",
        mime: "text/plain",
        bytes: Buffer.from("hi"),
        tool: "t",
      });
      const name = "a'; touch pwned; echo '$(touch pwned).txt";
      await ok("machine_put_file", { machine: "vps", artifact_id: art.id, remote_path: name });
      expect(readFileSync(join(remoteDir, name), "utf8")).toBe("hi");
      expect(existsSync(join(remoteDir, "pwned"))).toBe(false);
      rmSync(join(remoteDir, name));
    });

    it("only uploads library artifacts", async () => {
      await addVps();
      expect(
        (
          await fail("machine_put_file", {
            machine: "vps",
            artifact_id: "/etc/passwd",
            remote_path: "/tmp/x",
          })
        ).message,
      ).toMatch(/not found/);
      expect(
        (
          await fail("machine_put_file", {
            machine: "vps",
            artifact_id: "x",
            remote_path: "-x",
            mode: "u+s",
          })
        ).code,
      ).toBe("INVALID_ARGUMENTS");
      expect(calls()).toEqual([]);
    });

    it("downloads into the library, never to a local path", async () => {
      await addVps();
      writeFileSync(join(remoteDir, "down.png"), Buffer.concat([PNG_MAGIC, allBytes]));
      const r = await ok("machine_get_file", {
        machine: "vps",
        remote_path: join(remoteDir, "down.png"),
      });
      expect(r.bytes).toBe(allBytes.byteLength + PNG_MAGIC.byteLength);
      expect(r.artifact.mime).toBe("image/png");
      // Packs get an id and a url, never a filesystem path.
      expect(r.artifact.path).toBeUndefined();
      expect(typeof r.artifact.url).toBe("string");
      const stored = library.get(r.artifact.id);
      expect(stored?.path.startsWith(join(tmp, "lib"))).toBe(true);
      expect(readFileSync(stored!.path).equals(Buffer.concat([PNG_MAGIC, allBytes]))).toBe(true);
      expect(library.get(r.artifact.id)).toMatchObject({
        kind: "image",
        meta: { machine: "vps", untrusted: true },
      });
      expect(
        (await fail("machine_get_file", { machine: "vps", remote_path: "x", out: "/tmp/x" })).code,
      ).toBe("INVALID_ARGUMENTS");
      rmSync(join(remoteDir, "down.png"));
    });

    it("derives the stored type from the content, never from the caller (L5)", async () => {
      await addVps();
      const cases: Array<[string, Buffer, string]> = [
        ["fake.png", Buffer.from("<html><script>x</script></html>"), "application/octet-stream"],
        ["real.bin", Buffer.concat([PNG_MAGIC, Buffer.alloc(8)]), "image/png"],
        ["notes.txt", Buffer.from("hello\n"), "text/plain"],
        ["data.json", Buffer.from([0x7b, 0x00, 0xff]), "application/octet-stream"],
        ["page.html", Buffer.from("<html></html>"), "application/octet-stream"],
        ["doc.pdf", Buffer.from("%PDF-1.7\n"), "application/pdf"],
      ];
      for (const [name, bytes, mime] of cases) {
        writeFileSync(join(remoteDir, name), bytes);
        const r = await ok("machine_get_file", {
          machine: "vps",
          remote_path: join(remoteDir, name),
        });
        expect([name, r.artifact.mime]).toEqual([name, mime]);
        rmSync(join(remoteDir, name));
      }
      expect(
        (
          await fail("machine_get_file", {
            machine: "vps",
            remote_path: "/etc/hosts",
            mime: "text/html",
          })
        ).code,
      ).toBe("INVALID_ARGUMENTS");
    });

    it("refuses files over max_bytes, directories and missing files", async () => {
      await addVps();
      writeFileSync(join(remoteDir, "big.bin"), Buffer.alloc(5000));
      expect(
        (
          await fail("machine_get_file", {
            machine: "vps",
            remote_path: join(remoteDir, "big.bin"),
            max_bytes: 4999,
          })
        ).message,
      ).toMatch(/over the 4999 byte limit/);
      expect(
        (await fail("machine_get_file", { machine: "vps", remote_path: remoteDir })).message,
      ).toMatch(/not a regular file/);
      expect(
        (await fail("machine_get_file", { machine: "vps", remote_path: "/no/such/file" })).message,
      ).toMatch(/not a regular file/);
      expect(library.list({})).toEqual([]);
      rmSync(join(remoteDir, "big.bin"));
    });
  });

  describe("repos", () => {
    it("dry-runs, updates with the fake git and runs post_update", async () => {
      await addVps();
      const repoDir = join(remoteDir, "api");
      mkdirSync(repoDir, { recursive: true });
      await ok("machine_add_repo", {
        name: "api",
        machine: "vps",
        path: repoDir,
        repo_url: "https://github.com/acme/api.git",
        branch: "main",
        post_update: "echo deployed > deployed.txt",
      });
      const dry = await ok("machine_update_repo", { repo: "acme/api", dry_run: true });
      expect(dry.dry_run).toBe(true);
      expect(dry.remote_command).toBe(
        `cd '${repoDir}' || exit 1\ngit pull --ff-only origin 'main' || exit $?\necho deployed > deployed.txt`,
      );
      expect(calls()).toEqual([]);

      const r = await ok("machine_update_repo", { repo: "api" });
      expect(r).toMatchObject({ ok: true, exit_code: 0, dry_run: false });
      expect(r.stdout).toContain("Already up to date.");
      expect(readFileSync(join(remoteDir, "git-calls.log"), "utf8")).toBe(
        "pull --ff-only origin main\n",
      );
      expect(readFileSync(join(repoDir, "deployed.txt"), "utf8")).toBe("deployed\n");
      rmSync(repoDir, { recursive: true, force: true });
    });

    it("quotes a hostile repo path", async () => {
      await addVps();
      const repoDir = join(remoteDir, "x'; touch pwned; echo '$(touch pwned)");
      mkdirSync(repoDir, { recursive: true });
      await ok("machine_add_repo", { name: "evil", machine: "vps", path: repoDir });
      const r = await ok("machine_update_repo", { repo: "evil" });
      expect(r.ok).toBe(true);
      expect(existsSync(join(remoteDir, "pwned"))).toBe(false);
      expect(existsSync(join(repoDir, "pwned"))).toBe(false);
      rmSync(repoDir, { recursive: true, force: true });
    });

    it("reports unknown and ambiguous repos and removes repos", async () => {
      await addVps();
      expect((await fail("machine_update_repo", { repo: "api" })).message).toMatch(
        /no repos registered/,
      );
      await ok("machine_add_repo", {
        name: "api",
        machine: "vps",
        path: "/srv/api",
        aliases: ["backend"],
      });
      await ok("machine_add_repo", {
        name: "web",
        machine: "vps",
        path: "/srv/web",
        aliases: ["backend"],
      });
      expect((await fail("machine_update_repo", { repo: "nope" })).message).toMatch(
        /no repo matched/,
      );
      expect((await fail("machine_update_repo", { repo: "backend" })).message).toMatch(
        /matched several/,
      );
      expect(await ok("machine_remove_repo", { name: "web" })).toEqual({ removed: true });
      expect((await ok("machine_update_repo", { repo: "backend", dry_run: true })).repo.name).toBe(
        "api",
      );
      expect(calls()).toEqual([]);
    });

    it("refuses to run a post_update command for a caller that may not use machine_run", async () => {
      await addVps();
      const repoDir = join(remoteDir, "api");
      mkdirSync(repoDir, { recursive: true });
      await ok("machine_add_repo", {
        name: "api",
        machine: "vps",
        path: repoDir,
        post_update: "echo deployed > deployed.txt",
      });
      // A profile that exposes machine_update_repo but not machine_run: the
      // update must refuse to execute the stored command remotely.
      const scoped = () =>
        requestScope.run({ allows: (t: string) => t !== "machine_run" }, () =>
          fail("machine_update_repo", { repo: "api" }),
        );
      const err = await scoped();
      expect(err.message).toMatch(/post_update/);
      expect(err.message).toMatch(/machine_run/);
      expect(existsSync(join(repoDir, "deployed.txt"))).toBe(false);
      expect(calls()).toEqual([]);
      // The same caller may still dry-run (no connection, no execution) ...
      const dry = await requestScope.run({ allows: (t: string) => t !== "machine_run" }, () =>
        ok("machine_update_repo", { repo: "api", dry_run: true }),
      );
      expect(dry.dry_run).toBe(true);
      expect(calls()).toEqual([]);
      // ... and an unrestricted caller runs it as before.
      const r = await ok("machine_update_repo", { repo: "api" });
      expect(r.ok).toBe(true);
      expect(readFileSync(join(repoDir, "deployed.txt"), "utf8")).toBe("deployed\n");
      rmSync(repoDir, { recursive: true, force: true });
    });
  });

  describe("auth methods (L-12)", () => {
    it("refuses to connect a machine with no auth method, before ssh runs", async () => {
      await ok("machine_add", { name: "vps", host: "vps.test", user: "deploy" });
      const err = await fail("machine_run", { machine: "vps", command: "true" });
      expect(err.message).toMatch(/no auth method/);
      expect(err.message).toMatch(/identity_file/);
      expect(err.message).toMatch(/use_agent/);
      expect(err.message).toMatch(/use_default_keys/);
      expect(calls()).toEqual([]);
      const list = await ok("machines_list", {});
      expect(list.machines[0].details.auth).toBe("none");
    });

    it("buildSshArgs only offers identities the machine explicitly asked for", () => {
      const dataDir = join(tmp, "pack data");
      const mk = (ssh: Partial<MachineRecord["ssh"]>) =>
        buildSshArgs(
          {
            name: "vps",
            provider: "ssh",
            ssh: {
              host: "vps.test",
              user: "deploy",
              port: 22,
              identityFile: null,
              hostKey: null,
              useAgent: false,
              useDefaultKeys: false,
              ...ssh,
            },
            createdAt: "",
            updatedAt: "",
          },
          "true",
          { dataDir, connectTimeoutSeconds: 5 },
        );
      // identity_file: only that key (IdentitiesOnly keeps agent keys out too).
      const withFile = mk({ identityFile: "/k" });
      expect(withFile).toContain("IdentitiesOnly=yes");
      expect(withFile[withFile.indexOf("-i") + 1]).toBe("/k");
      expect(withFile).not.toContain("IdentityFile=none");
      // use_default_keys: ssh's default files, nothing pinned down.
      const defaults = mk({ useDefaultKeys: true });
      expect(defaults).not.toContain("IdentitiesOnly=yes");
      expect(defaults).not.toContain("IdentityFile=none");
      expect(defaults).not.toContain("-i");
      // use_agent only: no default key files, agent still consulted.
      const agentOnly = mk({ useAgent: true });
      expect(agentOnly).toContain("IdentityFile=none");
      expect(agentOnly).not.toContain("IdentitiesOnly=yes");
      // no auth method: nothing is offered at all.
      const none = mk({});
      expect(none).toContain("IdentityFile=none");
      expect(none).toContain("IdentitiesOnly=yes");
    });

    it("refuses use_default_keys unless the user turned on allowDefaultKeys", async () => {
      await loader.close();
      await boot({}, { ...ALLOWED, allowDefaultKeys: false });
      const err = await fail("machine_add", {
        name: "vps",
        host: "vps.test",
        user: "deploy",
        use_default_keys: true,
      });
      expect(err.message).toMatch(/allowDefaultKeys/);
      await ok("machine_add", { name: "vps", host: "vps.test", user: "deploy", use_agent: true });
      // A stored default-keys machine is cut off once the setting goes off.
      await loader.close();
      await boot({}, ALLOWED);
      await ok("machine_add", {
        name: "old",
        host: "vps.test",
        user: "deploy",
        use_default_keys: true,
      });
      await loader.close();
      await boot({}, { ...ALLOWED, allowDefaultKeys: false });
      const run = await fail("machine_run", { machine: "old", command: "true" });
      expect(run.message).toMatch(/allowDefaultKeys/);
      expect(calls()).toEqual([]);
    });

    it("passes SSH_AUTH_SOCK only to machines registered with use_agent", async () => {
      await loader.close();
      await boot({ sshAuthSock: "/tmp/fake-agent.sock" });
      await ok("machine_add", { name: "a", host: "vps.test", user: "u", use_agent: true });
      await ok("machine_add", {
        name: "b",
        host: "other.test",
        user: "u",
        use_default_keys: true,
      });
      await ok("machine_run", { machine: "a", command: "true" });
      expect(calls().at(-1)!.sock).toBe("/tmp/fake-agent.sock");
      await ok("machine_run", { machine: "b", command: "true" });
      expect(calls().at(-1)!.sock).toBeNull();
      const list = await ok("machines_list", {});
      const authOf = (id: string) =>
        String(list.machines.find((m: { id: string }) => m.id === id)?.details.auth);
      expect(authOf("a")).toBe("agent");
      expect(authOf("b")).toBe("default_keys");
    });
  });

  describe("remote symlink refusal (L-12)", () => {
    it("refuses to download or upload through a remote symlink", async () => {
      await addVps();
      const outside = join(tmp, "host-secret.txt");
      writeFileSync(outside, "host secret");
      const link = join(remoteDir, "link.txt");
      symlinkSync(outside, link);
      const err = await fail("machine_get_file", { machine: "vps", remote_path: link });
      expect(err.message).toMatch(/refusing to download a remote symlink/);
      expect(library.list({})).toEqual([]);
      const art = library.save({
        kind: "other",
        mime: "text/plain",
        bytes: Buffer.from("pwned"),
        tool: "t",
      });
      const up = await fail("machine_put_file", {
        machine: "vps",
        artifact_id: art.id,
        remote_path: link,
      });
      expect(up.message).toMatch(/refusing to upload through a remote symlink/);
      expect(readFileSync(outside, "utf8")).toBe("host secret");
      // A regular existing file can still be overwritten; a directory cannot.
      writeFileSync(join(remoteDir, "plain.txt"), "old");
      await ok("machine_put_file", {
        machine: "vps",
        artifact_id: art.id,
        remote_path: join(remoteDir, "plain.txt"),
      });
      expect(readFileSync(join(remoteDir, "plain.txt"), "utf8")).toBe("pwned");
      const dirErr = await fail("machine_put_file", {
        machine: "vps",
        artifact_id: art.id,
        remote_path: remoteDir,
      });
      expect(dirErr.message).toMatch(/not a regular file/);
      rmSync(link);
      rmSync(join(remoteDir, "plain.txt"));
    });
  });
});
