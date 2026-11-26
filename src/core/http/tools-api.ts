// src/core/http/tools-api.ts
//
// The tool playground of the management API.
//
//   GET  /api/tools               every registered tool with its input schema
//   POST /api/tools/:name/call    {arguments?: object, background?: boolean}
//
// A call goes through the tool registry, exactly as a call over MCP does: the
// same argument validation, secret check, redaction, metering and usage
// ledger. It runs as the user (the default profile's scope, every tool).
//
//   200 {ok:true, result}                the tool ran
//   202 {ok:true, job_id}                a long-running tool (or background:true) was
//                                        queued; follow it on /api/jobs/<id> or /api/events
//   400 INVALID_ARGUMENTS                with the validation issues
//   404 UNKNOWN_TOOL
//   409 MISSING_SECRET                   names the secret, never a value
//   422 TOOL_ERROR                       the tool failed (message already redacted)
//   429 JOB_QUEUE_FULL / 413 JOB_INPUT_TOO_LARGE
//
// Behind the admin token, the Origin guard and the CSRF rule; body limit 256 kB.
import type { Express } from "express";
import { z } from "zod";
import type { ScopeFor } from "../mcp/scope-for.js";
import { DEFAULT_PROFILE_ID, requestScope } from "../mcp/scope.js";
import type { TaskEngine } from "../mcp/tasks.js";
import { TOOL_NAME_PATTERN } from "../packs/manifest.js";
import type { ToolCallError, ToolRegistry } from "../tools/registry.js";
import { type ApiLogger, apiRouter, fail, mountApi, parse, route } from "./api-common.js";
import type { OriginPolicy } from "./origin.js";

export interface ToolsApiDeps {
  origin: OriginPolicy;
  logger?: ApiLogger;
  registry: Pick<ToolRegistry, "list" | "get" | "call">;
  /**
   * Builds the scope of a call. The queue uses the same function, so an inline
   * call and a queued one reach exactly the same tools. Absent: no restriction.
   */
  scopeFor?: ScopeFor;
  /** Absent: long-running tools run inline and `background` is refused. */
  tasks?: Pick<TaskEngine, "start">;
  /** True when a secret is set: a queued tool reports a missing key before the job starts. */
  hasSecret?: (name: string) => boolean | Promise<boolean>;
  /** Applied to results: signs the artifact links inside them. */
  decorate?(value: unknown): unknown;
}

const CallBody = z
  .object({
    arguments: z.record(z.string(), z.unknown()).optional(),
    background: z.boolean().optional(),
  })
  .strict();

const STATUS: Record<ToolCallError["code"], number> = {
  UNKNOWN_TOOL: 404,
  INVALID_ARGUMENTS: 400,
  MISSING_SECRET: 409,
  TOOL_ERROR: 422,
  // The spend policy: a person must approve (the error has the link), or it said no.
  APPROVAL_REQUIRED: 403,
  APPROVAL_DENIED: 403,
  APPROVAL_EXPIRED: 403,
  SPEND_BLOCKED: 402,
};

export function mountToolsApi(app: Express, deps: ToolsApiDeps): void {
  const { registry } = deps;
  const decorate = deps.decorate ?? ((v: unknown) => v);
  const router = apiRouter(deps.origin);

  router.get(
    "/",
    route((_req, res) => {
      res.json({
        ok: true,
        tools: registry.list().map((t) => ({
          name: t.name,
          pack: t.packId,
          origin: t.origin,
          description: t.description,
          tags: t.tags,
          capability: t.capability ?? null,
          requires_secrets: t.requiresSecrets,
          long_running: t.longRunning,
          annotations: t.annotations ?? null,
          input_schema: t.inputSchema,
        })),
      });
    }),
  );

  router.post(
    "/:name/call",
    route(async (req, res) => {
      const name = req.params.name ?? "";
      const tool = TOOL_NAME_PATTERN.test(name) ? registry.get(name) : undefined;
      if (!tool) return fail(res, 404, "UNKNOWN_TOOL", "no such tool");
      const body = parse(CallBody, req.body ?? {}, res);
      if (!body) return;
      const args = body.arguments ?? {};
      // The dashboard is the single user: it calls as the default profile, inline or queued.
      const scope = deps.scopeFor
        ? deps.scopeFor(DEFAULT_PROFILE_ID)
        : { profileId: DEFAULT_PROFILE_ID, baseUrl: deps.origin.base() };

      const queued = body.background === true || tool.longRunning;
      if (queued && deps.tasks) {
        // Same order as the MCP server: arguments, then secrets, then the queue.
        const parsed = tool.input.safeParse(args);
        if (!parsed.success) {
          return fail(
            res,
            400,
            "INVALID_ARGUMENTS",
            "the arguments are not valid for this tool",
            parsed.error.issues.slice(0, 20).map((i) => ({
              path: i.path.join("."),
              message: i.message.slice(0, 300),
            })),
          );
        }
        if (deps.hasSecret) {
          for (const secret of tool.requiresSecrets) {
            if (!(await deps.hasSecret(secret))) {
              return res.status(409).json({
                ok: false,
                error: {
                  code: "MISSING_SECRET",
                  message: `the secret ${secret} is not set`,
                  pack: tool.packId,
                  secret,
                },
              });
            }
          }
        }
        // The standard Idempotency-Key header: sending the same queued call
        // twice returns the job it already started (see IDEMPOTENCY_META_KEY).
        const idempotencyKey = req.get("idempotency-key");
        let jobId: string;
        try {
          jobId = deps.tasks.start(name, parsed.data as Record<string, unknown>, {
            profile: DEFAULT_PROFILE_ID,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          });
        } catch (e) {
          const err = e as { name?: string; code?: string; message?: string };
          if (err?.name === "JobIdempotencyError") {
            return fail(
              res,
              err.code === "IDEMPOTENCY_KEY_INVALID" ? 400 : 409,
              String(err.code),
              String(err.message),
            );
          }
          if (err?.name === "JobLimitError") {
            return fail(
              res,
              err.code === "JOB_INPUT_TOO_LARGE" ? 413 : 429,
              String(err.code),
              String(err.message),
            );
          }
          throw e;
        }
        return res.status(202).json({ ok: true, job_id: jobId, tool: name });
      }
      if (body.background === true) {
        return fail(res, 400, "INVALID_REQUEST", "background calls are not available");
      }

      // The caller going away cancels the call.
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on("close", onClose);
      try {
        const envelope = await requestScope.run(scope, () =>
          registry.call(name, args, { signal: abort.signal }),
        );
        if (envelope.ok) {
          res.json({ ok: true, result: decorate(envelope.result) });
          return;
        }
        const { code, message, retryable, issues, pack, secret } = envelope.error;
        res.status(STATUS[code] ?? 422).json({
          ok: false,
          error: {
            code,
            message,
            retryable,
            ...(issues ? { issues } : {}),
            ...(pack ? { pack } : {}),
            ...(secret ? { secret } : {}),
          },
        });
      } finally {
        res.off("close", onClose);
      }
    }),
  );

  mountApi(app, "/api/tools", router, deps.logger);
}
