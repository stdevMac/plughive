// src/core/secrets/keychain-backend.ts
//
// macOS Keychain backend: generic-password items, service "plughive" (by
// default), account = secret name, driven through /usr/bin/security.
//
// HOW VALUES ARE WRITTEN WITHOUT APPEARING IN ARGV
// ------------------------------------------------
// `security add-generic-password -w <value>` would expose the value to every
// local process via `ps`. Instead we start `/usr/bin/security -i` (interactive
// mode: argv is just "-i") and write ONE command line to its stdin:
//
//     add-generic-password -a <ACCOUNT> -s <SERVICE> -U -X <hex of the bytes>
//
// `-X` takes the password as a hexadecimal string, so no quoting is needed,
// and `-U` updates an existing item. The value only ever travels over the
// pipe. Verified on macOS 15 (Darwin 24.6) against the real tool:
//   - the item is created/updated and `find-generic-password -w` returns it;
//   - the exit status of `security -i` is that of the command (0 on success,
//     45 when adding a duplicate without -U);
//   - IMPORTANT: interactive mode reads lines into a 4096 byte buffer. A
//     longer line is silently split: the item is stored TRUNCATED and the
//     remainder is run as a second "command" whose text (secret hex) is echoed
//     to stderr. So every line we send is kept well under that limit, larger
//     values are split across several items, stderr of the tool is never
//     surfaced, and each write is read back and compared.
//
// Reads use `find-generic-password -a <ACCOUNT> -s <SERVICE> -w`, which prints
// the password on stdout (exit 44 = not found). That command prints a hex
// dump instead of the text when the data is not printable, so we only ever
// store printable ASCII: a value that is not plain printable ASCII is stored
// as "plughive:b64:<base64>".
//
// Listing: `security` cannot enumerate by service without `dump-keychain`
// (which walks every item the user owns), so the backend keeps its own index
// item (account "plughive.index") holding the comma-separated secret names.
// `list()` cross-checks the index with attribute-only lookups (no -w, so no
// secret data is read) and prunes names whose item was removed externally.
// When no names remain (last delete, or pruning) the index item is removed.
//
// CONCURRENCY: every operation (reads included) runs under an in-process
// mutex and a cross-process lock file (`<lockDir>/plughive-keychain-<hash of
// service>.lock`; the daemon passes its own home, which only the user can
// write to, so nobody else on the machine can plant the lock), so the index is always
// re-read and merged inside the lock and readers never observe a half-written
// chunked value. A duplicate-item status (45) from `add-generic-password -U`
// (two writers racing to create the same item) is retried as an update.
//
// TESTING: `runner` replaces the process that runs /usr/bin/security, so the
// duplicate-item and failure paths can be unit-tested without the Keychain.
//
// Items created by `security` trust `security` in their ACL, so these reads do
// not prompt. If the tool ever blocks (locked keychain, GUI prompt) the call
// is killed after a timeout and reported as an error; it never hangs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SecretStoreError } from "./errors.js";
import { withLockFile } from "./lockfile.js";
import { Mutex, type SecretBackend, isValidSecretName } from "./types.js";

const SECURITY_BIN = "/usr/bin/security";
const NOT_FOUND = 44;
const DUPLICATE = 45;
const DUPLICATE_RETRIES = 3;
const LIST_CONCURRENCY = 4;
/** How long `has()` trusts its copy of the index before reading it again. */
const INDEX_TTL_MS = 2000;
const INDEX_ACCOUNT = "plughive.index";
const PREFIX = "plughive:";
const B64_PREFIX = `${PREFIX}b64:`;
const CHUNK_PREFIX = `${PREFIX}chunks:`;
/** Stored characters per item. 1500 chars = 3000 hex chars per command line. */
const CHUNK_CHARS = 1500;
/** Hard ceiling for one interactive command line (the tool's buffer is 4096). */
const MAX_LINE_CHARS = 3900;
const MAX_CHUNKS = 64;

