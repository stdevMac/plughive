// src/core/mcp/server.ts
//
// Builds the low-level MCP `Server` for ONE request. It serves the tools of
// one exposure profile and adds, on top of the ToolRegistry:
//   - the search surface (search_tools / describe_tool / execute_tool)
//   - long-running tools as jobs: an MCP task for clients that declare the
//     tasks extension on the request, `{ job_id, status, wait_with }` for the rest
//   - wait_for_job / cancel_job
//   - progress notifications (when the request carries a progress token)
//   - missing keys: URL elicitation to the local setup page for clients that
//     support it, a plain explanatory error result for the rest
// A caller only ever reaches tools and jobs of its own profile.
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  inputRequired,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Exposure, LIST_ALL_PROFILE, type Profile, resolveExposure } from "../profiles.js";
import {
  NOT_SERIALISABLE_MESSAGE,
  type RegisteredTool,
  type ToolCallError,
  type ToolEnvelope,
  type ToolRegistry,
} from "../tools/registry.js";
import {
  CancelJobInput,
  DescribeToolInput,
  ExecuteToolInput,
  SearchToolsInput,
  type SearchableTool,
  WaitForJobInput,
  searchTools,
} from "./meta.js";
import {
  type ResourceLibrary,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
  resourceTemplates,
  resourcesVisible,
} from "./resources.js";
import { DEFAULT_PROFILE_ID, type RequestScope, canSeeJob, requestScope } from "./scope.js";
import { type SetupTokens, safeHelpUrl, safeLabel } from "./setup-token.js";
import {
  IDEMPOTENCY_META_KEY,
  TASKS_EXTENSION,
  type TaskEngine,
  type TaskJob,
  isTerminal,
  jobErrorCode,
  taskState,
} from "./tasks.js";

export type { RequestScope } from "./scope.js";

export const SERVER_INFO = { name: "plughive", version: "0.1.0" } as const;
/** A tools/call result text larger than this is cut, with a notice. */
export const MAX_RESULT_TEXT_BYTES = 1024 * 1024;
const RESULT_PREVIEW_CHARS = 100_000;
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SETUP_INPUT_KEY = "secret_setup";
/** inputResponses key of the install-approval URL elicitation. */
const INSTALL_APPROVAL_INPUT_KEY = "install_approval";

/**
 * Told to every client at initialize: where to turn when something is missing.
 * Clients that show server instructions to the model make setup_plan the first
 * stop instead of guessing install commands.
 */
export const SERVER_INSTRUCTIONS =
  "plughive serves media, research and automation tools from one local daemon. " +
  "When a tool fails because a program is not installed, a key is not set or a pack is switched off, " +
  "call setup_plan with the user's goal (or list_installable / software_status for one program) " +
  "before suggesting manual steps: it lists free and local options first and says how to set each up. " +
  "install_software installs into plughive's own folder without admin rights; " +
  "when it answers approval_required, ask the user to approve it, call install_software again once, then wait_for_job. " +
  "A call that answers APPROVAL_REQUIRED went over a spend cap or rule: ask the user to approve it on the dashboard, then retry it once. " +
  "To add an MCP server the user asks for, look in list_mounts first (enable_mount, or connect_mount for an OAuth sign-in); " +
  "otherwise add_mount proposes it, and it is added once the user approves it. " +
  "optimize_mounts lists mounts that are unused, costly or failing; ask the user before it parks (switches off) any. " +
  "search_tools also finds tools of parked mounts (marked parked): describing or calling one switches its mount back on. " +
  "Keys are typed on the dashboard, never in chat.";

/** inputResponses key of the spend-approval URL elicitation. */
const SPEND_APPROVAL_INPUT_KEY = "spend_approval";
/** inputResponses key of the in-chat approve/deny form (policy rule approve_in_chat). */
const APPROVAL_FORM_INPUT_KEY = "approval_decision";

export interface McpLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Tools smart mount took out of a profile (parked mounts, hidden tools) that
 * it can bring back when an agent asks for one (src/core/mounts/smart.ts).
 */
export interface DormantTools {
  list(profile: Profile): Array<SearchableTool & { mount: string; reason: "parked" | "hidden" }>;
  wake(
    profile: Profile,
    name: string,
  ): Promise<{ status: "none" } | { status: "ask" | "woken"; message: string }>;
}

