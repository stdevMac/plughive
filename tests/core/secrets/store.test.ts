import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  InvalidSecretNameError,
  MemoryBackend,
  MissingSecretError,
  REDACTED,
  Redactor,
  type SecretBackend,
  SecretStoreError,
  createSecretStore,
  isValidSecretName,
} from "../../../src/core/secrets/index.js";

const T = 120_000;
const base = mkdtempSync(join(tmpdir(), "plughive-secret-store-"));
let counter = 0;
const newHome = (): string => {
  counter += 1;
  return join(base, `home-${counter}`);
};

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const ENV_VALUE = "env-value-0123456789";
const STORED_VALUE = "stored-value-abcdefgh";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SecretStoreError) return err.code;
    throw err;
  }
  return "NO_ERROR";
}

describe("createSecretStore layering", () => {
  it("the store wins over the environment, and an empty variable counts as unset", async () => {
    const env: Record<string, string | undefined> = { API_KEY: ENV_VALUE, EMPTY_KEY: "" };
    const backend = new MemoryBackend({ API_KEY: STORED_VALUE, EMPTY_KEY: STORED_VALUE });
    const store = createSecretStore({
      home: newHome(),
      env,
      backend,
      knownNames: ["API_KEY", "EMPTY_KEY", "LATE_KEY"],
    });
    expect(store.backendKind).toBe("memory");
    expect(await store.get("API_KEY")).toBe(STORED_VALUE);
    expect(await store.get("EMPTY_KEY")).toBe(STORED_VALUE);
    expect(await store.get("ABSENT_KEY")).toBeNull();
    expect(await store.has("API_KEY")).toBe(true);
    expect(await store.has("ABSENT_KEY")).toBe(false);

    // Without a stored value the environment is the fallback.
    await backend.delete("API_KEY");
    expect(await store.get("API_KEY")).toBe(ENV_VALUE);
    // The env object is read live, never copied or mutated.
    env.API_KEY = undefined;
    expect(await store.get("API_KEY")).toBeNull();
    env.LATE_KEY = "late-env-value-1234";
    expect(await store.get("LATE_KEY")).toBe("late-env-value-1234");
    expect(Object.keys(env).sort()).toEqual(["API_KEY", "EMPTY_KEY", "LATE_KEY"]);
  });

  it("only declared names are read from the environment", async () => {
    // Undeclared variables (PATH, HOME, other programs' tokens...) are never
    // served, so a tool cannot read arbitrary process env through the store.
    const env = { GITHUB_TOKEN: "ghp-not-ours-0123456789", API_KEY: ENV_VALUE };
    const backend = new MemoryBackend();
    const store = createSecretStore({ home: newHome(), env, backend });
    expect(await store.get("GITHUB_TOKEN")).toBeNull();
    expect(await store.has("GITHUB_TOKEN")).toBe(false);
    expect(await store.get("API_KEY")).toBeNull();
    expect(await store.list()).toEqual([]);
    store.declareNames(["API_KEY", "GITHUB_TOKEN"]);
    expect(await store.get("API_KEY")).toBe(ENV_VALUE);
    expect(await store.get("GITHUB_TOKEN")).toBe("ghp-not-ours-0123456789");
  });

  it("reports which layer provides a value and whether an env fallback exists", async () => {
    const env: Record<string, string | undefined> = { API_KEY: ENV_VALUE };
    const backend = new MemoryBackend({ STORE_KEY: STORED_VALUE });
    const store = createSecretStore({ home: newHome(), env, backend, knownNames: ["API_KEY"] });
    expect(await store.source("API_KEY")).toBe("env");
    expect(await store.source("STORE_KEY")).toBe("memory");
    expect(await store.source("ABSENT_KEY")).toBeNull();
    expect(store.hasEnvFallback("API_KEY")).toBe(true);
    expect(store.hasEnvFallback("STORE_KEY")).toBe(false);
    env.API_KEY = "";
    expect(store.hasEnvFallback("API_KEY")).toBe(false);
  });

  it("set and delete only touch the backend", async () => {
    const env: Record<string, string | undefined> = { API_KEY: ENV_VALUE };
    const backend = new MemoryBackend();
    const store = createSecretStore({ home: newHome(), env, backend, knownNames: ["API_KEY"] });
    await store.set("API_KEY", STORED_VALUE);
    expect(env.API_KEY).toBe(ENV_VALUE);
    expect(await backend.get("API_KEY")).toBe(STORED_VALUE);
    expect(await store.get("API_KEY")).toBe(STORED_VALUE); // a saved key takes effect
    expect(await store.source("API_KEY")).toBe("memory");

    await store.delete("API_KEY");
    expect(await backend.get("API_KEY")).toBeNull();
    expect(env.API_KEY).toBe(ENV_VALUE);
    expect(await store.get("API_KEY")).toBe(ENV_VALUE);
    await store.delete("NEVER_SET"); // no throw
  });

  it("does not serve inherited object properties or its own settings as secrets", async () => {
    const env = Object.create({ INHERITED_KEY: "inherited-value-123" }) as Record<
      string,
      string | undefined
    >;
    env.PLUGHIVE_SECRETS = "memory";
    env.PLUGHIVE_SECRETS_PASSPHRASE = "the-passphrase-value";
    const store = createSecretStore({ home: newHome(), env });
    expect(store.backendKind).toBe("memory");
    expect(await store.get("INHERITED_KEY")).toBeNull();
    expect(await store.get("PLUGHIVE_SECRETS")).toBeNull();
    expect(await store.get("PLUGHIVE_SECRETS_PASSPHRASE")).toBeNull();
    store.declareNames(["PLUGHIVE_SECRETS_PASSPHRASE"]);
    expect(await store.list()).toEqual([]);
    // ...but the passphrase is still scrubbed from redacted output.
    expect(store.redactor.redact("p=the-passphrase-value")).toBe(`p=${REDACTED}`);
  });

  it("rejects empty and non-string values", async () => {
    const store = createSecretStore({ home: newHome(), env: {}, backend: "memory" });
    for (const bad of ["", undefined, null, 42]) {
      await expect(store.set("API_KEY", bad as unknown as string)).rejects.toMatchObject({
        code: "SECRET_EMPTY",
      });
    }
    expect(await store.has("API_KEY")).toBe(false);
  });
});

