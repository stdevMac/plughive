// Security fixes, batch D1, for the machines pack (D-M9): the state file and
// the pinned host-key file must never be read or written through a symlink,
// temp files are created with O_EXCL, uploads land via rename (not through a
// swapped-in symlink), machine_update_repo requires machine_run for every
// run (git pull itself executes the repo's hooks), and host validation uses
// a real IPv6 check (D-L3).
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tools } from "../../../packs/machines/index.js";
import type { AccessPolicy } from "../../../packs/machines/policy.js";
import { SshProvider, hostKeyFilePath } from "../../../packs/machines/providers/ssh.js";
import { isValidHost } from "../../../packs/machines/shell.js";
import { type MachineRecord, MachineStore } from "../../../packs/machines/state.js";
import { expectMode } from "../../support/platform.js";

/** A well-formed known_hosts line (the key bytes are fake but valid base64). */
const PIN =
  "vps.test ssh-ed25519 AAAAAHRlc3Qta2V5LW1hdGVyaWFsLWZvci1waW5uaW5nLXRlc3RzISEAAAAAAAAAAAAA";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

let dir: string;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "machines-d1-"));
  dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function machineRecord(over: Partial<MachineRecord["ssh"]> = {}): MachineRecord {
  return {
    name: "vps",
    provider: "ssh",
    ssh: {
      host: "vps.test",
      user: "deploy",
      port: 22,
      identityFile: "/keys/id",
      hostKey: null,
      useAgent: false,
      useDefaultKeys: false,
      ...over,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const POLICY: AccessPolicy = {
  hosts: [{ user: null, host: "vps.test", port: null }],
  identityFiles: ["/keys/id"],
  defaultKeys: false,
};

/** A spawn that records argv and answers like a successful ssh. */
function recordingSpawn() {
  const calls: string[][] = [];
  const spawn = (async (_bin: string, args: readonly string[]) => {
    calls.push([...args]);
    return { stdout: "ok\n", stderr: "", exitCode: 0 };
  }) as unknown as PackContext["spawn"];
  return { calls, spawn };
}

describe("MachineStore (D-M9)", () => {
  it("writes and reads back state at mode 0600", () => {
    const store = new MachineStore(dataDir);
    store.write({ version: 1, machines: [machineRecord()], repos: [] });
    expectMode(store.path, 0o600);
    expect(store.read().machines[0]?.name).toBe("vps");
  });

  it("refuses to read a symlinked state file and never chmods through it", () => {
    const store = new MachineStore(dataDir);
    store.write({ version: 1, machines: [machineRecord()], repos: [] });
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "do not touch", { mode: 0o644 });
    rmSync(store.path);
    symlinkSync(victim, store.path);
    expect(() => store.read()).toThrow(/symlink/);
    // The victim was neither read through nor chmodded through the link.
    expect(readFileSync(victim, "utf8")).toBe("do not touch");
    expectMode(victim, 0o644);
  });

  it("tightens loose permissions on the opened file", () => {
    const store = new MachineStore(dataDir);
    store.write({ version: 1, machines: [], repos: [] });
    chmodSync(store.path, 0o644);
    store.read();
    expectMode(store.path, 0o600);
  });
});

describe("pinned host key file (D-M9)", () => {
  it("never writes through a symlink at the pin path", async () => {
    const store = new MachineStore(dataDir);
    store.write({ version: 1, machines: [machineRecord({ hostKey: PIN })], repos: [] });
    const victim = join(dir, "authorized_keys");
    writeFileSync(victim, "ssh-ed25519 AAAA legit\n", { mode: 0o644 });
    const pin = hostKeyFilePath(dataDir, "vps");
    mkdirSync(join(dataDir, "host_keys"), { recursive: true });
    symlinkSync(victim, pin);
    const { calls, spawn } = recordingSpawn();
    const provider = new SshProvider({
      store,
      spawn,
      dataDir,
      connectTimeoutSeconds: 5,
      policy: POLICY,
    });
    await provider.run("vps", "true", { timeoutMs: 1000, maxOutputBytes: 1024 });
    // The symlink itself was replaced by a real 0600 file holding the pin.
    expect(lstatSync(pin).isSymbolicLink()).toBe(false);
    expect(readFileSync(pin, "utf8")).toBe(`${PIN}\n`);
    expectMode(pin, 0o600);
    // The victim behind the link was untouched.
    expect(readFileSync(victim, "utf8")).toBe("ssh-ed25519 AAAA legit\n");
    expectMode(victim, 0o644);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--");
  });
});

describe("uploads (D-M9 / D-L3)", () => {
  it("lands the bytes via mktemp + rename, so a swapped-in symlink is replaced, not followed", async () => {
    const store = new MachineStore(dataDir);
    store.write({ version: 1, machines: [machineRecord()], repos: [] });
    const { calls, spawn } = recordingSpawn();
    const provider = new SshProvider({
      store,
      spawn,
      dataDir,
      connectTimeoutSeconds: 5,
      policy: POLICY,
    });
    const r = await provider.putFile("vps", "/srv/app.conf", Buffer.from("hello"), {
      timeoutMs: 1000,
      mode: "600",
    });
    expect(r.bytes).toBe(5);
    const remote = calls[0]?.[calls[0].indexOf("--") + 2] ?? "";
    expect(remote).toContain("mktemp");
    expect(remote).toContain('mv -f "$t"');
    expect(remote).toContain("[ -L '/srv/app.conf' ]");
    expect(remote).not.toMatch(/cat > '\//); // never a direct write to the target path
  });
});

describe("machine_update_repo (D-M9)", () => {
  const updateRepo = tools.find((t) => t.name === "machine_update_repo") as unknown as {
    run: (input: Record<string, unknown>, ctx: PackContext) => Promise<any>;
  };

  function ctxWith(allowedForCaller: ((tool: string) => boolean) | undefined): PackContext {
    return {
      pack: { dataDir },
      settings: { allowedHosts: ["vps.test"], allowDefaultKeys: true },
      tools: allowedForCaller ? { allowedForCaller } : {},
      logger: silent,
      spawn: (async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })) as unknown as PackContext["spawn"],
    } as unknown as PackContext;
  }

  function seedRepo(postUpdate: string | null) {
    const store = new MachineStore(dataDir);
    store.write({
      version: 1,
      machines: [machineRecord({ useDefaultKeys: true, identityFile: null })],
      repos: [
        {
          name: "api",
          machine: "vps",
          path: "/srv/api",
          repoUrl: null,
          aliases: [],
          branch: null,
          postUpdate,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
  }

  it("requires machine_run even when the repo has no post_update (git pull runs hooks)", async () => {
    seedRepo(null);
    const denied = ctxWith(() => false);
    await expect(
      updateRepo.run(
        { repo: "api", timeout_ms: 1000, max_output_bytes: 1024, dry_run: false },
        denied,
      ),
    ).rejects.toThrow(/machine_run/);
    // dry_run still works without machine_run: nothing is executed.
    const dry = await updateRepo.run(
      { repo: "api", timeout_ms: 1000, max_output_bytes: 1024, dry_run: true },
      denied,
    );
    expect(dry.dry_run).toBe(true);
    // An unrestricted caller still runs.
    const allowed = ctxWith(undefined);
    const r = await updateRepo.run(
      { repo: "api", timeout_ms: 1000, max_output_bytes: 1024, dry_run: false },
      allowed,
    );
    expect(r.ok).toBe(true);
  });
});

describe("host validation (D-L3)", () => {
  it("uses a strict IPv6 check: no zone ids, no over-long or junk groups", () => {
    expect(isValidHost("vps.test")).toBe(true);
    expect(isValidHost("1.2.3.4")).toBe(true);
    expect(isValidHost("2001:db8::1")).toBe(true);
    expect(isValidHost("::ffff:1.2.3.4")).toBe(true);
    expect(isValidHost(":::")).toBe(false);
    expect(isValidHost("fe80::1%eth0")).toBe(false);
    expect(isValidHost("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isValidHost("gg::1")).toBe(false);
    expect(isValidHost("-x")).toBe(false);
    expect(isValidHost("a b")).toBe(false);
    expect(isValidHost("host:22")).toBe(false);
  });
});
