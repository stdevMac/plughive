// src/core/http/policy-api.ts
//
// Spend policy and approvals (docs/spend-and-approvals.md).
//
//   GET  /api/approvals                 ?status=pending|approved|denied|expired|consumed&limit=
//                                       newest first, with `pending` (the count for the badge)
//   GET  /api/approvals/:id             one request
//   POST /api/approvals/:id/approve     a pending request becomes usable once
//   POST /api/approvals/:id/deny
//
//   GET  /api/policy                    {policy, valid, error?, exists, caps: [{cap, spent_usd, ...}]}
//   PUT  /api/policy                    {policy}: validated, written atomically (owner-only).
//                                       409 POLICY_FILE_BROKEN when policy.json on disk does not
//                                       validate (it is never overwritten; fix or delete it).
//
// Behind the admin token (or a dashboard session), the Origin guard and the
// CSRF rule, like the rest of /api. No MCP tool reaches these routes: an
// agent can ask for an approval, never grant one. Argument summaries are
// redacted when the request is stored; amounts are what the providers
// estimate, not what they will bill.
import type { Express } from "express";
import { z } from "zod";
import type { PolicyGate } from "../policy/gate.js";
import { PolicyFileError, writePolicy } from "../policy/policy.js";
import { capStatus } from "../policy/spend.js";
import { type ApiLogger, apiRouter, fail, intQuery, mountApi, parse, route } from "./api-common.js";
import type { OriginPolicy } from "./origin.js";

export interface PolicyApiDeps {
  origin: OriginPolicy;
  logger?: ApiLogger;
  home: string;
  gate: Pick<PolicyGate, "approvals" | "policy" | "cache" | "approvalUrl" | "spend">;
  now?: () => number;
  /** An approval or the policy changed (pokes the event stream). */
  changed?: () => void;
}

const ApprovalsQuery = z
  .object({
    status: z.enum(["pending", "approved", "denied", "expired", "consumed"]).optional(),
    limit: intQuery(1, 500),
  })
  .strict();
const ID_RE = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PolicyBody = z.object({ policy: z.unknown() }).strict();

export function mountPolicyApi(app: Express, deps: PolicyApiDeps): void {
  const now = deps.now ?? Date.now;
  const approvals = apiRouter(deps.origin);
  const store = () => deps.gate.approvals;
  const view = <T extends { id: string }>(a: T) => ({ ...a, url: deps.gate.approvalUrl(a.id) });

  approvals.get(
    "/",
    route((req, res) => {
      const q = parse(ApprovalsQuery, req.query, res);
      if (!q) return;
      const rows = store().list({
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
      });
      res.json({ ok: true, approvals: rows.map(view), pending: store().pendingCount() });
    }),
  );
  approvals.get(
    "/:id",
    route((req, res) => {
      const id = req.params.id ?? "";
      const a = ID_RE.test(id) ? store().get(id) : null;
      if (!a) {
        fail(res, 404, "NOT_FOUND", "no such approval request");
        return;
      }
      res.json({ ok: true, approval: view(a) });
    }),
  );
  for (const [verb, decision] of [
    ["approve", "approved"],
    ["deny", "denied"],
  ] as const) {
    approvals.post(
      `/:id/${verb}`,
      route((req, res) => {
        const id = req.params.id ?? "";
        const current = ID_RE.test(id) ? store().get(id) : null;
        if (!current) {
          fail(res, 404, "NOT_FOUND", "no such approval request");
          return;
        }
        const ttlMs = deps.gate.policy().policy.approval_ttl_minutes * 60_000;
        if (!store().decide(id, decision, "dashboard", ttlMs)) {
          fail(res, 409, "NOT_PENDING", `the request is already ${current.status}`);
          return;
        }
        deps.logger?.info({ approval: id, decision }, "approval decided");
        deps.changed?.();
        res.json({ ok: true, approval: view(store().get(id) ?? current) });
      }),
    );
  }
  mountApi(app, "/api/approvals", approvals, deps.logger);

  const policy = apiRouter(deps.origin);
  const report = () => {
    const state = deps.gate.policy();
    const at = now();
    return {
      ok: true,
      valid: state.ok,
      ...(state.ok ? { exists: state.exists } : { exists: true, error: state.error }),
      policy: state.policy,
      // spent_usd null: the ledger could not be read (the cap counts as used up).
      caps: state.policy.caps.map((cap) => {
        const s = capStatus(cap, deps.gate.spend, at);
        return Number.isFinite(s.spent_usd) ? s : { ...s, spent_usd: null };
      }),
    };
  };
  policy.get(
    "/",
    route((_req, res) => {
      res.json(report());
    }),
  );
  policy.put(
    "/",
    route((req, res) => {
      const body = parse(PolicyBody, req.body, res);
      if (!body) return;
      try {
        writePolicy(deps.home, body.policy);
      } catch (e) {
        if (e instanceof PolicyFileError) {
          fail(res, e.code === "POLICY_FILE_BROKEN" ? 409 : 400, e.code, e.message);
          return;
        }
        throw e;
      }
      deps.gate.cache.invalidate();
      deps.logger?.info({}, "spend policy updated");
      deps.changed?.();
      res.json(report());
    }),
  );
  mountApi(app, "/api/policy", policy, deps.logger);
}
