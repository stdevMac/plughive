// Keychain integration tests. They only ever touch generic-password items
// under a unique throwaway service name created by this file, and remove them
// again in afterAll. They write to the real login keychain, which can raise
// keychain prompts and leave items behind if the run is killed, so they are
// opt-in: set PLUGHIVE_KEYCHAIN_TESTS=1 to run them. They run on macOS only
// and are skipped when the security tool is unavailable, slow, or would need
// user interaction.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretStoreError } from "../../../src/core/secrets/errors.js";
import {
  KeychainBackend,
  type SecurityRunResult,
  type SecurityRunner,
} from "../../../src/core/secrets/keychain-backend.js";
import { buildBackend, createSecretStore } from "../../../src/core/secrets/store.js";
import { expectMode } from "../../support/platform.js";

const T = 120_000;
const DARWIN = process.platform === "darwin";
const SERVICE = `plughive-test-${randomBytes(6).toString("hex")}`;
const PROBE_NAME = "PROBE_KEY";

const used = new Set<string>();
let backend: KeychainBackend | null = null;
let usable = false;

const OPTED_IN = process.env.PLUGHIVE_KEYCHAIN_TESTS === "1";

if (DARWIN && OPTED_IN) {
  try {
    // A short timeout: if the tool blocks (locked keychain, approval dialog)
    // the call is killed and the whole suite is skipped.
    const candidate = new KeychainBackend({ service: SERVICE, timeoutMs: 8_000 });
    backend = candidate;
    used.add(PROBE_NAME);
    await candidate.set(PROBE_NAME, "probe-value-123456");
    usable = (await candidate.get(PROBE_NAME)) === "probe-value-123456";
    await candidate.delete(PROBE_NAME);
  } catch {
    usable = false;
  }
}

afterAll(async () => {
  if (!backend) return;
  for (const name of used) {
    await backend.delete(name).catch(() => undefined);
  }
  await backend.destroyIndex().catch(() => undefined);
  if (usable) {
    // Nothing may be left behind under the throwaway service.
    for (const name of used) {
      expect(await backend.has(name), name).toBe(false);
    }
    expect(await backend.list()).toEqual([]);
    await backend.destroyIndex().catch(() => undefined);
  }
}, T);

function kc(): KeychainBackend {
  if (!backend) throw new Error("keychain backend not available");
  return backend;
}

async function put(name: string, value: string): Promise<void> {
  used.add(name);
  await kc().set(name, value);
}

describe.skipIf(!DARWIN)("KeychainBackend construction", () => {
  it("validates the service name", () => {
    for (const bad of ["", "has space", "semi;colon", "quote'", "-leading", "a".repeat(101)]) {
      try {
        new KeychainBackend({ service: bad });
        expect.unreachable(bad);
      } catch (err) {
        expect(err).toBeInstanceOf(SecretStoreError);
        expect((err as SecretStoreError).code).toBe("KEYCHAIN_BAD_SERVICE");
      }
    }
    expect(new KeychainBackend().service).toBe("plughive");
    expect(new KeychainBackend({ service: SERVICE }).kind).toBe("keychain");
  });

  it("rejects invalid secret names before running anything", async () => {
    const b = new KeychainBackend({ service: SERVICE });
    for (const bad of ["lower", "A B", "A;rm", "plughive.index", "API_KEY.part.0", ""]) {
      await expect(b.get(bad)).rejects.toMatchObject({ code: "INVALID_SECRET_NAME" });
      await expect(b.has(bad)).rejects.toMatchObject({ code: "INVALID_SECRET_NAME" });
      await expect(b.set(bad, "some-value-1")).rejects.toMatchObject({
        code: "INVALID_SECRET_NAME",
      });
      await expect(b.delete(bad)).rejects.toMatchObject({ code: "INVALID_SECRET_NAME" });
    }
    await expect(b.set("API_KEY", "")).rejects.toBeInstanceOf(SecretStoreError);
  });
});

