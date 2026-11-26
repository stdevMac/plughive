// src/core/secrets/store.ts
//
// Layered secret store: one writable backend (keychain, file or memory) over
// the process environment (read-only fallback).
//
// Precedence: a value saved in the backend wins. The environment is only
// consulted when the backend has nothing for that name, and only for names a
// pack manifest declares (so HOME, PATH or another tool's credentials are
// never served). Which pack may read which name is enforced by the pack
// loader (a pack only ever gets the secrets its own manifest declares).
//
// Where values live:
//   keychain (default on macOS)  the login keychain, one item per secret.
//   keyring (Windows; Linux with a desktop session)  Credential Manager or
//                                the Secret Service, one entry per secret.
//   file (headless Linux)        `<home>/secrets.json`, mode 0600, atomic
//                                writes. Encrypted at rest (AES-256-GCM, scrypt)
//                                when PLUGHIVE_SECRETS_PASSPHRASE is set;
//                                without a passphrase it is plain JSON that
//                                only file permissions protect.
//   memory                       nothing is persisted (tests:
//                                PLUGHIVE_SECRETS=memory).
// Values are never logged: everything read or written is registered with the
// redactor, which the logger and the tool registry apply to their output.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretStoreError } from "./errors.js";
import { FileBackend } from "./file-backend.js";
import { KeychainBackend } from "./keychain-backend.js";
import { KeyringBackend } from "./keyring-backend.js";
import { MemoryBackend } from "./memory-backend.js";
import { Redactor } from "./redactor.js";
import {
  type SecretBackend,
  type SecretBackendKind,
  type SecretListEntry,
  type SecretSource,
  type SecretStore,
  assertSecretName,
  isValidSecretName,
} from "./types.js";

export interface CreateSecretStoreOptions {
  /** Daemon home directory (holds secrets.json for the file backend). */
  home: string;
  /** Environment to layer on top. Injected, never mutated. */
  env: Record<string, string | undefined>;
  /**
   * Backend kind, or a ready backend instance. Default: `env.PLUGHIVE_SECRETS`
   * ("keychain" | "keyring" | "file" | "memory"), else `defaultBackendKind`.
   */
  backend?: SecretBackendKind | SecretBackend;
  /** File backend passphrase. Default: `env.PLUGHIVE_SECRETS_PASSPHRASE`. */
  passphrase?: string;
  /**
   * Keychain service name. Default: `env.PLUGHIVE_KEYCHAIN_SERVICE`, else
   * "plughive".
   */
  keychainService?: string;
  /** Share an existing redactor (for example the logger's). Default: a new one. */
  redactor?: Redactor;
  /**
   * Secret names packs declare. Only declared names are ever read from `env`:
   * `get`/`has` of an undeclared name never look at the environment.
   */
  knownNames?: Iterable<string>;
  /** Platform override for tests. Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Linux Secret Service probe override for tests. Default `probeSecretService`. */
  probeSecretService?: (env: Record<string, string | undefined>) => boolean | undefined;
}

/**
 * Where stored secrets actually live: the macOS Keychain, a file that is
 * encrypted with the passphrase, a plain file (no passphrase), or memory only.
 */
export type SecretStorage = "keychain" | "keyring" | "file-encrypted" | "file-plain" | "memory";

export interface LayeredSecretStore extends SecretStore {
  /** Kind of the writable backend. */
  readonly backendKind: SecretBackendKind;
  /** The Keychain service name when the backend is the Keychain, else null. */
  readonly keychainService: string | null;
  /** Where stored secrets live now (a file's state is read from disk). */
  storage(): SecretStorage;
  /** Every value this store has returned or stored is registered here. */
  readonly redactor: Redactor;
  /**
   * Tell the store which names packs may ask for. `list()` reports a declared
   * name when the environment provides it. (The store never enumerates the
   * whole environment: most variables there are not secrets of ours.)
   */
  declareNames(names: Iterable<string>, owner?: unknown): void;
  /**
   * Drop everything `owner` declared. A name no owner declares any more is no
   * longer served from the environment.
   */
  releaseNames(owner: unknown): void;
  /** `get` without the environment: only what the user stored. */
  getStored(name: string): Promise<string | null>;
  /** `has` without the environment: only what the user stored. */
  hasStored(name: string): Promise<boolean>;
  /**
   * Where `get(name)` would currently read the value from: the backend kind
   * when the backend has it, "env" for a declared name only the environment
   * provides, null when neither does.
   */
  source(name: string): Promise<SecretSource | null>;
  /**
   * True when a declared environment variable provides `name`. It is used
   * only while the backend has no value, and it survives `delete` (which only
   * touches the backend).
   */
  hasEnvFallback(name: string): boolean;
}

