// tests/lib/platform-nofollow-race.test.ts
//
// R4-H5: on Windows (no O_NOFOLLOW) openSyncNoFollow checks the name before
// and after the open. A symlink swapped in between those checks must not get
// its target truncated by O_TRUNC. node:fs is wrapped so the swap happens
// exactly inside that window; the Windows path is taken with platform "win32".
import * as realFs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hook: { onFirstLstat?: (path: string) => void } = {};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: ((path: string, opts?: unknown) => {
      const fn = hook.onFirstLstat;
      if (fn) {
        hook.onFirstLstat = undefined;
        fn(path);
        // What the first check saw: a plain file.
        return actual.statSync(process.execPath);
      }
      return (actual.lstatSync as (p: string, o?: unknown) => unknown)(path, opts);
    }) as typeof actual.lstatSync,
  };
});

const { openSyncNoFollow } = await import("../../src/lib/platform.js");

let dir: string;
afterEach(() => {
  hook.onFirstLstat = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("openSyncNoFollow on Windows (simulated)", () => {
  it("R4-H5: a link swapped in after the first check does not truncate its target", () => {
    dir = mkdtempSync(join(tmpdir(), "plughive-nofollow-"));
    const victim = join(dir, "victim");
    writeFileSync(victim, "keep me");
    const dest = join(dir, "dest");
    writeFileSync(dest, "old");
    hook.onFirstLstat = (path) => {
      realFs.rmSync(path);
      symlinkSync(victim, path);
    };
    const { O_WRONLY, O_CREAT, O_TRUNC } = realFs.constants;
    expect(() => openSyncNoFollow(dest, O_WRONLY | O_CREAT | O_TRUNC, 0o600, "win32")).toThrow(
      /ELOOP/,
    );
    expect(readFileSync(victim, "utf8")).toBe("keep me");
  });

  it("R4-H5: O_TRUNC still truncates a plain file once the checks pass", () => {
    dir = mkdtempSync(join(tmpdir(), "plughive-nofollow-"));
    const dest = join(dir, "dest");
    writeFileSync(dest, "old contents");
    const { O_WRONLY, O_CREAT, O_TRUNC } = realFs.constants;
    const fd = openSyncNoFollow(dest, O_WRONLY | O_CREAT | O_TRUNC, 0o600, "win32");
    realFs.writeSync(fd, "new");
    realFs.closeSync(fd);
    expect(readFileSync(dest, "utf8")).toBe("new");
  });
});
