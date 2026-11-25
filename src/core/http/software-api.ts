// src/core/http/software-api.ts
//
// The dashboard's side of the system pack: software installs and setup plans.
//
//   GET    /api/software                    every catalog item offered here, with its state
//                                           (?fresh=1 probes again instead of the 5 min cache)
//   GET    /api/software/:id                one item, probed now
//   POST   /api/software/:id/install        {approve?: true, force?: true}; approve is how a
//                                           person allows a gated, large or package-manager
//                                           install an agent asked for (the agent cannot)
//   POST   /api/software/:id/uninstall      removes what plughive installed
//
//   GET    /api/advisor/goals               the goals setup_plan knows
//   GET    /api/advisor/plan?goal=<text>    what a goal still needs on this machine
//
// Behind the admin token, the Origin guard and the CSRF rule like the rest of /api.
import type { Express, Response } from "express";
import { z } from "zod";
import type { SetupAdvisor } from "../advisor/plan.js";
import { InstallError, type Installer } from "../installer/installer.js";
import { type ApiLogger, apiRouter, fail, mountApi, parse, route } from "./api-common.js";
import type { OriginPolicy } from "./origin.js";

export interface SoftwareApiDeps {
  origin: OriginPolicy;
  logger?: ApiLogger;
  installer: Pick<Installer, "status" | "statusOf" | "startInstall" | "uninstall">;
  advisor: Pick<SetupAdvisor, "list" | "plan">;
  /** Called after an install starts or software was removed (the event stream looks again). */
  changed?: () => void;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const InstallBody = z
  .object({ approve: z.literal(true).optional(), force: z.literal(true).optional() })
  .strict()
  .optional();
const EmptyBody = z.object({}).strict().optional();
const PlanQuery = z.object({ goal: z.string().min(1).max(200) }).strict();

function softwareFailure(res: Response, e: unknown): void {
  if (e instanceof InstallError) {
    const status = e.code === "not_found" ? 404 : e.code === "busy" ? 409 : 400;
    fail(res, status, e.code.toUpperCase(), e.message.slice(0, 500));
    return;
  }
  throw e;
}

export function mountSoftwareApi(app: Express, deps: SoftwareApiDeps): void {
  const { installer, advisor } = deps;
  const changed = () => deps.changed?.();
  const unknown = (res: Response) => fail(res, 404, "NOT_FOUND", "no such software");

  const software = apiRouter(deps.origin);
  software.get(
    "/",
    route(async (req, res) => {
      const fresh = req.query.fresh === "1" || req.query.fresh === "true";
      res.json({ ok: true, items: await installer.status({ fresh }) });
    }),
  );
  software.get(
    "/:id",
    route(async (req, res) => {
      const id = req.params.id;
      if (!id || !ID.test(id)) return unknown(res);
      try {
        res.json({ ok: true, item: await installer.statusOf(id) });
      } catch (e) {
        softwareFailure(res, e);
      }
    }),
  );
  software.post(
    "/:id/install",
    route(async (req, res) => {
      const id = req.params.id;
      if (!id || !ID.test(id)) return unknown(res);
      const body = parse(InstallBody, req.body, res);
      if (res.headersSent) return;
      try {
        const start = await installer.startInstall(id, {
          ...(body?.approve ? { approved: true } : {}),
          ...(body?.force ? { force: true } : {}),
        });
        if (start.status === "started") changed();
        res.json({ ok: true, result: start });
      } catch (e) {
        softwareFailure(res, e);
      }
    }),
  );
  software.post(
    "/:id/uninstall",
    route(async (req, res) => {
      const id = req.params.id;
      if (!id || !ID.test(id)) return unknown(res);
      parse(EmptyBody, req.body, res);
      if (res.headersSent) return;
      try {
        const result = await installer.uninstall(id);
        if (result.status === "removed") {
          deps.logger?.info({ software: id }, "software removed");
          changed();
        }
        res.json({ ok: true, result });
      } catch (e) {
        softwareFailure(res, e);
      }
    }),
  );
  mountApi(app, "/api/software", software, deps.logger);

  const advisorRouter = apiRouter(deps.origin);
  advisorRouter.get(
    "/goals",
    route((_req, res) => {
      res.json({ ok: true, goals: advisor.list() });
    }),
  );
  advisorRouter.get(
    "/plan",
    route(async (req, res) => {
      const q = parse(PlanQuery, req.query, res);
      if (!q) return;
      const plan = await advisor.plan(q.goal);
      if (!plan) return fail(res, 404, "UNKNOWN_GOAL", "no goal matches that");
      res.json({ ok: true, plan });
    }),
  );
  mountApi(app, "/api/advisor", advisorRouter, deps.logger);
}
