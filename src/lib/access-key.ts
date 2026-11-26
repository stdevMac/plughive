// src/lib/access-key.ts
import { createHash, timingSafeEqual } from "node:crypto";

/** True for 127.0.0.1, any 127.x.x.x, ::1, [::1] and localhost. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  const m = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/** Reads `Authorization: Bearer <t>` or `X-API-Key`. Never a query parameter. */
export function extractAuthToken(req: {
  header(name: string): string | undefined;
}): string | null {
  // The scheme name is case-insensitive (RFC 9110): "bearer", "BEARER" and "Bearer" all work.
  const bearer = req.header("authorization")?.match(/^\s*bearer\s+(\S.*)$/i);
  if (bearer?.[1]) return bearer[1].trim();
  return req.header("x-api-key") ?? null;
}

/** Constant-time comparison over SHA-256 digests (hides length differences). */
export function verifyAccessKey(expected: string, presented: string | null): boolean {
  if (presented == null) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

export const MIN_NETWORK_KEY_LENGTH = 16;

/** Refuse to listen on a non-loopback address unless an access key is set. */
export function assertSafeBind(bindHost: string, accessKey: string | null): void {
  if (isLoopbackHost(bindHost)) return;
  if (accessKey) {
    if (accessKey.length < MIN_NETWORK_KEY_LENGTH) {
      throw new Error(
        `PLUGHIVE_ACCESS_KEY must be at least ${MIN_NETWORK_KEY_LENGTH} characters to bind to ${bindHost}.`,
      );
    }
    return;
  }
  const hint =
    "Set PLUGHIVE_ACCESS_KEY to require a key on /mcp, /p and /artifacts, or bind to 127.0.0.1.";
  throw new Error(`Refusing to bind to ${bindHost} without PLUGHIVE_ACCESS_KEY. ${hint}`);
}

/**
 * On a non-loopback address (a container, a server) the file backend must be
 * encrypted: a plain secrets.json in a volume or a backup is every provider key
 * in clear text. PLUGHIVE_ALLOW_PLAIN_SECRETS=1 accepts it knowingly.
 */
export function assertEncryptedSecretsOnNetwork(
  bindHost: string,
  env: Record<string, string | undefined>,
  storage?: string,
): void {
  if (isLoopbackHost(bindHost)) return;
  // The resolved backend when known: a headless machine with no keychain falls
  // back to a plain file without PLUGHIVE_SECRETS=file ever being set.
  const plain =
    storage !== undefined
      ? storage === "file-plain"
      : env.PLUGHIVE_SECRETS?.trim().toLowerCase() === "file" && !env.PLUGHIVE_SECRETS_PASSPHRASE;
  if (!plain) return;
  if (env.PLUGHIVE_ALLOW_PLAIN_SECRETS === "1") return;
  throw new Error(
    `Refusing to keep provider keys in a plain file while bound to ${bindHost}. Set PLUGHIVE_SECRETS_PASSPHRASE (or PLUGHIVE_SECRETS_PASSPHRASE_FILE) to encrypt them, or PLUGHIVE_ALLOW_PLAIN_SECRETS=1 to accept a plain file.`,
  );
}

/**
 * The multi-key settings from older versions are gone. Fail loudly instead of
 * silently running without the auth the user thinks they configured.
 */
export function assertNoMultiKeyConfig(env: Record<string, string | undefined>): void {
  const old = ["PLUGHIVE_API_KEYS", "PLUGHIVE_API_KEYS_PATH"].filter((k) => env[k]?.trim());
  if (old.length === 0) return;
  throw new Error(
    `${old.join(", ")} is no longer supported. plughive is single-user: set one PLUGHIVE_ACCESS_KEY instead and remove the old setting.`,
  );
}
