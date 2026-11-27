import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
// tests/lib/config.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonOrigin, loadConfig, parseOrigin } from "../../src/lib/config.js";

describe("config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plughive-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the port and the home folder", () => {
    const cfg = loadConfig({ env: { PLUGHIVE_PORT: "7812", PLUGHIVE_ROOT: dir } });
    expect(cfg.port).toBe(7812);
    expect(cfg.root).toBe(dir);
    expect(loadConfig({ env: { PLUGHIVE_HOME: dir } }).root).toBe(dir);
    expect(loadConfig({ env: {} }).port).toBe(7777);
    expect(() => loadConfig({ env: { PLUGHIVE_PORT: "70000" } })).toThrow(/PLUGHIVE_PORT/);
  });

  it("expands ~\\ to the home folder on Windows", () => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const cfg = loadConfig({ env: { PLUGHIVE_ROOT: "~\\plughive-test" } });
      expect(cfg.root).toBe(resolve(homedir(), "plughive-test"));
    } finally {
      Object.defineProperty(process, "platform", saved);
    }
  });

  it("loads import roots and worker defaults", () => {
    const cfg = loadConfig({
      env: { PLUGHIVE_IMPORT_ROOTS: " ~/videos, /srv/media, , ~/photos " },
    });
    expect(cfg.importRoots).toEqual([
      join(process.env.HOME!, "videos"),
      resolve("/srv/media"),
      join(process.env.HOME!, "photos"),
    ]);
    expect(cfg.jobConcurrency).toBe(2);
    expect(cfg.bindHost).toBe("127.0.0.1");
    expect(cfg.accessKey).toBeNull();
  });

  it("loads the bind host and access key", () => {
    const cfg = loadConfig({
      env: { PLUGHIVE_BIND_HOST: "0.0.0.0", PLUGHIVE_ACCESS_KEY: "secret" },
    });
    expect(cfg.bindHost).toBe("0.0.0.0");
    expect(cfg.accessKey).toBe("secret");
  });

  it("accepts the older PLUGHIVE_API_KEY name, preferring PLUGHIVE_ACCESS_KEY", () => {
    expect(loadConfig({ env: { PLUGHIVE_API_KEY: "old" } }).accessKey).toBe("old");
    expect(
      loadConfig({ env: { PLUGHIVE_API_KEY: "old", PLUGHIVE_ACCESS_KEY: "new" } }).accessKey,
    ).toBe("new");
  });

  it("rejects an invalid PLUGHIVE_JOB_CONCURRENCY", () => {
    expect(() => loadConfig({ env: { PLUGHIVE_JOB_CONCURRENCY: "nope" } })).toThrow(
      /PLUGHIVE_JOB_CONCURRENCY/,
    );
  });

  it("holds no provider keys: those belong to the secret store", () => {
    const cfg = loadConfig({
      env: { OPENROUTER_API_KEY: "sk-or-not-config-000", FAL_KEY: "fal-not-config-000" },
    });
    expect(JSON.stringify(cfg)).not.toContain("not-config");
    expect(Object.keys(cfg).sort()).toEqual([
      "accessKey",
      "allowedOrigins",
      "bindHost",
      "codeMode",
      "hookRateLimit",
      "importRoots",
      "jobConcurrency",
      "jobMaxQueued",
      "port",
      "publicUrl",
      "root",
      "triggers",
    ]);
  });

  it("M6: PLUGHIVE_PUBLIC_URL and PLUGHIVE_ALLOWED_ORIGINS are validated origins", () => {
    const none = loadConfig({ env: { PLUGHIVE_ROOT: dir } });
    expect(none.publicUrl).toBeNull();
    expect(none.allowedOrigins).toEqual([]);
    const cfg = loadConfig({
      env: {
        PLUGHIVE_ROOT: dir,
        PLUGHIVE_PUBLIC_URL: " https://Store.Example.com/ ",
        PLUGHIVE_ALLOWED_ORIGINS: "https://a.example.com, http://localhost:3000 ,",
      },
    });
    expect(cfg.publicUrl).toBe("https://store.example.com");
    expect(cfg.allowedOrigins).toEqual(["https://a.example.com", "http://localhost:3000"]);
  });

  it.each([
    "shop.internal:7777",
    "ftp://store.example.com",
    "javascript:alert(1)",
    "https://user:hunter2secret@store.example.com",
    "https://store.example.com/path",
    "https://store.example.com/?token=hunter2secret",
    "https://store.example.com/#hunter2secret",
    "*",
  ])("M6: rejects %s as an origin without echoing it", (value) => {
    for (const name of ["PLUGHIVE_PUBLIC_URL", "PLUGHIVE_ALLOWED_ORIGINS"]) {
      let message = "";
      try {
        loadConfig({ env: { PLUGHIVE_ROOT: dir, [name]: value } });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain("hunter2secret");
      expect(message).not.toContain(value);
    }
    expect(() => parseOrigin("X", value)).toThrow();
  });

  it("M6: daemonOrigin comes from the public URL or the bind address", () => {
    expect(
      daemonOrigin({ publicUrl: "https://store.example.com", bindHost: "0.0.0.0", port: 7777 }),
    ).toBe("https://store.example.com");
    expect(daemonOrigin({ publicUrl: null, bindHost: "127.0.0.1", port: 7777 })).toBe(
      "http://127.0.0.1:7777",
    );
    expect(daemonOrigin({ publicUrl: null, bindHost: "0.0.0.0", port: 7777 })).toBe(
      "http://127.0.0.1:7777",
    );
    expect(daemonOrigin({ publicUrl: null, bindHost: "192.168.1.20", port: 7777 }, 8123)).toBe(
      "http://192.168.1.20:8123",
    );
    expect(daemonOrigin({ publicUrl: null, bindHost: "::1", port: 7777 })).toBe(
      "http://[::1]:7777",
    );
  });

  it("M3: the queue cap is configurable and validated", () => {
    expect(loadConfig({ env: { PLUGHIVE_ROOT: dir } }).jobMaxQueued).toBe(200);
    expect(
      loadConfig({ env: { PLUGHIVE_ROOT: dir, PLUGHIVE_MAX_QUEUED_JOBS: "5" } }).jobMaxQueued,
    ).toBe(5);
    expect(() =>
      loadConfig({ env: { PLUGHIVE_ROOT: dir, PLUGHIVE_MAX_QUEUED_JOBS: "0" } }),
    ).toThrow();
    expect(() =>
      loadConfig({ env: { PLUGHIVE_ROOT: dir, PLUGHIVE_MAX_QUEUED_JOBS: "many" } }),
    ).toThrow();
  });
});
