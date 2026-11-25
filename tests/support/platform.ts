// tests/support/platform.ts
//
// Helpers for tests that must pass on macOS, Linux and Windows. Windows has no
// POSIX permission bits (stat reports 0o666/0o444 for files and 0o777 for
// folders), may refuse symlinks without Developer Mode, and cannot start a
// "#!" script, so tests use these instead of open-coding those checks.
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

export const IS_WINDOWS = process.platform === "win32";
export const IS_POSIX = !IS_WINDOWS;

/** `it` that runs only where POSIX permissions and "#!" scripts exist. */
export const itPosix = it.skipIf(IS_WINDOWS);
export const describePosix = describe.skipIf(IS_WINDOWS);

/** Permission bits of a path (POSIX only; meaningless on Windows). */
export const modeOf = (path: string): number => statSync(path).mode & 0o777;

/**
 * Assert a path's permission bits on POSIX. On Windows there are none to
 * check, so this only asserts the path exists.
 */
export function expectMode(path: string, mode: number, label?: string): void {
  if (IS_WINDOWS) {
    expect(() => statSync(path), label).not.toThrow();
    return;
  }
  expect(modeOf(path), label ?? path).toBe(mode);
}

let symlinkProbe: boolean | undefined;

/** Whether this process may create symlinks (Windows needs admin or Developer Mode). */
export function canSymlink(): boolean {
  if (symlinkProbe !== undefined) return symlinkProbe;
  const dir = mkdtempSync(join(tmpdir(), "plughive-symlink-probe-"));
  try {
    writeFileSync(join(dir, "t"), "");
    symlinkSync(join(dir, "t"), join(dir, "l"));
    symlinkProbe = true;
  } catch {
    symlinkProbe = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return symlinkProbe;
}

/** `it` that runs only where symlinks can be created. */
export const itSymlink = it.skipIf(!canSymlink());
export const describeSymlink = describe.skipIf(!canSymlink());

/** Join PATH entries with this OS's separator. */
export const joinPathList = (...dirs: string[]): string => dirs.filter(Boolean).join(delimiter);

/**
 * Write an executable named `name` into `dir` that runs `source` with this
 * Node. POSIX only: Windows cannot start a "#!" script, and the spawn layer
 * refuses .cmd shims, so callers guard with `itPosix`.
 */
export function fakeBinary(dir: string, name: string, source: string): string {
  if (IS_WINDOWS) throw new Error("fakeBinary is POSIX-only; guard the test with itPosix");
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

/** A shell-script executable (POSIX only), for tests that need /bin/sh. */
export function fakeShellBinary(dir: string, name: string, body: string): string {
  if (IS_WINDOWS) throw new Error("fakeShellBinary is POSIX-only; guard the test with itPosix");
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}
