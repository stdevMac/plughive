// src/core/http/csrf.ts
//
// CSRF rule for state-changing local routes (ARCHITECTURE section 8): the
// request's Origin must be the daemon's own, or be absent together with
// `X-PlugHive-CSRF: 1` (a header no cross-site form or simple request can
// set). An origin that is only allow-listed (PLUGHIVE_ALLOWED_ORIGINS) is
// same-SITE with a loopback daemon, so a form posted from it would carry the
// SameSite=Strict session cookie: such an origin may write only with the CSRF
// header as well. The daemon's origin comes from its configuration, never
// from the Host header.
import type { NextFunction, Request, Response } from "express";
import type { OriginPolicy } from "./origin.js";

export const CSRF_HEADER = "x-plughive-csrf";

export function isSameOriginWrite(req: Pick<Request, "header">, policy: OriginPolicy): boolean {
  const origin = req.header("origin");
  if (origin === undefined || origin === "") return req.header(CSRF_HEADER) === "1";
  if (policy.isOwn(origin)) return true;
  // Allow-listed but not the daemon's own origin: same-site, not same-origin,
  // so the session cookie would ride along on a plain form post.
  return policy.isAllowed(origin) && req.header(CSRF_HEADER) === "1";
}

/** Express middleware: 403 JSON for writes that fail the rule; reads pass. */
export function csrfGuard(policy: OriginPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD" || isSameOriginWrite(req, policy)) {
      next();
      return;
    }
    res.status(403).json({
      ok: false,
      error: {
        code: "CSRF_REJECTED",
        message: "state-changing requests need a same-origin Origin header or X-PlugHive-CSRF: 1",
      },
    });
  };
}