describe.skipIf(!usable)("KeychainBackend (real keychain, throwaway service)", () => {
  it(
    "reports absent items as null / false and deletes idempotently",
    async () => {
      expect(await kc().get("ABSENT_KEY")).toBeNull();
      expect(await kc().has("ABSENT_KEY")).toBe(false);
      await kc().delete("ABSENT_KEY");
    },
    T,
  );

  it(
    "round-trips, updates and deletes a value",
    async () => {
      await put("API_KEY", "sk-test-first-value-0001");
      expect(await kc().get("API_KEY")).toBe("sk-test-first-value-0001");
      expect(await kc().has("API_KEY")).toBe(true);
      await put("API_KEY", "sk-test-second-value-0002");
      expect(await kc().get("API_KEY")).toBe("sk-test-second-value-0002");
      await kc().delete("API_KEY");
      expect(await kc().get("API_KEY")).toBeNull();
      expect(await kc().has("API_KEY")).toBe(false);
    },
    T,
  );

  it(
    "preserves shell- and quote-special characters exactly",
    async () => {
      const values = [
        `it's "quoted" \\ back$lash \`tick\` $(nope) ; | & < > * ? ~ # ! %41 {x} [y]`,
        "  leading and trailing spaces  ",
        "-w looks-like-an-option",
        "plughive:b64:not-really-base64", // collides with the internal prefix
        "plughive:chunks:2:0123456789abcdef", // looks like a chunk header
        "0123456789abcdef", // looks like hex
      ];
      for (const [i, value] of values.entries()) {
        const name = `SPECIAL_${i}`;
        await put(name, value);
        expect(await kc().get(name), value).toBe(value);
      }
    },
    T,
  );

  it(
    "preserves non-ASCII and multi-line values",
    async () => {
      const values = [
        "pässwörd \u{1f511} 中文",
        "line one\nline two\r\n\ttabbed",
        "trailing newline\n",
      ];
      for (const [i, value] of values.entries()) {
        const name = `UNICODE_${i}`;
        await put(name, value);
        expect(await kc().get(name)).toBe(value);
      }
    },
    T,
  );

  it(
    "stores values larger than one command line by chunking, and shrinks cleanly",
    async () => {
      // Sizes around the chunk boundary and well past the 4096 byte line limit.
      for (const size of [1499, 1500, 1501, 3000, 5000]) {
        const value = randomBytes(size).toString("base64").slice(0, size);
        await put("LARGE_KEY", value);
        const read = await kc().get("LARGE_KEY");
        expect(read?.length, String(size)).toBe(size);
        expect(read === value, String(size)).toBe(true);
      }
      const pem = `-----BEGIN PRIVATE KEY-----\n${randomBytes(2400).toString("base64")}\n-----END PRIVATE KEY-----\n`;
      await put("LARGE_KEY", pem);
      expect((await kc().get("LARGE_KEY")) === pem).toBe(true);

      // Back to a small value: the old part items must be gone.
      await put("LARGE_KEY", "small-again-123");
      expect(await kc().get("LARGE_KEY")).toBe("small-again-123");
      const fresh = new KeychainBackend({ service: SERVICE, timeoutMs: 8_000 });
      expect(await fresh.list()).toContain("LARGE_KEY");
      await kc().delete("LARGE_KEY");
      expect(await kc().has("LARGE_KEY")).toBe(false);
    },
    T,
  );

  it(
    "lists the names it stored, sorted, across instances, and never internal items",
    async () => {
      await put("LIST_B", "list-value-b-1");
      await put("LIST_A", "list-value-a-1");
      await put("LIST_BIG", "x".repeat(3200));
      const other = new KeychainBackend({ service: SERVICE, timeoutMs: 8_000 });
      const names = await other.list();
      expect(names).toEqual([...names].sort());
      expect(names).toEqual(expect.arrayContaining(["LIST_A", "LIST_B", "LIST_BIG"]));
      for (const name of names) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]{1,63}$/);
      }
      await kc().delete("LIST_A");
      await kc().delete("LIST_BIG");
      const after = await other.list();
      expect(after).toContain("LIST_B");
      expect(after).not.toContain("LIST_A");
      expect(after).not.toContain("LIST_BIG");
    },
    T,
  );

  it(
    "keeps the index consistent under concurrent writes",
    async () => {
      const names = Array.from({ length: 6 }, (_, i) => `CONC_${i}`);
      for (const name of names) used.add(name);
      await Promise.all(names.map((name, i) => kc().set(name, `concurrent-value-${i}`)));
      expect(await kc().list()).toEqual(expect.arrayContaining(names));
      for (const [i, name] of names.entries()) {
        expect(await kc().get(name)).toBe(`concurrent-value-${i}`);
      }
    },
    T,
  );

  it(
    "works through createSecretStore with env precedence",
    async () => {
      used.add("STORE_KEY");
      const store = createSecretStore({
        // The keychain backend keeps only its lock file here.
        home: mkdtempSync(join(tmpdir(), "plughive-kc-home-")),
        env: { ENV_KEY: "from-env-value-99" },
        backend: "keychain",
        keychainService: SERVICE,
        knownNames: ["ENV_KEY"],
      });
      await store.set("STORE_KEY", "from-keychain-value-1");
      expect(await store.get("STORE_KEY")).toBe("from-keychain-value-1");
      const listed = await store.list();
      expect(listed).toEqual(
        expect.arrayContaining([
          { name: "ENV_KEY", source: "env" },
          { name: "STORE_KEY", source: "keychain" },
        ]),
      );
      expect(store.redactor.redact("x from-keychain-value-1")).not.toContain("from-keychain");
      await store.delete("STORE_KEY");
      expect(await store.has("STORE_KEY")).toBe(false);
    },
    T,
  );

  it(
    "removes the index item when the last secret is deleted (own throwaway service)",
    async () => {
      // A second throwaway service, so the shared one's index is not involved.
      const service = `plughive-test-${randomBytes(6).toString("hex")}`;
      const own = new KeychainBackend({ service, timeoutMs: 8_000 });
      try {
        await own.set("ONLY_KEY", "only-value-13579");
        expect(await own.list()).toEqual(["ONLY_KEY"]);
        await own.delete("ONLY_KEY");
        expect(await own.has("ONLY_KEY")).toBe(false);
        // Read the index item directly: it must be gone, not left holding "-".
        const raw = await new Promise<number | null>((resolveCode) => {
          import("node:child_process").then(({ spawn }) => {
            const child = spawn(
              "/usr/bin/security",
              ["find-generic-password", "-a", "plughive.index", "-s", service],
              {
                stdio: "ignore",
              },
            );
            child.on("close", (code) => resolveCode(code));
            child.on("error", () => resolveCode(null));
          });
        });
        expect(raw).toBe(44);
        expect(await new KeychainBackend({ service, timeoutMs: 8_000 }).list()).toEqual([]);
      } finally {
        await own.delete("ONLY_KEY").catch(() => undefined);
      }
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// Unit tests with a fake `security` runner (any platform, no Keychain).

interface FakeHooks {
  /** Return an exit code to short-circuit an add (the item is not stored). */
  onAdd?: (account: string, value: string, attempt: number) => number | undefined;
  /** Override a password read (`-w`) result. */
  onRead?: (account: string) => SecurityRunResult | undefined;
  /** Transform the value actually stored. */
  store?: (account: string, value: string) => string;
  delayMs?: number;
}

function fakeKeychain(service: string, hooks: FakeHooks = {}) {
  const items = new Map<string, string>();
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const addAttempts = new Map<string, number>();
  let inflight = 0;
  let maxInflight = 0;
  const ok = (stdout = ""): SecurityRunResult => ({ code: 0, stdout, timedOut: false });
  const missing: SecurityRunResult = { code: 44, stdout: "", timedOut: false };
  const runner: SecurityRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      if (hooks.delayMs) await new Promise((r) => setTimeout(r, hooks.delayMs));
      if (args[0] === "-i") {
        const m = (stdin ?? "").match(
          /^add-generic-password -a (\S+) -s (\S+) -U -X ([0-9a-f]+)\n$/,
        );
        if (!m || m[2] !== service) return { code: 1, stdout: "", timedOut: false };
        const account = m[1] as string;
        const value = Buffer.from(m[3] as string, "hex").toString("latin1");
        const attempt = addAttempts.get(account) ?? 0;
        addAttempts.set(account, attempt + 1);
        const code = hooks.onAdd?.(account, value, attempt);
        if (code !== undefined) return { code, stdout: "", timedOut: false };
        items.set(account, hooks.store ? hooks.store(account, value) : value);
        return ok();
      }
      const account = args[args.indexOf("-a") + 1] as string;
      if (args[0] === "find-generic-password") {
        if (args.includes("-w")) {
          const override = hooks.onRead?.(account);
          if (override) return override;
          const value = items.get(account);
          return value === undefined ? missing : ok(`${value}\n`);
        }
        return items.has(account) ? ok("attributes") : missing;
      }
      if (args[0] === "delete-generic-password") {
        return items.delete(account) ? ok() : missing;
      }
      return { code: 1, stdout: "", timedOut: false };
    } finally {
      inflight--;
    }
  };
  return { runner, items, calls, maxInflight: () => maxInflight };
}