export interface McpServerDeps {
  registry: ToolRegistry;
  /** Smart mount's parked and hidden tools. Absent: search sees only exposed tools. */
  dormant?: DormantTools;
  /** Looks a profile up by id. Absent: every tool is listed (no profiles). */
  profile?: (id: string) => Profile | undefined;
  /** Job-backed tasks. Absent: long-running tools run inline. */
  tasks?: TaskEngine;
  /**
   * Builds the scope an inline call runs in; the job queue is given the same
   * function. Absent: the tools exposed to this request.
   */
  scopeFor?: (profileId: string | undefined) => RequestScope;
  /** Setup-page tokens. Absent: missing keys are always reported as text. */
  setup?: SetupTokens;
  /**
   * True when the secret is set. Lets a long-running tool report a missing key
   * right away instead of from inside a background job.
   */
  hasSecret?: (name: string) => boolean | Promise<boolean>;
  /**
   * What the owning pack's manifest says about one of its secrets, or
   * undefined when it declares none by that name. When given, it is the only
   * source of the label and help link shown to the user.
   */
  secretInfo?: (pack: string, secret: string) => { label?: string; helpUrl?: string } | undefined;
  /** Last step before a successful result is sent (e.g. signs artifact links). */
  decorateResult?: (result: unknown) => unknown;
  /**
   * Redacts stored secret values in text sent to the client. Applied to
   * resources/read contents exactly as the registry applies it to tool
   * results and errors.
   */
  redact?: (text: string) => string;
  /** The library, served as `artifact://` resources. Absent: no resources capability. */
  library?: ResourceLibrary;
  /**
   * Approvals answered by the client's own form (the policy's approve_in_chat
   * rule). Absent: approvals are only decided on the dashboard, Telegram or the tray.
   */
  chatApprovals?: {
    allowed(profile: string): boolean;
    decide(id: string, approve: boolean, profile: string): boolean;
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface HandlerCtx {
  mcpReq: {
    _meta?: { progressToken?: string | number; [key: string]: unknown };
    envelope?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    signal: AbortSignal;
    notify(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
  };
}

function stringify(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : null;
  } catch {
    return null;
  }
}

interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  [key: string]: unknown;
}

function errorResult(error: ErrorBody, extra: string[] = []): ToolResult {
  const body =
    stringify({ ok: false, error }) ??
    `{"ok":false,"error":{"code":"TOOL_ERROR","message":"the tool failed","retryable":false}}`;
  return {
    content: [
      { type: "text", text: body },
      ...extra.map((t) => ({ type: "text" as const, text: t })),
    ],
    isError: true,
  };
}

/**
 * A successful tool result as tools/call content. A value that cannot be
 * serialised is a clean tool error; a text over the size limit is cut and says so.
 */
export function okResult(result: unknown): ToolResult {
  const json = stringify({ ok: true, result: result === undefined ? null : result });
  if (json === null) {
    return errorResult({ code: "TOOL_ERROR", message: NOT_SERIALISABLE_MESSAGE, retryable: false });
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_RESULT_TEXT_BYTES) return { content: [{ type: "text", text: json }] };
  const notice = `The result was ${bytes} bytes, over the ${MAX_RESULT_TEXT_BYTES} byte limit, and was cut. Nothing after result_preview was sent. Large outputs belong in artifacts: use list_artifacts to find files the tool saved, or ask the tool for a smaller result.`;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          truncated: true,
          notice,
          result_preview: json.slice(0, RESULT_PREVIEW_CHARS),
        }),
      },
    ],
  };
}

const invalidParams = (message: string, data?: unknown) =>
  new ProtocolError(ProtocolErrorCode.InvalidParams, message, data);

/** The label and help link of a missing-key error, made safe to show. */
function presentable(error: ToolCallError): ToolCallError {
  const { label: rawLabel, helpUrl: rawHelp, ...rest } = error;
  const label = safeLabel(rawLabel);
  const helpUrl = safeHelpUrl(rawHelp);
  return { ...rest, ...(label ? { label } : {}), ...(helpUrl ? { helpUrl } : {}) };
}

