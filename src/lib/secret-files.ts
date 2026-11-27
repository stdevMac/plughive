// src/lib/secret-files.ts
//
// <NAME>_FILE for the daemon's own credentials: the value is read from a file
// (Docker and Compose secrets mount them under /run/secrets) instead of being
// passed in the container's environment, where `docker inspect` shows it. The variable itself wins when both are set. The file is read
// once at startup and must be a regular file of at most 4 KiB (symlinks are
// allowed: Kubernetes projects secrets through them).
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The credentials that accept a _FILE variant. */
export const SECRET_FILE_VARS = [
  "PLUGHIVE_ACCESS_KEY",
  "PLUGHIVE_ADMIN_TOKEN",
  "PLUGHIVE_SECRETS_PASSPHRASE",
] as const;

const MAX_BYTES = 4096;

function readSecretFile(name: string, path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    throw new Error(`${name}_FILE: cannot open ${path} (${code})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${name}_FILE: ${path} is not a regular file`);
    if (st.size > MAX_BYTES) throw new Error(`${name}_FILE: ${path} is over ${MAX_BYTES} bytes`);
    // Read at most one byte past the cap: a file that reports size 0 (a
    // /proc-style pseudo-file) can still stream far more than it declares.
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let got = 0;
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
      if (got > MAX_BYTES) throw new Error(`${name}_FILE: ${path} is over ${MAX_BYTES} bytes`);
    }
    // A trailing newline (echo, most editors) is not part of the secret.
    const value = buf.toString("utf8", 0, got).replace(/\r?\n$/, "");
    if (value.trim() === "") throw new Error(`${name}_FILE: ${path} is empty`);
    return value;
  } finally {
    closeSync(fd);
  }
}

/**
 * Fills each credential from its _FILE variant when the variable itself is
 * unset or empty, then removes the _FILE variable so no child sees the path.
 * Throws a message for the user when a named file cannot be used: a missing
 * secret must stop the start, not silently fall back to no key.
 */
export function applySecretFiles(env: NodeJS.ProcessEnv): void {
  for (const name of SECRET_FILE_VARS) {
    const fileVar = `${name}_FILE`;
    const path = env[fileVar]?.trim();
    if (!path) continue;
    if (!env[name]?.trim()) env[name] = readSecretFile(name, path);
    delete env[fileVar];
  }
}
