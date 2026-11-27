// src/lib/platform.ts
//
// The one place that knows how Windows, macOS and Linux differ for the daemon:
// PATH syntax, executable lookup, the environment a child process needs to
// start at all, the URL opener, and file replacement that survives Windows'
// "file in use" errors. Everything takes `platform` as a parameter (default:
// this process) so tests on one OS can cover the others.
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";

export type Platform = NodeJS.Platform;

export const isWindows = (platform: Platform = process.platform): boolean => platform === "win32";

/** The PATH list separator: ";" on Windows, ":" elsewhere. */
export function pathDelimiter(platform: Platform = process.platform): string {
  return isWindows(platform) ? ";" : ":";
}

/** Split a PATH value into its entries (empty entries dropped). */
export function splitPath(raw: string, platform: Platform = process.platform): string[] {
  return raw.split(pathDelimiter(platform)).filter((d) => d.length > 0);
}

export function joinPath(dirs: readonly string[], platform: Platform = process.platform): string {
  return dirs.join(pathDelimiter(platform));
}

/** A conservative system PATH used when the daemon has none. */
export function defaultSystemPath(
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (isWindows(platform)) {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    return [`${root}\\System32`, root, `${root}\\System32\\Wbem`].join(";");
  }
  return "/usr/bin:/bin";
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * File names to try for a bare program name. On Windows that is the name with
 * each PATHEXT extension (and the bare name when it already has one); elsewhere
 * just the name.
 */
export function exeCandidates(
  name: string,
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isWindows(platform)) return [name];
  const parse = (raw: string): string[] =>
    raw
      .split(";")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^\.[a-z0-9]+$/.test(e));
  // An empty or unusable PATHEXT would leave nothing to try: use the default.
  let exts = parse(env.PATHEXT ?? "");
  if (exts.length === 0) exts = parse(DEFAULT_PATHEXT);
  const lower = name.toLowerCase();
  if (exts.some((e) => lower.endsWith(e))) return [name];
  return exts.map((e) => `${name}${e}`);
}

/**
 * Batch scripts cannot be started without a shell (Node refuses them since
 * CVE-2024-27980), and running them through cmd.exe re-parses arguments.
 * The spawn layer refuses them instead.
 */
export function isBatchScript(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file);
}

const WINDOWS_PASS_THROUGH = [
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SystemDrive",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;

/**
 * The variables a child needs just to start on this OS, copied from the
 * daemon's own environment. Windows programs (and Winsock, and OpenSSH) fail
 * without SystemRoot; nothing here is a secret.
 */
export function systemChildEnv(
  platform: Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!isWindows(platform)) return {};
  const out: Record<string, string> = {};
  for (const name of WINDOWS_PASS_THROUGH) {
    const v = env[name];
    if (typeof v === "string" && v.length > 0 && v.length < 1024) out[name] = v;
  }
  return out;
}

/**
 * Point every per-user folder variable of this OS at `home` and every temp
 * variable at `tmp`, so a spawned program that follows "~", %APPDATA% or an
 * XDG default lands there.
 */
export function homeEnv(
  home: string,
  tmp: string,
  platform: Platform = process.platform,
): Record<string, string> {
  if (isWindows(platform)) {
    return {
      HOME: home,
      USERPROFILE: home,
      APPDATA: win32.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: win32.join(home, "AppData", "Local"),
      TEMP: tmp,
      TMP: tmp,
      TMPDIR: tmp,
    };
  }
  return { HOME: home, TMPDIR: tmp };
}

/** Folders (relative to the private home) that `homeEnv` refers to. */
export function homeEnvDirs(platform: Platform = process.platform): string[] {
  if (isWindows(platform))
    return [win32.join("AppData", "Roaming"), win32.join("AppData", "Local")];
  return [];
}

/** The user's home folder, never taken from a possibly-stale $HOME on Windows. */
export function userHome(): string {
  return homedir();
}

/** Absolute on any OS: "/x", "C:\\x", "C:/x" or "\\\\server\\share". */
export function isAbsoluteAnyOs(p: string): boolean {
  return posix.isAbsolute(p) || win32.isAbsolute(p);
}

