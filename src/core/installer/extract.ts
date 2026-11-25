// src/core/installer/extract.ts
//
// Unpack a downloaded archive into an empty folder with the system `tar`
// (bsdtar on macOS and Windows reads zip too; on Linux a zip goes to `unzip`).
// The entry list is read first and the archive refused when any entry is
// absolute or climbs out with "..". After extraction the tree is walked and any
// symlink that points outside the folder, any special file, or any hard-linked
// file (a second name for the same inode) is refused, before the tree is used.
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadExeca } from "../../lib/lazy-execa.js";
import { isWindows, systemChildEnv } from "../../lib/platform.js";

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

const LIST_LIMIT = 16 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60_000;

function tarBinary(): string {
  if (isWindows()) {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    return join(root, "System32", "tar.exe");
  }
  return "/usr/bin/tar";
}

/** Reject an entry name that is absolute or leaves the folder. */
export function unsafeEntry(name: string): boolean {
  const n = name.replace(/\\/g, "/");
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return true;
  return n.split("/").some((s) => s === "..");
}

async function run(file: string, args: string[], cwd?: string): Promise<string> {
  const { execa } = await loadExeca();
  const r = await execa(file, args, {
    shell: false,
    reject: false,
    cwd,
    maxBuffer: LIST_LIMIT,
    timeout: TIMEOUT_MS,
    extendEnv: false,
    env: { ...systemChildEnv(), PATH: isWindows() ? "" : "/usr/bin:/bin", LC_ALL: "C" },
    stdin: "ignore",
  });
  if (r.exitCode !== 0) {
    throw new ExtractError(
      `${file.split(/[\\/]/).pop()} failed: ${String(r.stderr ?? "").slice(0, 300)}`,
    );
  }
  return String(r.stdout ?? "");
}

async function listEntries(archive: string, format: "tar.gz" | "zip"): Promise<string[]> {
  if (format === "zip" && process.platform === "linux") {
    // `unzip -Z1` prints one name per line.
    return (await run("/usr/bin/unzip", ["-Z1", archive])).split("\n").filter(Boolean);
  }
  return (await run(tarBinary(), ["-tf", archive])).split(/\r?\n/).filter(Boolean);
}

function checkTree(dest: string): void {
  // Walk the real path, so a link's target and the root it is checked against
  // agree when dest itself is reached through a symlink (/tmp, /var on macOS).
  const root = realpathSync.native(dest);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(p);
        const abs = resolve(dirname(p), target);
        const rel = relative(root, abs);
        if (isAbsolute(target) || rel.startsWith("..") || isAbsolute(rel)) {
          throw new ExtractError(`archive link ${relative(root, p)} points outside the folder`);
        }
      } else if (st.isDirectory()) {
        walk(p);
      } else if (!st.isFile()) {
        throw new ExtractError(`archive entry ${relative(root, p)} is not a regular file`);
      } else if (st.nlink > 1) {
        // A second name for the same file: one of them can lie outside the
        // folder (a tar hard-link entry), so the tree is refused.
        throw new ExtractError(`archive entry ${relative(root, p)} has more than one hard link`);
      }
    }
  };
  walk(root);
}

/** Extract `archive` into `dest` (an empty folder). Throws ExtractError. */
export async function extractArchive(
  archive: string,
  format: "tar.gz" | "zip",
  dest: string,
): Promise<void> {
  const entries = await listEntries(archive, format);
  if (entries.length === 0) throw new ExtractError("the archive is empty");
  const bad = entries.find(unsafeEntry);
  if (bad) throw new ExtractError(`archive entry ${bad.slice(0, 120)} leaves the install folder`);
  if (format === "zip" && process.platform === "linux") {
    await run("/usr/bin/unzip", ["-q", "-o", archive, "-d", dest]);
  } else {
    // -C into the folder; no -P (keeps tar's own refusal of absolute names and "..").
    await run(tarBinary(), ["-xf", archive, "-C", dest]);
  }
  checkTree(dest);
}

/** `p` is inside `root` (both absolute). */
export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
