// src/core/mounts/user-mounts.ts
//
// The user's own upstream MCP servers: `$PLUGHIVE_HOME/mounts.json`.
//
//   {
//     "version": 1,
//     "mounts": [
//       { "id": "github", "prefix": "gh", "transport": "http",
//         "url": "https://api.githubcopilot.com/mcp/",
//         "headers": { "Authorization": "Bearer ${secret:GITHUB_TOKEN}" } },
//       { "id": "files", "prefix": "fs", "transport": "stdio",
//         "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
//         "env": { "API_KEY": "${secret:FILES_API_KEY}" } }
//     ]
//   }
//
// The file is the only place a stdio mount can come from: a stdio mount
// starts a process with the user's rights, so no pack manifest can create one.
// It is written by the user (an editor), through the /api/mounts routes, or by
// the add_mount tool once a person has approved that exact mount in the
// approvals queue (src/core/tools/builtin/mounts.ts); a tool call alone never
// writes it. Those routes need the admin token
// in every configuration (src/core/http/admin-auth.ts): whoever can add a
// stdio mount can run a program as the user, so "a local caller" is not enough
// and the agents' access key does not qualify either.
//
// Credentials are never written here. `${secret:NAME}` in a url, header value,
// argument or env value is filled in from the secret store when the mount is
// connected; a mount with a missing secret is listed but not connected.
// A secret never goes over plain http:// to another machine: /api/mounts
// refuses such a mount, and one written into the file by hand is listed but
// not connected (plainHttpSecretProblem).
// The file is validated as a whole: when it does not parse, no user mount is
// connected and the problem is reported by listMounts().
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isLoopbackHost } from "../../lib/access-key.js";
import { atomicReplaceSync } from "../../lib/platform.js";
import { PACK_ID_PATTERN, SECRET_REF_PATTERN, isDeniedSecretName } from "../packs/manifest.js";
import { SECRET_NAME_PATTERN } from "../secrets/index.js";

export const USER_MOUNTS_FILE = "mounts.json";
export const USER_MOUNT_PACK = "user";
export const MAX_USER_MOUNTS = 64;
const MAX_FILE_BYTES = 1024 * 1024;

const PREFIX_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
// A bare program name looked up on PATH, or an absolute path. No shell syntax:
// the command is started directly, never through a shell.
// A program name, or an absolute path: "/usr/bin/x", "C:\\x\\y.exe", "C:/x" or "\\\\server\\share\\x".
const COMMAND_PATTERN =
  /^(?:[A-Za-z0-9_+][A-Za-z0-9._+-]{0,63}|\/[^\0\n]{1,1023}|[A-Za-z]:[\\/][^\0\n]{1,1020}|\\\\[^\0\n\\]+\\[^\0\n]{1,1000})$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\0"), "must not contain NUL");

const mountUrl = z
  .string()
  .max(2048)
  .refine((raw) => {
    try {
      // The secret reference stands in for a value; check the rest.
      const u = new URL(raw.replace(SECRET_REF_PATTERN, "x"));
      return (
        (u.protocol === "http:" || u.protocol === "https:") &&
        u.username === "" &&
        u.password === ""
      );
    } catch {
      return false;
    }
  }, "mount url must be an http(s) URL without credentials in it");

