// src/core/triggers/http.ts
//
// HTTP side of triggers:
//
//   POST /hooks/<id>     inbound webhook. No admin token and no access key: the
//                        per-trigger secret is the credential. Checked in this
//                        order: rate limit, body size, known enabled webhook
//                        trigger, timestamp window, HMAC-SHA256 signature
//                        (timing-safe compare), replay. An unknown id and a
//                        trigger that is not a webhook get the same 404; a
//                        disabled hook is reported only to a signed request.
//   /api/triggers        admin CRUD (admin token or dashboard session, CSRF
//                        rule on writes), mounted after app.use("/api", ...).
import { timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import { type ApiLogger, apiRouter, fail, mountApi, parse, route } from "../http/api-common.js";
import type { OriginPolicy } from "../http/origin.js";
import { CronError, assertSchedulable } from "./cron.js";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  TriggerFireError,
  type TriggerService,
  isWorkflowTool,
  nextSlot,
  sign,
} from "./service.js";
import { MAX_TRIGGERS, type Trigger, type TriggerCallback } from "./store.js";

export const HOOK_PATH = "/hooks";
export const MAX_HOOK_BODY_BYTES = 256 * 1024;
/** A signed request is accepted this long either side of the daemon's clock. */
export const HOOK_TOLERANCE_S = 300;
export const DEFAULT_HOOK_RATE_PER_MIN = 30;
/** All hooks together, so a flood across many ids is bounded too. */
const GLOBAL_HOOK_RATE_FACTOR = 10;
const HOOK_ID = /^trg_[A-Za-z0-9_-]{6,40}$/;

/** Keys one RateLimiter tracks at once; a new key past this is refused. */
const MAX_WINDOWS = 10_000;

/** Fixed one-minute windows per key. */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}
  take(key: string): boolean {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      if (!w && this.windows.size >= MAX_WINDOWS) {
        // Make room from ended windows only: clearing live ones would hand
        // every key a fresh budget.
        for (const [k, old] of this.windows) {
          if (now - old.start >= 60_000) this.windows.delete(k);
        }
        if (this.windows.size >= MAX_WINDOWS) return false;
      }
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    return w.count <= this.perMinute;
  }
}

export interface HookCheck {
  ok: boolean;
  status: number;
  code: string;
  message: string;
}

const refuse = (status: number, code: string, message: string): HookCheck => ({
  ok: false,
  status,
  code,
  message,
});

/** Verify a signed webhook request against a secret. Pure apart from the clock. */
export function verifyHook(
  secret: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  body: Buffer,
  nowMs: number,
  toleranceS = HOOK_TOLERANCE_S,
): HookCheck {
  if (!timestampHeader || !/^\d{1,12}$/.test(timestampHeader)) {
    return refuse(401, "BAD_TIMESTAMP", `missing or malformed ${TIMESTAMP_HEADER} header`);
  }
  const ts = Number(timestampHeader);
  if (Math.abs(nowMs / 1000 - ts) > toleranceS) {
    return refuse(401, "STALE_TIMESTAMP", "the timestamp is outside the accepted window");
  }
  const expected = Buffer.from(sign(secret, timestampHeader, body));
  const given = Buffer.from(String(signatureHeader ?? ""));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return refuse(401, "BAD_SIGNATURE", "the signature does not match");
  }
  return { ok: true, status: 200, code: "OK", message: "ok" };
}

export interface TriggerHttpDeps {
  service: TriggerService;
  origin: OriginPolicy;
  logger: ApiLogger;
  /** Requests per minute per hook. */
  hookRatePerMinute?: number;
  now?: () => number;
}

