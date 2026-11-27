// src/lib/logger.ts
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { atomicReplaceSync, fchmodBestEffort, openSyncNoFollow } from "./platform.js";

export type Logger = ReturnType<typeof pino>;

/** The log file is rotated when it is larger than this (10 MB). */
export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
/** Rotated files kept beside the live one: server.jsonl.1 (newest) to .3. */
export const LOG_KEEP_FILES = 3;
const ROTATE_CHECK_MS = 60_000;

export interface LoggerOptions {
  /** Rotate past this size; default 10 MB. */
  maxBytes?: number;
  /** How often the size is checked while running; default one minute. */
  checkEveryMs?: number;
}

/**
 * Rotate `file` when it is larger than `maxBytes`: file -> file.1 -> file.2 ->
 * file.3, the oldest is removed. Returns true when it rotated. Rotated files
 * keep the owner-only mode. Only a regular file is rotated (a symlink in its
 * place is left alone), and renames retry on Windows while another process
 * (an antivirus scanner) holds a file open.
 */
export function rotateLogFile(file: string, maxBytes: number): boolean {
  let size: number;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  // Shift the older files first and drop the oldest only when its slot is
  // needed, so a rename that fails part-way loses nothing.
  for (let n = LOG_KEEP_FILES - 1; n >= 1; n--) {
    if (existsSync(`${file}.${n}`)) {
      rmSync(`${file}.${n + 1}`, { force: true });
      atomicReplaceSync(`${file}.${n}`, `${file}.${n + 1}`);
    }
  }
  rmSync(`${file}.1`, { force: true });
  atomicReplaceSync(file, `${file}.1`);
  return true;
}

/** chmod `path`, but never through a symbolic link. */
function ownerOnly(path: string, mode: number): void {
  try {
    if (lstatSync(path).isSymbolicLink()) return;
    chmodSync(path, mode);
  } catch {
    // Not ours to change (a mounted volume, for example): keep logging.
  }
}

/**
 * Create the live log file owner-only, or tighten the one already there,
 * before the logger opens it by name. A symlink or anything but a regular
 * file in its place is refused: the log would be written wherever it points.
 */
function prepareLogFile(path: string): void {
  let fd: number;
  try {
    fd = openSyncNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`refusing to write the log to ${path}: it is a symbolic link`);
    }
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`refusing to write the log to ${path}: it is not a regular file`);
    }
    try {
      fchmodBestEffort(fd, 0o600);
    } catch {
      // Not ours to change (a mounted volume, for example): keep logging.
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Multi-stream logger:
 *   - file (JSON, sync): `~/.plughive/logs/server.jsonl` for replay / grep.
 *     The folder is 0700 and the files 0600 (the log holds tool names and
 *     masked arguments), also when they already existed with looser modes.
 *     The file is rotated by size, at start and while running.
 *   - stdout: pretty when PLUGHIVE_LOG_PRETTY=1 (default when stdout is a TTY)
 *     so you can watch the server work in the `pnpm dev` terminal. Set the env
 *     var to "0" to force raw JSON to stdout (e.g. when piping to a collector).
 *
 * Level via PLUGHIVE_LOG_LEVEL (default "info"). Use "debug" for verbose,
 * "warn" to silence per-call traces.
 */
export function createLogger(root: string, opts: LoggerOptions = {}): Logger {
  const logDir = join(root, "logs");
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  ownerOnly(logDir, 0o700);
  const filePath = join(logDir, "server.jsonl");
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  for (let n = 1; n <= LOG_KEEP_FILES; n++) {
    if (existsSync(`${filePath}.${n}`)) ownerOnly(`${filePath}.${n}`, 0o600);
  }
  try {
    rotateLogFile(filePath, maxBytes);
  } catch {
    // Rotation is housekeeping: a failure must not stop the daemon.
  }

  const level = process.env.PLUGHIVE_LOG_LEVEL ?? "info";

  const pretty =
    process.env.PLUGHIVE_LOG_PRETTY === "1" ||
    (process.env.PLUGHIVE_LOG_PRETTY !== "0" && process.stdout.isTTY);

  const stdoutStream = pretty
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,app",
          singleLine: false,
        },
      })
    : process.stdout;

  prepareLogFile(filePath);
  const fileStream = pino.destination({ dest: filePath, sync: true, mode: 0o600 });

  const timer = setInterval(() => {
    try {
      if (rotateLogFile(filePath, maxBytes)) {
        prepareLogFile(filePath);
        fileStream.reopen();
      }
    } catch {
      // Try again at the next check.
    }
  }, opts.checkEveryMs ?? ROTATE_CHECK_MS);
  timer.unref();

  return pino(
    { base: { app: "plughive" }, level },
    pino.multistream([
      { stream: stdoutStream, level },
      { stream: fileStream, level },
    ]),
  );
}