export const UserMountSchema = z
  .object({
    id: z.string().regex(PACK_ID_PATTERN, "mount id must match ^[a-z][a-z0-9-]{1,31}$"),
    name: text(120).min(1).optional(),
    description: text(500).min(1).optional(),
    enabled: z.boolean().default(true),
    transport: z.enum(["http", "stdio"], { error: 'mount transport must be "http" or "stdio"' }),
    prefix: z.string().regex(PREFIX_PATTERN, "mount prefix must match ^[a-z][a-z0-9_-]{0,31}$"),
    url: mountUrl.optional(),
    headers: z.record(z.string().regex(HEADER_NAME, "invalid header name"), text(8192)).optional(),
    command: z
      .string()
      .regex(COMMAND_PATTERN, "mount command must be a program name or an absolute path")
      .optional(),
    args: z.array(text(4096)).max(64).optional(),
    env: z
      .record(z.string().regex(ENV_NAME, "invalid environment variable name"), text(8192))
      .optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (m.transport === "http") {
      if (!m.url) issue("url", "an http mount needs a url");
      if (m.command !== undefined) issue("command", "an http mount has no command");
      if (m.args !== undefined) issue("args", "an http mount has no args");
      if (m.env !== undefined) issue("env", "an http mount has no env");
    } else {
      if (!m.command) issue("command", "a stdio mount needs a command");
      if (m.url !== undefined) issue("url", "a stdio mount has no url");
      if (m.headers !== undefined) issue("headers", "a stdio mount has no headers");
    }
    for (const name of userMountSecretRefs(m)) {
      if (!SECRET_NAME_PATTERN.test(name) || isDeniedSecretName(name)) {
        issue("secrets", `"\${secret:${name.slice(0, 64)}}" is not a secret name a mount may use`);
      }
    }
  });

export type UserMount = z.output<typeof UserMountSchema>;
export type UserMountInput = z.input<typeof UserMountSchema>;

export const UserMountsFileSchema = z
  .object({
    version: z.literal(1).default(1),
    mounts: z.array(UserMountSchema).max(MAX_USER_MOUNTS).default([]),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const prefixes = new Set<string>();
    file.mounts.forEach((m, i) => {
      if (ids.has(m.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["mounts", i, "id"],
          message: `duplicate mount id "${m.id}"`,
        });
      }
      if (prefixes.has(m.prefix)) {
        ctx.addIssue({
          code: "custom",
          path: ["mounts", i, "prefix"],
          message: `duplicate mount prefix "${m.prefix}"`,
        });
      }
      ids.add(m.id);
      prefixes.add(m.prefix);
    });
  });

/** Secret names a mount refers to, in order of first use. */
export function userMountSecretRefs(
  m: Pick<UserMount, "url" | "headers" | "args" | "env">,
): string[] {
  const names = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    for (const match of s.matchAll(SECRET_REF_PATTERN)) names.add(match[1] ?? "");
  };
  scan(m.url);
  for (const v of Object.values(m.headers ?? {})) scan(v);
  for (const v of m.args ?? []) scan(v);
  for (const v of Object.values(m.env ?? {})) scan(v);
  return [...names];
}

// Header names that carry a credential even when the value is written out
// literally instead of as a ${secret:NAME} reference.
export const CREDENTIAL_HEADER =
  /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key)$|token|secret|api[-_]?key|auth/i;

/**
 * Why this mount would send a secret in clear text, or null. An http mount
 * whose url is plain `http://` to a host other than this machine may not carry
 * a secret: not in a header (a ${secret:NAME} value or a credential header
 * such as Authorization) and not in the url. Anyone on the path would read it.
 */
export function plainHttpSecretProblem(
  m: Pick<UserMount, "transport" | "url" | "headers">,
): { path: string; message: string } | null {
  if (m.transport !== "http" || !m.url) return null;
  let u: URL;
  try {
    u = new URL(m.url.replace(SECRET_REF_PATTERN, "x"));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || isLoopbackHost(u.hostname)) return null;
  const where = `plain http:// to ${u.hostname.slice(0, 253)}`;
  const fix = "use an https:// url (plain http is allowed only to this machine)";
  for (const [name, value] of Object.entries(m.headers ?? {})) {
    const refs = [...value.matchAll(SECRET_REF_PATTERN)].length > 0;
    if (refs || CREDENTIAL_HEADER.test(name)) {
      return {
        path: `headers.${name}`,
        message: `the header ${name} carries a secret and would be sent over ${where}; ${fix}`,
      };
    }
  }
  if ([...m.url.matchAll(SECRET_REF_PATTERN)].length > 0) {
    return {
      path: "url",
      message: `the url carries a secret and would be sent over ${where}; ${fix}`,
    };
  }
  return null;
}