describe("createSecretStore.list", () => {
  it("reports stored names plus declared env names with the effective source", async () => {
    const env = {
      ENV_ONLY: ENV_VALUE,
      BOTH_KEY: ENV_VALUE,
      UNDECLARED_ENV: "not-ours-value-123",
      EMPTY_DECLARED: "",
      PATH: "/usr/bin",
    };
    const backend = new MemoryBackend({ BOTH_KEY: STORED_VALUE, STORE_ONLY: STORED_VALUE });
    const store = createSecretStore({
      home: newHome(),
      env,
      backend,
      knownNames: ["ENV_ONLY", "BOTH_KEY", "EMPTY_DECLARED", "NOT_SET_ANYWHERE"],
    });
    const listed = await store.list();
    expect(listed).toEqual([
      { name: "BOTH_KEY", source: "memory" },
      { name: "ENV_ONLY", source: "env" },
      { name: "STORE_ONLY", source: "memory" },
    ]);
    // never values
    expect(JSON.stringify(listed)).not.toContain(ENV_VALUE);
    expect(JSON.stringify(listed)).not.toContain(STORED_VALUE);

    store.declareNames(new Set(["UNDECLARED_ENV"]));
    expect((await store.list()).map((e) => e.name)).toContain("UNDECLARED_ENV");
  });

  it("redacts a declared environment value before anything reads it", () => {
    const env = { LATE_ENV: ENV_VALUE, NOT_OURS: "other-tool-credential-xyz" };
    const store = createSecretStore({ home: newHome(), env, backend: new MemoryBackend() });
    store.declareNames(["LATE_ENV"]);
    expect(store.redactor.redact(`echo ${ENV_VALUE}`)).toBe(`echo ${REDACTED}`);
    // Undeclared variables are not ours to register.
    expect(store.redactor.redact("other-tool-credential-xyz")).toBe("other-tool-credential-xyz");
  });

  it("drops invalid names a backend might return", async () => {
    const backend: SecretBackend = {
      kind: "memory",
      get: async () => null,
      has: async () => false,
      set: async () => undefined,
      delete: async () => undefined,
      list: async () => ["GOOD_KEY", "bad name", "plughive.index", ""],
    };
    const store = createSecretStore({ home: newHome(), env: {}, backend });
    expect(await store.list()).toEqual([{ name: "GOOD_KEY", source: "memory" }]);
  });
});

