import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SecretDecryptError, SecretStoreError } from "../../../src/core/secrets/errors.js";
import { FileBackend } from "../../../src/core/secrets/file-backend.js";
import { canSymlink, expectMode, itSymlink } from "../../support/platform.js";

const T = 120_000;
const POSIX = process.platform !== "win32";
const VALUE = "sk-test-0123456789abcdef-VALUE";
const PASSPHRASE = "correct horse battery staple 42";

const base = mkdtempSync(join(tmpdir(), "plughive-file-backend-"));
let counter = 0;
let home: string;

beforeEach(() => {
  counter += 1;
  home = join(base, `home-${counter}`); // not created: the backend must create it
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const file = (): string => join(home, "secrets.json");

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SecretStoreError) return err.code;
    throw err;
  }
  return "NO_ERROR";
}

describe("FileBackend (plaintext)", () => {
  it("reads as empty when nothing exists and does not create anything", async () => {
    const backend = new FileBackend({ home });
    expect(await backend.get("API_KEY")).toBeNull();
    expect(await backend.has("API_KEY")).toBe(false);
    expect(await backend.list()).toEqual([]);
    await backend.delete("API_KEY");
    expect(() => statSync(home)).toThrow();
  });

  it("round-trips values, lists names sorted and deletes", async () => {
    const backend = new FileBackend({ home });
    await backend.set("ZED_KEY", "z-value-123");
    await backend.set("API_KEY", VALUE);
    await backend.set("API_KEY", `${VALUE}-2`);
    expect(await backend.get("API_KEY")).toBe(`${VALUE}-2`);
    expect(await backend.has("ZED_KEY")).toBe(true);
    expect(await backend.list()).toEqual(["API_KEY", "ZED_KEY"]);
    await backend.delete("API_KEY");
    expect(await backend.get("API_KEY")).toBeNull();
    expect(await backend.list()).toEqual(["ZED_KEY"]);

    // a second instance sees the same data
    expect(await new FileBackend({ home }).get("ZED_KEY")).toBe("z-value-123");
    const parsed = JSON.parse(readFileSync(file(), "utf8"));
    expect(parsed).toEqual({ version: 1, secrets: { ZED_KEY: "z-value-123" } });
  });

  it.runIf(POSIX)("creates the directory 0700 and the file 0600", async () => {
    const previous = process.umask(0o000); // a permissive umask must not matter
    try {
      const backend = new FileBackend({ home });
      await backend.set("API_KEY", VALUE);
    } finally {
      process.umask(previous);
    }
    expectMode(home, 0o700);
    expectMode(file(), 0o600);
  });

  it.runIf(POSIX)("keeps a pre-existing 0755 home as is; the file is still 0600", async () => {
    // A directory the backend did not create may be shared (e.g. the user's
    // config dir), so it is not chmod-ed; the secrets file itself is private.
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    await new FileBackend({ home }).set("API_KEY", VALUE);
    expectMode(home, 0o755);
    expectMode(file(), 0o600);
  });

  it.runIf(POSIX)("refuses a group- or world-writable home", async () => {
    for (const loose of [0o775, 0o757, 0o777]) {
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home);
      chmodSync(home, loose);
      const backend = new FileBackend({ home });
      expect(await codeOf(backend.set("API_KEY", VALUE)), loose.toString(8)).toBe(
        "SECRET_DIR_INSECURE",
      );
      expect(readdirSync(home)).toEqual([]);
    }
  });

  it("serialises writers through a lock file and removes it afterwards", async () => {
    const a = new FileBackend({ home });
    const b = new FileBackend({ home }); // separate instances: separate mutexes
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).set(`KEY_${i}`, `value-${i}-abcdef`)),
    );
    expect(await a.list()).toHaveLength(20);
    expect(readdirSync(home)).toEqual(["secrets.json"]);
  });

  it("recovers a stale lock left by a dead process", async () => {
    mkdirSync(home, { mode: 0o700 });
    // pid 2^22+ is far above any real pid on macOS/Linux defaults.
    writeFileSync(join(home, ".secrets.json.lock"), `4999999 ${Date.now()} x\n`, { mode: 0o600 });
    await new FileBackend({ home, lockTimeoutMs: 2000 }).set("API_KEY", VALUE);
    expect(await new FileBackend({ home }).get("API_KEY")).toBe(VALUE);
    expect(readdirSync(home)).toEqual(["secrets.json"]);
  });

  it("times out on a live lock instead of waiting forever", async () => {
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, ".secrets.json.lock"), `${process.pid} ${Date.now()} x\n`, {
      mode: 0o600,
    });
    const backend = new FileBackend({ home, lockTimeoutMs: 150 });
    expect(await codeOf(backend.set("API_KEY", VALUE))).toBe("SECRET_LOCK_TIMEOUT");
    rmSync(join(home, ".secrets.json.lock"));
  });

  it("removes stale temp files of dead writers", async () => {
    mkdirSync(home, { mode: 0o700 });
    const stale = join(home, ".secrets.4999999.0123456789abcdef.tmp");
    writeFileSync(stale, "partial", { mode: 0o600 });
    await new FileBackend({ home }).set("API_KEY", VALUE);
    expect(readdirSync(home)).toEqual(["secrets.json"]);
  });

  it.runIf(POSIX)("fixes a group/world readable file before using it", async () => {
    const backend = new FileBackend({ home });
    await backend.set("API_KEY", VALUE);
    for (const loose of [0o644, 0o640, 0o604, 0o666, 0o660]) {
      chmodSync(file(), loose);
      expect(await backend.get("API_KEY")).toBe(VALUE);
      expectMode(file(), 0o600, loose.toString(8));
    }
  });

  it("writes atomically and leaves no temp files", async () => {
    const backend = new FileBackend({ home });
    const names = Array.from({ length: 25 }, (_, i) => `KEY_${i}`);
    await Promise.all(names.map((name, i) => backend.set(name, `value-${i}-abcdef`)));
    expect(await backend.list()).toEqual([...names].sort());
    for (const [i, name] of names.entries()) {
      expect(await backend.get(name)).toBe(`value-${i}-abcdef`);
    }
    expect(readdirSync(home)).toEqual(["secrets.json"]);
  });

  itSymlink("refuses a secrets file that is a symlink or a directory", async () => {
    mkdirSync(home, { recursive: true });
    const elsewhere = join(base, `elsewhere-${counter}.json`);
    writeFileSync(elsewhere, JSON.stringify({ version: 1, secrets: { API_KEY: VALUE } }), {
      mode: 0o600,
    });
    symlinkSync(elsewhere, file());
    const backend = new FileBackend({ home });
    expect(await codeOf(backend.get("API_KEY"))).toBe("SECRET_FILE_NOT_REGULAR");
    expect(await codeOf(backend.set("OTHER_KEY", "x-value-1"))).toBe("SECRET_FILE_NOT_REGULAR");
    // the link target was not modified through the link
    expect(JSON.parse(readFileSync(elsewhere, "utf8")).secrets).toEqual({ API_KEY: VALUE });

    rmSync(file());
    mkdirSync(file());
    expect(await codeOf(backend.get("API_KEY"))).toBe("SECRET_FILE_NOT_REGULAR");
  });

  it("rejects malformed files without leaking their content", async () => {
    mkdirSync(home, { recursive: true });
    const cases = [
      "not json at all sk-leak-123456",
      "[]",
      JSON.stringify({ version: 2, secrets: {} }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, secrets: [] }),
      JSON.stringify({ version: 1, secrets: { API_KEY: 5 } }),
      JSON.stringify({ version: 1, secrets: { "bad name": "sk-leak-123456" } }),
    ];
    for (const content of cases) {
      writeFileSync(file(), content, { mode: 0o600 });
      const backend = new FileBackend({ home });
      try {
        await backend.list();
        expect.unreachable(content);
      } catch (err) {
        expect(err).toBeInstanceOf(SecretStoreError);
        expect((err as SecretStoreError).code).toBe("SECRET_FILE_MALFORMED");
        expect((err as Error).message).not.toContain("sk-leak-123456");
      }
    }
  });

  it("validates constructor options", () => {
    expect(() => new FileBackend({ home: "" })).toThrow(SecretStoreError);
    expect(() => new FileBackend({ home, filename: "../x.json" })).toThrow(SecretStoreError);
    expect(() => new FileBackend({ home, filename: ".." })).toThrow(SecretStoreError);
    expect(new FileBackend({ home }).encrypted).toBe(false);
    expect(new FileBackend({ home, passphrase: "" }).encrypted).toBe(false);
    expect(new FileBackend({ home, passphrase: "x" }).encrypted).toBe(true);
  });
});