/** POST /hooks/:id. Mount before the /api guard; it has its own credential. */
export function mountHooks(app: Express, deps: TriggerHttpDeps): void {
  const now = deps.now ?? Date.now;
  const per = deps.hookRatePerMinute ?? DEFAULT_HOOK_RATE_PER_MIN;
  // Signed requests that start a run: each hook, and all hooks together.
  const perHook = new RateLimiter(per, now);
  const global = new RateLimiter(per * GLOBAL_HOOK_RATE_FACTOR, now);
  // Before the signature is checked, requests only use budgets of their own,
  // so unsigned floods cannot use up the budget signed requests start runs
  // with: one per hook id, and one shared by ids that are not webhook triggers
  // (guessing ids cannot use up the budget of the real hooks either).
  const tries = new RateLimiter(per * GLOBAL_HOOK_RATE_FACTOR, now);
  const unknown = new RateLimiter(per * GLOBAL_HOOK_RATE_FACTOR, now);
  const limited = (res: Response) => {
    res.setHeader("retry-after", "60");
    fail(res, 429, "RATE_LIMITED", "too many requests for this hook");
  };
  const store = deps.service.store;
  const notFound = (res: Response) => fail(res, 404, "NOT_FOUND", "no such hook");
  const lookup = (id: string) => (HOOK_ID.test(id) ? store.get(id) : null);

  const limit = (req: Request, res: Response, next: () => void) => {
    const id = String(req.params.id ?? "");
    const known = lookup(id)?.kind === "webhook";
    if (!(known ? tries.take(id) : unknown.take("*"))) return limited(res);
    next();
  };
  const raw = express.raw({ type: () => true, limit: MAX_HOOK_BODY_BYTES });

  app.post(`${HOOK_PATH}/:id`, limit, raw, (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const t = lookup(id);
    const secret = t ? store.secret(t.id) : null;
    if (!t || !secret || t.kind !== "webhook") return notFound(res);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifyHook(
      secret,
      req.header(TIMESTAMP_HEADER),
      req.header(SIGNATURE_HEADER),
      body,
      now(),
    );
    if (!check.ok) return fail(res, check.status, check.code, check.message);
    if (!t.enabled) return fail(res, 409, "DISABLED", "this hook is disabled");
    // Before the replay check, so a sender that was told to wait can resend.
    if (!(perHook.take(t.id) && global.take("*"))) return limited(res);
    // Same signature twice: a replay (the timestamp is part of what is signed).
    if (!store.remember(t.id, String(req.header(SIGNATURE_HEADER)), now())) {
      return fail(res, 409, "REPLAYED", "this request was already received");
    }
    let extra: Record<string, unknown> | undefined;
    if (t.useBody && body.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return fail(res, 400, "INVALID_REQUEST", "the body is not JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return fail(res, 400, "INVALID_REQUEST", "the body must be a JSON object");
      }
      extra = parsed as Record<string, unknown>;
    }
    try {
      const run = deps.service.fire(t, "webhook", extra);
      res.status(202).json({ ok: true, job_id: run.jobId, run_id: run.id });
    } catch (e) {
      const err = e as TriggerFireError;
      const status =
        err.code === "INVALID_INPUT"
          ? 400
          : err.code === "UNKNOWN_WORKFLOW"
            ? 409
            : err.code === "BUSY"
              ? 429
              : 503;
      fail(res, status, err.code ?? "START_FAILED", err.message);
    }
  });
  // Any other method on a hook path: refused without reading a body.
  app.all(`${HOOK_PATH}/:id`, (_req, res) => fail(res, 405, "METHOD_NOT_ALLOWED", "use POST"));
}

// ---------------------------------------------------------------------------
// /api/triggers
// ---------------------------------------------------------------------------

const Name = z.string().trim().min(1).max(80);
const Args = z.record(z.string(), z.unknown());
const Zone = z.enum(["UTC", "local"]);
const Callback = z.union([
  z
    .object({
      type: z.literal("webhook"),
      url: z
        .string()
        .max(2000)
        .refine((u) => {
          try {
            const p = new URL(u);
            return (
              (p.protocol === "https:" || p.protocol === "http:") && !p.username && !p.password
            );
          } catch {
            return false;
          }
        }, "must be an http(s) URL without credentials"),
    })
    .strict(),
  z
    .object({
      type: z.literal("telegram"),
      chat_id: z
        .string()
        .regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/)
        .optional(),
    })
    .strict(),
]);

const Create = z
  .object({
    name: Name,
    kind: z.enum(["cron", "webhook"]),
    workflow: z.string().min(1).max(128),
    args: Args.optional(),
    schedule: z.string().max(200).optional(),
    timezone: Zone.optional(),
    catch_up: z.boolean().optional(),
    use_body: z.boolean().optional(),
    enabled: z.boolean().optional(),
    profile: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    callback: Callback.nullable().optional(),
  })
  .strict();