export class UserMountsError extends Error {
  constructor(
    readonly code:
      | "INVALID_MOUNT"
      | "MOUNT_EXISTS"
      | "UNKNOWN_MOUNT"
      | "MOUNTS_FILE_INVALID"
      | "MOUNT_LIMIT",
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
    this.name = "UserMountsError";
  }
}

export interface UserMountsState {
  mounts: UserMount[];
  /** Why the file was not used (it is left untouched), or null. */
  error: string | null;
}

/** Reads and rewrites `<home>/mounts.json`. Synchronous: the file is tiny. */
export class UserMountStore {
  readonly path: string;

  constructor(private readonly home: string) {
    this.path = join(home, USER_MOUNTS_FILE);
  }

  read(): UserMountsState {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { mounts: [], error: null };
      return { mounts: [], error: `${USER_MOUNTS_FILE} could not be read` };
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) {
      return { mounts: [], error: `${USER_MOUNTS_FILE} is too large` };
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { mounts: [], error: `${USER_MOUNTS_FILE} is not valid JSON` };
    }
    const parsed = UserMountsFileSchema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.length ? `${first.path.join(".")}: ` : "";
      return {
        mounts: [],
        error: `${USER_MOUNTS_FILE} is invalid (${where}${first?.message ?? "unknown problem"})`,
      };
    }
    return { mounts: parsed.data.mounts, error: null };
  }

  /** The mounts, or MOUNTS_FILE_INVALID: a broken file is never overwritten. */
  private editable(): UserMount[] {
    const state = this.read();
    if (state.error !== null) {
      throw new UserMountsError(
        "MOUNTS_FILE_INVALID",
        `${state.error}; fix or remove the file before changing mounts`,
      );
    }
    return state.mounts;
  }

  add(input: unknown): UserMount {
    const parsed = UserMountSchema.safeParse(input);
    if (!parsed.success) {
      throw new UserMountsError("INVALID_MOUNT", "invalid mount", parsed.error.issues);
    }
    const mount = parsed.data;
    const insecure = plainHttpSecretProblem(mount);
    if (insecure) {
      throw new UserMountsError("INVALID_MOUNT", insecure.message, [
        { path: insecure.path.split("."), message: insecure.message },
      ]);
    }
    const mounts = this.editable();
    if (mounts.length >= MAX_USER_MOUNTS) {
      throw new UserMountsError("MOUNT_LIMIT", `at most ${MAX_USER_MOUNTS} user mounts`);
    }
    if (mounts.some((m) => m.id === mount.id)) {
      throw new UserMountsError("MOUNT_EXISTS", `a mount with the id "${mount.id}" exists`);
    }
    if (mounts.some((m) => m.prefix === mount.prefix)) {
      throw new UserMountsError("MOUNT_EXISTS", `the prefix "${mount.prefix}" is in use`);
    }
    this.write([...mounts, mount]);
    return mount;
  }

  remove(id: string): boolean {
    const mounts = this.editable();
    const rest = mounts.filter((m) => m.id !== id);
    if (rest.length === mounts.length) return false;
    this.write(rest);
    return true;
  }

  setEnabled(id: string, on: boolean): boolean {
    const mounts = this.editable();
    const target = mounts.find((m) => m.id === id);
    if (!target) return false;
    if (target.enabled !== on) {
      this.write(mounts.map((m) => (m.id === id ? { ...m, enabled: on } : m)));
    }
    return true;
  }

  /** Atomic replace, 0600 (the file holds no credentials, but it names commands). */
  private write(mounts: UserMount[]): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify({ version: 1, mounts }, null, 2)}\n`;
    const tmp = join(
      this.home,
      `.${USER_MOUNTS_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeSync(fd, body);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      atomicReplaceSync(tmp, this.path);
      if (process.platform !== "win32") chmodSync(this.path, 0o600);
    } catch (e) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      throw e;
    }
  }
}
