// src/core/http/origin.ts
//
// The daemon's own origin, and which browser origins may call it.
//
// Every absolute URL the daemon emits (setup links, artifact links) and every
// Origin comparison uses this policy. Nothing here reads the request's Host
// header: on a network bind that header is whatever the client sent.
//
//   base()        PLUGHIVE_PUBLIC_URL when set, else derived from the bind address
//   isOwn(o)      o is the daemon itself (base, the bind origin, loopback aliases
//                 of a loopback bind)
//   isAllowed(o)  isOwn, or listed in PLUGHIVE_ALLOWED_ORIGINS
import type { NextFunction, Request, Response } from "express";
import { isLoopbackHost } from "../../lib/access-key.js";
import { daemonOrigin } from "../../lib/config.js";

export interface OriginPolicy {
  /** The origin used in every URL the daemon hands out. */
  base(): string;
  /** True when `origin` is the daemon's own origin. */
  isOwn(origin: string): boolean;
  /** True when a browser page on `origin` may call the daemon. Never a wildcard. */
  isAllowed(origin: string): boolean;
}

export interface OriginPolicyOptions {
  publicUrl: string | null;
  bindHost: string;
  allowedOrigins: readonly string[];
  /** The port the daemon listens on (a function: tests listen on an ephemeral port). */
  port: () => number;
}

/** Scheme, host and port of an Origin header value, normalised. Null: not an origin. */
export function normalizeOrigin(value: string): string | null {
  if (value.length > 300) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

const WILDCARD_BINDS = new Set(["0.0.0.0", "::", "[::]", ""]);

export function createOriginPolicy(opts: OriginPolicyOptions): OriginPolicy {
  const bind = opts.bindHost.trim().toLowerCase();
  const local = () =>
    daemonOrigin({ publicUrl: null, bindHost: opts.bindHost, port: opts.port() }).toLowerCase();
  const own = (): Set<string> => {
    const set = new Set<string>([local()]);
    if (opts.publicUrl) set.add(opts.publicUrl.toLowerCase());
    // A loopback (or wildcard) bind is reachable under every loopback name.
    if (isLoopbackHost(bind) || WILDCARD_BINDS.has(bind)) {
      for (const name of ["127.0.0.1", "localhost", "[::1]"])
        set.add(`http://${name}:${opts.port()}`);
    }
    return set;
  };
  const extra = new Set(opts.allowedOrigins.map((o) => o.toLowerCase()));
  const isOwn = (origin: string) => {
    const normal = normalizeOrigin(origin);
    return normal !== null && own().has(normal);
  };
  return {
    base: () => opts.publicUrl ?? local(),
    isOwn,
    isAllowed: (origin) => {
      if (isOwn(origin)) return true;
      const normal = normalizeOrigin(origin);
      return normal !== null && extra.has(normal);
    },
  };
}

/**
 * Browser guard for the daemon's API surface: a request that carries an Origin
 * header must come from an allowed origin. Requests without Origin (every
 * non-browser MCP client) pass. No CORS header is ever emitted, so a page on
 * an allowed origin other than the daemon's own still needs same-site access
 * or a proxy; the allow-list only stops the 403.
 */
export function originGuard(policy: OriginPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (origin === undefined || origin === "" || policy.isAllowed(origin)) {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error: { code: "FORBIDDEN_ORIGIN", message: "cross-origin requests are not allowed" },
    });
  };
}