const Patch = z
  .object({
    name: Name.optional(),
    args: Args.optional(),
    schedule: z.string().max(200).optional(),
    timezone: Zone.optional(),
    catch_up: z.boolean().optional(),
    use_body: z.boolean().optional(),
    enabled: z.boolean().optional(),
    callback: Callback.nullable().optional(),
  })
  .strict();

export interface TriggerApiDeps extends TriggerHttpDeps {
  /** The daemon's base URL, for webhook URLs. */
  baseUrl: () => string;
  /** True when the profile exists. Absent: any profile name is accepted. */
  profileExists?: (id: string) => boolean;
}

export function triggerView(t: Trigger, baseUrl: string) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    workflow: t.workflow,
    args: t.args,
    schedule: t.schedule,
    timezone: t.timezone,
    catch_up: t.catchUp,
    use_body: t.useBody,
    enabled: t.enabled,
    profile: t.profile,
    callback: t.callback,
    webhook_url: t.kind === "webhook" ? `${baseUrl}${HOOK_PATH}/${t.id}` : null,
    next_run_at: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
    last_run: t.lastRunAt
      ? {
          at: new Date(t.lastRunAt).toISOString(),
          job_id: t.lastJobId,
          status: t.lastStatus,
          error: t.lastError,
        }
      : null,
    created_at: new Date(t.createdAt).toISOString(),
    updated_at: new Date(t.updatedAt).toISOString(),
  };
}

