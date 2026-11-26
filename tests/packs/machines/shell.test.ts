import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUpdateScript } from "../../../packs/machines/index.js";
import { buildSshArgs } from "../../../packs/machines/providers/ssh.js";
import {
  USER_PATTERN,
  composeRemoteCommand,
  identityFileProblem,
  isValidHost,
  remotePathProblem,
  shellQuote,
} from "../../../packs/machines/shell.js";
import type { MachineRecord, RepoRecord } from "../../../packs/machines/state.js";
import { itPosix } from "../../support/platform.js";

const HOSTILE = [
  "",
  "plain",
  "it's",
  "'",
  "''",
  "'\\''",
  "a'b'c",
  "$(touch pwned)",
  "`touch pwned`",
  "${HOME}",
  "$HOME",
  '"; touch pwned; echo "',
  "'; touch pwned; echo '",
  "a\nb\ttouch pwned",
  "\\",
  "\\'",
  "*",
  "~",
  "-n",
  "--",
  "a && touch pwned",
  "a | touch pwned",
  "a; touch pwned",
  "> pwned",
  "<(touch pwned)",
  "!!",
  "#comment",
  "ünïcødé ✓ 漢字",
  "\r\n",
  " leading and trailing ",
];

describe("shellQuote", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "machines-quote-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // The quoting targets the remote POSIX shell; these run it locally as /bin/sh,
  // which a Windows runner does not have.
  itPosix.each(HOSTILE.map((s) => [JSON.stringify(s), s]))(
    "round-trips %s through /bin/sh as one literal word",
    (_label, value) => {
      const r = spawnSync("/bin/sh", ["-c", `printf '%s|' ${shellQuote(value)}`], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${value}|`);
      expect(existsSync(join(dir, "pwned"))).toBe(false);
    },
  );

  itPosix("quotes several values into separate words", () => {
    const r = spawnSync("/bin/sh", ["-c", `printf '[%s]' ${HOSTILE.map(shellQuote).join(" ")}`], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.stdout).toBe(HOSTILE.map((s) => `[${s}]`).join(""));
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("rejects NUL and non-strings", () => {
    expect(() => shellQuote("a\0b")).toThrow("NUL");
    expect(() => shellQuote(1 as unknown as string)).toThrow(TypeError);
  });

  itPosix("composeRemoteCommand quotes cwd and env values and leaves the command verbatim", () => {
    const script = composeRemoteCommand('printf "%s|%s" "$(pwd)" "$V"', {
      cwd: dir,
      env: { V: "'; touch pwned; echo '$(touch pwned)`touch pwned`" },
    });
    const r = spawnSync("/bin/sh", ["-c", script], { cwd: "/", encoding: "utf8" });
    expect(r.stdout.endsWith("|'; touch pwned; echo '$(touch pwned)`touch pwned`")).toBe(true);
    expect(existsSync(join(dir, "pwned"))).toBe(false);
  });

  it("composeRemoteCommand refuses bad env names and leaves a bare command alone", () => {
    expect(() => composeRemoteCommand("x", { env: { "A;B": "1" } })).toThrow("invalid env name");
    expect(composeRemoteCommand("uptime")).toBe("uptime");
  });
});

describe("validators", () => {
  it("hosts", () => {
    for (const ok of [
      "example.com",
      "a",
      "1.2.3.4",
      "my-host.internal",
      "::1",
      "2001:db8::1",
      "::ffff:1.2.3.4",
    ]) {
      expect(isValidHost(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "-oProxyCommand=touch /tmp/x",
      "-p",
      "root@example.com",
      "example.com:22",
      "ssh://example.com",
      "a b",
      "a\nb",
      "a;b",
      "$(x)",
      "-host",
      "host-",
      "[::1]",
      "fe80::1%en0",
      "a".repeat(254),
    ]) {
      expect(isValidHost(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("users", () => {
    for (const ok of ["root", "deploy", "_svc", "a.b-c_d"])
      expect(USER_PATTERN.test(ok)).toBe(true);
    for (const bad of [
      "",
      "-oProxyCommand=x",
      "-l",
      "a b",
      "root@host",
      "%u",
      "a\n",
      "a:b",
      "x".repeat(33),
    ]) {
      expect(USER_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("identity file paths", () => {
    expect(identityFileProblem("/Users/me/.ssh/id_ed25519")).toBeNull();
    expect(identityFileProblem("~/.ssh/id ed25519")).toBeNull();
    for (const bad of [
      "",
      "id_rsa",
      "-oProxyCommand=x",
      "~root/.ssh/id",
      "/a/../etc/shadow",
      "/k%h",
      "/k\n-o",
      "/k\0",
    ]) {
      expect(identityFileProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("remote paths", () => {
    expect(remotePathProblem("/srv/app", "p", true)).toBeNull();
    expect(remotePathProblem("relative/dir", "p")).toBeNull();
    expect(remotePathProblem("relative/dir", "p", true)).not.toBeNull();
    for (const bad of ["", "-rf", "~/x", "a\nb", "a\0b", "a\u001bb"]) {
      expect(remotePathProblem(bad, "p"), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

const machine = (over: Partial<MachineRecord["ssh"]> = {}): MachineRecord => ({
  name: "vps",
  provider: "ssh",
  ssh: {
    host: "example.com",
    user: "deploy",
    port: 2222,
    identityFile: null,
    hostKey: null,
    useAgent: false,
    useDefaultKeys: false,
    ...over,
  },
  createdAt: "",
  updatedAt: "",
});

describe("buildSshArgs", () => {
  it("fixes options, ends option parsing before the host and passes the command as one argument", () => {
    const args = buildSshArgs(machine(), "echo hi; uptime", {
      dataDir: "/data/m",
      connectTimeoutSeconds: 7,
    });
    const dd = args.indexOf("--");
    expect(args.slice(dd)).toEqual(["--", "example.com", "echo hi; uptime"]);
    expect(args.slice(0, 5)).toEqual(["-T", "-a", "-x", "-F", "none"]);
    const opts = args.flatMap((a, i) => (args[i - 1] === "-o" ? [a] : []));
    expect(opts).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "StrictHostKeyChecking=accept-new",
        `UserKnownHostsFile="${join("/data/m", "known_hosts")}"`,
        `GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "UpdateHostKeys=no",
        "ConnectTimeout=7",
        "ServerAliveInterval=15",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ProxyCommand=none",
        "PermitLocalCommand=no",
        "PasswordAuthentication=no",
      ]),
    );
    expect(args).toContain("2222");
    expect(args).not.toContain("-i");
  });

  it("adds the identity file as its own argv entry with IdentitiesOnly", () => {
    const args = buildSshArgs(machine({ identityFile: "~/.ssh/my key" }), "true", {
      dataDir: "/d",
      connectTimeoutSeconds: 10,
    });
    expect(args[args.indexOf("-i") + 1]).toBe("~/.ssh/my key");
    expect(args).toContain("IdentitiesOnly=yes");
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("--"));
  });

  it("refuses a data dir that cannot be carried in an -o value", () => {
    expect(() =>
      buildSshArgs(machine(), "x", { dataDir: '/a"b', connectTimeoutSeconds: 1 }),
    ).toThrow();
  });
});

describe("buildUpdateScript", () => {
  const repo = (over: Partial<RepoRecord>): RepoRecord => ({
    name: "api",
    machine: "vps",
    path: "/srv/api",
    repoUrl: null,
    aliases: [],
    branch: null,
    postUpdate: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  });

  it("quotes the path and branch and appends post_update verbatim", () => {
    expect(buildUpdateScript(repo({}))).toBe(
      "cd '/srv/api' || exit 1\ngit pull --ff-only || exit $?",
    );
    expect(
      buildUpdateScript(
        repo({ path: "/srv/it's", branch: "release/1.0", postUpdate: "docker compose up -d" }),
      ),
    ).toBe(
      "cd '/srv/it'\\''s' || exit 1\ngit pull --ff-only origin 'release/1.0' || exit $?\ndocker compose up -d",
    );
  });
});