describe("FileBackend (encrypted)", () => {
  it(
    "round-trips through a fresh instance and hides names and values on disk",
    async () => {
      const backend = new FileBackend({ home, passphrase: PASSPHRASE });
      await backend.set("API_KEY", VALUE);
      await backend.set("OTHER_KEY", "another-secret-value");
      const raw = readFileSync(file(), "utf8");
      expect(raw).not.toContain(VALUE);
      expect(raw).not.toContain("API_KEY");
      expect(raw).not.toContain("another-secret-value");
      expect(raw).not.toContain(PASSPHRASE);
      const envelope = JSON.parse(raw);
      expect(envelope).toMatchObject({
        version: 2,
        encrypted: true,
        cipher: "aes-256-gcm",
        kdf: { name: "scrypt", N: 131072, r: 8, p: 1 },
      });
      expect(Buffer.from(envelope.kdf.salt, "base64")).toHaveLength(16);
      expect(Buffer.from(envelope.nonce, "base64")).toHaveLength(12);
      expect(Buffer.from(envelope.tag, "base64")).toHaveLength(16);
      if (POSIX) expectMode(file(), 0o600);

      const again = new FileBackend({ home, passphrase: PASSPHRASE });
      expect(await again.get("API_KEY")).toBe(VALUE);
      expect(await again.list()).toEqual(["API_KEY", "OTHER_KEY"]);
    },
    T,
  );

  it(
    "uses a fresh salt and nonce for every write",
    async () => {
      const backend = new FileBackend({ home, passphrase: PASSPHRASE });
      const seenSalts = new Set<string>();
      const seenNonces = new Set<string>();
      const seenCipher = new Set<string>();
      for (let i = 0; i < 4; i++) {
        await backend.set("API_KEY", VALUE); // identical plaintext each time
        const envelope = JSON.parse(readFileSync(file(), "utf8"));
        seenSalts.add(envelope.kdf.salt);
        seenNonces.add(envelope.nonce);
        seenCipher.add(envelope.ciphertext);
      }
      expect(seenSalts.size).toBe(4);
      expect(seenNonces.size).toBe(4);
      expect(seenCipher.size).toBe(4);
      expect(await backend.get("API_KEY")).toBe(VALUE);
    },
    T,
  );

  it(
    "wrong passphrase gives a clear error that leaks nothing",
    async () => {
      await new FileBackend({ home, passphrase: PASSPHRASE }).set("API_KEY", VALUE);
      const wrong = "definitely-the-wrong-passphrase";
      const backend = new FileBackend({ home, passphrase: wrong });
      for (const op of [
        () => backend.get("API_KEY"),
        () => backend.has("API_KEY"),
        () => backend.list(),
        () => backend.set("NEW_KEY", "new-value-123"),
        () => backend.delete("API_KEY"),
      ]) {
        try {
          await op();
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(SecretDecryptError);
          const text = `${(err as Error).message} ${(err as Error).stack} ${JSON.stringify(err)}`;
          expect((err as Error).message).toMatch(/wrong passphrase/);
          expect(text).not.toContain(wrong);
          expect(text).not.toContain(PASSPHRASE);
          expect(text).not.toContain(VALUE);
        }
      }
      // the failed writes did not clobber the file
      expect(await new FileBackend({ home, passphrase: PASSPHRASE }).get("API_KEY")).toBe(VALUE);
    },
    T,
  );

  it(
    "detects tampering with any part of the envelope",
    async () => {
      await new FileBackend({ home, passphrase: PASSPHRASE }).set("API_KEY", VALUE);
      const original = readFileSync(file(), "utf8");
      const flip = (b64: string, index = 0): string => {
        const bytes = Buffer.from(b64, "base64");
        bytes[index] = (bytes[index] ?? 0) ^ 0x01;
        return bytes.toString("base64");
      };
      type Envelope = {
        version: number;
        kdf: { N: number; p: number; salt: string };
        nonce: string;
        ciphertext: string;
        tag: string;
      };
      const mutations: Array<[string, (e: Envelope) => void]> = [
        ["ciphertext first byte", (e) => void (e.ciphertext = flip(e.ciphertext))],
        ["ciphertext last byte", (e) => void (e.ciphertext = flip(e.ciphertext, -1 >>> 0))],
        ["tag", (e) => void (e.tag = flip(e.tag))],
        ["nonce", (e) => void (e.nonce = flip(e.nonce))],
        ["salt", (e) => void (e.kdf.salt = flip(e.kdf.salt))],
        ["kdf cost N", (e) => void (e.kdf.N = 65536)],
        ["kdf p", (e) => void (e.kdf.p = 2)],
        [
          "truncated ciphertext",
          (e) =>
            void (e.ciphertext = Buffer.from(e.ciphertext, "base64")
              .subarray(0, -1)
              .toString("base64")),
        ],
      ];
      for (const [label, mutate] of mutations) {
        const envelope = JSON.parse(original) as Envelope;
        if (label === "ciphertext last byte") {
          const bytes = Buffer.from(envelope.ciphertext, "base64");
          bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x80;
          envelope.ciphertext = bytes.toString("base64");
        } else {
          mutate(envelope);
        }
        writeFileSync(file(), JSON.stringify(envelope), { mode: 0o600 });
        const backend = new FileBackend({ home, passphrase: PASSPHRASE });
        await expect(backend.get("API_KEY"), label).rejects.toBeInstanceOf(SecretDecryptError);
      }

      // Parameters outside the accepted bounds are rejected before any KDF work.
      for (const patch of [
        { N: 2 },
        { N: 1024 },
        { N: 16384 }, // allowed for v1 envelopes only
        { N: 32768 },
        { N: 2 ** 30 },
        { N: 32769 },
        { r: 1 },
        { p: 0 },
        { p: 64 },
        { name: "pbkdf2" },
      ]) {
        const envelope = JSON.parse(original);
        Object.assign(envelope.kdf, patch);
        writeFileSync(file(), JSON.stringify(envelope), { mode: 0o600 });
        expect(
          await codeOf(new FileBackend({ home, passphrase: PASSPHRASE }).get("API_KEY")),
          JSON.stringify(patch),
        ).toBe("SECRET_FILE_MALFORMED");
      }

      // Version downgrade: the version is bound into the AAD.
      const v1 = JSON.parse(original);
      v1.version = 1;
      writeFileSync(file(), JSON.stringify(v1), { mode: 0o600 });
      await expect(
        new FileBackend({ home, passphrase: PASSPHRASE }).get("API_KEY"),
      ).rejects.toBeInstanceOf(SecretDecryptError);

      // Downgrade to plaintext: a plaintext body is refused while a passphrase
      // is configured (unless migratePlaintext), and stripping "encrypted"
      // from an envelope is malformed.
      writeFileSync(file(), JSON.stringify({ version: 1, secrets: { API_KEY: "attacker" } }), {
        mode: 0o600,
      });
      expect(await codeOf(new FileBackend({ home, passphrase: PASSPHRASE }).get("API_KEY"))).toBe(
        "SECRET_FILE_NOT_ENCRYPTED",
      );
      const stripped = JSON.parse(original);
      stripped.encrypted = false;
      writeFileSync(file(), JSON.stringify(stripped), { mode: 0o600 });
      expect(await codeOf(new FileBackend({ home, passphrase: PASSPHRASE }).get("API_KEY"))).toBe(
        "SECRET_FILE_MALFORMED",
      );

      writeFileSync(file(), original, { mode: 0o600 });
      expect(await new FileBackend({ home, passphrase: PASSPHRASE }).get("API_KEY")).toBe(VALUE);
    },
    T,
  );

  it(
    "an encrypted file cannot be opened or overwritten without the passphrase",
    async () => {
      await new FileBackend({ home, passphrase: PASSPHRASE }).set("API_KEY", VALUE);
      const before = readFileSync(file(), "utf8");
      const plain = new FileBackend({ home });
      expect(await codeOf(plain.get("API_KEY"))).toBe("SECRET_PASSPHRASE_REQUIRED");
      expect(await codeOf(plain.set("API_KEY", "overwrite-attempt"))).toBe(
        "SECRET_PASSPHRASE_REQUIRED",
      );
      expect(readFileSync(file(), "utf8")).toBe(before);
    },
    T,
  );

  it(
    "refuses an existing plaintext file when a passphrase is set, without migratePlaintext",
    async () => {
      await new FileBackend({ home }).set("API_KEY", VALUE);
      const before = readFileSync(file(), "utf8");
      const backend = new FileBackend({ home, passphrase: PASSPHRASE });
      for (const op of [
        () => backend.get("API_KEY"),
        () => backend.list(),
        () => backend.set("OTHER_KEY", "second-secret-value"),
      ]) {
        expect(await codeOf(op())).toBe("SECRET_FILE_NOT_ENCRYPTED");
      }
      expect(readFileSync(file(), "utf8")).toBe(before);
    },
    T,
  );

  it(
    "encrypts an existing plaintext file on first use with migratePlaintext",
    async () => {
      await new FileBackend({ home }).set("API_KEY", VALUE);
      expect(readFileSync(file(), "utf8")).toContain(VALUE);
      const backend = new FileBackend({ home, passphrase: PASSPHRASE, migratePlaintext: true });
      expect(await backend.get("API_KEY")).toBe(VALUE);
      // already migrated by the read, before any write
      const raw = readFileSync(file(), "utf8");
      expect(raw).not.toContain(VALUE);
      expect(JSON.parse(raw)).toMatchObject({ version: 2, encrypted: true });
      await backend.set("OTHER_KEY", "second-secret-value");
      expect(await backend.get("API_KEY")).toBe(VALUE);
      expect(await new FileBackend({ home, passphrase: PASSPHRASE }).list()).toEqual([
        "API_KEY",
        "OTHER_KEY",
      ]);
    },
    T,
  );

  it(
    "reads a v1 envelope (N=32768) and upgrades it to v2 on the next write",
    async () => {
      // Build a v1 envelope exactly as the previous release wrote it.
      const salt = randomBytes(16);
      const N = 32768;
      const key = scryptSync(PASSPHRASE.normalize("NFKC"), salt, 32, {
        N,
        r: 8,
        p: 1,
        maxmem: 256 * N * 8 + 1024 * 1024,
      });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      cipher.setAAD(
        Buffer.from(
          `plughive-secrets|v1|scrypt|${N}|8|1|${salt.toString("base64")}|aes-256-gcm`,
          "utf8",
        ),
      );
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ secrets: { API_KEY: VALUE } }), "utf8"),
        cipher.final(),
      ]);
      mkdirSync(home, { mode: 0o700 });
      writeFileSync(
        file(),
        JSON.stringify({
          version: 1,
          encrypted: true,
          kdf: { name: "scrypt", N, r: 8, p: 1, salt: salt.toString("base64") },
          cipher: "aes-256-gcm",
          nonce: nonce.toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
        }),
        { mode: 0o600 },
      );
      const backend = new FileBackend({ home, passphrase: PASSPHRASE });
      expect(await backend.get("API_KEY")).toBe(VALUE);
      await backend.delete("NOT_THERE"); // no change, but the upgrade is written
      expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({
        version: 2,
        kdf: { N: 131072 },
      });
      expect(await new FileBackend({ home, passphrase: PASSPHRASE }).get("API_KEY")).toBe(VALUE);
    },
    T,
  );

  it(
    "handles unicode values and passphrases",
    async () => {
      const passphrase = "päss \u{1f511} phrase";
      const value = 'välue \u{1f600} "quoted" \\ back\nslash';
      await new FileBackend({ home, passphrase }).set("API_KEY", value);
      expect(await new FileBackend({ home, passphrase }).get("API_KEY")).toBe(value);
    },
    T,
  );
});

