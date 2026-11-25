// src/core/tools/builtin/mounts.ts
//
// Mount tools in the "system" pack: an agent can see which upstream MCP
// servers plughive offers or has, switch them on and off, start an OAuth
// sign-in, remove one the user added, and propose a new one.
//
//   list_mounts      the catalog (pack mounts) and the user's own mounts
//   add_mount        propose a new http or stdio mount (always needs approval)
//   enable_mount     switch a mount on
//   disable_mount    switch a mount off
//   connect_mount    start an OAuth sign-in; the user opens the link
//   remove_mount     delete a mount from mounts.json
//   optimize_mounts  smart mount: usage, token cost, what to park (src/core/mounts/smart.ts)
//
// add_mount never writes on its own say-so. A stdio mount starts a program
// with the user's rights and an http mount receives the user's keys, so every
// add opens a request in the approvals queue and only the next identical call
// after a person approved it (dashboard or Telegram, behind the admin token)
// writes mounts.json. The approval is used up by that call. Without a policy
// gate there is no queue, and add_mount refuses and points at the Mounts page.
//
// Keys never pass through here: a mount refers to `${secret:NAME}` and the
// user types the value on the Mounts page. add_mount refuses a literal
// credential (a credential header, a key-like query parameter, or any env
// value that is not a secret reference), so an agent cannot put a key it read
// in chat into mounts.json, and the whole command line has to fit in the text
// a person reads before approving.
import { z } from "zod";
import { currentScope } from "../../mcp/scope.js";
import type { MountInfo, MountManager } from "../../mounts/manager.js";
import { MountOAuthError } from "../../mounts/manager.js";
import type { SmartMounts } from "../../mounts/smart.js";
import {
  CREDENTIAL_HEADER,
  USER_MOUNT_PACK,
  type UserMount,
  UserMountSchema,
  UserMountsError,
  plainHttpSecretProblem,
  userMountSecretRefs,
} from "../../mounts/user-mounts.js";
import { SECRET_REF_PATTERN } from "../../packs/manifest.js";
import type { PolicyGate } from "../../policy/gate.js";
import type { RegisteredTool } from "../registry.js";
import { systemTool } from "./system.js";

export type MountToolManager = Pick<
  MountManager,
  | "listMounts"
  | "userFileError"
  | "setMountEnabled"
  | "addUserMount"
  | "removeUserMount"
  | "oauthStart"
>;

export interface MountToolDeps {
  mounts: MountToolManager;
  /** The approvals queue add_mount asks through. Absent: add_mount refuses. */
  gate?: PolicyGate;
  /**
   * Whether the secret store already holds a value under a name. add_mount
   * refuses such a name, so a proposed mount cannot be pointed at a key the
   * user stored for something else. Absent: add_mount refuses every add.
   */
  secrets?: { hasStored(name: string): Promise<boolean> };
  /** Smart mount. Absent: no optimize_mounts tool. */
  smart?: Pick<SmartMounts, "report" | "park" | "setSettings" | "applyProfiles" | "undo">;
}

/** What the person reads before approving (the queue keeps 500 characters of it). */
export const MAX_APPROVAL_REASON = 500;

const MOUNT_PART = "[a-z][a-z0-9-]{1,31}";
const mountId = z
  .string()
  .regex(new RegExp(`^${MOUNT_PART}/${MOUNT_PART}$`), 'a mount id from list_mounts, "<pack>/<id>"');
const ONLY_SECRET_REF = /^\$\{secret:[^}]*\}$/;
const KEY_LIKE_PARAM = /key|token|secret|auth|password|sig/i;

function mountsUrl(): string {
  return `${currentScope()?.baseUrl ?? ""}/mounts`;
}

/** The next thing that stands between this mount and its tools, or null. */
function nextStep(m: MountInfo): string | null {
  if (m.connected) return null;
  if (!m.mountable) return m.note ?? "this mount cannot be connected";
  if (m.oauth && !m.oauth.signedIn) {
    return m.oauth.pending
      ? "waiting for the user to finish signing in at the vendor"
      : `sign in: call connect_mount with id "${m.id}" and give the user the link`;
  }
  const missing = m.secrets.filter((s) => !s.present).map((s) => s.name);
  if (missing.length) {
    return `the user sets ${missing.join(", ")} on the Mounts page (${mountsUrl()}); keys are never typed in chat`;
  }
  if (!m.enabled) return `switch it on: call enable_mount with id "${m.id}"`;
  if (m.error) return `the last connect failed: ${m.error}`;
  return "connecting";
}

