// src/core/http/admin-auth.ts
//
// Authentication of the management API. Everything under /api needs the admin
// token, in every configuration: a loopback daemon without an access key is no
// exception, because "local" includes every other process on the machine.
//
// A request is authenticated by one of:
//
//   Authorization: Bearer <admin token>        CLI, Mac app, scripts
//   Cookie: plughive_session=<session id>     the dashboard in a browser
//
// The access key (PLUGHIVE_ACCESS_KEY) is not accepted here: it is what
// agents hold, and an agent must not be able to administer the daemon.
//
// Sessions:
//
//   GET    /api/session            {ok:true, authenticated:boolean}; needs no credential
//   POST   /api/session {token}    200 and Set-Cookie, 401 for a wrong token,
//                                  429 for a wrong token once the caller is locked out
//   DELETE /api/session            ends the session of the cookie sent
//
// Lockout: the token is compared first, and the right token always opens a
// session, so nobody can lock the holder of the token out by guessing. Only
// wrong tokens count: MAX_FAILED_LOGINS a minute per remote address (the
// socket's, never a forwarded header), and MAX_FAILED_LOGINS_GLOBAL a minute
// over all addresses together. At most MAX_TRACKED_ADDRESSES addresses are
// remembered; the one whose last failure is oldest is forgotten first. The
// token's 256 bits are what stop guessing; the lockout only slows it.
//
// The cookie is HttpOnly; SameSite=Strict; Path=/api (and Secure when the
// daemon's public URL is https). Sessions live in memory (a restart signs
// every browser out), expire SESSION_TTL_MS after their last use and are
// capped at MAX_SESSIONS (the least recently used one goes first).
//
// A cookie makes the browser rules matter: the app-wide Origin guard and the
// CSRF rule of every /api router stay in force on top of this.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { csrfGuard } from "./csrf.js";
import type { OriginPolicy } from "./origin.js";

export const SESSION_COOKIE = "plughive_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_SESSIONS = 64;
export const MAX_FAILED_LOGINS = 10;
export const MAX_FAILED_LOGINS_GLOBAL = 200;
export const MAX_TRACKED_ADDRESSES = 1024;
export const FAILED_LOGIN_WINDOW_MS = 60_000;
const SESSION_BODY_LIMIT = "4kb";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface AdminAuthOptions {
  /** The admin token. */
  token: string;
  /** True when the daemon is reached over https: the cookie is marked Secure. */
  secureCookie?: boolean;
  now?: () => number;
  maxSessions?: number;
  /** Wrong tokens a minute from one remote address before it is locked out. */
  maxFailedLogins?: number;
  /** Wrong tokens a minute from all addresses together before everyone is. */
  maxFailedLoginsGlobal?: number;
  /** Remote addresses whose failures are remembered. */
  maxTrackedAddresses?: number;
  /** For tests: the address a request counts against (default: the socket's). */
  remoteAddress?: (req: Request) => string;
}

