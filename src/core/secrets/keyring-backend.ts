// src/core/secrets/keyring-backend.ts
//
// OS keyring backend for Windows (Credential Manager) and Linux (the D-Bus
// Secret Service: GNOME Keyring, KWallet). One generic credential per secret,
// service "plughive" (by default), account = secret name, through the
// prebuilt `@napi-rs/keyring` addon. Values never pass through argv or a
// child process.
//
// It mirrors the macOS keychain backend's layout:
//   - Windows Credential Manager caps one credential at 2560 bytes (stored as
//     UTF-16, so ~1280 characters). Values above CHUNK_CHARS are split across
//     `<name>.part.<i>` entries and the head entry holds
//     "plughive:chunks:<count>:<sha256 prefix>".
//   - Values that are not printable ASCII are stored as "plughive:b64:<base64>"
//     so every backend round-trips the same bytes.
//   - Neither OS API enumerates by service portably, so an index entry
//     ("plughive.index") lists the names; `list()` prunes names whose entry
//     was removed outside plughive.
// Every operation runs under an in-process mutex and a cross-process lock file
// in the daemon home, so the index is re-read and merged inside the lock.
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SecretStoreError } from "./errors.js";
import { withLockFile } from "./lockfile.js";
import { Mutex, type SecretBackend, isValidSecretName } from "./types.js";

const INDEX_ACCOUNT = "plughive.index";
const PREFIX = "plughive:";
const B64_PREFIX = `${PREFIX}b64:`;
const CHUNK_PREFIX = `${PREFIX}chunks:`;
/** Characters per entry: under Credential Manager's 2560-byte UTF-16 blob. */
const CHUNK_CHARS = 1000;
const MAX_CHUNKS = 64;

/** The three calls the backend needs from an OS keyring. */
export interface KeyringEntryStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  /** Returns false when there was nothing to delete. */
  delete(service: string, account: string): Promise<boolean>;
}

export interface KeyringBackendOptions {
  /** Keyring service name. Default "plughive". */
  service?: string;
  /** Replaces the native addon (tests). */
  store?: KeyringEntryStore;
  /** Directory for the cross-process lock file. Default os.tmpdir(). */
  lockDir?: string;
  lockTimeoutMs?: number;
  /** Per-call timeout in ms (a locked keyring may wait for a prompt). Default 15000. */
  timeoutMs?: number;
}

function fail(message: string, code = "KEYRING_ERROR"): SecretStoreError {
  return new SecretStoreError(message, code);
}

const UNAVAILABLE_HINT =
  "Set PLUGHIVE_SECRETS=file to keep secrets in a file in the plughive folder instead.";

/** The real store: `@napi-rs/keyring`, loaded on first use. */
function nativeStore(): KeyringEntryStore {
  type AsyncEntryCtor = new (
    service: string,
    account: string,
  ) => {
    getPassword(): Promise<string | undefined | null>;
    setPassword(value: string): Promise<void>;
    deleteCredential?(): Promise<boolean>;
    deletePassword(): Promise<boolean>;
  };
  let ctor: Promise<AsyncEntryCtor> | null = null;
  const load = (): Promise<AsyncEntryCtor> => {
    ctor ??= import("@napi-rs/keyring")
      .then((m) => (m as unknown as { AsyncEntry: AsyncEntryCtor }).AsyncEntry)
      .catch(() => {
        ctor = null;
        throw fail(
          `The system keyring library could not be loaded. ${UNAVAILABLE_HINT}`,
          "KEYRING_UNAVAILABLE",
        );
      });
    return ctor;
  };
  const wrap = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await task();
    } catch (err) {
      if (err instanceof SecretStoreError) throw err;
      // Never surface the addon's message: it is OS text and may be long.
      throw fail(`The system keyring did not answer. ${UNAVAILABLE_HINT}`, "KEYRING_UNAVAILABLE");
    }
  };
  return {
    async get(service, account) {
      const Entry = await load();
      return wrap(async () => (await new Entry(service, account).getPassword()) ?? null);
    },
    async set(service, account, value) {
      const Entry = await load();
      await wrap(() => new Entry(service, account).setPassword(value));
    },
    async delete(service, account) {
      const Entry = await load();
      return wrap(async () => {
        const entry = new Entry(service, account);
        // A missing credential is "nothing to delete", not an error.
        if ((await entry.getPassword()) == null) return false;
        return entry.deletePassword();
      });
    },
  };
}