/** The command that opens a URL in the default browser, without a shell. */
export function browserCommand(
  url: string,
  platform: Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === "darwin") return { file: "open", args: [url] };
  // rundll32 hands the URL to the shell's protocol handler verbatim; cmd's
  // `start` would re-parse % and & in it.
  if (isWindows(platform)) return { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { file: "xdg-open", args: [url] };
}

const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * rename(tmp, target) that retries for a moment on Windows, where an
 * antivirus scanner or another reader holding the target open makes the
 * replace fail with EPERM/EBUSY.
 */
export function atomicReplaceSync(
  tmp: string,
  target: string,
  platform: Platform = process.platform,
): void {
  const attempts = isWindows(platform) ? 10 : 1;
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i + 1 >= attempts || !RETRYABLE_RENAME.has(code)) throw err;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) {
        /* brief synchronous back-off */
      }
    }
  }
}

function symlinkRefused(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ELOOP: the final component is a symbolic link, open '${path}'`), {
    code: "ELOOP",
    syscall: "open",
    path,
  });
}

/**
 * openSync that never opens a symlink in the final component. POSIX adds
 * O_NOFOLLOW (the open fails with ELOOP). Windows has no O_NOFOLLOW, so the
 * name is lstat-ed before the open and again after it, and must be the very
 * file the descriptor refers to and not a link; otherwise the descriptor is
 * closed and the same ELOOP error is thrown. O_TRUNC is held back until that
 * check has passed (and the file is a regular one), so a link swapped in
 * between the checks cannot get its target truncated.
 */
export function openSyncNoFollow(
  path: string,
  flags: number,
  mode?: number,
  platform: Platform = process.platform,
): number {
  if (!isWindows(platform)) return openSync(path, flags | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    if (lstatSync(path).isSymbolicLink()) throw symlinkRefused(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const trunc = constants.O_TRUNC ?? 0;
  const truncate = trunc !== 0 && (flags & trunc) !== 0;
  const fd = openSync(path, truncate ? flags & ~trunc : flags, mode);
  try {
    const named = lstatSync(path, { bigint: true });
    const opened = fstatSync(fd, { bigint: true });
    if (named.isSymbolicLink() || named.ino !== opened.ino || named.dev !== opened.dev) {
      throw symlinkRefused(path);
    }
    if (truncate) {
      if (!opened.isFile()) {
        throw Object.assign(new Error(`refusing to truncate '${path}': it is not a regular file`), {
          code: "EINVAL",
          syscall: "open",
          path,
        });
      }
      ftruncateSync(fd, 0);
    }
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return fd;
}

/**
 * fchmod that a Windows file system may refuse (EPERM, ENOSYS, ...): there the
 * mode is only a read-only bit anyway, so a refusal is ignored. On POSIX the
 * error is thrown.
 */
export function fchmodBestEffort(
  fd: number,
  mode: number,
  platform: Platform = process.platform,
): void {
  try {
    fchmodSync(fd, mode);
  } catch (err) {
    if (!isWindows(platform)) throw err;
  }
}

/**
 * Writes `text` to `target` through a fresh temp file next to it: a random
 * name created with O_EXCL (and O_NOFOLLOW where the OS has it), so nothing
 * planted at a predictable `<file>.tmp` path, a symlink included, is followed
 * or overwritten. Owner-only by default. The temp file is removed on failure.
 */
export function writeFileAtomicSync(target: string, text: string, mode = 0o600): void {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(tmp, flags, mode);
  try {
    try {
      fchmodBestEffort(fd, mode); // the umask may have narrowed it
      writeFileSync(fd, text); // loops until every byte is written
    } finally {
      closeSync(fd);
    }
    atomicReplaceSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export async function atomicReplace(
  tmp: string,
  target: string,
  platform: Platform = process.platform,
): Promise<void> {
  const attempts = isWindows(platform) ? 10 : 1;
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i + 1 >= attempts || !RETRYABLE_RENAME.has(code)) throw err;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}

/** OS label for messages and hints. */
export function osFamily(platform: Platform = process.platform): "macos" | "windows" | "linux" {
  if (platform === "darwin") return "macos";
  if (isWindows(platform)) return "windows";
  return "linux";
}