function view(m: MountInfo) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    source: m.source === "pack" ? "catalog" : "mine",
    transport: m.transport,
    prefix: m.prefix,
    ...(m.url ? { url: m.url } : {}),
    ...(m.command ? { command: m.command } : {}),
    auth: m.auth,
    ...(m.docsUrl ? { docs_url: m.docsUrl } : {}),
    enabled: m.enabled,
    connected: m.connected,
    tools: m.tools,
    secrets: m.secrets,
    ...(m.oauth ? { signed_in: m.oauth.signedIn } : {}),
    next: nextStep(m),
  };
}

function toolError(e: unknown): never {
  if (e instanceof UserMountsError) {
    const first = (e.issues?.[0] ?? null) as { path?: unknown[]; message?: string } | null;
    const detail = first?.message
      ? ` (${first.path?.length ? `${first.path.join(".")}: ` : ""}${first.message})`
      : "";
    throw new Error(`${e.message}${detail}`);
  }
  if (e instanceof MountOAuthError) throw new Error(e.message);
  throw e;
}

/** A literal credential an agent tried to write into the mount, or null. */
export function literalCredentialProblem(m: UserMount): string | null {
  for (const [name, value] of Object.entries(m.headers ?? {})) {
    if (CREDENTIAL_HEADER.test(name) && !value.match(SECRET_REF_PATTERN)) {
      return `the header ${name} carries a credential: write it as \${secret:NAME} (for example "Bearer \${secret:${m.id.toUpperCase().replaceAll("-", "_")}_MCP_TOKEN}") and ask the user to set the value on the Mounts page`;
    }
  }
  if (m.url) {
    try {
      const u = new URL(m.url.replace(SECRET_REF_PATTERN, "SECRETREF"));
      for (const [name, value] of u.searchParams) {
        if (KEY_LIKE_PARAM.test(name) && !value.includes("SECRETREF")) {
          return `the url parameter ${name} looks like a credential: write it as \${secret:NAME}`;
        }
      }
    } catch {
      // the schema has already checked the url
    }
  }
  for (const [name, value] of Object.entries(m.env ?? {})) {
    if (!ONLY_SECRET_REF.test(value)) {
      return `env ${name}: a mount proposed by an agent may only set env values to a \${secret:NAME} reference (the user types the value on the Mounts page)`;
    }
  }
  return null;
}

const quote = (s: string) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : JSON.stringify(s));

/**
 * Ask the approvals queue. Null when approved (the approval is consumed);
 * otherwise the answer to give the agent.
 */
function askApproval(
  gate: PolicyGate,
  tool: "add_mount" | "enable_mount",
  args: unknown,
  reason: string,
): Record<string, unknown> | null {
  const decision = gate.requestApproval({ tool: `system/${tool}`, args, reason });
  if (decision.status === "approved") return null;
  const a = decision.approval;
  return {
    status: decision.status === "pending" ? "approval_required" : `approval_${decision.status}`,
    approval_id: a.id,
    approval_url: a.url,
    expires_at: a.expires_at,
    reason,
    message:
      decision.status === "pending"
        ? `Ask the user to review and approve this (Approvals page or Telegram), then call ${tool} again once with the same arguments. Do not retry in a loop.`
        : `The user ${decision.status === "denied" ? "denied" : "did not answer"} this request. Calling ${tool} again asks again.`,
  };
}

/** The sentence a person approves: the whole mount, or null when it does not fit. */
export function approvalReason(m: UserMount): string | null {
  // The name is the agent's own text: escaped, so quotes or new lines in it
  // cannot make the sentence read as something else.
  const label = `${JSON.stringify(m.name ?? m.id)} (${USER_MOUNT_PACK}/${m.id}, tools as ${m.prefix}_*)`;
  let text: string;
  if (m.transport === "stdio") {
    const line = [m.command ?? "", ...(m.args ?? [])].map(quote).join(" ");
    // Env values are ${secret:NAME} references only (literalCredentialProblem).
    const env = Object.entries(m.env ?? {}).map(([k, v]) => `${k}=${v}`);
    text = `add local MCP server ${label}: runs \`${line}\` as you${env.length ? `, env ${env.join(" ")}` : ""}`;
  } else {
    // Header values are shown as written: a credential is a ${secret:NAME}
    // reference, so the person sees which key goes to this url.
    const headers = Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
    text = `add remote MCP server ${label}: ${m.url}${headers.length ? `, sends headers ${headers.join("; ")}` : ""}`;
  }
  return text.length <= MAX_APPROVAL_REASON ? text : null;
}