describe("KeychainBackend with a fake runner", () => {
  const FAKE_SERVICE = "plughive-fake";
  let lockDir: string;

  function make(hooks: FakeHooks = {}, extra: { lockTimeoutMs?: number } = {}) {
    const fake = fakeKeychain(FAKE_SERVICE, hooks);
    const kb = new KeychainBackend({
      service: FAKE_SERVICE,
      runner: fake.runner,
      lockDir,
      ...extra,
    });
    return { fake, kb };
  }

  beforeAll(() => {
    lockDir = mkdtempSync(join(tmpdir(), "plughive-kc-lock-"));
  });

  afterAll(() => {
    if (lockDir) rmSync(lockDir, { recursive: true, force: true });
  });

  it("has() answers a burst of checks with one index read, and follows its own writes", async () => {
    const { fake, kb } = make();
    await kb.set("KEY_ONE", "value-one-123");
    await kb.set("KEY_TWO", "value-two-123");

    // A fresh instance (no cached index): 60 concurrent checks, one `security` call.
    const reader = new KeychainBackend({ service: FAKE_SERVICE, runner: fake.runner, lockDir });
    const before = fake.calls.length;
    const names = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? "KEY_ONE" : `NOT_SET_${i}`));
    const answers = await Promise.all(names.map((n) => reader.has(n)));
    expect(fake.calls.length - before).toBe(1);
    expect(answers.filter(Boolean)).toHaveLength(20);
    expect(await reader.has("KEY_TWO")).toBe(true);
    expect(fake.calls.length - before).toBe(1);

    // Its own delete and set show at once, without waiting for the cache to expire.
    await reader.delete("KEY_TWO");
    expect(await reader.has("KEY_TWO")).toBe(false);
    await reader.set("KEY_THREE", "value-three-123");
    expect(await reader.has("KEY_THREE")).toBe(true);
  });

  it("U1: the daemon keeps the lock in its home, never in the shared temp folder", async () => {
    const home = join(lockDir, "home-not-created-yet");
    const built = buildBackend({
      home,
      env: {},
      backend: "keychain",
      platform: "darwin",
      keychainService: FAKE_SERVICE,
    }) as KeychainBackend;
    expect(dirname(built.lockPath)).toBe(home);
    expect(built.lockPath.startsWith(`${tmpdir()}/plughive-keychain-`)).toBe(false);

    // The folder is made owner-only on first use and the lock is taken inside it.
    const seen: boolean[] = [];
    const fake = fakeKeychain(FAKE_SERVICE);
    const kb = new KeychainBackend({
      service: FAKE_SERVICE,
      lockDir: home,
      runner: async (args, stdin) => {
        seen.push(existsSync(kb.lockPath));
        return fake.runner(args, stdin);
      },
    });
    await kb.set("API_KEY", "value-123456");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    expectMode(home, 0o700);
    expect(existsSync(kb.lockPath)).toBe(false);
  });

  it("retries a duplicate-item status (45) as an update", async () => {
    const { fake, kb } = make({
      onAdd: (account, _v, attempt) => (account === "API_KEY" && attempt === 0 ? 45 : undefined),
    });
    await kb.set("API_KEY", "value-123456");
    expect(await kb.get("API_KEY")).toBe("value-123456");
    expect(fake.calls.filter((c) => c.stdin?.includes("-a API_KEY ")).length).toBe(2);
    expect(await kb.list()).toEqual(["API_KEY"]);
  });

  it("gives up after a bounded number of duplicate statuses", async () => {
    const { fake, kb } = make({ onAdd: (account) => (account === "API_KEY" ? 45 : undefined) });
    await expect(kb.set("API_KEY", "value-123456")).rejects.toMatchObject({
      code: "KEYCHAIN_ERROR",
    });
    expect(fake.calls.filter((c) => c.stdin?.includes("-a API_KEY ")).length).toBe(4);
  });

  it("a failed read-back leaves the written item alone", async () => {
    let reads = 0;
    const { fake, kb } = make({
      onRead: (account) => {
        if (account !== "API_KEY") return undefined;
        reads++;
        // first read: previous-chunk probe (absent); second: the read-back times out
        return reads === 2 ? { code: null, stdout: "", timedOut: true } : undefined;
      },
    });
    await expect(kb.set("API_KEY", "value-123456")).rejects.toMatchObject({
      code: "KEYCHAIN_TIMEOUT",
    });
    expect(fake.items.get("API_KEY")).toBe("value-123456");
    expect(
      fake.calls.some((c) => c.args[0] === "delete-generic-password" && c.args.includes("API_KEY")),
    ).toBe(false);
  });

  it("a read-back that differs removes the item and fails", async () => {
    const { fake, kb } = make({
      store: (account, value) => (account === "API_KEY" ? value.slice(0, 4) : value),
    });
    await expect(kb.set("API_KEY", "value-123456")).rejects.toMatchObject({
      code: "KEYCHAIN_VERIFY_FAILED",
    });
    expect(fake.items.has("API_KEY")).toBe(false);
  });

  it("list() checks items with bounded concurrency and prunes missing ones", async () => {
    const { fake, kb } = make({ delayMs: 5 });
    const names = Array.from({ length: 12 }, (_, i) => `KEY_${String(i).padStart(2, "0")}`);
    fake.items.set("plughive.index", names.join(","));
    for (const name of names.slice(0, 10)) fake.items.set(name, "v");
    const listed = await kb.list();
    expect(listed).toEqual(names.slice(0, 10));
    expect(fake.maxInflight()).toBeGreaterThan(1);
    expect(fake.maxInflight()).toBeLessThanOrEqual(4);
    expect(fake.items.get("plughive.index")).toBe(names.slice(0, 10).join(","));
  });

  it("deleting the last secret removes the index item", async () => {
    const { fake, kb } = make();
    await kb.set("API_KEY", "value-123456");
    await kb.set("OTHER_KEY", "value-654321");
    expect(fake.items.get("plughive.index")).toBe("API_KEY,OTHER_KEY");
    await kb.delete("API_KEY");
    expect(fake.items.get("plughive.index")).toBe("OTHER_KEY");
    await kb.delete("OTHER_KEY");
    expect(fake.items.has("plughive.index")).toBe(false);
    expect([...fake.items.keys()]).toEqual([]);
    expect(await kb.list()).toEqual([]);
    // Deleting again, with no index item at all, is fine.
    await kb.delete("OTHER_KEY");
    expect(fake.items.size).toBe(0);
  });

  it("list() removes the index item when pruning leaves nothing, and an old empty one", async () => {
    const { fake, kb } = make();
    fake.items.set("plughive.index", "GONE_KEY,ALSO_GONE");
    expect(await kb.list()).toEqual([]);
    expect(fake.items.has("plughive.index")).toBe(false);
    // "-" is how older versions stored an empty index.
    fake.items.set("plughive.index", "-");
    expect(await kb.list()).toEqual([]);
    expect(fake.items.has("plughive.index")).toBe(false);
    // No index item: list() writes nothing.
    const before = fake.calls.length;
    expect(await kb.list()).toEqual([]);
    const after = fake.calls.slice(before);
    expect(after.every((c) => c.args[0] === "find-generic-password")).toBe(true);
    expect(fake.items.size).toBe(0);
  });

  it("PLUGHIVE_KEYCHAIN_SERVICE picks the service name, strictly validated", () => {
    const home = join(lockDir, "svc-home");
    const build = (
      env: Record<string, string | undefined>,
      extra: { keychainService?: string } = {},
    ) =>
      buildBackend({
        home,
        env,
        backend: "keychain",
        platform: "darwin",
        ...extra,
      }) as KeychainBackend;
    expect(build({}).service).toBe("plughive");
    expect(build({ PLUGHIVE_KEYCHAIN_SERVICE: "" }).service).toBe("plughive");
    expect(build({ PLUGHIVE_KEYCHAIN_SERVICE: "  " }).service).toBe("plughive");
    expect(build({ PLUGHIVE_KEYCHAIN_SERVICE: "plughive.dev_2" }).service).toBe("plughive.dev_2");
    expect(build({ PLUGHIVE_KEYCHAIN_SERVICE: " trimmed " }).service).toBe("trimmed");
    expect(build({ PLUGHIVE_KEYCHAIN_SERVICE: "x".repeat(64) }).service).toBe("x".repeat(64));
    // An explicit option wins over the environment.
    expect(
      build({ PLUGHIVE_KEYCHAIN_SERVICE: "from-env" }, { keychainService: "from-option" }).service,
    ).toBe("from-option");
    for (const bad of [
      "has space",
      "semi;colon",
      "quote'",
      'dq"',
      "-leading",
      ".leading",
      "slash/name",
      "new\nline",
      "dollar$x",
      "x".repeat(65),
      "café",
    ]) {
      try {
        build({ PLUGHIVE_KEYCHAIN_SERVICE: bad });
        expect.unreachable(bad);
      } catch (err) {
        expect(err, bad).toBeInstanceOf(SecretStoreError);
        expect((err as SecretStoreError).code).toBe("KEYCHAIN_BAD_SERVICE");
        // The message names the rule, never echoes the value.
        expect((err as Error).message).not.toContain(bad);
      }
    }
    // The setting is not a secret of ours: never served from the environment.
    const store = createSecretStore({
      home,
      env: { PLUGHIVE_KEYCHAIN_SERVICE: "plughive-x" },
      backend: "memory",
      knownNames: ["PLUGHIVE_KEYCHAIN_SERVICE"],
    });
    expect(store.hasEnvFallback("PLUGHIVE_KEYCHAIN_SERVICE")).toBe(false);
    expect(store.keychainService).toBeNull();
    // A file or memory backend ignores the setting (it is not even validated).
    expect(
      buildBackend({ home, env: { PLUGHIVE_KEYCHAIN_SERVICE: "bad name" }, backend: "memory" })
        .kind,
    ).toBe("memory");
  });

  it("the store reports the keychain service it uses", () => {
    const store = createSecretStore({
      home: join(lockDir, "svc-home-2"),
      env: { PLUGHIVE_KEYCHAIN_SERVICE: "plughive-reported" },
      backend: "keychain",
      platform: "darwin",
    });
    expect(store.backendKind).toBe("keychain");
    expect(store.keychainService).toBe("plughive-reported");
    expect(store.storage()).toBe("keychain");
  });

  it("errors never echo the value, whatever the runner does", async () => {
    const secret = "sk-very-secret-value-0001";
    const throwing = new KeychainBackend({
      service: FAKE_SERVICE,
      lockDir,
      runner: async (_args, stdin) => {
        throw new Error(`boom ${stdin ?? ""} ${secret}`);
      },
    });
    const err = (await throwing.set("API_KEY", secret).catch((e: unknown) => e)) as Error & {
      code?: string;
    };
    expect(err).toBeInstanceOf(SecretStoreError);
    expect(err.code).toBe("KEYCHAIN_UNAVAILABLE");
    expect(`${err.message} ${err.stack}`).not.toContain(secret);
    expect(`${err.message} ${err.stack}`).not.toContain(Buffer.from(secret).toString("hex"));

    const { kb } = make({ onAdd: () => 1 });
    const status = (await kb.set("API_KEY", secret).catch((e: unknown) => e)) as Error;
    expect(status.message).toContain("status 1");
    expect(`${status.message} ${status.stack}`).not.toContain(secret);
  });

  it("every operation takes the cross-process lock", async () => {
    const lockPath = join(
      lockDir,
      `plughive-keychain-${createHash("sha256").update(FAKE_SERVICE, "utf8").digest("hex").slice(0, 16)}.lock`,
    );
    let sawLock = false;
    const fake = fakeKeychain(FAKE_SERVICE);
    const kb = new KeychainBackend({
      service: FAKE_SERVICE,
      lockDir,
      runner: async (args, stdin) => {
        sawLock ||= existsSync(lockPath);
        return fake.runner(args, stdin);
      },
    });
    await kb.set("API_KEY", "value-123456");
    expect(sawLock).toBe(true);
    expect(existsSync(lockPath)).toBe(false);

    // A live lock held by another owner (this pid, fresh) blocks until the timeout.
    writeFileSync(lockPath, `${process.pid} ${Date.now()} other\n`, { mode: 0o600 });
    try {
      const blocked = new KeychainBackend({
        service: FAKE_SERVICE,
        lockDir,
        lockTimeoutMs: 100,
        runner: fake.runner,
      });
      const before = fake.calls.length;
      await expect(blocked.get("API_KEY")).rejects.toMatchObject({ code: "SECRET_LOCK_TIMEOUT" });
      expect(fake.calls.length).toBe(before);
    } finally {
      rmSync(lockPath, { force: true });
    }
  });
});
