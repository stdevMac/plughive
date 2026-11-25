// src/core/installer/lockfile.ts
//
// tools/lock.json: what the installer put under tools/, with the sha256 of
// every program a shim in tools/bin points at. The spawn layer re-hashes the
// program against this file before each run from tools/bin, so a program that
// was swapped or edited after install is refused.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../lib/platform.js";

const LockedBin = z
  .object({
    /** The program, relative to the tools folder (forward slashes). */
    target: z.string().min(1).max(400),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const LockedItem = z
  .object({
    version: z.string().max(40),
    method: z.enum(["archive", "uv", "model"]),
    installed_at: z.string().max(40),
    /** sha256 of the downloaded file (archive installs). */
    source_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    bins: z.record(z.string().max(64), LockedBin),
    /** A model file: its path relative to the plughive home (forward slashes). */
    file: z.string().min(1).max(400).optional(),
  })
  .strict();
export type LockedItem = z.output<typeof LockedItem>;

const LockFile = z
  .object({ version: z.literal(1), items: z.record(z.string(), LockedItem) })
  .strict();
export type LockFile = z.output<typeof LockFile>;

export const LOCK_NAME = "lock.json";

export function emptyLock(): LockFile {
  return { version: 1, items: {} };
}

/** The lock file, or an empty one when it is missing. A corrupt file counts as empty (nothing trusted). */
export function readLock(toolsRoot: string): LockFile {
  const file = join(toolsRoot, LOCK_NAME);
  if (!existsSync(file)) return emptyLock();
  try {
    return LockFile.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return emptyLock();
  }
}

export function writeLock(toolsRoot: string, lock: LockFile): void {
  const file = join(toolsRoot, LOCK_NAME);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomicSync(file, `${JSON.stringify(LockFile.parse(lock), null, 2)}\n`);
}

/**
 * Read-modify-write under a process-local mutex: two installs running in this
 * daemon cannot read the same lock, each add its own item and let the second
 * write lose the first's entry. (Across processes the exclusive temp file +
 * rename above is what keeps a write whole.)
 */
const updateQueues = new Map<string, Promise<unknown>>();

export async function updateLock(
  toolsRoot: string,
  change: (lock: LockFile) => void | Promise<void>,
): Promise<LockFile> {
  const key = join(toolsRoot, LOCK_NAME);
  const prev = updateQueues.get(key) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      const lock = readLock(toolsRoot);
      await change(lock);
      writeLock(toolsRoot, lock);
      return lock;
    });
  updateQueues.set(key, run);
  try {
    return await run;
  } finally {
    if (updateQueues.get(key) === run) updateQueues.delete(key);
  }
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
