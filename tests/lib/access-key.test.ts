// tests/lib/access-key.test.ts
import { describe, expect, it } from "vitest";
import {
  assertEncryptedSecretsOnNetwork,
  assertNoMultiKeyConfig,
  assertSafeBind,
  extractAuthToken,
  isLoopbackHost,
  verifyAccessKey,
} from "../../src/lib/access-key.js";

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST"])(
    "treats %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    "0.0.0.0",
    "::",
    "192.168.1.5",
    "10.0.0.1",
    "example.com",
    "127.0.0.1.evil.com",
    "128.0.0.1",
  ])("treats %s as non-loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("verifyAccessKey", () => {
  it("accepts a matching key", () => {
    expect(verifyAccessKey("secret", "secret")).toBe(true);
  });
  it("rejects a mismatch", () => {
    expect(verifyAccessKey("secret", "Secret")).toBe(false);
  });
  it("rejects keys of different lengths without throwing", () => {
    expect(verifyAccessKey("secret", "secret-but-longer")).toBe(false);
    expect(verifyAccessKey("secret", "")).toBe(false);
  });
  it("rejects null", () => {
    expect(verifyAccessKey("secret", null)).toBe(false);
  });
});

describe("assertSafeBind", () => {
  it("throws for a non-loopback host without a key", () => {
    expect(() => assertSafeBind("0.0.0.0", null)).toThrow(
      /Refusing to bind to 0\.0\.0\.0 without PLUGHIVE_ACCESS_KEY/,
    );
  });
  it("passes for a non-loopback host with a key", () => {
    expect(() => assertSafeBind("0.0.0.0", "a-long-enough-access-key")).not.toThrow();
  });
  it("rejects a short key and unspecified addresses on a network bind", () => {
    expect(() => assertSafeBind("0.0.0.0", "short")).toThrow(/at least 16/);
    for (const host of ["", "0", "::", " 0.0.0.0 ", "::ffff:127.0.0.1"]) {
      expect(() => assertSafeBind(host, null)).toThrow(/Refusing to bind/);
    }
  });
  it("passes for loopback hosts without a key", () => {
    expect(() => assertSafeBind("127.0.0.1", null)).not.toThrow();
    expect(() => assertSafeBind("localhost", null)).not.toThrow();
  });
});

describe("extractAuthToken", () => {
  const req = (headers: Record<string, string>) => ({
    header: (name: string) => headers[name.toLowerCase()],
  });
  it("reads a Bearer token", () => {
    expect(extractAuthToken(req({ authorization: "Bearer abc" }))).toBe("abc");
  });
  it.each(["bearer abc", "BEARER abc", "BeArEr   abc", "  Bearer abc"])(
    "L6: the scheme is case-insensitive (%s)",
    (value) => {
      expect(extractAuthToken(req({ authorization: value }))).toBe("abc");
    },
  );
  it.each(["Basic abc", "Bearer", "Bearer ", "bearerabc", "abc"])(
    "L6: %s is not a bearer token",
    (value) => {
      expect(extractAuthToken(req({ authorization: value }))).toBeNull();
    },
  );
  it("reads X-API-Key", () => {
    expect(extractAuthToken(req({ "x-api-key": "abc" }))).toBe("abc");
  });
  it("returns null when absent", () => {
    expect(extractAuthToken(req({}))).toBeNull();
  });
});

describe("assertNoMultiKeyConfig", () => {
  it("passes when only the single access key is configured", () => {
    expect(() => assertNoMultiKeyConfig({ PLUGHIVE_ACCESS_KEY: "x" })).not.toThrow();
  });
  it("fails loudly on the removed multi-key settings", () => {
    expect(() => assertNoMultiKeyConfig({ PLUGHIVE_API_KEYS: "a,b" })).toThrow(
      /no longer supported/,
    );
  });
});

describe("assertEncryptedSecretsOnNetwork", () => {
  it("refuses a plain secrets file on a non-loopback bind", () => {
    expect(() => assertEncryptedSecretsOnNetwork("0.0.0.0", { PLUGHIVE_SECRETS: "file" })).toThrow(
      /PLUGHIVE_SECRETS_PASSPHRASE/,
    );
  });
  it("accepts a passphrase, an explicit opt-in, loopback, or another backend", () => {
    expect(() =>
      assertEncryptedSecretsOnNetwork("0.0.0.0", {
        PLUGHIVE_SECRETS: "file",
        PLUGHIVE_SECRETS_PASSPHRASE: "p",
      }),
    ).not.toThrow();
    expect(() =>
      assertEncryptedSecretsOnNetwork("0.0.0.0", {
        PLUGHIVE_SECRETS: "file",
        PLUGHIVE_ALLOW_PLAIN_SECRETS: "1",
      }),
    ).not.toThrow();
    expect(() =>
      assertEncryptedSecretsOnNetwork("127.0.0.1", { PLUGHIVE_SECRETS: "file" }),
    ).not.toThrow();
    expect(() => assertEncryptedSecretsOnNetwork("0.0.0.0", {})).not.toThrow();
  });
  it("judges the resolved backend, not only PLUGHIVE_SECRETS", () => {
    // No keychain on a headless box: the store fell back to a plain file.
    expect(() => assertEncryptedSecretsOnNetwork("0.0.0.0", {}, "file-plain")).toThrow(
      /plain file/,
    );
    expect(() =>
      assertEncryptedSecretsOnNetwork(
        "0.0.0.0",
        { PLUGHIVE_ALLOW_PLAIN_SECRETS: "1" },
        "file-plain",
      ),
    ).not.toThrow();
    expect(() =>
      assertEncryptedSecretsOnNetwork("0.0.0.0", { PLUGHIVE_SECRETS: "file" }, "file-encrypted"),
    ).not.toThrow();
    expect(() => assertEncryptedSecretsOnNetwork("0.0.0.0", {}, "keychain")).not.toThrow();
    expect(() => assertEncryptedSecretsOnNetwork("127.0.0.1", {}, "file-plain")).not.toThrow();
  });
});
