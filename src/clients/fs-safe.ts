// src/clients/fs-safe.ts
//
// File plumbing for client config writes: resolve the real target without
// leaving the user's home, read it, keep one backup, write atomically.
// Every open of the resolved target, its backup and the temp file refuses a
// symlink in the last component (O_NOFOLLOW, or the Windows equivalent), so a
// link swapped in after resolveTarget is never followed.

import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicReplaceSync, fchmodBestEffort, openSyncNoFollow } from "../lib/platform.js";
import { ClientConfigError } from "./errors.js";

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The real path a write to `path` would land on. Symlinks are followed only
 * while they stay inside the real `home`; anything else is refused.
 */
export function resolveTarget(path: string, home: string): string {
  const realHome = realpathSync(home);
  const abs = resolve(path);
  // Walk up to the nearest existing ancestor, then resolve it for real.
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    let present = false;
    try {
      lstatSync(existing);
      present = true;
    } catch {
      present = false;
    }
    if (present) break;
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    throw new ClientConfigError(`cannot resolve ${existing} (a broken symlink?)`);
  }
  const target = rest.length ? join(real, ...rest) : real;
  if (!inside(target, realHome)) {
    throw new ClientConfigError(
      `refusing to write ${path}: it resolves outside the home directory`,
    );
  }
  if (existsSync(target) && !statSync(target).isFile()) {
    throw new ClientConfigError(`refusing to write ${path}: it is not a regular file`);
  }
  return target;
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function linkRefused(err: unknown, target: string): unknown {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ELOOP" || code === "EMLINK") {
    return new ClientConfigError(`refusing to use ${target}: it is a symbolic link`);
  }
  return err;
}

/** Open the resolved target without following a symlink in its place. */
function openTarget(target: string, flags: number): number {
  try {
    return openSyncNoFollow(target, flags);
  } catch (err) {
    throw linkRefused(err, target);
  }
}

function readTarget(target: string): Buffer {
  const fd = openTarget(target, constants.O_RDONLY);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Narrow an existing file to 0600 (no-op when it already is). */
export function restrictMode(target: string): void {
  if (!existsSync(target)) return;
  const fd = openTarget(target, constants.O_RDONLY);
  try {
    if ((fstatSync(fd).mode & 0o077) !== 0) fchmodBestEffort(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

/** File contents, or null when it does not exist. */
export function readIfExists(target: string): string | null {
  try {
    return readTarget(target).toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const BACKUP_TAG = ".plughive-backup-";

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/**
 * One backup per file, made before the first change and never replaced:
 * `<file>.plughive-backup-<UTC timestamp>`. Returns its path when this call
 * made it. Backups are always 0600: client configs often hold other servers'
 * tokens, and a backup outlives the edit that made it.
 */
export function backupOnce(target: string, now = new Date()): string | undefined {
  if (!existsSync(target)) return undefined;
  const dir = dirname(target);
  const base = basename(target);
  if (readdirSync(dir).some((f) => f.startsWith(base + BACKUP_TAG))) return undefined;
  const out = join(dir, `${base}${BACKUP_TAG}${stamp(now)}`);
  const bytes = readTarget(target);
  // O_EXCL: never overwrite (or follow a planted link at) the backup path.
  const fd = openSync(
    out,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    fchmodBestEffort(fd, 0o600);
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(out, { force: true });
    throw err;
  }
  closeSync(fd);
  return out;
}

export interface WriteOptions {
  /** The text carries a secret (an access key): write 0600 whatever the file's mode was. */
  secret?: boolean;
}

/**
 * Write `text` to `target` through a temp file and a rename. Keeps the
 * existing mode (0600 for new files), except that a write carrying a secret
 * is always 0600.
 */
export function writeAtomic(target: string, text: string, opts: WriteOptions = {}): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = opts.secret ? 0o600 : existsSync(target) ? statSync(target).mode & 0o7777 : 0o600;
  const tmp = join(
    dir,
    `.${basename(target)}.plughive-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    mode,
  );
  try {
    fchmodBestEffort(fd, mode); // the umask may have narrowed it
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    atomicReplaceSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is best effort.
  }
}