export interface KeychainBackendOptions {
  /** Platform the backend runs on (macOS only). Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Keychain service name. Default "plughive". */
  service?: string;
  /** Per-call timeout for the security tool in ms. Default 10000. */
  timeoutMs?: number;
  /**
   * Runs the security tool. Default: spawns /usr/bin/security. Inject a fake
   * for tests. When a runner is given the backend may be constructed on any
   * platform.
   */
  runner?: SecurityRunner;
  /**
   * Directory for the cross-process lock file, created 0700 when missing.
   * createSecretStore passes the daemon home. Default os.tmpdir(), which on a
   * machine where that is shared lets another user hold the lock.
   */
  lockDir?: string;
  /** How long to wait for another process holding the lock. Default 10 s. */
  lockTimeoutMs?: number;
}

export interface SecurityRunResult {
  /** Exit status (null when killed). */
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/** `args` is argv after the binary; `stdin` is written then closed. */
export type SecurityRunner = (args: string[], stdin?: string) => Promise<SecurityRunResult>;

type RunResult = SecurityRunResult;

function fail(message: string, code = "KEYCHAIN_ERROR"): SecretStoreError {
  return new SecretStoreError(message, code);
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

/** The names an index item lists ("-", from older versions, is the empty list). */
function parseIndex(stored: string | null): string[] {
  if (stored === null || stored === "-") return [];
  return [...new Set(stored.split(",").filter((name) => isValidSecretName(name)))];
}

export class KeychainBackend implements SecretBackend {
  readonly kind = "keychain" as const;
  readonly service: string;
  private readonly timeoutMs: number;
  private readonly runner: SecurityRunner;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number | undefined;
  private readonly mutex = new Mutex();
  /**
   * The names the index listed at `at`. `has()` answers from it, so a page that
   * checks a hundred declared names runs one `security` call instead of a
   * hundred serialized ones. Our own writes keep it current; the TTL picks up
   * writes from other processes (the CLI, a second daemon).
   */
  private indexCache: { names: Set<string>; at: number } | null = null;
  private indexLoad: Promise<Set<string>> | null = null;

  constructor(options: KeychainBackendOptions = {}) {
    if ((options.platform ?? process.platform) !== "darwin" && options.runner === undefined) {
      throw fail("The keychain backend is only available on macOS.", "KEYCHAIN_UNAVAILABLE");
    }
    const service = options.service ?? "plughive";
    // The service name is interpolated into an interactive command line, so
    // it is restricted to characters that need no quoting.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(service)) {
      throw fail("Invalid keychain service name.", "KEYCHAIN_BAD_SERVICE");
    }
    this.service = service;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.runner = options.runner ?? ((args, stdin) => this.spawnSecurity(args, stdin));
    const key = createHash("sha256").update(service, "utf8").digest("hex").slice(0, 16);
    this.lockPath = join(options.lockDir ?? tmpdir(), `plughive-keychain-${key}.lock`);
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  /** In-process mutex plus the cross-process lock file. */
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

  // -- SecretBackend --------------------------------------------------------

  async get(name: string): Promise<string | null> {
    this.assertName(name);
    const stored = await this.locked(() => this.readValue(name));
    return stored === null ? null : decodeStored(stored);
  }

  async has(name: string): Promise<boolean> {
    this.assertName(name);
    return (await this.indexSnapshot()).has(name);
  }

  /** The cached index, read again (once, shared by concurrent callers) when stale. */
  private indexSnapshot(): Promise<Set<string>> {
    const cached = this.indexCache;
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return Promise.resolve(cached.names);
    if (!this.indexLoad) {
      this.indexLoad = this.locked(() => this.readIndex())
        .then((names) => {
          const set = new Set(names);
          this.indexCache = { names: set, at: Date.now() };
          return set;
        })
        .finally(() => {
          this.indexLoad = null;
        });
    }
    return this.indexLoad;
  }

  async set(name: string, value: string): Promise<void> {
    this.assertName(name);
    if (typeof value !== "string" || value === "") throw fail("Secret values must be non-empty.");
    await this.locked(async () => {
      await this.writeValue(name, encodeStored(value));
      // Re-read inside the lock, so names another process added survive.
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
      const stored = await this.readValue(INDEX_ACCOUNT);
      const names = parseIndex(stored);
      if (names.length === 0) {
        // An index item that lists nothing (an older version wrote "-") is
        // removed, so an unused service leaves nothing behind in the keychain.
        if (stored !== null) await this.removeValue(INDEX_ACCOUNT);
        return [];
      }
      const present: boolean[] = new Array(names.length).fill(false);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < names.length) {
          const i = next++;
          present[i] = await this.itemExists(names[i] ?? "");
        }
      };
      await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, names.length) }, worker));
      const alive = names.filter((_, i) => present[i] === true);
      if (alive.length !== names.length) await this.writeIndex(alive);
      return alive.sort();
    });
  }

  /** Remove the index item too. For tests and uninstall; secrets must be deleted first. */
  async destroyIndex(): Promise<void> {
    await this.locked(() => this.removeValue(INDEX_ACCOUNT));
  }

  // -- index ----------------------------------------------------------------

  private async readIndex(): Promise<string[]> {
    const names = parseIndex(await this.readValue(INDEX_ACCOUNT));
    this.indexCache = { names: new Set(names), at: Date.now() };
    return names;
  }

  private async writeIndex(names: string[]): Promise<void> {
    // No names left: remove the index item instead of keeping an empty one.
    if (names.length === 0) await this.removeValue(INDEX_ACCOUNT);
    else await this.writeValue(INDEX_ACCOUNT, [...names].sort().join(","));
    this.indexCache = { names: new Set(names), at: Date.now() };
  }

  // -- values (single item or chunked) --------------------------------------

  private partAccount(account: string, index: number): string {
    return `${account}.part.${index}`;
  }

  private parseChunkHeader(raw: string): { count: number; sum: string } | null {
    if (!raw.startsWith(CHUNK_PREFIX)) return null;
    const match = raw.slice(CHUNK_PREFIX.length).match(/^([0-9]{1,3}):([0-9a-f]{16})$/);
    if (!match) throw fail("A keychain item is corrupt.", "KEYCHAIN_CORRUPT");
    const count = Number(match[1]);
    if (count < 2 || count > MAX_CHUNKS) {
      throw fail("A keychain item is corrupt.", "KEYCHAIN_CORRUPT");
    }
    return { count, sum: match[2] ?? "" };
  }

  /** Read the stored (encoded) string for an account, reassembling chunks. */
  private async readValue(account: string): Promise<string | null> {
    const head = await this.findPassword(account);
    if (head === null) return null;
    const header = this.parseChunkHeader(head);
    if (!header) return head;
    const parts: string[] = [];
    for (let i = 0; i < header.count; i++) {
      const part = await this.findPassword(this.partAccount(account, i));
      if (part === null) throw fail("A keychain item is incomplete.", "KEYCHAIN_CORRUPT");
      parts.push(part);
    }
    const stored = parts.join("");
    if (checksum(stored) !== header.sum) {
      throw fail("A keychain item is corrupt.", "KEYCHAIN_CORRUPT");
    }
    return stored;
  }

  private async previousChunkCount(account: string): Promise<number> {
    let head: string | null;
    try {
      head = await this.findPassword(account);
    } catch {
      return 0;
    }
    if (head === null) return 0;
    try {
      return this.parseChunkHeader(head)?.count ?? 0;
    } catch {
      return MAX_CHUNKS; // corrupt header: sweep every possible part
    }
  }

  private async sweepParts(account: string, from: number, to: number): Promise<void> {
    for (let i = from; i < to; i++) {
      await this.deleteItem(this.partAccount(account, i));
    }
  }

  private async writeValue(account: string, stored: string): Promise<void> {
    const previous = await this.previousChunkCount(account);
    let count = 0;
    if (stored.length <= CHUNK_CHARS) {
      await this.addPassword(account, stored);
    } else {
      count = Math.ceil(stored.length / CHUNK_CHARS);
      if (count > MAX_CHUNKS) throw fail("The secret is too large for the keychain backend.");
      for (let i = 0; i < count; i++) {
        await this.addPassword(
          this.partAccount(account, i),
          stored.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
        );
      }
      await this.addPassword(account, `${CHUNK_PREFIX}${count}:${checksum(stored)}`);
    }
    await this.sweepParts(account, count, previous);
    // Read back: guards against silent truncation by the tool. If the read
    // itself fails (timeout, locked keychain) the error propagates and the
    // item is left alone; only a value that demonstrably differs from what
    // was written is removed, so a wrong value is never served later.
    let check: string | null;
    try {
      check = await this.readValue(account);
    } catch (err) {
      if (err instanceof SecretStoreError && err.code === "KEYCHAIN_CORRUPT") check = null;
      else throw err;
    }
    if (check !== stored) {
      await this.removeValue(account).catch(() => undefined);
      throw fail("The keychain did not store the value correctly.", "KEYCHAIN_VERIFY_FAILED");
    }
  }

  private async removeValue(account: string): Promise<void> {
    const previous = await this.previousChunkCount(account);
    await this.sweepParts(account, 0, previous);
    await this.deleteItem(account);
  }

  // -- /usr/bin/security ----------------------------------------------------

  private assertName(name: string): void {
    if (!isValidSecretName(name)) throw fail("Invalid secret name.", "INVALID_SECRET_NAME");
  }

  private async run(args: string[], stdin?: string): Promise<RunResult> {
    try {
      return await this.runner(args, stdin);
    } catch (err) {
      if (err instanceof SecretStoreError) throw err;
      // Never surface what a runner threw: it may echo its input.
      throw fail("Could not run the macOS security tool.", "KEYCHAIN_UNAVAILABLE");
    }
  }

  private spawnSecurity(args: string[], stdin?: string): Promise<RunResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(SECURITY_BIN, args, {
        stdio: ["pipe", "pipe", "ignore"], // stderr is discarded on purpose
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
      });
      const chunks: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", () => {
        clearTimeout(timer);
        reject(fail("Could not run the macOS security tool.", "KEYCHAIN_UNAVAILABLE"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "");
    });
  }

  private check(result: RunResult, action: string): void {
    if (result.timedOut) {
      throw fail(
        `The keychain did not respond while ${action} (it may be locked or waiting for approval).`,
        "KEYCHAIN_TIMEOUT",
      );
    }
    if (result.code !== 0) {
      throw fail(`The keychain reported an error while ${action} (status ${result.code}).`);
    }
  }

  /** `find-generic-password -w`: the stored string, or null when absent. */
  private async findPassword(account: string): Promise<string | null> {
    const result = await this.run([
      "find-generic-password",
      "-a",
      account,
      "-s",
      this.service,
      "-w",
    ]);
    if (!result.timedOut && result.code === NOT_FOUND) return null;
    this.check(result, "reading a secret");
    return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  }

  /** Attribute-only lookup: does not read the password data. */
  private async itemExists(account: string): Promise<boolean> {
    const result = await this.run(["find-generic-password", "-a", account, "-s", this.service]);
    if (!result.timedOut && result.code === NOT_FOUND) return false;
    this.check(result, "looking up a secret");
    return true;
  }

  /** Create or update one item. The data goes over stdin only (see file header). */
  private async addPassword(account: string, stored: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(account)) throw fail("Invalid keychain account name.");
    if (stored === "" || !/^[\x20-\x7e]+$/.test(stored) || stored.length > CHUNK_CHARS) {
      throw fail("Internal error: unencodable keychain value.");
    }
    const hex = Buffer.from(stored, "latin1").toString("hex");
    const line = `add-generic-password -a ${account} -s ${this.service} -U -X ${hex}\n`;
    if (line.length > MAX_LINE_CHARS) throw fail("Internal error: keychain command too long.");
    // 45 = duplicate item: two writers raced to create it. Retry; with -U the
    // retry updates the item that now exists.
    for (let attempt = 0; ; attempt++) {
      const result = await this.run(["-i"], line);
      if (!result.timedOut && result.code === DUPLICATE && attempt < DUPLICATE_RETRIES) continue;
      this.check(result, "saving a secret");
      return;
    }
  }

  /** Returns false when the item did not exist. */
  private async deleteItem(account: string): Promise<boolean> {
    const result = await this.run(["delete-generic-password", "-a", account, "-s", this.service]);
    if (!result.timedOut && result.code === NOT_FOUND) return false;
    this.check(result, "deleting a secret");
    return true;
  }
}
