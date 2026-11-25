// src/core/tools/builtin/system.ts
//
// The built-in "system" pack: set up this machine. Agents can see what software
// plughive installs, install it (a gated, large or package-manager install
// opens a request in the approvals queue first; the next call after the user
// approves it starts the install), remove it, and ask
// what a goal still needs (setup_plan).
import { z } from "zod";
import type { SetupAdvisor } from "../../advisor/plan.js";
import { InstallError, type InstallStart, type Installer } from "../../installer/installer.js";
import { currentScope } from "../../mcp/scope.js";
import type { PolicyGate } from "../../policy/gate.js";
import { type CallContext, type RegisteredTool, toolInputJsonSchema } from "../registry.js";

export const SYSTEM_PACK_ID = "system";

export interface SystemToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  readOnly: boolean;
  destructive?: boolean;
  tags?: readonly string[];
  run(input: z.output<S>, callCtx: CallContext): Promise<unknown> | unknown;
}

export function systemTool<S extends z.ZodType>(spec: SystemToolSpec<S>): RegisteredTool {
  return {
    name: spec.name,
    packId: SYSTEM_PACK_ID,
    origin: "native",
    description: spec.description,
    inputSchema: toolInputJsonSchema(spec.input),
    annotations: {
      readOnlyHint: spec.readOnly,
      ...(spec.destructive ? { destructiveHint: true } : {}),
      ...(!spec.readOnly ? { openWorldHint: true } : {}),
    },
    tags: ["system", "setup", ...(spec.tags ?? [])],
    requiresSecrets: [],
    longRunning: false,
    input: spec.input,
    run: async (input, callCtx) => spec.run(input as z.output<S>, callCtx),
  };
}

const softwareId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "a software id from list_installable");

/** The approval link, absolute when the daemon's origin is known. */
export function withApprovalUrl(start: InstallStart): InstallStart & { approval_url?: string } {
  if (start.status !== "approval_required") return start;
  const base = currentScope()?.baseUrl;
  return base ? { ...start, approval_url: `${base}${start.approval_path}` } : start;
}

function softwareError(e: unknown): never {
  if (e instanceof InstallError) throw new Error(e.message);
  throw e;
}

export interface SystemToolDeps {
  installer: Installer;
  advisor: SetupAdvisor;
  /** Opens install approvals in the shared approvals queue (dashboard, Telegram). */
  gate?: PolicyGate;
}

export function systemTools(deps: SystemToolDeps): RegisteredTool[] {
  const { installer, advisor, gate } = deps;
  return [
    systemTool({
      name: "list_installable",
      description:
        "Software plughive can install or detect on this computer (ffmpeg, yt-dlp, whisper.cpp, Ollama, ...): version, license, download size, how it installs here, and whether it is already installed. Filter with `tag` (video, audio, image, transcribe, llm, document, agent).",
      input: z.object({ tag: z.string().max(30).optional() }).strict(),
      readOnly: true,
      run: async ({ tag }) => {
        const all = await installer.status();
        return { items: tag ? all.filter((s) => s.tags.includes(tag)) : all };
      },
    }),
    systemTool({
      name: "software_status",
      description:
        "Is one program installed, where, which version, and (for a service such as Ollama) is it running. Probes it now.",
      input: z.object({ id: softwareId }).strict(),
      readOnly: true,
      run: async ({ id }) => installer.statusOf(id).catch(softwareError),
    }),
    systemTool({
      name: "install_software",
      description:
        "Install a program from list_installable into plughive's own tools folder (no admin rights; downloads are checked against pinned sha256 values). Returns a job_id: wait with wait_for_job. A gated, large (over 200 MB) or package-manager install returns status approval_required with an approval link: ask the user to approve it (dashboard Approvals or Software page, or Telegram), then call install_software again once; do not retry in a loop.",
      input: z.object({ id: softwareId }).strict(),
      readOnly: false,
      run: async ({ id }) => {
        const profile = currentScope()?.profileId;
        const opts = profile ? { profile } : {};
        const start = await installer.startInstall(id, opts).catch(softwareError);
        if (start.status !== "approval_required" || !gate) return withApprovalUrl(start);
        const decision = gate.requestApproval({
          tool: "system/install_software",
          args: { id },
          reason: `install ${id} (${start.size_mb} MB, ${start.license})`,
        });
        if (decision.status === "approved") {
          return installer.startInstall(id, { ...opts, approved: true }).catch(softwareError);
        }
        const a = decision.approval;
        const message =
          decision.status === "pending"
            ? `${start.message} Ask the user to approve it (Approvals page, Software page or Telegram), then call install_software again once. Do not retry in a loop.`
            : `The user ${decision.status === "denied" ? "denied" : "did not answer"} this install. Calling install_software again asks again.`;
        return {
          ...withApprovalUrl(start),
          status:
            decision.status === "pending" ? "approval_required" : `approval_${decision.status}`,
          approval_id: a.id,
          approval_url: a.url,
          expires_at: a.expires_at,
          message,
        };
      },
    }),
    systemTool({
      name: "uninstall_software",
      description:
        "Remove a program plughive installed (its folder in tools/ and its command). Software installed another way is not touched: the answer says how to remove it.",
      input: z.object({ id: softwareId }).strict(),
      readOnly: false,
      destructive: true,
      run: async ({ id }) => installer.uninstall(id).catch(softwareError),
    }),
    systemTool({
      name: "setup_plan",
      description:
        "What this computer still needs for a goal, free and local options first. Goals: make short videos, transcribe meetings, find clients, edit images, research the web, automate my apps (or describe yours). Each option says what is needed (install, key, login or enable_pack), why, what it costs and how to do it. Call this when a tool fails because something is not installed or not configured.",
      input: z.object({ goal: z.string().min(1).max(200).optional() }).strict(),
      readOnly: true,
      run: async ({ goal }) => {
        if (!goal) return { goals: advisor.list() };
        const plan = await advisor.plan(goal);
        if (!plan) {
          return {
            error: `no goal matches "${goal.slice(0, 80)}"`,
            goals: advisor.list(),
          };
        }
        return plan;
      },
    }),
  ];
}
