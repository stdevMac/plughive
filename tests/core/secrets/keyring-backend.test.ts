import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretStoreError } from "../../../src/core/secrets/errors.js";
import {
  KeyringBackend,
  type KeyringEntryStore,
} from "../../../src/core/secrets/keyring-backend.js";

/** An in-memory stand-in for the OS keyring, with Credential Manager's size limit. */
function fakeKeyring(maxChars = 1280): KeyringEntryStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  const key = (s: string, a: string) => `${s}\u0000${a}`;
  return {
    items,
    async get(s, a) {
      return items.get(key(s, a)) ?? null;
    },
    async set(s, a, v) {
      if (v.length > maxChars) throw new Error("blob too large");
      items.set(key(s, a), v);
    },
    async delete(s, a) {
      return items.delete(key(s, a));
    },
  };
}

const dirs: string[] = [];
function lockDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mcp-keyring-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("KeyringBackend", () => {
  it("round-trips, lists and deletes", async () => {
    const store = fakeKeyring();
    const b = new KeyringBackend({ store, lockDir: lockDir() });
    expect(await b.get("FAL_KEY")).toBeNull();
    await b.set("FAL_KEY", "abc");
    await b.set("OPENAI_KEY", "héllo ✓");
    expect(await b.get("FAL_KEY")).toBe("abc");
    expect(await b.get("OPENAI_KEY")).toBe("héllo ✓");
    expect(await b.has("FAL_KEY")).toBe(true);
    expect(await b.list()).toEqual(["FAL_KEY", "OPENAI_KEY"]);
    await b.delete("FAL_KEY");
    await b.delete("OPENAI_KEY");
    expect(await b.list()).toEqual([]);
    expect(store.items.size).toBe(0);
  });

  it("chunks values above the per-entry limit and cleans up old parts", async () => {
    const store = fakeKeyring();
    const b = new KeyringBackend({ store, lockDir: lockDir() });
    const big = "x".repeat(5000);
    await b.set("BIG_KEY", big);
    expect(await b.get("BIG_KEY")).toBe(big);
    await b.set("BIG_KEY", "small");
    expect(await b.get("BIG_KEY")).toBe("small");
    // Only the value and the index remain.
    expect(store.items.size).toBe(2);
  });

  it("prunes names removed outside plughive", async () => {
    const store = fakeKeyring();
    const b = new KeyringBackend({ store, lockDir: lockDir() });
    await b.set("A_KEY", "1");
    await b.set("B_KEY", "2");
    await store.delete("plughive", "A_KEY");
    expect(await b.list()).toEqual(["B_KEY"]);
  });

  it("times out a keyring that never answers", async () => {
    const hang: KeyringEntryStore = {
      get: () => new Promise(() => undefined),
      set: () => new Promise(() => undefined),
      delete: () => new Promise(() => undefined),
    };
    const b = new KeyringBackend({ store: hang, lockDir: lockDir(), timeoutMs: 50 });
    const err = await b.get("FAL_KEY").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as SecretStoreError).code).toBe("KEYRING_TIMEOUT");
  });

  it("rejects bad names and service names", async () => {
    const b = new KeyringBackend({ store: fakeKeyring(), lockDir: lockDir() });
    await expect(b.get("lower")).rejects.toThrow(SecretStoreError);
    expect(() => new KeyringBackend({ service: "bad service", store: fakeKeyring() })).toThrow(
      SecretStoreError,
    );
  });
});