/** How to supply a missing key, for clients that cannot be sent to the setup page. */
export function missingSecretHelp(rawError: ToolCallError, baseUrl?: string): string {
  const error = presentable(rawError);
  const what = error.label ? `${error.secret} (${error.label})` : `${error.secret}`;
  const lines = [
    `The tool needs a key that is not set: ${what}, used by the pack "${error.pack}".`,
    baseUrl
      ? `Set it in the plughive dashboard at ${baseUrl}/ under the pack "${error.pack}", or set the environment variable ${error.secret} and restart plughive.`
      : `Set the environment variable ${error.secret} and restart plughive, or set it in the plughive dashboard.`,
  ];
  // Only an https link is ever printed.
  if (error.helpUrl) lines.push(`Where to get it: ${error.helpUrl}`);
  lines.push("The key itself must never be sent through this chat.");
  return lines.join("\n");
}

/** What to do about a call that waits for a person's approval. */
export function approvalHelp(url: string): string {
  return [
    `This call needs a person's approval first (spend policy). Ask the user to open ${url} , sign in to the plughive dashboard and approve it.`,
    "Then call the same tool again with exactly the same arguments: the approval covers that one call, once.",
  ].join("\n");
}

/** A registry envelope as a tools/call result. Unknown tool and bad arguments are protocol errors. */
export function envelopeToResult(
  envelope: ToolEnvelope,
  baseUrl?: string,
  decorate?: (result: unknown) => unknown,
): ToolResult {
  if (envelope.ok) return okResult(decorate ? decorate(envelope.result) : envelope.result);
  const { error } = envelope;
  if (error.code === "UNKNOWN_TOOL") throw invalidParams(error.message);
  if (error.code === "INVALID_ARGUMENTS")
    throw invalidParams(error.message, { issues: error.issues });
  if (error.code === "MISSING_SECRET") {
    const shown = presentable(error);
    return errorResult({ ...shown }, [missingSecretHelp(shown, baseUrl)]);
  }
  if (error.code === "APPROVAL_REQUIRED" && error.approval) {
    return errorResult({ ...error }, [approvalHelp(error.approval.url)]);
  }
  return errorResult({ ...error });
}

function clientCapabilities(ctx: HandlerCtx): Record<string, unknown> {
  const caps = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_KEY];
  return caps !== null && typeof caps === "object" ? (caps as Record<string, unknown>) : {};
}

function declaresTasks(ctx: HandlerCtx): boolean {
  const extensions = clientCapabilities(ctx).extensions;
  return extensions !== null && typeof extensions === "object" && TASKS_EXTENSION in extensions;
}

function acceptsUrlElicitation(ctx: HandlerCtx): boolean {
  const elicitation = clientCapabilities(ctx).elicitation;
  return elicitation !== null && typeof elicitation === "object" && "url" in elicitation;
}

/**
 * Form mode: declared as `elicitation.form`, or as an empty `elicitation`
 * object (clients from before URL mode existed only had forms).
 */
function acceptsFormElicitation(ctx: HandlerCtx): boolean {
  const elicitation = clientCapabilities(ctx).elicitation;
  if (elicitation === null || typeof elicitation !== "object") return false;
  return "form" in elicitation || Object.keys(elicitation).length === 0;
}

/** The person's answer to the approve/deny form: approve, deny, or none (closed without answering). */
function formDecision(response: unknown): "approve" | "deny" | null {
  if (response === null || typeof response !== "object") return null;
  const { action, content } = response as { action?: unknown; content?: unknown };
  if (action === "decline") return "deny";
  if (action !== "accept" || content === null || typeof content !== "object") return null;
  const decision = (content as { decision?: unknown }).decision;
  return decision === "approve" || decision === "deny" ? decision : null;
}

