// The compile cache lives in a private per-user directory, never the shared /tmp.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileCacheDir, isPrivateDir } from "../../src/lib/compile-cache.js";

const tmp = mkdtempSync(join(tmpdir(), "mcp-ccache-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("compileCacheDir", () => {
  it("uses the user's cache directory on each OS, not os.tmpdir()", () => {
    expect(compileCacheDir({}, "darwin", "/Users/a")).toBe(
      "/Users/a/Library/Caches/plughive/node-compile-cache",
    );
    expect(compileCacheDir({}, "linux", "/home/a")).toBe(
      "/home/a/.cache/plughive/node-compile-cache",
    );
    expect(compileCacheDir({ XDG_CACHE_HOME: "/x/cache" }, "linux", "/home/a")).toBe(
      "/x/cache/plughive/node-compile-cache",
    );
    // A relative XDG_CACHE_HOME is invalid by the spec and ignored.
    expect(compileCacheDir({ XDG_CACHE_HOME: "rel" }, "linux", "/home/a")).toBe(
      "/home/a/.cache/plughive/node-compile-cache",
    );
    expect(
      compileCacheDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a"),
    ).toContain("plughive");
  });
});

describe.skipIf(process.platform === "win32")("isPrivateDir", () => {
  it("accepts a 0700 directory of this user", () => {
    const d = join(tmp, "private");
    mkdirSync(d, { mode: 0o700 });
    expect(isPrivateDir(d)).toBe(true);
  });

  it("rejects a directory others can write to, and a file", () => {
    const d = join(tmp, "shared");
    mkdirSync(d);
    chmodSync(d, 0o777);
    expect(isPrivateDir(d)).toBe(false);
    const g = join(tmp, "group");
    mkdirSync(g);
    chmodSync(g, 0o770);
    expect(isPrivateDir(g)).toBe(false);
    const f = join(tmp, "file");
    writeFileSync(f, "");
    expect(isPrivateDir(f)).toBe(false);
  });

  it("rejects a private directory inside a folder others can write to", () => {
    const open = join(tmp, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const d = join(open, "private");
    mkdirSync(d, { mode: 0o700 });
    expect(isPrivateDir(d)).toBe(false);
    // A sticky shared folder (like /tmp) is fine: others cannot rename our entry.
    chmodSync(open, 0o1777);
    expect(isPrivateDir(d)).toBe(true);
  });

  it("judges where a symlink points, not the link", () => {
    const open = join(tmp, "open2");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const target = join(open, "private");
    mkdirSync(target, { mode: 0o700 });
    const link = join(tmp, "link");
    symlinkSync(target, link);
    expect(isPrivateDir(link)).toBe(false);
  });
});