const BACKEND_KINDS: readonly SecretBackendKind[] = ["keychain", "keyring", "file", "memory"];
/** Settings of the store itself: never reported or served as secrets. */
const RESERVED_NAMES = new Set([
  "PLUGHIVE_SECRETS",
  "PLUGHIVE_SECRETS_PASSPHRASE",
  "PLUGHIVE_KEYCHAIN_SERVICE",
]);

/** PLUGHIVE_KEYCHAIN_SERVICE: short, and only characters safe on a command line. */
export const KEYCHAIN_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function keychainServiceFrom(options: CreateSecretStoreOptions): string | undefined {
  if (options.keychainService !== undefined) return options.keychainService;
  const raw = options.env.PLUGHIVE_KEYCHAIN_SERVICE;
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;
  if (!KEYCHAIN_SERVICE_PATTERN.test(value)) {
    throw new SecretStoreError(
      "PLUGHIVE_KEYCHAIN_SERVICE must be 1 to 64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit.",
      "KEYCHAIN_BAD_SERVICE",
    );
  }
  return value;
}

function isBackendKind(value: unknown): value is SecretBackendKind {
  return typeof value === "string" && (BACKEND_KINDS as readonly string[]).includes(value);
}

/**
 * The OS credential store where there is one: the Keychain on macOS, Credential
 * Manager on Windows, the Secret Service on a Linux desktop session (a D-Bus
 * session bus is present). Headless Linux (servers, containers) has no
 * keyring daemon to talk to, so it keeps secrets in the file. On Linux
 * `buildBackend` refines this with `linuxBackendKind` (is a Secret Service
 * actually there?).
 */
export function defaultBackendKind(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): SecretBackendKind {
  if (platform === "darwin") return "keychain";
  if (platform === "win32") return "keyring";
  if (platform === "linux" && (env.DBUS_SESSION_BUS_ADDRESS ?? "") !== "") return "keyring";
  return "file";
}

/** File in the daemon home that records the backend chosen on Linux. */
export const BACKEND_CHOICE_FILE = "secrets-backend";

const SECRET_SERVICE = "org.freedesktop.secrets";

/**
 * Whether a D-Bus Secret Service (GNOME Keyring, KWallet, KeePassXC) is on the
 * session bus or can be started by it. Asks the bus with `busctl` (systemd)
 * or `dbus-send`; `undefined` when neither tool could answer.
 */
export function probeSecretService(env: Record<string, string | undefined>): boolean | undefined {
  const childEnv = { ...process.env, ...env } as NodeJS.ProcessEnv;
  const run = (cmd: string, args: string[]): string | undefined => {
    try {
      return execFileSync(cmd, args, {
        env: childEnv,
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      });
    } catch {
      return undefined;
    }
  };
  const names = (out: string | undefined): string[] | undefined =>
    out === undefined ? undefined : (out.match(/[A-Za-z0-9_.:-]+/g) ?? []);
  const viaBusctl = (flag: string): string[] | undefined =>
    names(run("busctl", ["--user", "--no-pager", "--no-legend", flag]));
  const owned = viaBusctl("list");
  if (owned !== undefined) {
    if (owned.includes(SECRET_SERVICE)) return true;
    const activatable = viaBusctl("--activatable");
    if (activatable !== undefined) return activatable.includes(SECRET_SERVICE);
  }
  const call = (method: string): string[] | undefined =>
    names(
      run("dbus-send", [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        `org.freedesktop.DBus.${method}`,
      ]),
    );
  const listed = [...(call("ListNames") ?? []), ...(call("ListActivatableNames") ?? [])];
  if (listed.length > 0) return listed.includes(SECRET_SERVICE);
  return owned !== undefined ? false : undefined;
}

