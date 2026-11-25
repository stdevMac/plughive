// src/core/http/api-common.ts
//
// Shared plumbing of the /api management routes. Every router built here has
// the same shape, which is the security model of the API:
//
//   1. app.use("/api", accessKey) is mounted by createApp before any of them,
//      and the app-wide guards (Host, pack marker, Origin) run before that.
//   2. csrfGuard: a write needs an allowed Origin, or no Origin together with
//      `X-PlugHive-CSRF: 1`.
//   3. express.json with a 256 kB limit, only after 1 and 2.
//   4. Input is validated with zod; a refusal is `{ok:false,error:{code,message}}`.
//   5. Errors never carry a stack, a path or a secret: an unexpected one is
//      logged by class name and answered with INTERNAL.
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import { z } from "zod";
import { csrfGuard } from "./csrf.js";
import type { OriginPolicy } from "./origin.js";

export const API_BODY_LIMIT = "256kb";

export interface ApiLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const fail = (
  res: Response,
  status: number,
  code: string,
  message: string,
  issues?: unknown[],
) =>
  res.status(status).json({ ok: false, error: { code, message, ...(issues ? { issues } : {}) } });

/** A router with the CSRF rule and the JSON body parser already on it. */
export function apiRouter(origin: OriginPolicy): Router {
  const router = express.Router();
  router.use(csrfGuard(origin));
  router.use(express.json({ limit: API_BODY_LIMIT }));
  return router;
}

/** A request whose path parameters are plain strings (no wildcard routes here). */
export type ApiRequest = Request<Record<string, string | undefined>>;

/** Forward a rejected handler to the router's error middleware (Express 4 does not). */
export const route =
  (fn: (req: ApiRequest, res: Response) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req as ApiRequest, res))
      .catch(next);
  };

/** Validate with zod. On failure the 400 is already sent and undefined is returned. */
export function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  res: Response,
  code = "INVALID_REQUEST",
): z.output<S> | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  fail(
    res,
    400,
    code,
    "the request is not valid",
    parsed.error.issues.slice(0, 20).map((i) => ({
      path: i.path.join("."),
      message: i.message.slice(0, 300),
    })),
  );
  return undefined;
}

/** Add the error middleware and mount the router. Call last. */
export function mountApi(app: Express, path: string, router: Router, logger?: ApiLogger): void {
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = (err as { status?: number } | null)?.status;
    if (status === 400 || status === 413) {
      fail(
        res,
        status,
        "INVALID_REQUEST",
        status === 413 ? "request body too large" : "malformed JSON body",
      );
      return;
    }
    // The message could quote a path or a value: log the class only.
    logger?.error(
      { method: req.method, route: path, err: err instanceof Error ? err.name : typeof err },
      "api error",
    );
    fail(res, 500, "INTERNAL", "internal error");
  });
  app.use(path, router);
}

/** An integer query parameter (`?limit=20`). */
export const intQuery = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional();

/** An ISO date or date-time query parameter. */
export const isoQuery = z
  .string()
  .max(40)
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)),
    "must be an ISO date",
  )
  .optional();
