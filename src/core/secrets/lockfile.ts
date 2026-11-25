// src/core/secrets/lockfile.ts
//
// Cross-process advisory lock built on an O_EXCL lock file.
//
// The lock file holds "<pid> <timestamp ms> <random>". A lock is stale when
// its owner process no longer exists (same machine) or when it is older than
// `staleMs`. Waiting is bounded: after `timeoutMs` acquisition fails with
// SECRET_LOCK_TIMEOUT.
//
// Stale-lock removal re-reads the lock right before unlinking it and only
// removes it when it is still the same file with the same content. POSIX has
// no atomic compare-and-unlink, so a tiny window remains in which two
// contenders recovering the same stale lock could both proceed; that needs a
// crashed owner plus two simultaneous writers within microseconds.
//
// Every read of the lock goes through an O_NOFOLLOW descriptor, so a symlink
// planted at the lock path is neither read through nor removed here.
import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { SecretStoreError } from "./errors.js";

export interface LockOptions {
  /** Give up waiting after this long. Default 10 s. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. Default 30 s. */
  staleMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockRead {
  content: string;
  ino: number;
  dev: number;
  mtimeMs: number;
}

/**
 * Read the lock file through an O_NOFOLLOW descriptor: a symlink or special
 * file at `path` reads as null, never as the file it points at.
 */
async function readLockNoFollow(path: string): Promise<LockRead | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return {
      content: await handle.readFile("utf8"),
      ino: info.ino,
      dev: info.dev,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

async function tryCreate(
  path: string,
): Promise<{ token: string; ino: number; dev: number } | null> {
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}\n`;
  try {
    const handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(token, "utf8");
      const info = await handle.stat();
      return { token, ino: info.ino, dev: info.dev };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw new SecretStoreError("Could not create the secrets lock file.", "SECRET_LOCK_FAILED");
  }
}

/** Remove the lock at `path` if it is stale. Returns true when it was removed. */
async function removeIfStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const info = await lstat(path);
    // Only a plain file is ever removed; a symlink at the lock path is left alone.
    if (!info.isFile()) return false;
  } catch (err) {
    // Vanished in the meantime: the caller simply retries.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  const first = await readLockNoFollow(path);
  if (!first) return false;
  const [pidText, stampText] = first.content.trim().split(" ");
  const pid = Number(pidText);
  const stamp = Number(stampText);
  const age = Date.now() - (Number.isFinite(stamp) && stamp > 0 ? stamp : first.mtimeMs);
  // A lock that is still being written (empty content) is not stale yet.
  const stale = age > staleMs || (first.content.trim() !== "" && !processAlive(pid));
  if (!stale) return false;
  try {
    // Still the same file (dev/ino) with the same content right before the unlink.
    const again = await readLockNoFollow(path);
    if (
      !again ||
      again.ino !== first.ino ||
      again.dev !== first.dev ||
      again.content !== first.content
    ) {
      return false;
    }
    await unlink(path);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Run `task` while holding the lock file at `path`. */
export async function withLockFile<T>(
  path: string,
  task: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  let delay = 5;
  let held: { token: string; ino: number; dev: number } | null;
  for (;;) {
    held = await tryCreate(path);
    if (held !== null) break;
    if (await removeIfStale(path, staleMs)) continue;
    if (Date.now() >= deadline) {
      throw new SecretStoreError(
        "Timed out waiting for another process to release the secrets lock.",
        "SECRET_LOCK_TIMEOUT",
      );
    }
    await sleep(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 100);
  }
  try {
    return await task();
  } finally {
    // Only remove the lock if it is still ours: same file, same content, read
    // without following a link.
    try {
      const cur = await readLockNoFollow(path);
      if (cur && cur.content === held.token && cur.ino === held.ino && cur.dev === held.dev) {
        await unlink(path);
      }
    } catch {
      // already gone
    }
  }
}