/**
 * The Linux backend, decided once per daemon home and then kept, so stored
 * secrets never seem to vanish because a keyring was briefly unreachable:
 *   1. secrets already in `<home>/secrets.json` -> file (existing data wins);
 *   2. an earlier choice in `<home>/secrets-backend` -> that choice;
 *   3. no session bus -> file; a session bus -> keyring only if a Secret
 *      Service answers (or the bus cannot be asked: assume a desktop).
 * The choice in 3 is recorded.
 */
export function linuxBackendKind(
  home: string,
  env: Record<string, string | undefined>,
  probe: (env: Record<string, string | undefined>) => boolean | undefined = probeSecretService,
): SecretBackendKind {
  if (existsSync(join(home, "secrets.json"))) return "file";
  const choiceFile = join(home, BACKEND_CHOICE_FILE);
  try {
    const recorded = readFileSync(choiceFile, "utf8").trim();
    if (recorded === "keyring" || recorded === "file") return recorded;
  } catch {
    // Nothing recorded yet.
  }
  let kind: SecretBackendKind = "file";
  if ((env.DBUS_SESSION_BUS_ADDRESS ?? "") !== "") {
    kind = probe(env) === false ? "file" : "keyring";
  }
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(choiceFile, `${kind}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    // Another process recorded it first, or the home is read-only: both fine.
    try {
      const recorded = readFileSync(choiceFile, "utf8").trim();
      if (recorded === "keyring" || recorded === "file") return recorded;
    } catch {
      // Keep the probed kind.
    }
  }
  return kind;
}

export function buildBackend(options: CreateSecretStoreOptions): SecretBackend {
  const requested = options.backend;
  if (typeof requested === "object" && requested !== null) return requested;

  const platform = options.platform ?? process.platform;
  let kind: SecretBackendKind;
  if (requested !== undefined) {
    if (!isBackendKind(requested)) {
      throw new SecretStoreError("Unknown secrets backend.", "SECRET_BACKEND_UNKNOWN");
    }
    kind = requested;
  } else {
    const fromEnv = options.env.PLUGHIVE_SECRETS?.trim().toLowerCase();
    if (fromEnv !== undefined && fromEnv !== "") {
      if (!isBackendKind(fromEnv)) {
        throw new SecretStoreError(
          'PLUGHIVE_SECRETS must be "keychain", "keyring", "file" or "memory".',
          "SECRET_BACKEND_UNKNOWN",
        );
      }
      kind = fromEnv;
    } else if (platform === "linux") {
      kind = linuxBackendKind(options.home, options.env, options.probeSecretService);
    } else {
      kind = defaultBackendKind(platform, options.env);
    }
  }

  if (kind === "memory") return new MemoryBackend();
  if (kind === "keyring") {
    if (platform === "darwin") {
      throw new SecretStoreError('On macOS use the "keychain" backend.', "KEYRING_UNAVAILABLE");
    }
    const service = keychainServiceFrom(options);
    return new KeyringBackend({
      lockDir: options.home,
      ...(service !== undefined ? { service } : {}),
    });
  }
  if (kind === "keychain") {
    if (platform !== "darwin") {
      throw new SecretStoreError(
        "The keychain backend is only available on macOS.",
        "KEYCHAIN_UNAVAILABLE",
      );
    }
    // The lock lives in the daemon home (owner-only), not in a shared temp folder.
    const service = keychainServiceFrom(options);
    return new KeychainBackend({
      lockDir: options.home,
      platform,
      ...(service !== undefined ? { service } : {}),
    });
  }
  const passphrase = options.passphrase ?? options.env.PLUGHIVE_SECRETS_PASSPHRASE;
  return new FileBackend({
    home: options.home,
    ...(passphrase !== undefined && passphrase !== "" ? { passphrase } : {}),
  });
}

export function createSecretStore(options: CreateSecretStoreOptions): LayeredSecretStore {
  if (!options || typeof options.home !== "string" || options.home === "") {
    throw new SecretStoreError("createSecretStore requires a home directory.");
  }
  if (typeof options.env !== "object" || options.env === null) {
    throw new SecretStoreError("createSecretStore requires an env object.");
  }
  const env = options.env;
  const backend = buildBackend(options);
  const redactor = options.redactor ?? new Redactor();
  // Who declared what. A name is served from the environment only while some
  // owner (a loaded bundled pack, the daemon itself) still declares it.
  const DEFAULT_OWNER = Symbol("default");
  const owners = new Map<unknown, Set<string>>();
  const declared = {
    has: (name: string): boolean => {
      for (const names of owners.values()) if (names.has(name)) return true;
      return false;
    },
    *[Symbol.iterator](): IterableIterator<string> {
      const seen = new Set<string>();
      for (const names of owners.values()) {
        for (const name of names) {
          if (!seen.has(name)) {
            seen.add(name);
            yield name;
          }
        }
      }
    },
  };

  // Only declared names are served from the environment: most variables there
  // (HOME, PATH, other tools' credentials) are not secrets of ours.
  // An empty variable counts as unset, so `FOO=` does not mask a stored secret.
  const fromEnv = (name: string): string | undefined => {
    if (RESERVED_NAMES.has(name)) return undefined;
    if (!declared.has(name)) return undefined;
    if (!Object.hasOwn(env, name)) return undefined;
    const value = env[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  const declareNames = (names: Iterable<string>, owner: unknown = DEFAULT_OWNER): void => {
    let mine = owners.get(owner);
    for (const name of names) {
      assertSecretName(name);
      if (!mine) {
        mine = new Set();
        owners.set(owner, mine);
      }
      mine.add(name);
      // Register an environment value now, not on first get(): a pack or a
      // child process can see the variable without ever asking the store.
      const value = fromEnv(name);
      if (value !== undefined) redactor.register(value);
    }
  };
  if (options.knownNames !== undefined) declareNames(options.knownNames);

  // The passphrase is a secret too: keep it out of anything that gets redacted.
  const passphrase = options.passphrase ?? env.PLUGHIVE_SECRETS_PASSPHRASE;
  if (typeof passphrase === "string") redactor.register(passphrase);

  const serviceField = (backend as { service?: unknown }).service;
  const keychainService =
    backend.kind === "keychain" && typeof serviceField === "string" ? serviceField : null;

  return {
    backendKind: backend.kind,
    keychainService,
    storage(): SecretStorage {
      if (backend.kind === "keychain") return "keychain";
      if (backend.kind === "keyring") return "keyring";
      if (backend.kind === "memory") return "memory";
      // A file backend without a readable `encrypted` flag is reported as plain:
      // never claim encryption that cannot be confirmed.
      try {
        return (backend as { encrypted?: unknown }).encrypted === true
          ? "file-encrypted"
          : "file-plain";
      } catch {
        return "file-plain";
      }
    },
    redactor,
    declareNames,
    releaseNames(owner) {
      owners.delete(owner);
    },

    async getStored(name) {
      assertSecretName(name);
      const value = await backend.get(name);
      if (value === null) return null;
      redactor.register(value);
      return value;
    },

    async hasStored(name) {
      assertSecretName(name);
      return backend.has(name);
    },

    async get(name) {
      assertSecretName(name);
      const value = (await backend.get(name)) ?? fromEnv(name) ?? null;
      if (value === null) return null;
      redactor.register(value);
      return value;
    },

    async has(name) {
      assertSecretName(name);
      return (await backend.has(name)) || fromEnv(name) !== undefined;
    },

    async set(name, value) {
      assertSecretName(name);
      if (typeof value !== "string" || value === "") {
        throw new SecretStoreError("Secret values must be non-empty strings.", "SECRET_EMPTY");
      }
      // Register first: if the backend fails, its error path is already covered.
      redactor.register(value);
      await backend.set(name, value);
    },

    async delete(name) {
      assertSecretName(name);
      await backend.delete(name);
    },

    hasEnvFallback(name) {
      assertSecretName(name);
      return fromEnv(name) !== undefined;
    },

    async source(name) {
      assertSecretName(name);
      if (await backend.has(name)) return backend.kind;
      return fromEnv(name) !== undefined ? "env" : null;
    },

    async list() {
      const stored = (await backend.list()).filter((name) => isValidSecretName(name));
      const inBackend = new Set<string>(stored);
      const names = new Set<string>(stored);
      for (const name of declared) {
        if (fromEnv(name) !== undefined) names.add(name);
      }
      const out: SecretListEntry[] = [];
      for (const name of [...names].sort()) {
        out.push({ name, source: inBackend.has(name) ? backend.kind : "env" });
      }
      return out;
    },
  };
}