const addInput = z
  .object({
    id: z.string().describe("short id, lowercase letters, digits and dashes (e.g. github)"),
    name: z.string().optional(),
    description: z.string().optional(),
    transport: z.enum(["http", "stdio"]),
    prefix: z
      .string()
      .optional()
      .describe("the server's tools are listed as <prefix>_<tool>; default: the id"),
    url: z.string().optional().describe("http: the server's MCP endpoint (https)"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('http: headers to send; credentials only as "${secret:NAME}"'),
    command: z
      .string()
      .optional()
      .describe("stdio: program name on PATH or absolute path (npx, uvx, docker, ...)"),
    args: z.array(z.string()).optional().describe("stdio: arguments"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('stdio: environment, each value "${secret:NAME}"'),
  })
  .strict();

export function mountTools(deps: MountToolDeps): RegisteredTool[] {
  const { mounts, gate, secrets, smart } = deps;
  const find = async (id: string) => {
    const m = (await mounts.listMounts()).find((x) => x.id === id);
    if (!m) throw new Error(`unknown mount "${id}": call list_mounts for the ids`);
    return m;
  };

  return [
    systemTool({
      name: "list_mounts",
      description:
        "Upstream MCP servers plughive offers (source catalog: Exa, Tavily, Linear, Notion, Zapier, ...) and the ones the user added (source mine): whether each is on and connected, how many tools it serves, which keys it needs and whether they are set, and `next`, the step still missing. Filter with `query` (name, id or description) and `source`.",
      input: z
        .object({
          query: z.string().max(80).optional(),
          source: z.enum(["catalog", "mine", "all"]).default("all"),
        })
        .strict(),
      readOnly: true,
      tags: ["mounts"],
      run: async ({ query, source }) => {
        const q = query?.toLowerCase();
        const all = (await mounts.listMounts()).map(view).filter((m) => {
          if (source !== "all" && m.source !== source) return false;
          if (!q) return true;
          return [m.id, m.name, m.description ?? ""].some((s) => s.toLowerCase().includes(q));
        });
        return {
          mounts: all,
          mounts_page: mountsUrl(),
          mounts_file_error: mounts.userFileError(),
        };
      },
    }),
    systemTool({
      name: "add_mount",
      description:
        'Propose a new MCP server for plughive to mount: transport "http" (a remote endpoint) or "stdio" (a local program such as `npx -y <package>`). Look in list_mounts first: a catalog entry is set up with enable_mount or connect_mount instead. Credentials are never literal: write "${secret:NAME}" in a header, url or env value and the user types the value on the Mounts page. Every add needs the user\'s approval: the first call answers status approval_required with an approval link; ask the user to approve it (dashboard Approvals page or Telegram), then call add_mount again once with the same arguments. Do not retry in a loop.',
      input: addInput,
      readOnly: false,
      tags: ["mounts"],
      run: async (input) => {
        const parsed = UserMountSchema.safeParse({ ...input, prefix: input.prefix ?? input.id });
        if (!parsed.success) {
          toolError(new UserMountsError("INVALID_MOUNT", "invalid mount", parsed.error.issues));
        }
        const mount = parsed.data;
        const insecure = plainHttpSecretProblem(mount);
        if (insecure) throw new Error(insecure.message);
        const literal = literalCredentialProblem(mount);
        if (literal) throw new Error(literal);
        const fileError = mounts.userFileError();
        if (fileError) throw new Error(`${fileError}; the user has to fix or remove it first`);
        const existing = await mounts.listMounts();
        if (existing.some((m) => m.id === `${USER_MOUNT_PACK}/${mount.id}`)) {
          throw new Error(`a mount with the id "${mount.id}" exists: pick another id`);
        }
        if (existing.some((m) => m.prefix === mount.prefix)) {
          throw new Error(`the prefix "${mount.prefix}" is in use: pass another prefix`);
        }
        // New names only: a key already stored (for a pack, another mount or
        // anything else) is not the agent's to send to a new server.
        const refs = userMountSecretRefs(mount);
        if (refs.length && !secrets) throw new Error("this daemon cannot check secret names");
        for (const name of refs) {
          if (await secrets?.hasStored(name)) {
            throw new Error(
              `the secret ${name} already holds a key the user stored for something else: use a new name for this mount (e.g. ${mount.id.toUpperCase().replaceAll("-", "_")}_MCP_KEY); to reuse that key, the user adds the mount on the Mounts page`,
            );
          }
        }
        const reason = approvalReason(mount);
        if (!reason) {
          throw new Error(
            `this mount is too long to show in an approval (over ${MAX_APPROVAL_REASON} characters): shorten it, or ask the user to add it on the Mounts page (${mountsUrl()})`,
          );
        }
        if (!gate) {
          return {
            status: "unavailable",
            message: `Approvals are off in this daemon, so an agent cannot add a mount. Ask the user to add it on the Mounts page (${mountsUrl()}).`,
            mounts_page: mountsUrl(),
          };
        }
        const waiting = askApproval(gate, "add_mount", mount, reason);
        if (waiting) return waiting;
        const id = await mounts.addUserMount(mount).catch(toolError);
        return { status: "added", mount: view(await find(id)) };
      },
    }),
    systemTool({
      name: "enable_mount",
      description:
        "Switch on a mount from list_mounts (catalog or the user's own) and connect it. Its tools then appear as <prefix>_<tool>. A mount that needs keys stays unconnected until the user sets them on the Mounts page; an OAuth mount is signed in to with connect_mount. A local (stdio) server of the user's own needs their approval: the first call answers approval_required; ask the user to approve it, then call again once.",
      input: z.object({ id: mountId }).strict(),
      readOnly: false,
      tags: ["mounts"],
      run: async ({ id }) => {
        const before = await find(id);
        if (!before.mountable) throw new Error(before.note ?? "this mount cannot be switched on");
        if (before.oauth && !before.oauth.signedIn) {
          return {
            status: "sign_in_required",
            mount: view(before),
            message: `This server signs in with OAuth: call connect_mount with id "${id}" and give the user the link. Signing in switches it on.`,
          };
        }
        // A program of the user's own runs as them: switching one back on
        // needs the same approval as adding it. (Smart mount's wake does not
        // come through here: it only restores what it parked itself.)
        if (before.source === "user" && before.transport === "stdio") {
          const reason = `switch on local MCP server ${JSON.stringify(before.name ?? id)} (${id}): runs \`${before.command ?? ""}\` as you`;
          if (!gate) {
            return {
              status: "unavailable",
              message: `Approvals are off in this daemon, so an agent cannot switch on a local server. Ask the user to switch it on on the Mounts page (${mountsUrl()}).`,
              mounts_page: mountsUrl(),
            };
          }
          const waiting = askApproval(
            gate,
            "enable_mount",
            { id, command: before.command },
            reason.slice(0, MAX_APPROVAL_REASON),
          );
          if (waiting) return waiting;
        }
        await mounts.setMountEnabled(id, true).catch(toolError);
        return { status: "enabled", mount: view(await find(id)) };
      },
    }),
    systemTool({
      name: "disable_mount",
      description:
        "Switch off a mount and disconnect it. Its settings, keys and sign-in are kept; enable_mount switches it back on.",
      input: z.object({ id: mountId }).strict(),
      readOnly: false,
      tags: ["mounts"],
      run: async ({ id }) => {
        await find(id);
        await mounts.setMountEnabled(id, false).catch(toolError);
        return { status: "disabled", mount: view(await find(id)) };
      },
    }),
    systemTool({
      name: "connect_mount",
      description:
        "Start the OAuth sign-in of a catalog mount whose auth is oauth (Notion, Sentry, Linear, Atlassian, Stripe, Cloudflare, ...). Returns authorization_url: give it to the user to open in their browser. The tokens go to plughive's secret store, never to you. When they finish, the mount is switched on; list_mounts shows it connected.",
      input: z.object({ id: mountId }).strict(),
      readOnly: false,
      tags: ["mounts"],
      run: async ({ id }) => {
        const authorizationUrl = await mounts.oauthStart(id).catch(toolError);
        return {
          status: "sign_in_started",
          authorization_url: authorizationUrl,
          message:
            "Give the user this link to open in their browser and sign in. Do not open it yourself. Call list_mounts afterwards to see it connected.",
        };
      },
    }),
    ...(smart
      ? [
          systemTool({
            name: "optimize_mounts",
            description:
              "Smart mount: for every mount, when it was last called, calls in 30 days, how long it has been idle and roughly how many tokens its tools cost in every tools/list, plus suggestions, each with a `key`. Park kinds (switch the mount off): idle (unused for idle_days), heavy (many tokens, few calls), overlap (does the same job as a mount or built-in that gets the calls). Profile kinds (change one list-mode profile): profile_unused (other profiles use the mount, this one never does: hide it), unused_tools (hide the tools of a mount the profile never calls), search_mode (switch a costly list-mode profile to auto). Health kinds, to fix and never applied: sign_in, missing_key (the user sets the key on the Mounts page, never in chat), failing, failing_tool. apply: true parks the park kinds (or just `ids`); keys and sign-ins stay, and search_tools still finds a parked mount's tools: describing or calling one switches it back on (settings.wake auto) or answers TOOL_PARKED (ask). apply_keys applies profile suggestions by key; undo takes the keys of `changes` and reverts them. Also returns a 7-day summary. `settings` changes the mode (off, suggest, auto: an hourly sweep parks idle mounts), idle_days, keep (mount ids never suggested) and wake (you may set ask; only the user switches ask back to auto). Ask the user before apply, apply_keys or switching to auto.",
            input: z
              .object({
                apply: z.boolean().default(false),
                ids: z.array(mountId).max(64).optional(),
                apply_keys: z.array(z.string().min(1).max(200)).max(64).optional(),
                undo: z.array(z.string().min(1).max(200)).max(64).optional(),
                settings: z
                  .object({
                    mode: z.enum(["off", "suggest", "auto"]).optional(),
                    idle_days: z.number().int().min(1).max(365).optional(),
                    keep: z.array(mountId).max(256).optional(),
                    wake: z.enum(["auto", "ask"]).optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
            readOnly: false,
            tags: ["mounts"],
            run: async ({ apply, ids, apply_keys, undo, settings }) => {
              // "Ask first" is the user's guard against agents waking servers:
              // an agent may tighten it, never loosen it.
              if (settings?.wake === "auto" && (await smart.report()).settings.wake === "ask") {
                throw new Error(
                  `the user set parked tools to "ask first": only they can change that, on the Mounts page (${mountsUrl()})`,
                );
              }
              if (settings) {
                smart.setSettings({
                  ...(settings.mode ? { mode: settings.mode } : {}),
                  ...(settings.idle_days ? { idleDays: settings.idle_days } : {}),
                  ...(settings.keep ? { keep: settings.keep } : {}),
                  ...(settings.wake ? { wake: settings.wake } : {}),
                });
              }
              const undone = undo?.length ? smart.undo(undo) : null;
              const result = apply ? await smart.park(ids) : null;
              const changed = apply_keys?.length ? await smart.applyProfiles(apply_keys) : null;
              const report = await smart.report();
              return {
                ...(result ? { parked: result.parked, not_parked: result.skipped } : {}),
                ...(changed ? { applied: changed.applied, not_applied: changed.skipped } : {}),
                ...(undone && undo
                  ? { undone, not_undone: undo.filter((k) => !undone.includes(k)) }
                  : {}),
                settings: {
                  mode: report.settings.mode,
                  idle_days: report.settings.idleDays,
                  keep: report.settings.keep,
                  wake: report.settings.wake,
                },
                summary: report.summary,
                enabled_tokens: report.enabled_tokens,
                reclaimable_tokens: report.reclaimable_tokens,
                suggestions: report.suggestions,
                changes: report.changes,
                mounts: report.mounts.filter((m) => m.enabled || m.parked),
              };
            },
          }),
        ]
      : []),
    systemTool({
      name: "remove_mount",
      description:
        "Delete a mount the user added (source mine) from mounts.json and disconnect it. Its keys stay in the secret store. Catalog mounts cannot be removed: use disable_mount.",
      input: z.object({ id: mountId }).strict(),
      readOnly: false,
      destructive: true,
      tags: ["mounts"],
      run: async ({ id }) => {
        if (!id.startsWith(`${USER_MOUNT_PACK}/`)) {
          throw new Error("catalog mounts cannot be removed: use disable_mount");
        }
        const removed = await mounts.removeUserMount(id).catch(toolError);
        if (!removed) throw new Error(`unknown mount "${id}": call list_mounts for the ids`);
        return { status: "removed", id };
      },
    }),
  ];
}