function parseArgs<T extends z.ZodType>(tool: string, schema: T, args: unknown): z.output<T> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw invalidParams(`invalid arguments for ${tool}: ${z.prettifyError(parsed.error)}`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

const jobNotFound = (jobId: string): ToolResult =>
  errorResult({ code: "TOOL_ERROR", message: `job ${jobId} not found`, retryable: false });

export function buildMcpServer(
  deps: McpServerDeps,
  era: "legacy" | "modern",
  scope: RequestScope = {},
): Server {
  const { registry, tasks } = deps;
  const modern = era === "modern";
  const callerProfile = scope.profileId ?? DEFAULT_PROFILE_ID;
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      prompts: {},
      ...(deps.library ? { resources: {} } : {}),
      // Only modern requests can carry the per-request extension declaration.
      ...(modern && tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {}),
    },
    instructions: SERVER_INSTRUCTIONS,
  });

  const currentProfile = (): Profile => {
    const profile = deps.profile ? deps.profile(callerProfile) : LIST_ALL_PROFILE;
    // The HTTP layer answers 404 for unknown profiles before we get here.
    if (!profile) throw invalidParams("unknown profile");
    return profile;
  };
  const exposure = (): Exposure =>
    resolveExposure(currentProfile(), registry, { jobs: tasks !== undefined });

  const progressSink = (ctx: HandlerCtx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    if (token === undefined) return undefined;
    return (fraction: number, message?: string) => {
      const progress = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
      void ctx.mcpReq
        .notify({
          method: "notifications/progress",
          params: { progressToken: token, progress, total: 1, ...(message ? { message } : {}) },
        })
        .catch(() => {});
    };
  };

  /** A job the caller's profile may see, or null (same answer as "does not exist"). */
  const visibleJob = (id: string): TaskJob | null => {
    const job = tasks?.get(id) ?? null;
    return job && canSeeJob(job.profile, callerProfile) ? job : null;
  };

  /** The first declared secret of `tool` that is not set, when that can be known up front. */
  const firstMissingSecret = async (tool: RegisteredTool): Promise<string | null> => {
    if (!deps.hasSecret) return null;
    for (const name of tool.requiresSecrets) {
      try {
        if (!(await deps.hasSecret(name))) return name;
      } catch {
        return null; // cannot tell: let the tool report it
      }
    }
    return null;
  };

  /** Label and help link of a missing key: from the owning pack's manifest when known. */
  const describeMissing = (error: ToolCallError): ToolCallError => {
    if (!deps.secretInfo || !error.pack || !error.secret) return presentable(error);
    let info: { label?: string; helpUrl?: string } | undefined;
    try {
      info = deps.secretInfo(error.pack, error.secret);
    } catch {
      info = undefined;
    }
    const { label: _label, helpUrl: _helpUrl, ...rest } = error;
    return presentable({
      ...rest,
      ...(info?.label !== undefined ? { label: info.label } : {}),
      ...(info?.helpUrl !== undefined ? { helpUrl: info.helpUrl } : {}),
    });
  };

  /** A missing key: the setup page for clients that can open it, an explanation for the rest. */
  const missingSecret = (rawError: ToolCallError, ctx: HandlerCtx): unknown => {
    const error = describeMissing(rawError);
    const { pack, secret, label, helpUrl } = error;
    const alreadyAsked = ctx.mcpReq.inputResponses?.[SETUP_INPUT_KEY] !== undefined;
    if (
      modern &&
      deps.setup &&
      scope.baseUrl &&
      pack &&
      secret &&
      !alreadyAsked &&
      acceptsUrlElicitation(ctx)
    ) {
      // An odd pack or secret name cannot be minted: fall back to text, never a protocol error.
      const token = deps.setup.tryMint({
        pack,
        secret,
        ...(label ? { label } : {}),
        ...(helpUrl ? { helpUrl } : {}),
      });
      if (token) {
        return inputRequired({
          inputRequests: {
            [SETUP_INPUT_KEY]: inputRequired.elicitUrl({
              message: `plughive needs ${label ?? secret} (${secret}) for the pack "${pack}". Open the local setup page to store it. The key stays on this machine and is never sent through the chat.`,
              url: `${scope.baseUrl}/setup/secret?token=${token}`,
            }),
          },
        });
      }
    }
    return envelopeToResult({ ok: false, error }, scope.baseUrl);
  };

  /**
   * A system-pack install that needs the user's OK: clients that can open a
   * URL get the dashboard's approval page as an elicitation; the rest (and a
   * retry after the page was shown) get the result with its link as text.
   */
  const approvalRequest = (
    tool: RegisteredTool,
    envelope: ToolEnvelope,
    ctx: HandlerCtx,
  ): unknown | null => {
    if (tool.packId !== "system" || !envelope.ok) return null;
    const result = envelope.result as {
      status?: unknown;
      approval_path?: unknown;
      message?: unknown;
    };
    if (result?.status !== "approval_required" || typeof result.approval_path !== "string") {
      return null;
    }
    // Only a dashboard path, never a link a tool result made up.
    if (!/^\/software\?install=[A-Za-z0-9._%-]{1,120}$/.test(result.approval_path)) return null;
    const alreadyAsked = ctx.mcpReq.inputResponses?.[INSTALL_APPROVAL_INPUT_KEY] !== undefined;
    if (!modern || !scope.baseUrl || alreadyAsked || !acceptsUrlElicitation(ctx)) return null;
    return inputRequired({
      inputRequests: {
        [INSTALL_APPROVAL_INPUT_KEY]: inputRequired.elicitUrl({
          message: `${typeof result.message === "string" ? result.message : "This install needs your approval."} Open the plughive dashboard to review and approve it.`,
          url: `${scope.baseUrl}${result.approval_path}`,
        }),
      },
    });
  };

  /** Run one exposed registry tool for this request. */
  const runTool = async (
    tool: RegisteredTool,
    args: unknown,
    ctx: HandlerCtx,
    exposed: readonly RegisteredTool[],
  ): Promise<unknown> => {
    const names = new Set(exposed.map((t) => t.name));
    // Long-running: validate now, run as a job. Invalid arguments fall through
    // to the inline path, which reports them without running anything. A
    // workflow dry run only plans, so it answers inline too.
    const dryRun =
      tool.origin === "workflow" && (args as { dry_run?: unknown } | undefined)?.dry_run === true;
    if (tool.longRunning && !dryRun && tasks && tool.input.safeParse(args ?? {}).success) {
      const missing = await firstMissingSecret(tool);
      if (missing) {
        return missingSecret(
          {
            code: "MISSING_SECRET",
            message: `Pack "${tool.packId}" needs the secret ${missing}, which is not set.`,
            retryable: false,
            pack: tool.packId,
            secret: missing,
          },
          ctx,
        );
      }
      const idempotencyKey = ctx.mcpReq._meta?.[IDEMPOTENCY_META_KEY];
      let jobId: string;
      try {
        jobId = tasks.start(tool.name, (args ?? {}) as Record<string, unknown>, {
          profile: callerProfile,
          // Passed as it came: a malformed key is refused, never ignored.
          ...(idempotencyKey !== undefined ? { idempotencyKey: idempotencyKey as string } : {}),
        });
      } catch (e) {
        const limit = e as { name?: unknown; code?: unknown; message?: unknown };
        if (limit?.name === "JobIdempotencyError" && typeof limit.code === "string") {
          if (limit.code === "IDEMPOTENCY_KEY_INVALID") {
            throw invalidParams(`_meta["${IDEMPOTENCY_META_KEY}"]: ${String(limit.message)}`);
          }
          return errorResult({
            code: limit.code,
            message: String(limit.message),
            retryable: false,
          });
        }
        if (limit?.name === "JobLimitError" && typeof limit.code === "string") {
          return errorResult({
            code: limit.code,
            message: String(limit.message),
            retryable: limit.code === "JOB_QUEUE_FULL",
          });
        }
        throw e;
      }
      const job = tasks.get(jobId);
      if (modern && declaresTasks(ctx) && job) {
        return { resultType: "task", ...taskState(job, tasks.ttlMs) };
      }
      // Only name tools this caller can actually call.
      return okResult({
        job_id: jobId,
        status: job?.status ?? "queued",
        wait_with: "wait_for_job",
        cancel_with: "cancel_job",
        ...(names.has("get_job_status") ? { poll_with: "get_job_status" } : {}),
      });
    }

    const progress = progressSink(ctx);
    const call = () =>
      requestScope.run(
        deps.scopeFor
          ? { ...scope, ...deps.scopeFor(callerProfile) }
          : {
              ...scope,
              profileId: callerProfile,
              allows: (name) => names.has(name),
              // Same rule as scope-for.ts: every profile, the default one
              // included, only reaches the providers of packs it exposes.
              allowsProviderPack: (pack: string) => exposed.some((t) => t.packId === pack),
            },
        () =>
          registry.call(tool.name, args ?? {}, {
            signal: ctx.mcpReq.signal,
            ...(progress ? { progress } : {}),
          }),
      );
    let envelope = await call();

    // In-chat approval (opt-in): a form the client shows, then the same call again.
    const pending =
      !envelope.ok && envelope.error.code === "APPROVAL_REQUIRED"
        ? envelope.error.approval
        : undefined;
    const chat = deps.chatApprovals;
    if (pending && modern && chat?.allowed(callerProfile) && acceptsFormElicitation(ctx)) {
      const answer = ctx.mcpReq.inputResponses?.[APPROVAL_FORM_INPUT_KEY];
      if (answer === undefined) {
        const estimate =
          typeof pending.estimate_usd === "number"
            ? ` Estimated cost: $${pending.estimate_usd.toFixed(4)}.`
            : "";
        return inputRequired({
          inputRequests: {
            [APPROVAL_FORM_INPUT_KEY]: inputRequired.elicit({
              message: `plughive asks before ${tool.name} runs: ${pending.reason.replace(/[.\s]+$/, "")}.${estimate} Approve this one call?`,
              requestedSchema: {
                type: "object",
                properties: {
                  decision: {
                    type: "string",
                    title: "Decision",
                    description: "Approve runs this call once; deny stops it.",
                    enum: ["approve", "deny"],
                  },
                },
                required: ["decision"],
              },
            }),
          },
        });
      }
      const decision = formDecision(answer);
      // The id is the one the gate just returned for this call, never one the client sent.
      if (decision && chat.decide(pending.id, decision === "approve", callerProfile)) {
        envelope = await call();
      }
    }

    if (!envelope.ok && envelope.error.code === "MISSING_SECRET") {
      return missingSecret(envelope.error, ctx);
    }
    const approval = approvalRequest(tool, envelope, ctx);
    if (approval) return approval;
    const spendApproval =
      !envelope.ok && envelope.error.code === "APPROVAL_REQUIRED"
        ? envelope.error.approval
        : undefined;
    // Asked once per request: a retry that still finds the request pending gets the text.
    if (
      spendApproval &&
      modern &&
      ctx.mcpReq.inputResponses?.[SPEND_APPROVAL_INPUT_KEY] === undefined &&
      // A form already answered (or closed) this round: the link goes back as text.
      ctx.mcpReq.inputResponses?.[APPROVAL_FORM_INPUT_KEY] === undefined &&
      acceptsUrlElicitation(ctx)
    ) {
      return inputRequired({
        inputRequests: {
          [SPEND_APPROVAL_INPUT_KEY]: inputRequired.elicitUrl({
            message: `${spendApproval.reason} Open the plughive dashboard to approve or deny it (the request expires at ${spendApproval.expires_at}).`,
            url: spendApproval.url,
          }),
        },
      });
    }
    return envelopeToResult(envelope, scope.baseUrl, deps.decorateResult);
  };

  const waitForJob = async (args: unknown, ctx: HandlerCtx): Promise<ToolResult> => {
    if (!tasks) throw invalidParams("unknown tool: wait_for_job");
    const input = parseArgs("wait_for_job", WaitForJobInput, args);
    if (!visibleJob(input.job_id)) return jobNotFound(input.job_id);
    const progress = progressSink(ctx);
    let last: number | null = null;
    const job = await tasks.wait(input.job_id, input.timeout_s * 1000, ctx.mcpReq.signal, (j) => {
      if (progress && j.progress != null && j.progress !== last) {
        last = j.progress;
        progress(j.progress);
      }
    });
    if (!job) return jobNotFound(input.job_id);
    const done = isTerminal(job.status);
    return okResult({
      job_id: job.id,
      status: job.status,
      done,
      progress: job.progress,
      ...(job.status === "succeeded"
        ? { result: deps.decorateResult ? deps.decorateResult(job.result) : job.result }
        : {}),
      // The job-level code existing clients know; the tool's own code is on tasks/get.
      ...(job.error ? { error: { code: "JOB_FAILED", message: job.error } } : {}),
      ...(done ? {} : { hint: "Not finished yet. Call wait_for_job again with the same job_id." }),
    });
  };

  const cancelJob = (args: unknown): ToolResult => {
    if (!tasks) throw invalidParams("unknown tool: cancel_job");
    const input = parseArgs("cancel_job", CancelJobInput, args);
    if (!visibleJob(input.job_id)) return jobNotFound(input.job_id);
    const cancelled = tasks.cancel(input.job_id);
    const job = tasks.get(input.job_id);
    return okResult({
      job_id: input.job_id,
      cancelled,
      status: job?.status ?? "cancelled",
      ...(cancelled ? {} : { note: "The job had already finished; nothing was changed." }),
    });
  };

  server.setRequestHandler("tools/list", async () => ({
    // biome-ignore lint/suspicious/noExplicitAny: json-schema passthrough
    tools: exposure().tools as any,
  }));

  // biome-ignore lint/suspicious/noExplicitAny: task and input-required results are wider than the SDK's tools/call type
  server.setRequestHandler("tools/call", (async (req: any, rawCtx: any) => {
    const ctx = rawCtx as HandlerCtx;
    const name: string = req.params.name;
    const args: unknown = req.params.arguments ?? {};
    let exposed = exposure().exposed;
    const find = (n: string) => exposed.find((t) => t.name === n);
    /**
     * A tool this profile cannot see: if smart mount took it away, bring it
     * back and look again. Returns the tool, why it cannot be used yet, or
     * null when smart mount has nothing to do with it.
     */
    const revive = async (n: string): Promise<RegisteredTool | ErrorBody | null> => {
      if (!deps.dormant) return null;
      const woke = await deps.dormant.wake(currentProfile(), n);
      if (woke.status === "none") return null;
      if (woke.status === "ask") {
        return { code: "TOOL_PARKED", message: woke.message, retryable: true, tool: n };
      }
      exposed = exposure().exposed;
      return (
        find(n) ?? {
          code: "TOOL_UNAVAILABLE",
          message: `${woke.message}, but ${n} is not available yet (its server is still connecting): try again in a few seconds`,
          retryable: true,
          tool: n,
        }
      );
    };
    const isTool = (x: RegisteredTool | ErrorBody): x is RegisteredTool => "run" in x;
    const resolve = async (n: string): Promise<RegisteredTool | ToolResult> => {
      const tool = find(n) ?? (await revive(n));
      // Same answer for "does not exist" and "not in this profile".
      if (!tool) throw invalidParams(`unknown tool: ${n}`);
      return isTool(tool) ? tool : errorResult(tool);
    };
    const usable = (x: RegisteredTool | ToolResult): x is RegisteredTool => "run" in x;

    switch (name) {
      case "search_tools": {
        const input = parseArgs(name, SearchToolsInput, args);
        const visible = new Set(exposed.map((t) => t.name));
        const dormant = deps.dormant
          ? deps.dormant.list(currentProfile()).filter((t) => !visible.has(t.name))
          : [];
        const parked = new Map(dormant.map((t) => [t.name, t]));
        const { hits, total } = searchTools([...exposed, ...dormant], input.query, input.limit);
        const anyParked = hits.some((h) => parked.has(h.name));
        return okResult({
          tools: hits.map(({ name: n, description, pack }) => ({
            name: n,
            description,
            pack,
            ...(parked.has(n) ? { parked: true, mount: parked.get(n)?.mount } : {}),
          })),
          total_matches: total,
          next: anyParked
            ? "describe_tool for the input schema, then execute_tool; a parked tool's mount is switched back on when you describe or call it"
            : "describe_tool for the input schema, then execute_tool",
        });
      }
      case "describe_tool": {
        const input = parseArgs(name, DescribeToolInput, args);
        const names = [...new Set(typeof input.name === "string" ? [input.name] : input.name)];
        const notices: ErrorBody[] = [];
        for (const n of names) {
          if (find(n)) continue;
          const r = await revive(n);
          if (r && !isTool(r)) notices.push(r);
        }
        const found = names.map(find).filter((t): t is RegisteredTool => t !== undefined);
        return okResult({
          tools: found.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
            pack: t.packId,
            long_running: t.longRunning,
          })),
          not_found: names.filter((n) => !find(n)),
          ...(notices.length ? { notices } : {}),
        });
      }
      case "execute_tool": {
        const input = parseArgs(name, ExecuteToolInput, args);
        const tool = await resolve(input.name);
        if (!usable(tool)) return tool;
        return runTool(tool, input.arguments, ctx, exposed);
      }
      case "wait_for_job":
        return waitForJob(args, ctx);
      case "cancel_job":
        return cancelJob(args);
      default: {
        const tool = await resolve(name);
        if (!usable(tool)) return tool;
        return runTool(tool, args, ctx, exposed);
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: see above
  }) as any);

  registerResourcesAndPrompts(server, exposure, deps.library, deps.redact);
  if (modern && tasks) registerTaskMethods(server, tasks, visibleJob, deps.decorateResult);
  return server;
}