// ---------------------------------------------------------------------------
// Regression tests for the security review (S1-S6).

describe("FileBackend review regressions", () => {
  it(
    "S1: with a passphrase, a plaintext file planted over the encrypted one is refused",
    async () => {
      await new FileBackend({ home, passphrase: PASSPHRASE }).set("OPENAI_API_KEY", VALUE);
      writeFileSync(
        file(),
        JSON.stringify({ version: 1, secrets: { OPENAI_API_KEY: "sk-attacker-controlled" } }),
        { mode: 0o600 },
      );
      const again = new FileBackend({ home, passphrase: PASSPHRASE });
      expect(await codeOf(again.get("OPENAI_API_KEY"))).toBe("SECRET_FILE_NOT_ENCRYPTED");
    },
    T,
  );

  it(
    "S2: a plaintext file is only taken over with migratePlaintext, and then encrypted at once",
    async () => {
      await new FileBackend({ home }).set("EXA_API_KEY", VALUE);
      expect(
        await codeOf(new FileBackend({ home, passphrase: PASSPHRASE }).get("EXA_API_KEY")),
      ).toBe("SECRET_FILE_NOT_ENCRYPTED");
      expect(readFileSync(file(), "utf8")).toContain(VALUE);
      const migrating = new FileBackend({ home, passphrase: PASSPHRASE, migratePlaintext: true });
      expect(await migrating.get("EXA_API_KEY")).toBe(VALUE);
      expect(readFileSync(file(), "utf8")).not.toContain(VALUE);
    },
    T,
  );

  itSymlink("S3: two instances writing at once do not lose updates", async () => {
    const a = new FileBackend({ home });
    const b = new FileBackend({ home });
    await Promise.all([
      a.set("AAA_KEY", "value-a-123"),
      b.set("BBB_KEY", "value-b-123"),
      a.set("CCC_KEY", "value-c-123"),
      b.set("DDD_KEY", "value-d-123"),
    ]);
    expect(await a.list()).toEqual(["AAA_KEY", "BBB_KEY", "CCC_KEY", "DDD_KEY"]);
  });

  it.runIf(POSIX && canSymlink())(
    "S4: a home that is a symlink to a private directory is usable",
    async () => {
      mkdirSync(join(base, `real-${counter}`), { mode: 0o700 });
      symlinkSync(join(base, `real-${counter}`), home);
      await new FileBackend({ home }).set("AAA_KEY", "value-a-123");
      expect(await new FileBackend({ home }).get("AAA_KEY")).toBe("value-a-123");
    },
  );

  it.runIf(POSIX)(
    "S5: an existing 0755 home is not chmodded; a writable one is refused",
    async () => {
      mkdirSync(home, { mode: 0o755 });
      chmodSync(home, 0o755);
      await new FileBackend({ home }).set("AAA_KEY", "value-a-123");
      expectMode(home, 0o755);
      expectMode(file(), 0o600);
      chmodSync(home, 0o777);
      expect(await codeOf(new FileBackend({ home }).set("BBB_KEY", "value-b-123"))).toBe(
        "SECRET_DIR_INSECURE",
      );
      chmodSync(home, 0o700);
    },
  );

  it.runIf(POSIX)("S6: modes are private even under umask 0 and no temp file remains", async () => {
    const old = process.umask(0);
    try {
      await new FileBackend({ home }).set("AAA_KEY", "value-a-123");
      expectMode(home, 0o700);
      expectMode(file(), 0o600);
      expect(readdirSync(home)).toEqual(["secrets.json"]);
    } finally {
      process.umask(old);
    }
  });
});

