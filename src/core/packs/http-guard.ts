// src/core/packs/http-guard.ts
//
// The daemon's own HTTP surface refuses requests made through a pack's
// ctx.fetch. Every pack fetch carries PACK_MARKER_HEADER (set by the host, not
// removable by the pack), so even a pack with a localNetwork grant, or one that
// reaches the daemon through a redirect or an alias the port check missed,
// cannot drive /mcp, /api or /setup. Defence in depth behind the self-port
// deny in context.ts.
import { PACK_MARKER_HEADER } from "./context.js";

interface GuardRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface GuardResponse {
  status(code: number): { json(body: unknown): unknown };
}

export function isPackRequest(req: GuardRequest): boolean {
  return req.headers[PACK_MARKER_HEADER] !== undefined;
}

/** Express-compatible middleware: 403 for any request carrying the pack marker. */
export function rejectPackRequests(req: GuardRequest, res: GuardResponse, next: () => void): void {
  if (!isPackRequest(req)) {
    next();
    return;
  }
  res.status(403).json({
    ok: false,
    error: {
      code: "PACK_REQUEST_REFUSED",
      message: "packs cannot call the daemon's own HTTP API",
      retryable: false,
    },
  });
}
