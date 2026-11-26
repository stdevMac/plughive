// src/core/secrets/file-backend.ts
//
// `<home>/secrets.json`. File 0600, atomic replace (temp file in the same
// directory + fsync + rename), read-modify-write under a cross-process lock
// file (`<home>/.secrets.json.lock`, O_EXCL, stale-lock recovery, bounded wait).
//
// Without a passphrase the file is plain JSON protected only by file
// permissions:
//   { "version": 1, "secrets": { "NAME": "value" } }
//
// With a passphrase the secrets map is encrypted with AES-256-GCM under a key
// derived by scrypt. Every write uses a fresh random salt and nonce:
//   { "version": 2, "encrypted": true,
//     "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<b64>" },
//     "cipher": "aes-256-gcm", "nonce": "<b64>", "ciphertext": "<b64>", "tag": "<b64>" }
// The envelope header (version, kdf parameters, salt, cipher) is bound as GCM
// additional authenticated data, so any edit to the file fails authentication.
// Version 1 envelopes (N = 32768) written by earlier releases are still read;
// the next write upgrades them to version 2.
//
// With a passphrase configured, a plaintext file is refused
// (SECRET_FILE_NOT_ENCRYPTED): otherwise anyone able to write the file could
// inject values without knowing the passphrase. `migratePlaintext: true`
// accepts an existing plaintext file once and re-encrypts it immediately.
//
// The home directory: it is resolved with realpath once (a symlinked home
// works) and must be owned by the current user. A directory the backend
// creates itself is made 0700. A pre-existing directory is never chmod-ed
// (it is usually the daemon home, shared with other state); it is refused if
// group/other can write to it (SECRET_DIR_INSECURE), because then another user
// could replace the secrets file. A group/other readable home (e.g. 0755) is
// accepted: the secrets file, its temp files and the lock file are always
// created 0600, so only the file names are visible.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { closeSync, constants as fsConstants, lstatSync, openSync, readFileSync } from "node:fs";
import {
  type FileHandle,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { atomicReplace } from "../../lib/platform.js";
import { SecretDecryptError, SecretStoreError } from "./errors.js";
import { withLockFile } from "./lockfile.js";
import { Mutex, type SecretBackend, isValidSecretName } from "./types.js";

const PLAIN_VERSION = 1;
const ENCRYPTED_VERSION = 2;
const SCRYPT_N = 131072; // 2^17, ~128 MiB, ~0.2 s
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** Accepted scrypt N per envelope version (inclusive bounds, powers of two). */
const N_BOUNDS: Record<number, [number, number]> = {
  1: [16384, 131072],
  2: [65536, 262144],
};
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Temp files older than this are leftovers of a crashed writer. */
const STALE_TEMP_MS = 60_000;
const TEMP_PATTERN = /^\.secrets\.(\d+)\.[0-9a-f]{16}\.tmp$/;
const POSIX = process.platform !== "win32";

export interface FileBackendOptions {
  /** Directory that holds secrets.json (the daemon home). */
  home: string;
  /** When set (non-empty), the file is encrypted at rest. */
  passphrase?: string;
  /** File name inside `home`. Default "secrets.json". */
  filename?: string;
  /**
   * With a passphrase: accept an existing plaintext file and re-encrypt it
   * immediately (on first access). Default false: a plaintext file is refused
   * with SECRET_FILE_NOT_ENCRYPTED.
   */
  migratePlaintext?: boolean;
  /** How long to wait for another process holding the lock. Default 10 s. */
  lockTimeoutMs?: number;
}

interface KdfParams {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
}

interface ReadResult {
  secrets: Map<string, string>;
  /** On-disk format, or null when there is no file. */
  format: "plain" | "encrypted" | null;
  /** Encrypted with an older envelope version. */
  outdated: boolean;
}

function deriveKey(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(
      passphrase.normalize("NFKC"),
      kdf.salt,
      KEY_BYTES,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r + 1024 * 1024 },
      (err, key) => {
        if (err) reject(new SecretStoreError("Could not derive the secrets file key."));
        else resolvePromise(key);
      },
    );
  });
}