function encodeStored(value: string): string {
  const plain = /^[\x20-\x7e]+$/.test(value) && !value.startsWith(PREFIX);
  return plain ? value : `${B64_PREFIX}${Buffer.from(value, "utf8").toString("base64")}`;
}

function decodeStored(stored: string): string {
  if (stored.startsWith(B64_PREFIX)) {
    return Buffer.from(stored.slice(B64_PREFIX.length), "base64").toString("utf8");
  }
  return stored;
}

function checksum(stored: string): string {
  return createHash("sha256").update(stored, "utf8").digest("hex").slice(0, 16);
}

function parseIndex(stored: string | null): string[] {
  if (stored === null || stored === "") return [];
  return [...new Set(stored.split(",").filter((name) => isValidSecretName(name)))];
}

export class KeyringBackend implements SecretBackend {
  readonly kind = "keyring" as const;
  readonly service: string;
  readonly lockPath: string;
  private readonly store: KeyringEntryStore;
  private readonly lockTimeoutMs: number | undefined;
  private readonly timeoutMs: number;
  private readonly mutex = new Mutex();

  constructor(options: KeyringBackendOptions = {}) {
    const service = options.service ?? "plughive";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(service)) {
      throw fail("Invalid keyring service name.", "KEYRING_BAD_SERVICE");
    }
    this.service = service;
    this.store = options.store ?? nativeStore();
    const key = createHash("sha256").update(service, "utf8").digest("hex").slice(0, 16);
    this.lockPath = join(options.lockDir ?? tmpdir(), `plughive-keyring-${key}.lock`);
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private locked<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
      return withLockFile(
        this.lockPath,
        task,
        this.lockTimeoutMs !== undefined ? { timeoutMs: this.lockTimeoutMs } : {},
      );
    });
  }

  /** One keyring call, bounded in time: a locked keyring must not hang the daemon. */
  private timed<T>(task: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            fail(
              "The system keyring did not respond (it may be locked or waiting for approval).",
              "KEYRING_TIMEOUT",
            ),
          ),
        this.timeoutMs,
      );
      timer.unref?.();
    });
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  }

  private find(account: string): Promise<string | null> {
    return this.timed(this.store.get(this.service, account));
  }

  private put(account: string, value: string): Promise<void> {
    return this.timed(this.store.set(this.service, account, value));
  }

  private remove(account: string): Promise<boolean> {
    return this.timed(this.store.delete(this.service, account));
  }

  // -- SecretBackend --------------------------------------------------------

  async get(name: string): Promise<string | null> {
    this.assertName(name);
    const stored = await this.locked(() => this.readValue(name));
    return stored === null ? null : decodeStored(stored);
  }

  async has(name: string): Promise<boolean> {
    this.assertName(name);
    return this.locked(async () => (await this.find(name)) !== null);
  }

  async set(name: string, value: string): Promise<void> {
    this.assertName(name);
    if (typeof value !== "string" || value === "") throw fail("Secret values must be non-empty.");
    await this.locked(async () => {
      await this.writeValue(name, encodeStored(value));
      const names = await this.readIndex();
      if (!names.includes(name)) await this.writeIndex([...names, name]);
    });
  }

  async delete(name: string): Promise<void> {
    this.assertName(name);
    await this.locked(async () => {
      await this.removeValue(name);
      const names = await this.readIndex();
      if (names.includes(name)) await this.writeIndex(names.filter((n) => n !== name));
    });
  }

  async list(): Promise<string[]> {
    return this.locked(async () => {
      const names = await this.readIndex();
      const alive: string[] = [];
      for (const name of names) if ((await this.find(name)) !== null) alive.push(name);
      if (alive.length !== names.length) await this.writeIndex(alive);
      return alive.sort();
    });
  }

  // -- index ----------------------------------------------------------------

  private async readIndex(): Promise<string[]> {
    return parseIndex(await this.readValue(INDEX_ACCOUNT));
  }

  private async writeIndex(names: string[]): Promise<void> {
    if (names.length === 0) {
      await this.removeValue(INDEX_ACCOUNT);
      return;
    }
    await this.writeValue(INDEX_ACCOUNT, [...names].sort().join(","));
  }

  // -- values ---------------------------------------------------------------

  private partAccount(account: string, index: number): string {
    return `${account}.part.${index}`;
  }

  private parseChunkHeader(raw: string): { count: number; sum: string } | null {
    if (!raw.startsWith(CHUNK_PREFIX)) return null;
    const match = raw.slice(CHUNK_PREFIX.length).match(/^([0-9]{1,3}):([0-9a-f]{16})$/);
    const count = match ? Number(match[1]) : 0;
    if (!match || count < 2 || count > MAX_CHUNKS) {
      throw fail("A keyring entry is corrupt.", "KEYRING_CORRUPT");
    }
    return { count, sum: match[2] ?? "" };
  }

  private async readValue(account: string): Promise<string | null> {
    const head = await this.find(account);
    if (head === null) return null;
    const header = this.parseChunkHeader(head);
    if (!header) return head;
    const parts: string[] = [];
    for (let i = 0; i < header.count; i++) {
      const part = await this.find(this.partAccount(account, i));
      if (part === null) throw fail("A keyring entry is incomplete.", "KEYRING_CORRUPT");
      parts.push(part);
    }
    const stored = parts.join("");
    if (checksum(stored) !== header.sum)
      throw fail("A keyring entry is corrupt.", "KEYRING_CORRUPT");
    return stored;
  }

  private async previousChunkCount(account: string): Promise<number> {
    const head = await this.find(account).catch(() => null);
    if (head === null) return 0;
    try {
      return this.parseChunkHeader(head)?.count ?? 0;
    } catch {
      return MAX_CHUNKS;
    }
  }

  private async writeValue(account: string, stored: string): Promise<void> {
    const previous = await this.previousChunkCount(account);
    let count = 0;
    if (stored.length <= CHUNK_CHARS) {
      await this.put(account, stored);
    } else {
      count = Math.ceil(stored.length / CHUNK_CHARS);
      if (count > MAX_CHUNKS) throw fail("The secret is too large for the system keyring.");
      for (let i = 0; i < count; i++) {
        await this.put(
          this.partAccount(account, i),
          stored.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
        );
      }
      await this.put(account, `${CHUNK_PREFIX}${count}:${checksum(stored)}`);
    }
    for (let i = count; i < previous; i++) await this.remove(this.partAccount(account, i));
    let check: string | null;
    try {
      check = await this.readValue(account);
    } catch (err) {
      if (err instanceof SecretStoreError && err.code === "KEYRING_CORRUPT") check = null;
      else throw err;
    }
    if (check !== stored) {
      await this.removeValue(account).catch(() => undefined);
      throw fail("The system keyring did not store the value correctly.", "KEYRING_VERIFY_FAILED");
    }
  }

  private async removeValue(account: string): Promise<void> {
    const previous = await this.previousChunkCount(account);
    for (let i = 0; i < previous; i++) await this.remove(this.partAccount(account, i));
    await this.remove(account);
  }

  private assertName(name: string): void {
    if (!isValidSecretName(name)) throw fail("Invalid secret name.", "INVALID_SECRET_NAME");
  }
}
