// src/core/fs/safe-path.ts
//
// Path traversal guards: keep pack/tool supplied paths inside a root, vet
// user-supplied import files, and sanitise file names.
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { type FileHandle, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type UnsafePathReason =
  | "invalid_path"
  | "nul_byte"
  | "parent_segment"
  | "outside_root"
  | "symlink_escape"
  | "root_missing"
  | "not_found"
  | "not_regular_file"
  | "too_large"
  | "extension_not_allowed"
  | "named_fork"
  | "hard_link"
  | "changed_during_check";

const REASON_TEXT: Record<UnsafePathReason, string> = {
  invalid_path: "the path is empty or not a string",
  nul_byte: "the path contains a NUL byte",
  parent_segment: 'the path contains a ".." segment',
  outside_root: "the path is outside the allowed directory",
  symlink_escape: "the path leaves the allowed directory through a symbolic link",
  root_missing: "the allowed directory does not exist",
  not_found: "the file does not exist or cannot be read",
  not_regular_file: "the path is not a regular file",
  too_large: "the file is larger than the allowed size",
  extension_not_allowed: "the file extension is not allowed",
  named_fork: 'the path contains a macOS "..namedfork" component',
  hard_link: "the file has more than one hard link",
  changed_during_check: "the file changed while it was being checked",
};

export class UnsafePathError extends Error {
  readonly reason: UnsafePathReason;
  constructor(reason: UnsafePathReason) {
    super(`Path rejected: ${REASON_TEXT[reason]}`);
    this.name = "UnsafePathError";
    this.reason = reason;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function assertPlainPathString(value: unknown): asserts value is string {
  if (typeof value !== "string" || value === "") throw new UnsafePathError("invalid_path");
  if (value.includes("\0")) throw new UnsafePathError("nul_byte");
}

/**
 * Resolve `userPath` to an absolute path that is guaranteed to be inside
 * `root`, or throw `UnsafePathError`.
 *
 * - `root` must exist; it is canonicalised with realpath.
 * - `userPath` may be relative (resolved against root) or absolute (accepted
 *   only when it already points inside root).
 * - Any ".." segment is rejected outright, as are NUL bytes.
 * - Symlinks: the deepest existing ancestor of the target is realpath-ed and
 *   must still be inside root, so a link inside root that points elsewhere
 *   (including a dangling one) cannot be used to read or create files outside.
 *
 * - macOS "..namedfork" components are rejected.
 *
 * The returned path is the canonical one (realpath of the deepest existing
 * ancestor, in its on-disk case, plus the checked suffix). The target itself
 * does not have to exist.
 *
 * The result is only valid at the moment of the check: a directory on the
 * path can be swapped for a symlink before the caller uses it. When the
 * caller is going to open the file, use `openInside` instead, which validates
 * the opened descriptor itself.
 */
export function resolveInside(root: string, userPath: string): string {
  assertPlainPathString(root);
  assertPlainPathString(userPath);
  const components = userPath.split(/[\\/]/);
  if (components.includes("..")) throw new UnsafePathError("parent_segment");
  // macOS exposes resource forks as "<file>/..namedfork/rsrc".
  if (components.some((c) => c.toLowerCase() === "..namedfork")) {
    throw new UnsafePathError("named_fork");
  }

  const rootAbs = resolve(root);
  let rootReal: string;
  try {
    rootReal = realpathSync.native(rootAbs);
  } catch {
    throw new UnsafePathError("root_missing");
  }

  // Lexical containment, against the root as given or its canonical form.
  const lexical = resolve(rootAbs, userPath);
  let suffix: string;
  if (isWithin(rootAbs, lexical)) suffix = relative(rootAbs, lexical);
  else if (isWithin(rootReal, lexical)) suffix = relative(rootReal, lexical);
  else throw new UnsafePathError("outside_root");
  const candidate = join(rootReal, suffix);

  // Walk up to the deepest path component that exists (lstat, so a dangling
  // symlink counts as existing), canonicalise it, and re-attach the rest.
  let existing = candidate;
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) throw new UnsafePathError("outside_root");
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  let existingReal: string;
  try {
    // .native returns the on-disk spelling (case) on case-insensitive volumes.
    existingReal = realpathSync.native(existing);
  } catch {
    // Dangling or looping symlink: its eventual target is not provably inside.
    throw new UnsafePathError("symlink_escape");
  }
  const finalPath = missing.length > 0 ? join(existingReal, ...missing) : existingReal;
  if (!isWithin(rootReal, finalPath)) throw new UnsafePathError("symlink_escape");
  return finalPath;
}

export interface ReadableUserFileOptions {
  /** Directories the file may live in (after symlink resolution). */
  allowedRoots: string[];
  /** Maximum file size in bytes. */
  maxBytes: number;
  /** Optional extension allow-list, case-insensitive, with or without the dot. */
  allowedExtensions?: string[];
  /**
   * Reject files with more than one hard link (a hard link inside a root can
   * name a file whose other name is outside it). Default false for
   * assertReadableUserFile, true for readFileCapped.
   */
  rejectHardLinks?: boolean;
}

export interface ReadableUserFile {
  /** Canonical path (symlinks resolved). Use this, not the input, to read. */
  path: string;
  size: number;
}

type Stats = import("node:fs").Stats;

function validateMaxBytes(value: unknown, fn: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fn}: maxBytes must be a non-negative number`);
  }
  return Math.floor(value);
}

/**
 * After opening: the path must still resolve, inside `roots`, to the very
 * file the descriptor refers to. Catches a file or directory swapped between
 * the checks and the open.
 */
async function assertSameFile(
  path: string,
  opened: Stats,
  isAllowed: (real: string) => boolean,
): Promise<void> {
  let again: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    again = await realpath(path);
    info = await stat(again);
  } catch {
    throw new UnsafePathError("changed_during_check");
  }
  if (!isAllowed(again)) throw new UnsafePathError("changed_during_check");
  if (info.dev !== opened.dev || info.ino !== opened.ino) {
    throw new UnsafePathError("changed_during_check");
  }
}

async function canonicalRoots(allowedRoots: unknown[]): Promise<string[]> {
  const roots: string[] = [];
  for (const root of allowedRoots) {
    if (typeof root !== "string" || root === "" || root.includes("\0")) continue;
    try {
      roots.push(await realpath(resolve(root)));
    } catch {
      // a configured root that does not exist allows nothing
    }
  }
  return roots;
}

/** Shared by assertReadableUserFile and readFileCapped. Caller closes the handle. */
async function openUserFile(
  path: string,
  options: ReadableUserFileOptions,
  fn: string,
  rejectHardLinksDefault: boolean,
): Promise<{ handle: FileHandle; real: string; info: Stats; maxBytes: number }> {
  assertPlainPathString(path);
  if (!isAbsolute(path)) throw new UnsafePathError("invalid_path");
  // macOS exposes resource forks as "<file>/..namedfork/rsrc".
  if (path.split(/[\\/]/).some((c) => c.toLowerCase() === "..namedfork")) {
    throw new UnsafePathError("named_fork");
  }
  if (!options || !Array.isArray(options.allowedRoots)) throw new UnsafePathError("outside_root");
  const maxBytes = validateMaxBytes(options.maxBytes, fn);
  const rejectHardLinks = options.rejectHardLinks ?? rejectHardLinksDefault;

  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new UnsafePathError("not_found");
  }

  const roots = await canonicalRoots(options.allowedRoots);
  const isAllowed = (candidate: string): boolean => roots.some((root) => isWithin(root, candidate));
  if (!isAllowed(real)) throw new UnsafePathError("outside_root");

  if (options.allowedExtensions !== undefined) {
    const allowed = new Set(
      options.allowedExtensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase()),
    );
    if (!allowed.has(extname(real).toLowerCase())) {
      throw new UnsafePathError("extension_not_allowed");
    }
  }

  // Type check BEFORE opening so we never open a device or block on a FIFO.
  let pre: Awaited<ReturnType<typeof stat>>;
  try {
    pre = await stat(real);
  } catch {
    throw new UnsafePathError("not_found");
  }
  if (!pre.isFile()) throw new UnsafePathError("not_regular_file");

  let handle: FileHandle;
  try {
    handle = await open(
      real,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    throw new UnsafePathError("not_found");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UnsafePathError("not_regular_file");
    if (rejectHardLinks && info.nlink > 1) throw new UnsafePathError("hard_link");
    await assertSameFile(real, info, isAllowed);
    if (info.size > maxBytes) throw new UnsafePathError("too_large");
    return { handle, real, info, maxBytes };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Vet a user-supplied path before an import tool reads it: must be an
 * absolute path to an existing REGULAR file (no directories, devices,
 * sockets or FIFOs) whose real location is inside one of `allowedRoots`,
 * no larger than `maxBytes`, optionally with an allowed extension.
 *
 * This returns a PATH, so the file can still be replaced, grown or moved
 * before the caller reads it. To read the content, prefer `readFileCapped`,
 * which performs the same checks and reads through the vetted descriptor.
 */
export async function assertReadableUserFile(
  path: string,
  options: ReadableUserFileOptions,
): Promise<ReadableUserFile> {
  const { handle, real, info } = await openUserFile(path, options, "assertReadableUserFile", false);
  await handle.close();
  return { path: real, size: info.size };
}

async function readCapped(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    // Read one byte past the cap so growth after the size check is detected.
    const want = Math.min(64 * 1024, maxBytes + 1 - total);
    const buffer = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buffer, 0, want, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new UnsafePathError("too_large");
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Read a user-supplied file with every check of `assertReadableUserFile`,
 * through the descriptor that was checked, with a hard byte cap enforced
 * while reading (a file that grows past `maxBytes` fails with "too_large").
 * Hard-linked files are rejected unless `rejectHardLinks: false`.
 *
 * Given a FileHandle (for example from `openInside`), it only enforces the
 * regular-file check and the cap; location was the opener's job.
 */
export async function readFileCapped(
  file: string | FileHandle,
  options: ReadableUserFileOptions | { maxBytes: number },
): Promise<Buffer> {
  if (typeof file === "string") {
    const { handle, maxBytes } = await openUserFile(
      file,
      options as ReadableUserFileOptions,
      "readFileCapped",
      true,
    );
    try {
      return await readCapped(handle, maxBytes);
    } finally {
      await handle.close();
    }
  }
  const maxBytes = validateMaxBytes(options?.maxBytes, "readFileCapped");
  const info = await file.stat();
  if (!info.isFile()) throw new UnsafePathError("not_regular_file");
  if (info.size > maxBytes) throw new UnsafePathError("too_large");
  return readCapped(file, maxBytes);
}

export interface OpenInsideOptions {
  /**
   * open(2) flags. Default O_RDONLY. O_NOFOLLOW and O_NONBLOCK are always
   * added; O_TRUNC is refused (truncate through the handle after the checks).
   */
  flags?: number;
  /** Mode for a file created with O_CREAT. Default 0o600. */
  mode?: number;
  /** Reject files with more than one hard link. Default true. */
  rejectHardLinks?: boolean;
}

/**
 * Open `userPath` inside `root` and return the descriptor, validated AFTER
 * opening: it must be a regular file and the path must still resolve, inside
 * root, to that same file (dev/ino). This closes the window between
 * `resolveInside` and the caller's own open, in which a directory on the path
 * could be swapped for a symlink to somewhere else.
 *
 * The caller owns the handle and must close it.
 */
export async function openInside(
  root: string,
  userPath: string,
  options: OpenInsideOptions = {},
): Promise<FileHandle> {
  const flags = options.flags ?? fsConstants.O_RDONLY;
  if (!Number.isInteger(flags)) throw new TypeError("openInside: flags must be an integer");
  if ((flags & fsConstants.O_TRUNC) !== 0) {
    throw new TypeError("openInside: O_TRUNC is not supported; truncate the returned handle");
  }
  const target = resolveInside(root, userPath);
  const rootReal = realpathSync.native(resolve(root));
  let handle: FileHandle;
  try {
    handle = await open(
      target,
      flags | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      options.mode ?? 0o600,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP: the final component is a symlink (O_NOFOLLOW).
    throw new UnsafePathError(code === "ELOOP" ? "symlink_escape" : "not_found");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UnsafePathError("not_regular_file");
    if ((options.rejectHardLinks ?? true) && info.nlink > 1) {
      throw new UnsafePathError("hard_link");
    }
    await assertSameFile(target, info, (real) => isWithin(rootReal, real));
    return handle;
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

export interface SafeFilenameOptions {
  /** Maximum length in UTF-8 bytes. Default 200, clamped to 16..255. */
  maxBytes?: number;
  /** Used when nothing usable is left. Default "file". */
  fallback?: string;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * Turn an arbitrary string into a single safe file name: no path separators,
 * no control or bidi-override characters, no leading dots (so never ".",
 * ".." or a hidden file), no leading "-" (prefixed with "_"), bounded length
 * (extension preserved), never empty. A non-finite maxBytes uses the default.
 */
export function safeFilename(name: string, options: SafeFilenameOptions = {}): string {
  const requested = options.maxBytes;
  const maxBytes =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(255, Math.max(16, Math.floor(requested)))
      : 200;
  let text = typeof name === "string" ? name : "";
  text = text.normalize("NFC");
  // Control characters, DEL, C1 controls, zero-width, bidi formatting
  // (including the Arabic letter mark U+061C) and the Mongolian vowel separator.
  text = text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    /[\u0000-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    "",
  );
  // Path separators and characters that are special on common filesystems.
  text = text.replace(/[\\/:*?"<>|]/g, "_");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (WINDOWS_RESERVED.test(text)) text = `_${text}`;
  // A leading "-" makes the name parse as an option on a command line.
  if (text.startsWith("-")) text = `_${text}`;

  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const dot = text.lastIndexOf(".");
    const ext = dot > 0 ? text.slice(dot) : "";
    if (ext !== "" && Buffer.byteLength(ext, "utf8") <= 16) {
      const stem = truncateUtf8(text.slice(0, dot), maxBytes - Buffer.byteLength(ext, "utf8"));
      text = `${stem.replace(/[.\s]+$/, "") || "file"}${ext}`;
    } else {
      text = truncateUtf8(text, maxBytes).replace(/[.\s]+$/, "");
    }
  }

  if (text === "" || text === "." || text === "..") {
    const fallback = options.fallback;
    return typeof fallback === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(fallback)
      ? fallback
      : "file";
  }
  return text;
}
