import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_TOKEN_FILE,
  AdminTokenError,
  MIN_ADMIN_TOKEN_LENGTH,
  dashboardUrl,
  loadOrCreateAdminToken,
} from "../../src/lib/admin-token.js";
import { expectMode, itSymlink } from "../support/platform.js";

describe("admin token", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-admin-token-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("generates 32 random bytes on first use, in a 0600 file in a 0700 directory", () => {
    const home = join(dir, "home");
    const first = loadOrCreateAdminToken(home, {});
    expect(first).toMatchObject({
      source: "file",
      created: true,
      path: join(home, ADMIN_TOKEN_FILE),
    });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expectMode(join(home, ADMIN_TOKEN_FILE), 0o600);
    expectMode(home, 0o700);
    expect(readFileSync(join(home, ADMIN_TOKEN_FILE), "utf8")).toBe(`${first.token}\n`);
    // No temporary file is left behind.
    expect(readdirSync(home)).toEqual([ADMIN_TOKEN_FILE]);
  });

  it("returns the same token on the next start and never rewrites the file", () => {
    const first = loadOrCreateAdminToken(dir, {});
    const second = loadOrCreateAdminToken(dir, {});
    expect(second).toMatchObject({ token: first.token, source: "file", created: false });
    expect(loadOrCreateAdminToken(join(dir, "other"), {}).token).not.toBe(first.token);
  });

  it("tightens a token file and a home that are readable by others", () => {
    writeFileSync(join(dir, ADMIN_TOKEN_FILE), `${"k".repeat(40)}\n`, { mode: 0o644 });
    const loaded = loadOrCreateAdminToken(dir, {});
    expect(loaded.token).toBe("k".repeat(40));
    expectMode(join(dir, ADMIN_TOKEN_FILE), 0o600);
    if (process.platform !== "win32") expect(statSync(dir).mode & 0o077).toBe(0);
  });

  itSymlink("refuses a symbolic link, a short token and a file that is not a token", () => {
    const target = join(dir, "elsewhere");
    writeFileSync(target, `${"k".repeat(40)}\n`);
    const linked = join(dir, "linked");
    loadOrCreateAdminToken(linked, {});
    rmSync(join(linked, ADMIN_TOKEN_FILE));
    symlinkSync(target, join(linked, ADMIN_TOKEN_FILE));
    expect(() => loadOrCreateAdminToken(linked, {})).toThrow(AdminTokenError);

    const short = join(dir, "short");
    loadOrCreateAdminToken(short, {});
    writeFileSync(join(short, ADMIN_TOKEN_FILE), "short\n");
    expect(() => loadOrCreateAdminToken(short, {})).toThrow(/valid token/);

    const junk = join(dir, "junk");
    loadOrCreateAdminToken(junk, {});
    writeFileSync(join(junk, ADMIN_TOKEN_FILE), "x".repeat(5000));
    expect(() => loadOrCreateAdminToken(junk, {})).toThrow(AdminTokenError);
  });

  it("PLUGHIVE_ADMIN_TOKEN overrides the file and writes nothing", () => {
    const home = join(dir, "env-home");
    const given = "docker-admin-token-0123456789";
    const loaded = loadOrCreateAdminToken(home, { PLUGHIVE_ADMIN_TOKEN: `  ${given}  ` });
    expect(loaded).toEqual({ token: given, source: "env", path: null, created: false });
    expect(() => statSync(home)).toThrow();
  });

  it("PLUGHIVE_ADMIN_TOKEN must be at least 24 printable characters; the error never repeats it", () => {
    const short = "a".repeat(MIN_ADMIN_TOKEN_LENGTH - 1);
    for (const bad of [short, `${"a".repeat(30)} with space`, "a".repeat(600)]) {
      let message = "";
      try {
        loadOrCreateAdminToken(dir, { PLUGHIVE_ADMIN_TOKEN: bad });
      } catch (e) {
        expect(e).toBeInstanceOf(AdminTokenError);
        message = (e as Error).message;
      }
      expect(message).toContain("PLUGHIVE_ADMIN_TOKEN");
      expect(message).not.toContain(bad.trim());
    }
    expect(
      loadOrCreateAdminToken(dir, { PLUGHIVE_ADMIN_TOKEN: "a".repeat(MIN_ADMIN_TOKEN_LENGTH) })
        .source,
    ).toBe("env");
    // Blank counts as unset.
    expect(loadOrCreateAdminToken(dir, { PLUGHIVE_ADMIN_TOKEN: "   " }).source).toBe("file");
  });

  it("dashboardUrl puts the token in the fragment", () => {
    expect(dashboardUrl("http://127.0.0.1:7777", "abc_DEF-123")).toBe(
      "http://127.0.0.1:7777/#token=abc_DEF-123",
    );
    expect(dashboardUrl("https://store.example.test/", "a+b/c=")).toBe(
      "https://store.example.test/#token=a%2Bb%2Fc%3D",
    );
    const url = new URL(dashboardUrl("http://127.0.0.1:7777", "tok"));
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/");
    expect(url.hash).toBe("#token=tok");
  });
});