/** resources/* (library artifacts) and prompts/* (workflows), scoped like tools/list. */
function registerResourcesAndPrompts(
  server: Server,
  exposure: () => Exposure,
  library: ResourceLibrary | undefined,
  redact?: (text: string) => string,
): void {
  // biome-ignore lint/suspicious/noExplicitAny: request params are validated by the SDK schemas
  const handle = server.setRequestHandler.bind(server) as any;
  handle("prompts/list", async () => listPrompts(exposure()));
  handle("prompts/get", async (req: { params: { name: string; arguments?: unknown } }) =>
    getPrompt(exposure(), req.params.name, req.params.arguments),
  );
  if (!library) return;
  handle("resources/list", async (req: { params?: { cursor?: unknown } }) =>
    resourcesVisible(exposure()) ? listResources(library, req.params?.cursor) : { resources: [] },
  );
  handle("resources/templates/list", async () =>
    resourcesVisible(exposure()) ? resourceTemplates() : { resourceTemplates: [] },
  );
  handle("resources/read", async (req: { params: { uri: string } }) => {
    // A profile without the library answers as if the artifact did not exist.
    const out = resourcesVisible(exposure())
      ? readResource(library, req.params.uri)
      : readResource({ get: () => null, list: () => [] }, req.params.uri);
    // Tool results are redacted before they leave (registry.call); resource
    // contents get the same treatment.
    if (!redact) return out;
    return {
      contents: out.contents.map((c) =>
        "text" in c ? { ...c, text: redact(c.text) } : { ...c, blob: redact(c.blob) },
      ),
    };
  });
}