describe("FileBackend lock file (symlink hardening)", () => {
  it.runIf(POSIX && canSymlink())(
    "S7: a symlink planted at the lock path is neither read through nor removed",
    async () => {
      const backend = new FileBackend({ home, lockTimeoutMs: 300 });
      await backend.set("AAA_KEY", "value-a-123");
      // A victim file outside the home, and a symlink where the lock file was.
      const victim = join(base, `victim-${counter}.txt`);
      writeFileSync(victim, "VICTIM-CONTENT", { mode: 0o600 });
      const lockPath = join(home, ".secrets.json.lock");
      rmSync(lockPath, { force: true });
      symlinkSync(victim, lockPath);
      // The lock cannot be taken (the symlink is not a plain file we remove),
      // and the victim is untouched and the link still there.
      expect(await codeOf(backend.set("BBB_KEY", "value-b-123"))).toBe("SECRET_LOCK_TIMEOUT");
      expect(readFileSync(victim, "utf8")).toBe("VICTIM-CONTENT");
      expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
      // With the symlink gone, writing works again.
      rmSync(lockPath);
      await backend.set("BBB_KEY", "value-b-123");
      expect(await backend.get("BBB_KEY")).toBe("value-b-123");
      rmSync(victim, { force: true });
    },
  );
});