describe("secret names", () => {
  it("accepts ^[A-Z][A-Z0-9_]{1,63}$ only", () => {
    for (const good of ["AB", "API_KEY", "A1", "X_1_Y", `A${"B".repeat(63)}`]) {
      expect(isValidSecretName(good), good).toBe(true);
    }
    for (const bad of [
      "",
      "A",
      "a_key",
      "1KEY",
      "_KEY",
      "API-KEY",
      "API KEY",
      "API_KEY\n",
      "API.KEY",
      "../ETC",
      "KEY=1",
      "__proto__",
      `A${"B".repeat(64)}`,
    ]) {
      expect(isValidSecretName(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isValidSecretName(undefined as unknown as string)).toBe(false);
  });

  it("every store method rejects an invalid name without echoing it", async () => {
    const leaked = "sk-pasted-a-value-by-mistake-123";
    const store = createSecretStore({ home: newHome(), env: {}, backend: "memory" });
    const calls: Array<() => Promise<unknown>> = [
      () => store.get(leaked),
      () => store.has(leaked),
      () => store.set(leaked, "some-value-123"),
      () => store.delete(leaked),
    ];
    for (const call of calls) {
      try {
        await call();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidSecretNameError);
        expect((err as InvalidSecretNameError).code).toBe("INVALID_SECRET_NAME");
        expect(`${(err as Error).message}${(err as Error).stack}`).not.toContain(leaked);
      }
    }
    expect(() => store.declareNames([leaked])).toThrow(InvalidSecretNameError);
    expect(() =>
      createSecretStore({ home: newHome(), env: {}, backend: "memory", knownNames: ["bad"] }),
    ).toThrow(InvalidSecretNameError);
  });
});

describe("backend selection", () => {
  it("honours options.backend, then PLUGHIVE_SECRETS, then the platform", () => {
    const home = newHome();
    expect(createSecretStore({ home, env: {}, backend: "file" }).backendKind).toBe("file");
    expect(createSecretStore({ home, env: {}, backend: "memory" }).backendKind).toBe("memory");
    expect(
      createSecretStore({ home, env: { PLUGHIVE_SECRETS: "file" }, backend: "memory" }).backendKind,
    ).toBe("memory");
    expect(createSecretStore({ home, env: { PLUGHIVE_SECRETS: "file" } }).backendKind).toBe("file");
    expect(createSecretStore({ home, env: { PLUGHIVE_SECRETS: " Memory " } }).backendKind).toBe(
      "memory",
    );
    expect(createSecretStore({ home, env: {}, platform: "linux" }).backendKind).toBe("file");
    // Construction only: the keyring addon is loaded on first use.
    expect(createSecretStore({ home, env: {}, platform: "win32" }).backendKind).toBe("keyring");
    // Linux records its first choice in the home, so a desktop session needs a
    // fresh home (and a Secret Service that answers).
    const desktopHome = mkdtempSync(join(tmpdir(), "plughive-desktop-"));
    try {
      expect(
        createSecretStore({
          home: desktopHome,
          env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" },
          platform: "linux",
          probeSecretService: () => true,
        }).backendKind,
      ).toBe("keyring");
    } finally {
      rmSync(desktopHome, { recursive: true, force: true });
    }
    expect(
      createSecretStore({ home, env: { PLUGHIVE_SECRETS: "file" }, platform: "win32" }).backendKind,
    ).toBe("file");
    expect(
      createSecretStore({ home, env: { PLUGHIVE_SECRETS: "" }, platform: "linux" }).backendKind,
    ).toBe("file");
  });

  it.runIf(process.platform === "darwin")("defaults to the keychain on macOS", () => {
    // Construction only: no keychain item is read or written.
    const store = createSecretStore({
      home: newHome(),
      env: {},
      keychainService: "plughive-test-construct-only",
    });
    expect(store.backendKind).toBe("keychain");
  });

  it("rejects unknown backends and the keychain off macOS", () => {
    const home = newHome();
    expect(codeOf(() => createSecretStore({ home, env: { PLUGHIVE_SECRETS: "vault" } }))).toBe(
      "SECRET_BACKEND_UNKNOWN",
    );
    expect(codeOf(() => createSecretStore({ home, env: {}, backend: "nope" as "file" }))).toBe(
      "SECRET_BACKEND_UNKNOWN",
    );
    expect(
      codeOf(() => createSecretStore({ home, env: {}, backend: "keychain", platform: "linux" })),
    ).toBe("KEYCHAIN_UNAVAILABLE");
    expect(
      codeOf(() =>
        createSecretStore({ home, env: { PLUGHIVE_SECRETS: "keychain" }, platform: "linux" }),
      ),
    ).toBe("KEYCHAIN_UNAVAILABLE");
    expect(
      codeOf(() => createSecretStore({ home, env: {}, backend: "keyring", platform: "darwin" })),
    ).toBe("KEYRING_UNAVAILABLE");
    expect(() => createSecretStore({ home: "", env: {} })).toThrow(SecretStoreError);
    expect(() =>
      createSecretStore({ home, env: null as unknown as Record<string, string> }),
    ).toThrow(SecretStoreError);
  });

  it(
    "file backend persists across stores and takes the passphrase from the environment",
    async () => {
      const home = newHome();
      const passphrase = "env-supplied-passphrase-77";
      const env = { PLUGHIVE_SECRETS: "file", PLUGHIVE_SECRETS_PASSPHRASE: passphrase };
      const first = createSecretStore({ home, env });
      await first.set("API_KEY", STORED_VALUE);
      const raw = readFileSync(join(home, "secrets.json"), "utf8");
      expect(JSON.parse(raw).encrypted).toBe(true);
      expect(raw).not.toContain(STORED_VALUE);

      const second = createSecretStore({ home, env });
      expect(await second.get("API_KEY")).toBe(STORED_VALUE);
      expect(await second.list()).toEqual([{ name: "API_KEY", source: "file" }]);

      const wrong = createSecretStore({
        home,
        env: { PLUGHIVE_SECRETS: "file" },
        passphrase: "x",
      });
      await expect(wrong.get("API_KEY")).rejects.toMatchObject({ code: "SECRET_DECRYPT_FAILED" });
      const none = createSecretStore({ home, env: { PLUGHIVE_SECRETS: "file" } });
      await expect(none.get("API_KEY")).rejects.toMatchObject({
        code: "SECRET_PASSPHRASE_REQUIRED",
      });
    },
    T,
  );
});

describe("redactor integration", () => {
  it("registers every value the store returns or stores", async () => {
    const shared = new Redactor();
    const store = createSecretStore({
      home: newHome(),
      env: { ENV_KEY: ENV_VALUE },
      backend: new MemoryBackend({ OLD_KEY: "pre-existing-value-55" }),
      redactor: shared,
      knownNames: ["ENV_KEY"],
    });
    expect(store.redactor).toBe(shared);
    // A declared environment value is known at once; a stored one once read.
    expect(shared.redact(`a ${ENV_VALUE} pre-existing-value-55`)).toBe(
      `a ${REDACTED} pre-existing-value-55`,
    );

    await store.get("ENV_KEY");
    await store.get("OLD_KEY");
    await store.set("NEW_KEY", STORED_VALUE);
    const line = `env=${ENV_VALUE} old=pre-existing-value-55 new=${STORED_VALUE}`;
    expect(shared.redact(line)).toBe(`env=${REDACTED} old=${REDACTED} new=${REDACTED}`);
    expect(shared.redact(`Bearer ${Buffer.from(STORED_VALUE).toString("base64")}`)).toContain(
      REDACTED,
    );
  });

  it("registers a value even when the backend write fails", async () => {
    const failing: SecretBackend = {
      kind: "memory",
      get: async () => null,
      has: async () => false,
      set: async (_name, value) => {
        throw new Error(`backend exploded while writing ${value}`);
      },
      delete: async () => undefined,
      list: async () => [],
    };
    const store = createSecretStore({ home: newHome(), env: {}, backend: failing });
    const error = await store.set("API_KEY", STORED_VALUE).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect(store.redactor.redact((error as Error).message)).not.toContain(STORED_VALUE);
  });
});

describe("MissingSecretError", () => {
  it("carries pack, name, label and helpUrl", () => {
    const err = new MissingSecretError({
      pack: "exa",
      name: "EXA_API_KEY",
      label: "Exa API key",
      helpUrl: "https://example.test/keys",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("MISSING_SECRET");
    expect(err.pack).toBe("exa");
    expect(err.name).toBe("EXA_API_KEY");
    expect(err.label).toBe("Exa API key");
    expect(err.helpUrl).toBe("https://example.test/keys");
    expect(err.message).toContain("EXA_API_KEY");
    expect(err.message).not.toContain("—");

    const bare = new MissingSecretError({ pack: "exa", name: "EXA_API_KEY" });
    expect(bare.label).toBeUndefined();
    expect(bare.helpUrl).toBeUndefined();
  });
});

describe("MemoryBackend", () => {
  it("stores, lists sorted and deletes", async () => {
    const backend = new MemoryBackend({ ZED_KEY: "z-value-1" });
    expect(backend.kind).toBe("memory");
    await backend.set("API_KEY", STORED_VALUE);
    expect(await backend.list()).toEqual(["API_KEY", "ZED_KEY"]);
    expect(await backend.has("API_KEY")).toBe(true);
    await backend.delete("API_KEY");
    expect(await backend.get("API_KEY")).toBeNull();
    expect(await backend.has("API_KEY")).toBe(false);
    expect(await backend.get("__proto__")).toBeNull();
    expect(await backend.get("constructor")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the security review (S7, S8).

describe("store env layering review regressions", () => {
  it("S7: undeclared environment variables are neither served nor registered", async () => {
    const store = createSecretStore({
      home: newHome(),
      backend: new MemoryBackend(),
      env: {
        HOME: "/Users/someone",
        AWS_SECRET_ACCESS_KEY: "aws-secret-not-ours",
        PATH: "/usr/bin:/bin",
      },
    });
    expect(await store.get("AWS_SECRET_ACCESS_KEY")).toBeNull();
    expect(await store.get("HOME")).toBeNull();
    expect(await store.list()).toEqual([]);
    const line = "open /Users/someone/project/file.ts failed";
    expect(store.redactor.redact(line)).toBe(line);
  });

  it("S8: a rotated key takes effect over the environment, and deleting it falls back", async () => {
    const store = createSecretStore({
      home: newHome(),
      backend: new MemoryBackend(),
      env: { EXA_API_KEY: "from-env-000000" },
      knownNames: ["EXA_API_KEY"],
    });
    await store.set("EXA_API_KEY", "new-rotated-value");
    expect(await store.get("EXA_API_KEY")).toBe("new-rotated-value");
    expect(store.hasEnvFallback("EXA_API_KEY")).toBe(true);
    expect(await store.source("EXA_API_KEY")).toBe("memory");
    await store.delete("EXA_API_KEY");
    expect(await store.get("EXA_API_KEY")).toBe("from-env-000000");
    expect(await store.has("EXA_API_KEY")).toBe(true);
    expect(await store.source("EXA_API_KEY")).toBe("env");
  });
});

// M1: the environment fallback belongs to whoever declared the name, and only while they do.
describe("declared names have owners", () => {
  it("serves the environment while some owner declares the name; getStored/hasStored never do", async () => {
    const store = createSecretStore({
      home: newHome(),
      env: { EXA_API_KEY: ENV_VALUE },
      backend: "memory",
    });
    const a = {};
    const b = {};
    store.declareNames(["EXA_API_KEY"], a);
    store.declareNames(["EXA_API_KEY"], b);
    expect(await store.get("EXA_API_KEY")).toBe(ENV_VALUE);
    expect(await store.getStored("EXA_API_KEY")).toBeNull();
    expect(await store.hasStored("EXA_API_KEY")).toBe(false);

    store.releaseNames(a);
    expect(store.hasEnvFallback("EXA_API_KEY")).toBe(true);
    store.releaseNames(b);
    expect(store.hasEnvFallback("EXA_API_KEY")).toBe(false);
    expect(await store.get("EXA_API_KEY")).toBeNull();

    await store.set("EXA_API_KEY", STORED_VALUE);
    expect(await store.getStored("EXA_API_KEY")).toBe(STORED_VALUE);
    expect(await store.hasStored("EXA_API_KEY")).toBe(true);
  });
});
