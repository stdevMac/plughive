// src/lib/auth.ts
import type { NextFunction, Request, Response } from "express";
import { extractAuthToken, verifyAccessKey } from "./access-key.js";

export interface AccessKeyOpts {
  accessKey: string | null;
}

/**
 * When an access key is configured, require it (Bearer or X-API-Key) on
 * protected routes. With no key configured, requests pass through.
 */
export function accessKeyMiddleware(opts: AccessKeyOpts) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!opts.accessKey) {
      next();
      return;
    }
    if (!verifyAccessKey(opts.accessKey, extractAuthToken(req))) {
      res.status(401).json({
        ok: false,
        error: { code: "UNAUTHORIZED", message: "invalid or missing access key" },
      });
      return;
    }
    next();
  };
}