export interface AdminAuth {
  /** Express middleware: 401 unless the request carries the admin token or a live session. */
  require(req: Request, res: Response, next: NextFunction): void;
  /** True when the request carries the admin token or a live session. */
  isAuthenticated(req: Pick<Request, "header">): boolean;
  /** Mount /api/session. Call before `require` is mounted on /api. */
  mountSession(app: Express, origin: OriginPolicy): void;
  /** Open sessions (for tests). */
  sessions(): number;
  /** Remote addresses with remembered failures (for tests). */
  failedAddresses(): number;
  /** Forget every session. */
  close(): void;
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Constant-time comparison over digests (hides length differences). */
function sameSecret(expected: string, presented: string): boolean {
  return timingSafeEqual(sha256(expected), sha256(presented));
}

/** The Bearer credential only: X-API-Key belongs to the access key. */
function bearerOf(req: Pick<Request, "header">): string | null {
  const match = req.header("authorization")?.match(/^\s*bearer\s+(\S.*)$/i);
  return match?.[1] ? match[1].trim() : null;
}

function cookieOf(req: Pick<Request, "header">, name: string): string | null {
  const header = req.header("cookie");
  if (!header || header.length > 8192) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createAdminAuth(opts: AdminAuthOptions): AdminAuth {
  const now = opts.now ?? Date.now;
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const maxFailed = opts.maxFailedLogins ?? MAX_FAILED_LOGINS;
  const maxFailedGlobal = opts.maxFailedLoginsGlobal ?? MAX_FAILED_LOGINS_GLOBAL;
  const maxAddresses = opts.maxTrackedAddresses ?? MAX_TRACKED_ADDRESSES;
  /** Session id digest (hex) -> expiry. Insertion order is least recently used first. */
  const sessions = new Map<string, number>();
  /**
   * Remote address -> times of its recent wrong tokens, oldest first, at most
   * maxFailed of them. Insertion order is the order of the last failure.
   */
  const failures = new Map<string, number[]>();
  /** Times of the recent wrong tokens from every address, at most maxFailedGlobal. */
  let globalFailures: number[] = [];

  const keyOf = (id: string) => sha256(id).toString("hex");

  const sweep = () => {
    const t = now();
    for (const [key, expires] of sessions) if (expires <= t) sessions.delete(key);
  };

  /** A live session id: its expiry slides and it becomes the most recently used. */
  const touch = (id: string | null): boolean => {
    if (!id || !SESSION_ID_PATTERN.test(id)) return false;
    const key = keyOf(id);
    const expires = sessions.get(key);
    if (expires === undefined) return false;
    sessions.delete(key);
    if (expires <= now()) return false;
    sessions.set(key, now() + SESSION_TTL_MS);
    return true;
  };

  const open = (): string => {
    sweep();
    while (sessions.size >= maxSessions) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    sessions.set(keyOf(id), now() + SESSION_TTL_MS);
    return id;
  };

  const cookie = (value: string, maxAgeSeconds: number): string =>
    [
      `${SESSION_COOKIE}=${value}`,
      "Path=/api",
      `Max-Age=${maxAgeSeconds}`,
      "HttpOnly",
      "SameSite=Strict",
      ...(opts.secureCookie ? ["Secure"] : []),
    ].join("; ");

  const isAuthenticated = (req: Pick<Request, "header">): boolean => {
    const bearer = bearerOf(req);
    if (bearer !== null && sameSecret(opts.token, bearer)) return true;
    return touch(cookieOf(req, SESSION_COOKIE));
  };

  const live = (times: number[], t: number) =>
    times.filter((at) => t - at < FAILED_LOGIN_WINDOW_MS);

  /** Seconds until `times` holds fewer than `limit` live failures; 0 when it already does. */
  const waitFor = (times: number[], limit: number, t: number): number => {
    if (times.length < limit) return 0;
    const reopens = times[times.length - limit] ?? t;
    return Math.max(1, Math.ceil((reopens + FAILED_LOGIN_WINDOW_MS - t) / 1000));
  };

  /** Seconds this address must wait, from its own failures or everyone's. */
  const lockedOut = (address: string): number => {
    const t = now();
    globalFailures = live(globalFailures, t);
    const mine = live(failures.get(address) ?? [], t);
    return Math.max(waitFor(mine, maxFailed, t), waitFor(globalFailures, maxFailedGlobal, t));
  };

  const recordFailure = (address: string) => {
    const t = now();
    const mine = live(failures.get(address) ?? [], t);
    mine.push(t);
    failures.delete(address);
    if (failures.size >= maxAddresses) {
      for (const [key, times] of failures) {
        if (live(times, t).length === 0) failures.delete(key);
      }
      while (failures.size >= maxAddresses) {
        const oldest = failures.keys().next().value;
        if (oldest === undefined) break;
        failures.delete(oldest);
      }
    }
    failures.set(address, mine.slice(-maxFailed));
    globalFailures.push(t);
    if (globalFailures.length > maxFailedGlobal)
      globalFailures = globalFailures.slice(-maxFailedGlobal);
  };

  /** The socket's address: a forwarded header is the caller's to choose. */
  const addressOf = (req: Request): string => {
    if (opts.remoteAddress) return opts.remoteAddress(req);
    const raw = req.socket.remoteAddress ?? "unknown";
    return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  };

  const unauthorized = (res: Response) =>
    res.status(401).json({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: "the admin token or a dashboard session is required",
      },
    });

  return {
    isAuthenticated,
    require(req, res, next) {
      if (isAuthenticated(req)) return next();
      unauthorized(res);
    },
    mountSession(app, origin) {
      const router = express.Router();
      router.use(csrfGuard(origin));
      router.get("/", (req, res) => {
        res.set("Cache-Control", "no-store");
        const viaCookie = touch(cookieOf(req, SESSION_COOKIE));
        if (viaCookie) {
          // The browser's copy expires with the server's: both slide together.
          const id = cookieOf(req, SESSION_COOKIE) as string;
          res.set("Set-Cookie", cookie(id, Math.floor(SESSION_TTL_MS / 1000)));
        }
        res.json({ ok: true, authenticated: viaCookie || isAuthenticated(req) });
      });
      router.post("/", express.json({ limit: SESSION_BODY_LIMIT }), (req, res) => {
        res.set("Cache-Control", "no-store");
        const token = (req.body as { token?: unknown } | undefined)?.token;
        if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
          res.status(400).json({
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: 'the body must be {"token": "<admin token>"}',
            },
          });
          return;
        }
        // The comparison comes first: the right token is never locked out.
        if (!sameSecret(opts.token, token)) {
          const address = addressOf(req);
          const wait = lockedOut(address);
          recordFailure(address);
          if (wait > 0) {
            res.set("Retry-After", String(wait));
            res.status(429).json({
              ok: false,
              error: {
                code: "TOO_MANY_ATTEMPTS",
                message: "too many wrong tokens; try again in a minute",
              },
            });
            return;
          }
          unauthorized(res);
          return;
        }
        res.set("Set-Cookie", cookie(open(), Math.floor(SESSION_TTL_MS / 1000)));
        res.json({ ok: true, authenticated: true });
      });
      router.delete("/", (req, res) => {
        const id = cookieOf(req, SESSION_COOKIE);
        if (id && SESSION_ID_PATTERN.test(id)) sessions.delete(keyOf(id));
        res.set("Set-Cookie", cookie("", 0));
        res.json({ ok: true, authenticated: false });
      });
      router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const status = (err as { status?: number } | null)?.status;
        const known = status === 400 || status === 413;
        res.status(known ? status : 500).json({
          ok: false,
          error: known
            ? { code: "INVALID_REQUEST", message: 'the body must be {"token": "<admin token>"}' }
            : { code: "INTERNAL", message: "internal error" },
        });
      });
      app.use("/api/session", router);
    },
    sessions: () => {
      sweep();
      return sessions.size;
    },
    failedAddresses: () => failures.size,
    close: () => sessions.clear(),
  };
}
