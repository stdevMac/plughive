// src/core/mcp/setup-token.ts
//
// State tokens for the local /setup/secret page. A token authorizes storing
// ONE named secret of ONE pack, once, for a few minutes. It is
// `base64url(payload).base64url(HMAC-SHA256(key, payload))`; the key lives in
// memory, so tokens die with the daemon. The token never carries a secret value.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PACK_ID_PATTERN, isDeniedSecretName } from "../packs/manifest.js";
import { SECRET_NAME_PATTERN } from "../secrets/index.js";

export const SETUP_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_LENGTH = 2048;
const PRUNE_EVERY_MS = 60 * 1000;
// The one pack id pattern (core/packs/manifest.ts): a token names a real pack.
export { PACK_ID_PATTERN };
export const MAX_SECRET_LABEL_LENGTH = 80;
export const MAX_HELP_URL_LENGTH = 300;

/** A help link is only ever shown or linked when it is a plain https URL. */
export function safeHelpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_HELP_URL_LENGTH) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** A secret's display label: one line, no control characters, capped. */
export function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control characters
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") return undefined;
  return clean.length > MAX_SECRET_LABEL_LENGTH
    ? `${clean.slice(0, MAX_SECRET_LABEL_LENGTH - 1)}…`
    : clean;
}

export interface SetupClaim {
  pack: string;
  secret: string;
  label?: string;
  helpUrl?: string;
}

interface Payload extends SetupClaim {
  /** Nonce: makes the token single-use. */
  n: string;
  /** Expiry, ms since epoch. */
  e: number;
}

export type SetupTokenFailure = "invalid" | "expired" | "used";
export type SetupTokenCheck =
  | { ok: true; claim: SetupClaim; nonce: string }
  | { ok: false; reason: SetupTokenFailure };

export interface SetupTokensOptions {
  /** HMAC key, at least 32 bytes. Default: random per process. */
  key?: Buffer;
  ttlMs?: number;
  now?: () => number;
  /** How often consumed nonces are pruned (default 60 s; 0 disables the timer). */
  pruneEveryMs?: number;
}

export class SetupTokens {
  private readonly key: Buffer;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Consumed nonces with their expiry, pruned as they expire. */
  private readonly used = new Map<string, number>();

  private readonly timer: NodeJS.Timeout | null;

  constructor(opts: SetupTokensOptions = {}) {
    this.key = opts.key ?? randomBytes(32);
    if (this.key.length < 32) throw new Error("setup token key must be at least 32 bytes");
    this.ttlMs = opts.ttlMs ?? SETUP_TOKEN_TTL_MS;
    this.now = opts.now ?? Date.now;
    // Used nonces are forgotten once their token would have expired anyway,
    // whether or not another token is ever consumed.
    const every = opts.pruneEveryMs ?? PRUNE_EVERY_MS;
    this.timer = every > 0 ? setInterval(() => this.prune(), every) : null;
    this.timer?.unref();
  }

  /** Forget consumed nonces whose token has expired. Returns how many are still remembered. */
  prune(): number {
    const now = this.now();
    for (const [nonce, expiry] of this.used) if (expiry <= now) this.used.delete(nonce);
    return this.used.size;
  }

  /** Stop the prune timer (tests, shutdown). */
  close(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** `mint`, or null when the claim cannot be turned into a token (odd pack or secret name). */
  tryMint(claim: SetupClaim): string | null {
    try {
      return this.mint(claim);
    } catch {
      return null;
    }
  }

  mint(claim: SetupClaim): string {
    if (
      typeof claim.pack !== "string" ||
      typeof claim.secret !== "string" ||
      !PACK_ID_PATTERN.test(claim.pack) ||
      !SECRET_NAME_PATTERN.test(claim.secret) ||
      isDeniedSecretName(claim.secret)
    ) {
      throw new Error("cannot mint a setup token for an invalid pack or secret name");
    }
    const helpUrl = safeHelpUrl(claim.helpUrl);
    const label = safeLabel(claim.label);
    const payload: Payload = {
      pack: claim.pack,
      secret: claim.secret,
      ...(label ? { label } : {}),
      ...(helpUrl ? { helpUrl } : {}),
      n: randomBytes(16).toString("base64url"),
      e: this.now() + this.ttlMs,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  /** Check signature, expiry and reuse without consuming the token. */
  verify(token: unknown): SetupTokenCheck {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return { ok: false, reason: "invalid" };
    }
    const dot = token.indexOf(".");
    if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, reason: "invalid" };
    const body = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), "base64url");
    const expected = Buffer.from(this.sign(body), "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: "invalid" };
    }
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (
      typeof payload.pack !== "string" ||
      typeof payload.secret !== "string" ||
      typeof payload.n !== "string" ||
      typeof payload.e !== "number" ||
      !SECRET_NAME_PATTERN.test(payload.secret) ||
      isDeniedSecretName(payload.secret)
    ) {
      return { ok: false, reason: "invalid" };
    }
    if (this.now() >= payload.e) return { ok: false, reason: "expired" };
    if (this.used.has(payload.n)) return { ok: false, reason: "used" };
    return {
      ok: true,
      nonce: payload.n,
      claim: {
        pack: payload.pack,
        secret: payload.secret,
        ...(typeof payload.label === "string" ? { label: payload.label } : {}),
        ...(typeof payload.helpUrl === "string" ? { helpUrl: payload.helpUrl } : {}),
      },
    };
  }

  /** Verify and burn the token: a second call with the same token fails with "used". */
  consume(token: unknown): SetupTokenCheck {
    const check = this.verify(token);
    if (!check.ok) return check;
    this.prune();
    this.used.set(check.nonce, this.now() + this.ttlMs);
    return check;
  }

  private sign(body: string): string {
    return createHmac("sha256", this.key).update(`plughive.setup.v1:${body}`).digest("base64url");
  }
}
