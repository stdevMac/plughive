// src/lib/admin-token.ts
//
// The admin token: the credential of the management API (/api).
//
// It is a different credential from the access key. The access key
// (PLUGHIVE_ACCESS_KEY) is what agents present on /mcp, /p/<id>/mcp and
// /artifacts; the admin token is what the dashboard, the CLI and the Mac app
// present on /api. An agent holding the access key cannot administer the
// daemon, and the admin token does not open /mcp when an access key is set.
//
//   - 32 random bytes (base64url), generated on first start
//   - stored in $PLUGHIVE_HOME/admin-token: mode 0600, created atomically
//     (never a partially written file), in a directory kept at 0700
//   - PLUGHIVE_ADMIN_TOKEN overrides the file (containers); at least
//     MIN_ADMIN_TOKEN_LENGTH characters
//
// Never write the token through the logger. Callers register it with the
// redactor so it cannot leave through a tool result or an error either.
import { randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const ADMIN_TOKEN_FILE = "admin-token";
export const ADMIN_TOKEN_ENV = "PLUGHIVE_ADMIN_TOKEN";
export const MIN_ADMIN_TOKEN_LENGTH = 24;
const MAX_ADMIN_TOKEN_LENGTH = 512;
/** Printable, no whitespace: the value travels in a header and in a URL fragment. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export interface AdminToken {
  token: string;
  /** Where the token came from. */
  source: "env" | "file";
  /** The token file. Null when the environment provides the token. */
  path: string | null;
  /** True when this call generated the token. */
  created: boolean;
}

export class AdminTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminTokenError";
  }
}

function assertUsable(token: string, where: string): string {
  if (token.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new AdminTokenError(`${where} must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
  }
  if (token.length > MAX_ADMIN_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
    throw new AdminTokenError(`${where} must be printable characters without spaces`);
  }
  return token;
}

/** Read the token file without following a symlink; tighten its mode to 0600. */
function readTokenFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new AdminTokenError(`${path} is a symbolic link; remove it and start again`);
    }
    throw new AdminTokenError(`${path} could not be read (${code ?? "error"})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ADMIN_TOKEN_LENGTH + 2) {
      throw new AdminTokenError(`${path} is not a token file; remove it and start again`);
    }
    if ((stat.mode & 0o077) !== 0) {
      try {
        chmodSync(path, 0o600);
      } catch {
        // A read-only mount: the file is used as it is.
      }
    }
    const buf = Buffer.alloc(MAX_ADMIN_TOKEN_LENGTH + 2);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8").trim();
    try {
      return assertUsable(text, path);
    } catch {
      throw new AdminTokenError(`${path} does not hold a valid token; remove it and start again`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The admin token of this install: PLUGHIVE_ADMIN_TOKEN when set, else the
 * content of $home/admin-token, generated on first use. Two daemons racing on
 * the same home end up with the same token: the file is linked into place
 * only when no file is there yet, and the loser reads the winner's.
 */
export function loadOrCreateAdminToken(
  home: string,
  env: Record<string, string | undefined> = process.env,
): AdminToken {
  const given = env[ADMIN_TOKEN_ENV]?.trim();
  if (given) {
    return {
      token: assertUsable(given, ADMIN_TOKEN_ENV),
      source: "env",
      path: null,
      created: false,
    };
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(home).mode & 0o077) !== 0) chmodSync(home, 0o700);
  } catch {
    // Not ours to change (a mounted volume): the file mode still protects the token.
  }
  const path = join(home, ADMIN_TOKEN_FILE);
  const existing = readTokenFile(path);
  if (existing) return { token: existing, source: "file", path, created: false };

  const token = randomBytes(32).toString("base64url");
  const tmp = join(home, `.${ADMIN_TOKEN_FILE}.${process.pid}.${randomBytes(6).toString("hex")}`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    // link() fails when the name exists: a complete file appears, or none.
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      unlinkSync(tmp);
      throw new AdminTokenError(
        `${path} could not be created (${(e as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
    unlinkSync(tmp);
    const winner = readTokenFile(path);
    if (!winner) throw new AdminTokenError(`${path} could not be read`);
    return { token: winner, source: "file", path, created: false };
  }
  unlinkSync(tmp);
  return { token, source: "file", path, created: true };
}

/**
 * The link that signs a browser in to the dashboard. The token is in the
 * fragment, which a browser never sends: it reaches neither the server log
 * nor a Referer header. The dashboard reads it and calls POST /api/session.
 */
export function dashboardUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/#token=${encodeURIComponent(token)}`;
}