function aad(version: number, kdf: KdfParams): Buffer {
  return Buffer.from(
    `plughive-secrets|v${version}|scrypt|${kdf.N}|${kdf.r}|${kdf.p}|${kdf.salt.toString("base64")}|aes-256-gcm`,
    "utf8",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): SecretStoreError {
  return new SecretStoreError("The secrets file is malformed.", "SECRET_FILE_MALFORMED");
}

function decodeBase64(value: unknown, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw malformed();
  const out = Buffer.from(value, "base64");
  if (expectedBytes !== undefined && out.length !== expectedBytes) throw malformed();
  return out;
}

function parseSecretsMap(value: unknown): Map<string, string> {
  if (!isRecord(value)) throw malformed();
  const out = new Map<string, string>();
  for (const [name, secret] of Object.entries(value)) {
    if (!isValidSecretName(name) || typeof secret !== "string") throw malformed();
    out.set(name, secret);
  }
  return out;
}

function currentUid(): number | undefined {
  return POSIX && typeof process.getuid === "function" ? process.getuid() : undefined;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FileBackend implements SecretBackend {
  readonly kind = "file" as const;
  /** Path as configured (`home` joined with the file name, not resolved). */
  readonly path: string;
  private readonly home: string;
  private readonly filename: string;
  private readonly passphrase: string | undefined;
  private readonly migratePlaintext: boolean;
  private readonly lockTimeoutMs: number | undefined;
  private readonly mutex = new Mutex();
  /** Derived key for the salt of the file currently on disk. */
  private keyCache: { salt: string; key: Buffer } | null = null;
  /** realpath of home, once it exists and passed the checks. */
  private realHome: string | null = null;
  private tempsCleaned = false;

  constructor(options: FileBackendOptions) {
    if (!options || typeof options.home !== "string" || options.home === "") {
      throw new SecretStoreError("FileBackend requires a home directory.");
    }
    const filename = options.filename ?? "secrets.json";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(filename) || filename === "." || filename === "..") {
      throw new SecretStoreError("FileBackend: invalid file name.");
    }
    this.home = options.home;
    this.filename = filename;
    this.path = join(options.home, filename);
    this.passphrase =
      typeof options.passphrase === "string" && options.passphrase !== ""
        ? options.passphrase
        : undefined;
    this.migratePlaintext = options.migratePlaintext === true;
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  /**
   * Whether the secrets are encrypted at rest. Reflects the file on disk when
   * there is one (a plaintext file not yet migrated reports false); when there
   * is no file yet, whether the next write will encrypt.
   */
  get encrypted(): boolean {
    let fd: number | undefined;
    try {
      const info = lstatSync(this.path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return false;
      fd = openSync(this.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
      return isRecord(parsed) && parsed.encrypted === true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.passphrase !== undefined;
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  async get(name: string): Promise<string | null> {
    return (await this.load()).get(name) ?? null;
  }

  async has(name: string): Promise<boolean> {
    return (await this.load()).has(name);
  }

  async list(): Promise<string[]> {
    return [...(await this.load()).keys()].sort();
  }

  async set(name: string, value: string): Promise<void> {
    await this.mutate((secrets) => {
      secrets.set(name, value);
      return true;
    });
  }

  async delete(name: string): Promise<void> {
    // Nothing can be stored when home does not exist; do not create it.
    if ((await this.directory(false)) === null) return;
    await this.mutate((secrets) => secrets.delete(name));
  }

  // -- orchestration --------------------------------------------------------

  /** Read for get/has/list; performs the opt-in plaintext migration. */
  private async load(): Promise<Map<string, string>> {
    const dir = await this.directory(false);
    if (dir === null) return new Map();
    const result = await this.read(dir);
    if (result.format === "plain" && this.passphrase !== undefined) {
      // read() only lets this through with migratePlaintext: encrypt it now.
      await this.mutate(() => false);
    }
    return result.secrets;
  }

  /**
   * Read-modify-write under the in-process mutex and the cross-process lock.
   * `change` returns whether anything changed; a pending migration (plaintext
   * or outdated envelope) is written either way.
   */
  private async mutate(change: (secrets: Map<string, string>) => boolean): Promise<void> {
    await this.mutex.run(async () => {
      const dir = await this.directory(true);
      if (dir === null) throw new SecretStoreError("Unreachable.");
      const lockPath = join(dir, `.${this.filename}.lock`);
      await withLockFile(
        lockPath,
        async () => {
          // Re-read inside the lock: another process may have written since.
          const current = await this.read(dir);
          const changed = change(current.secrets);
          const migrate =
            this.passphrase !== undefined &&
            (current.format === "plain" || (current.format === "encrypted" && current.outdated));
          if (changed || migrate) await this.write(dir, current.secrets);
        },
        this.lockTimeoutMs !== undefined ? { timeoutMs: this.lockTimeoutMs } : {},
      );
    });
  }

  // -- the directory --------------------------------------------------------

  /**
   * realpath of home after the ownership/permission checks. With
   * `create=false` returns null when home does not exist.
   */
  private async directory(create: boolean): Promise<string | null> {
    if (this.realHome !== null) return this.realHome;
    let created = false;
    let real: string;
    try {
      real = await realpath(this.home);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new SecretStoreError(
          "Could not open the secrets directory.",
          "SECRET_FILE_UNWRITABLE",
        );
      }
      if (!create) return null;
      try {
        const first = await mkdir(this.home, { recursive: true, mode: 0o700 });
        created = first !== undefined;
        real = await realpath(this.home);
      } catch {
        throw new SecretStoreError(
          "Could not prepare the secrets directory.",
          "SECRET_FILE_UNWRITABLE",
        );
      }
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(real);
    } catch {
      throw new SecretStoreError(
        "Could not prepare the secrets directory.",
        "SECRET_FILE_UNWRITABLE",
      );
    }
    if (!info.isDirectory()) {
      throw new SecretStoreError(
        "The secrets directory is not a directory.",
        "SECRET_FILE_UNWRITABLE",
      );
    }
    if (POSIX) {
      const uid = currentUid();
      if (uid !== undefined && info.uid !== uid) {
        throw new SecretStoreError(
          "The secrets directory is owned by another user.",
          "SECRET_DIR_INSECURE",
        );
      }
      if (created) {
        // Ours: make it private regardless of the umask.
        if ((info.mode & 0o777) !== 0o700) {
          try {
            await chmod(real, 0o700);
          } catch {
            throw new SecretStoreError(
              "Could not prepare the secrets directory.",
              "SECRET_FILE_UNWRITABLE",
            );
          }
        }
      } else if ((info.mode & 0o022) !== 0) {
        throw new SecretStoreError(
          "The secrets directory is writable by other users. Run: chmod go-w on it.",
          "SECRET_DIR_INSECURE",
        );
      }
    }
    this.realHome = real;
    await this.cleanStaleTemps(real);
    return real;
  }

  /** Remove `.secrets.*.tmp` files left behind by a crashed writer. */
  private async cleanStaleTemps(dir: string): Promise<void> {
    if (this.tempsCleaned) return;
    this.tempsCleaned = true;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const uid = currentUid();
    for (const name of names) {
      const match = name.match(TEMP_PATTERN);
      if (!match) continue;
      const full = join(dir, name);
      try {
        const info = await lstat(full);
        if (!info.isFile() || (uid !== undefined && info.uid !== uid)) continue;
        const pid = Number(match[1]);
        const old = Date.now() - info.mtimeMs > STALE_TEMP_MS;
        if (old || !processAlive(pid)) await unlink(full);
      } catch {
        // best effort
      }
    }
  }

  // -- reading --------------------------------------------------------------

  private async read(dir: string): Promise<ReadResult> {
    const path = join(dir, this.filename);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { secrets: new Map(), format: null, outdated: false };
      }
      throw new SecretStoreError("Could not read the secrets file.", "SECRET_FILE_UNREADABLE");
    }
    if (!info.isFile()) {
      // Includes symlinks: we never follow a link for the secrets file.
      throw new SecretStoreError(
        "The secrets file is not a regular file.",
        "SECRET_FILE_NOT_REGULAR",
      );
    }
    // Opened without following a link, and every check below runs on the
    // descriptor: a file swapped for a symlink after the lstat can be neither
    // chmod-ed nor read through its path.
    let handle: FileHandle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      throw new SecretStoreError(
        "The secrets file is not a regular file.",
        "SECRET_FILE_NOT_REGULAR",
      );
    }
    let parsed: unknown;
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        throw new SecretStoreError(
          "The secrets file is not a regular file.",
          "SECRET_FILE_NOT_REGULAR",
        );
      }
      if (st.size > MAX_FILE_BYTES) {
        throw new SecretStoreError("The secrets file is too large.", "SECRET_FILE_MALFORMED");
      }
      const uid = currentUid();
      if (uid !== undefined && st.uid !== uid) {
        throw new SecretStoreError(
          "The secrets file is owned by another user.",
          "SECRET_FILE_INSECURE",
        );
      }
      if (POSIX && (st.mode & 0o022) !== 0) {
        // Group/world writable: someone else may have planted keys or endpoints
        // in it. Tightening the mode would bless that, so refuse instead.
        throw new SecretStoreError(
          "The secrets file is writable by other users. Check its contents, then run: chmod 600 on the file.",
          "SECRET_FILE_INSECURE",
        );
      }
      if (POSIX && (st.mode & 0o077) !== 0) {
        // Group/world readable. Tighten it on the open descriptor, or refuse.
        try {
          await handle.chmod(0o600);
          const after = await handle.stat();
          if ((after.mode & 0o077) !== 0) throw new Error("mode unchanged");
        } catch (err) {
          if (err instanceof SecretStoreError) throw err;
          throw new SecretStoreError(
            "The secrets file is readable by other users and its permissions could not be fixed. Run: chmod 600 on the file.",
            "SECRET_FILE_INSECURE",
          );
        }
      }
      parsed = JSON.parse(await readFile(handle, "utf8"));
    } catch (err) {
      if (err instanceof SecretStoreError) throw err;
      throw malformed();
    } finally {
      await handle.close();
    }
    if (!isRecord(parsed)) throw malformed();

    if (parsed.encrypted === true) {
      if (parsed.version !== 1 && parsed.version !== ENCRYPTED_VERSION) {
        throw new SecretStoreError(
          "The secrets file has an unsupported format version.",
          "SECRET_FILE_MALFORMED",
        );
      }
      if (this.passphrase === undefined) {
        throw new SecretStoreError(
          "The secrets file is encrypted. Set PLUGHIVE_SECRETS_PASSPHRASE to unlock it.",
          "SECRET_PASSPHRASE_REQUIRED",
        );
      }
      const secrets = await this.decrypt(parsed, parsed.version, this.passphrase);
      return { secrets, format: "encrypted", outdated: parsed.version !== ENCRYPTED_VERSION };
    }
    if (parsed.version !== PLAIN_VERSION) {
      throw new SecretStoreError(
        "The secrets file has an unsupported format version.",
        "SECRET_FILE_MALFORMED",
      );
    }
    const secrets = parseSecretsMap(parsed.secrets);
    if (this.passphrase !== undefined && !this.migratePlaintext) {
      throw new SecretStoreError(
        "A passphrase is configured but the secrets file is not encrypted. Refusing to use it; set migratePlaintext to encrypt the existing file.",
        "SECRET_FILE_NOT_ENCRYPTED",
      );
    }
    return { secrets, format: "plain", outdated: false };
  }

  private async decrypt(
    envelope: Record<string, unknown>,
    version: number,
    passphrase: string,
  ): Promise<Map<string, string>> {
    const kdfRaw = envelope.kdf;
    if (!isRecord(kdfRaw) || kdfRaw.name !== "scrypt" || envelope.cipher !== "aes-256-gcm") {
      throw malformed();
    }
    const { N, r, p } = kdfRaw;
    // Bound the cost parameters so a tampered file cannot make us burn
    // unbounded memory/CPU, or silently downgrade to a trivial KDF.
    const [minN, maxN] = N_BOUNDS[version] ?? [0, -1];
    const validN =
      typeof N === "number" && Number.isInteger(N) && N >= minN && N <= maxN && (N & (N - 1)) === 0;
    if (!validN || r !== 8 || typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 4) {
      throw malformed();
    }
    const kdf: KdfParams = { N: N as number, r, p, salt: decodeBase64(kdfRaw.salt, SALT_BYTES) };
    const nonce = decodeBase64(envelope.nonce, NONCE_BYTES);
    const tag = decodeBase64(envelope.tag, TAG_BYTES);
    const ciphertext = decodeBase64(envelope.ciphertext);

    const saltKey = `${kdf.N}:${kdf.r}:${kdf.p}:${kdf.salt.toString("base64")}`;
    const key =
      this.keyCache?.salt === saltKey ? this.keyCache.key : await deriveKey(passphrase, kdf);

    let plaintext: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(version, kdf));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretDecryptError();
    }
    this.keyCache = { salt: saltKey, key };
    let inner: unknown;
    try {
      inner = JSON.parse(plaintext);
    } catch {
      throw malformed();
    }
    return parseSecretsMap(isRecord(inner) ? inner.secrets : undefined);
  }

  // -- writing --------------------------------------------------------------

  private async serialise(secrets: Map<string, string>): Promise<string> {
    const sorted = Object.fromEntries([...secrets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    if (this.passphrase === undefined) {
      return `${JSON.stringify({ version: PLAIN_VERSION, secrets: sorted }, null, 2)}\n`;
    }
    const kdf: KdfParams = {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: randomBytes(SALT_BYTES),
    };
    const key = await deriveKey(this.passphrase, kdf);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(ENCRYPTED_VERSION, kdf));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ secrets: sorted }), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    this.keyCache = {
      salt: `${kdf.N}:${kdf.r}:${kdf.p}:${kdf.salt.toString("base64")}`,
      key,
    };
    return `${JSON.stringify(
      {
        version: ENCRYPTED_VERSION,
        encrypted: true,
        kdf: { name: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt.toString("base64") },
        cipher: "aes-256-gcm",
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: tag.toString("base64"),
      },
      null,
      2,
    )}\n`;
  }

  private async write(dir: string, secrets: Map<string, string>): Promise<void> {
    const content = await this.serialise(secrets);
    const tmp = join(dir, `.secrets.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      // "wx": the temp file must not already exist (no symlink tricks).
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        if (POSIX) await handle.chmod(0o600); // independent of umask
        await handle.sync();
      } finally {
        await handle.close();
      }
      await atomicReplace(tmp, join(dir, this.filename));
    } catch {
      await unlink(tmp).catch(() => undefined);
      throw new SecretStoreError("Could not write the secrets file.", "SECRET_FILE_UNWRITABLE");
    }
    // Best effort: persist the rename itself.
    try {
      const dirHandle = await open(dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // not supported on every platform/filesystem
    }
  }
}
