// packs/machines/shell.ts
//
// Validation patterns and the POSIX quoting used to compose remote commands.
// Nothing here builds a LOCAL shell string: ssh is spawned with an argv array.
// The remote side, however, always runs a shell, so every value the pack
// interpolates into a remote command goes through shellQuote().
import { win32 } from "node:path";
import { z } from "plughive/pack";

/**
 * POSIX single-quote escaping: wrap in '...' and turn each ' into '\''.
 * Inside single quotes a POSIX shell treats every byte literally, so the
 * result is one word whatever the input holds ($, `, \, ", newlines, globs).
 * NUL cannot be represented in a shell word or an argv entry and is rejected.
 */
export function shellQuote(value: string): string {
  if (typeof value !== "string") throw new TypeError("shellQuote expects a string");
  if (value.includes("\0")) throw new Error("value contains a NUL byte");
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ASCII control characters and DEL.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
export const CONTROL = /[\u0000-\u001f\u007f]/;

/** Registered machine and repo names: what the agent passes as `machine` / `repo`. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * DNS hostname or IPv4 (labels of letters, digits, inner dashes). No leading
 * "-", no "@", no ":" (so no "ssh://" URI and no "host:port"), no whitespace.
 */
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
/** Bare IPv6 (optionally with an embedded IPv4 tail). No brackets, no zone id. */
const IPV6 = /^(?=.{2,45}$)(?=.*:)[0-9A-Fa-f:.]+$/;
export function isValidHost(host: string): boolean {
  return HOSTNAME.test(host) || IPV6.test(host);
}

/** Login names: POSIX-portable, no leading "-", no "%" (ssh token expansion), no "@". */
export const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/**
 * Local identity file path, passed to `ssh -i` as its own argv entry. Absolute
 * or "~/"-relative, no control characters, no "%" (ssh expands %-tokens in
 * IdentityFile), no ".." segments. The pack never opens this file.
 */
export function identityFileProblem(p: string): string | null {
  if (p.length === 0 || p.length > 1024) return "identity_file must be 1-1024 characters";
  if (!p.startsWith("/") && !p.startsWith("~/") && !p.startsWith("~\\") && !win32.isAbsolute(p))
    return 'identity_file must be an absolute path or start with "~/"';
  if (CONTROL.test(p)) return "identity_file contains control characters";
  if (p.includes("%")) return 'identity_file must not contain "%"';
  if (p.split(/[/\\]/).includes("..")) return 'identity_file must not contain ".." segments';
  return null;
}

/** Remote paths (cwd, repo path, file transfer). Quoted before use; this is hygiene. */
export function remotePathProblem(p: string, what: string, absolute = false): string | null {
  if (p.length === 0 || p.length > 4096) return `${what} must be 1-4096 characters`;
  if (CONTROL.test(p)) return `${what} contains control characters`;
  if (p.startsWith("-")) return `${what} must not start with "-"`;
  if (p.startsWith("~"))
    return `${what} must not start with "~" (use an absolute path or a path relative to the login directory)`;
  if (absolute && !p.startsWith("/")) return `${what} must be an absolute path`;
  return null;
}

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** known_hosts key types ssh accepts for a pinned host key. */
const HOST_KEY_TYPE =
  /^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/;

/**
 * A pinned host key for one machine: exactly one known_hosts line,
 * `host keytype base64-key [comment]`. @cert-authority/@revoked markers and
 * wildcard host names are refused — a pin must name the key itself. Returns
 * null when the line is acceptable, else what is wrong with it.
 */
export function hostKeyLineProblem(line: string): string | null {
  if (line.length === 0 || line.length > 4096) return "host_key must be 1-4096 characters";
  if (CONTROL.test(line)) return "host_key contains control characters";
  const fields = line.trim().split(/\s+/);
  if (fields.length < 3) {
    return 'host_key must be one known_hosts line: "host keytype base64-key"';
  }
  const [hosts, keyType, key] = fields as [string, string, string];
  if (hosts.startsWith("@")) return "host_key must not use @cert-authority or @revoked markers";
  if (/[*,?]/.test(hosts)) return "host_key must name the host exactly (no wildcards)";
  if (!HOST_KEY_TYPE.test(keyType)) return `host_key has an unknown key type "${keyType}"`;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key) || Buffer.from(key, "base64").length < 16) {
    return "host_key has an invalid base64 key";
  }
  return null;
}

// --- zod helpers -------------------------------------------------------------

export const machineName = z
  .string()
  .max(256)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => NAME_PATTERN.test(s), "names are 1-64 chars of a-z, 0-9, '_', '.', '-'");

export const hostSchema = z
  .string()
  .refine(
    isValidHost,
    "host must be a hostname, IPv4 or bare IPv6 address (no user@, no port, no options)",
  );

export const userSchema = z
  .string()
  .regex(USER_PATTERN, "user must match ^[A-Za-z_][A-Za-z0-9_.-]{0,31}$");

export const portSchema = z.number().int().min(1).max(65535);

export const identityFileSchema = z.string().superRefine((p, ctx) => {
  const problem = identityFileProblem(p);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const remotePath = (what: string, absolute = false) =>
  z.string().superRefine((p, ctx) => {
    const problem = remotePathProblem(p, what, absolute);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const envSchema = z
  .record(
    z.string().regex(ENV_NAME_PATTERN, "env names must match ^[A-Za-z_][A-Za-z0-9_]*$"),
    z
      .string()
      .max(32_768)
      .refine((v) => !v.includes("\0"), "env values must not contain NUL"),
  )
  .refine((r) => Object.keys(r).length <= 64, "at most 64 env entries");

/** Compose the remote script for machine_run: optional cd and exports, then the command verbatim. */
export function composeRemoteCommand(
  command: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): string {
  const lines: string[] = [];
  if (opts.cwd !== undefined) lines.push(`cd ${shellQuote(opts.cwd)} || exit 1`);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!ENV_NAME_PATTERN.test(k)) throw new Error(`invalid env name: ${k}`);
    lines.push(`export ${k}=${shellQuote(v)}`);
  }
  if (lines.length === 0) return command;
  lines.push(command);
  return lines.join("\n");
}