/** tasks/get and tasks/cancel of the 2026-07-28 tasks extension. */
function registerTaskMethods(
  server: Server,
  tasks: TaskEngine,
  visibleJob: (id: string) => TaskJob | null,
  decorate: ((result: unknown) => unknown) | undefined,
): void {
  const params = z.object({ taskId: z.string().min(1).max(128) }).passthrough();
  const requireExtension = (ctx: HandlerCtx) => {
    if (declaresTasks(ctx)) return;
    throw new ProtocolError(
      ProtocolErrorCode.MissingRequiredClientCapability,
      `this request did not declare the ${TASKS_EXTENSION} extension`,
      { requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } },
    );
  };
  // A task of another profile is answered exactly like one that does not exist.
  const lookup = (taskId: string) => {
    const job = visibleJob(taskId);
    if (!job) throw invalidParams("unknown task");
    return job;
  };
  // biome-ignore lint/suspicious/noExplicitAny: extension methods are not in the SDK's method map
  const custom = server as any;

  custom.setRequestHandler(
    "tasks/get",
    { params },
    async (p: { taskId: string }, ctx: HandlerCtx) => {
      requireExtension(ctx);
      const job = lookup(p.taskId);
      // Everything below comes from the job row: same answer after a restart.
      const state = taskState(job, tasks.ttlMs);
      if (state.status === "completed") {
        return { ...state, result: okResult(decorate ? decorate(job.result) : job.result) };
      }
      if (state.status === "failed") {
        return {
          ...state,
          error: {
            code: ProtocolErrorCode.InternalError,
            message: job.error ?? "the job failed",
            data: { code: jobErrorCode(job) },
          },
        };
      }
      return state;
    },
  );

  custom.setRequestHandler(
    "tasks/cancel",
    { params },
    async (p: { taskId: string }, ctx: HandlerCtx) => {
      requireExtension(ctx);
      // Cancelling a finished task is acknowledged and changes nothing.
      tasks.cancel(lookup(p.taskId).id);
      return {};
    },
  );
}