export function mountTriggerApi(app: Express, deps: TriggerApiDeps): void {
  const { service } = deps;
  const store = service.store;
  const registry = service.registry;
  const now = deps.now ?? Date.now;
  const router = apiRouter(deps.origin);
  const view = (t: Trigger) => triggerView(t, deps.baseUrl());

  /** Validate a workflow name and its default arguments against the tool's input schema. */
  const checkWorkflow = (
    res: Response,
    workflow: string,
    args: Record<string, unknown>,
    kind: string,
  ) => {
    const tool = isWorkflowTool(workflow) ? registry.get(workflow) : undefined;
    if (!tool) {
      fail(res, 400, "UNKNOWN_WORKFLOW", `${workflow} is not a loaded workflow (wf_<name>)`);
      return false;
    }
    // A webhook may complete its input from the request body, so only a cron
    // trigger's arguments must already be a complete, valid input.
    if (kind === "cron") {
      const parsed = tool.input.safeParse(args);
      if (!parsed.success) {
        fail(
          res,
          400,
          "INVALID_INPUT",
          "args are not a valid input for this workflow",
          parsed.error.issues
            .slice(0, 10)
            .map((i) => ({ path: i.path.join("."), message: i.message })),
        );
        return false;
      }
    }
    return true;
  };
  const checkSchedule = (res: Response, schedule: string, zone: "UTC" | "local") => {
    try {
      assertSchedulable(schedule, zone);
      return true;
    } catch (e) {
      fail(res, 400, "INVALID_SCHEDULE", e instanceof CronError ? e.message : "invalid schedule");
      return false;
    }
  };

  router.get(
    "/",
    route((_req, res) => {
      res.json({ ok: true, triggers: store.list().map(view) });
    }),
  );

  router.get(
    "/workflows",
    route((_req, res) => {
      const workflows = registry
        .list()
        .filter((t) => isWorkflowTool(t.name))
        .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      res.json({ ok: true, workflows });
    }),
  );

  router.post(
    "/",
    route((req, res) => {
      const body = parse(Create, req.body, res);
      if (!body) return;
      if (store.count() >= MAX_TRIGGERS) {
        return fail(res, 409, "LIMIT", `at most ${MAX_TRIGGERS} triggers`);
      }
      const args = body.args ?? {};
      if (!checkWorkflow(res, body.workflow, args, body.kind)) return;
      const zone = body.timezone ?? "UTC";
      let schedule: string | null = null;
      if (body.kind === "cron") {
        if (!body.schedule)
          return fail(res, 400, "INVALID_SCHEDULE", "a cron trigger needs a schedule");
        if (!checkSchedule(res, body.schedule, zone)) return;
        schedule = body.schedule.trim();
      } else if (body.schedule) {
        return fail(res, 400, "INVALID_REQUEST", "a webhook trigger has no schedule");
      }
      if (body.profile && deps.profileExists && !deps.profileExists(body.profile)) {
        return fail(res, 400, "UNKNOWN_PROFILE", `profile ${body.profile} does not exist`);
      }
      const enabled = body.enabled ?? true;
      const { trigger, secret } = store.create({
        name: body.name,
        kind: body.kind,
        workflow: body.workflow,
        args,
        schedule,
        timezone: zone,
        catchUp: body.catch_up ?? false,
        useBody: body.use_body ?? false,
        enabled,
        profile: body.profile ?? null,
        callback: (body.callback ?? null) as TriggerCallback | null,
        nextRunAt: schedule && enabled ? nextSlot(schedule, zone, now()) : null,
      });
      deps.logger.info({ trigger: trigger.id, kind: trigger.kind }, "trigger created");
      // The secret is shown here and on rotation only.
      res.status(201).json({ ok: true, trigger: view(trigger), secret });
    }),
  );

  router.get(
    "/:id",
    route((req, res) => {
      const t = store.get(String(req.params.id));
      if (!t) return fail(res, 404, "NOT_FOUND", "no such trigger");
      res.json({ ok: true, trigger: view(t), runs: store.runs(t.id) });
    }),
  );

  router.patch(
    "/:id",
    route((req, res) => {
      const t = store.get(String(req.params.id));
      if (!t) return fail(res, 404, "NOT_FOUND", "no such trigger");
      const body = parse(Patch, req.body, res);
      if (!body) return;
      const args = body.args ?? t.args;
      if (body.args && !checkWorkflow(res, t.workflow, args, t.kind)) return;
      if (t.kind === "webhook" && (body.schedule || body.catch_up !== undefined)) {
        return fail(res, 400, "INVALID_REQUEST", "a webhook trigger has no schedule");
      }
      const zone = body.timezone ?? t.timezone;
      const schedule = body.schedule?.trim() ?? t.schedule;
      if (body.schedule && !checkSchedule(res, body.schedule, zone)) return;
      const enabled = body.enabled ?? t.enabled;
      // A changed schedule or a re-enabled trigger starts from now: no catch-up
      // of the time it was off.
      const reschedule =
        t.kind === "cron" &&
        schedule !== null &&
        (body.schedule !== undefined || body.timezone !== undefined || (enabled && !t.enabled));
      const updated = store.update(t.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.args !== undefined ? { args: body.args } : {}),
        ...(body.schedule !== undefined ? { schedule } : {}),
        ...(body.timezone !== undefined ? { timezone: zone } : {}),
        ...(body.catch_up !== undefined ? { catchUp: body.catch_up } : {}),
        ...(body.use_body !== undefined ? { useBody: body.use_body } : {}),
        ...(body.enabled !== undefined ? { enabled } : {}),
        ...(body.callback !== undefined
          ? { callback: (body.callback ?? null) as TriggerCallback | null }
          : {}),
        ...(reschedule ? { nextRunAt: enabled ? nextSlot(schedule, zone, now()) : null } : {}),
        ...(t.kind === "cron" && !enabled ? { nextRunAt: null } : {}),
      });
      if (!updated) return fail(res, 404, "NOT_FOUND", "no such trigger");
      res.json({ ok: true, trigger: view(updated) });
    }),
  );

  router.delete(
    "/:id",
    route((req, res) => {
      if (!store.delete(String(req.params.id)))
        return fail(res, 404, "NOT_FOUND", "no such trigger");
      res.json({ ok: true });
    }),
  );

  router.post(
    "/:id/run",
    route((req, res) => {
      const t = store.get(String(req.params.id));
      if (!t) return fail(res, 404, "NOT_FOUND", "no such trigger");
      try {
        const run = service.fire(t, "manual");
        res.status(202).json({ ok: true, job_id: run.jobId, run_id: run.id });
      } catch (e) {
        if (e instanceof TriggerFireError) return fail(res, 409, e.code, e.message);
        throw e;
      }
    }),
  );

  router.post(
    "/:id/rotate-secret",
    route((req, res) => {
      const secret = store.rotateSecret(String(req.params.id));
      if (!secret) return fail(res, 404, "NOT_FOUND", "no such trigger");
      res.json({ ok: true, secret });
    }),
  );

  mountApi(app, "/api/triggers", router, deps.logger);
}
