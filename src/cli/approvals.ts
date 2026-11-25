// src/cli/approvals.ts
//
//   plughive approvals [list|show|approve|deny]
//   plughive policy [show|get|set]
//
// The Approvals page: spend requests the agents wait on, and the policy
// (caps and rules) that decides when a call needs a person. An agent cannot
// approve its own request; a person does it here or on the dashboard.
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE } from "./args.js";
import {
  COMMON_HELP,
  type Ctx,
  ago,
  enc,
  printFields,
  printTable,
  readJsonInput,
  runGroup,
  sub,
  truncate,
  usd,
} from "./common.js";

export interface ApprovalView {
  id: string;
  kind: string;
  tool: string;
  provider: string | null;
  args_summary: string | null;
  estimate_usd: number | null;
  estimate_basis: string | null;
  reason: string | null;
  profile: string | null;
  job_id: string | null;
  status: string;
  created_at: string;
  expires_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  url: string;
}

export const APPROVALS_HELP = `Usage: plughive approvals <command> [options]

Spend and safety requests the agents are waiting on. A request is made when a
call goes over a cap or matches a rule of the policy ("plughive policy").

Commands:
  list                  pending requests (the default)
      --status S        pending, approved, denied, expired or consumed
      --all             every status
      --limit N         at most N (default 100, max 500)
  show <apr_id>         one request: tool, provider, estimate, reason
  approve <apr_id>      let it run; the agent retries the call once
  deny <apr_id>         refuse it

${COMMON_HELP}`;

function printApproval(io: CliIo, a: ApprovalView): void {
  printFields(io, [
    ["id", a.id],
    ["status", a.status],
    ["kind", a.kind],
    ["tool", a.tool],
    ["provider", a.provider],
    ["profile", a.profile],
    [
      "estimate",
      a.estimate_usd !== null
        ? `${usd(a.estimate_usd)}${a.estimate_basis ? ` (${a.estimate_basis})` : ""}`
        : null,
    ],
    ["reason", a.reason],
    ["arguments", a.args_summary],
    ["job", a.job_id],
    ["created", `${a.created_at} (${ago(a.created_at)})`],
    ["expires", a.expires_at ? `${a.expires_at} (${ago(a.expires_at)})` : null],
    ["decided", a.decided_at ? `${a.decided_at} by ${a.decided_by ?? "?"}` : null],
    ["link", a.url],
  ]);
}

const decide = (verdict: "approve" | "deny", io: CliIo) => async (args: string[]) => {
  const { positionals, ctx } = sub(
    `approvals ${verdict}`,
    args,
    io,
    {},
    { min: 1, max: 1, usage: "<apr_id>" },
  );
  const id = positionals[0] ?? "";
  const { approval } = await ctx
    .api()
    .post<{ approval: ApprovalView }>(`/api/approvals/${enc(id)}/${verdict}`);
  if (ctx.json) ctx.printJson(approval);
  else
    io.out(
      `${verdict === "approve" ? "Approved" : "Denied"} ${approval.id} (${approval.tool}${
        approval.estimate_usd !== null ? `, ${usd(approval.estimate_usd)}` : ""
      }).`,
    );
  return EXIT_OK;
};

export async function runApprovals(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "approvals",
    APPROVALS_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { values, ctx } = sub("approvals list", args, io, {
          status: { type: "string" },
          all: { type: "boolean" },
          limit: { type: "string" },
        });
        const q = new URLSearchParams();
        if (values.status && values.all)
          throw new CliError("give --status or --all, not both", EXIT_USAGE);
        if (!values.all) q.set("status", values.status ?? "pending");
        if (values.limit) q.set("limit", values.limit);
        const body = await ctx
          .api()
          .get<{ approvals: ApprovalView[]; pending: number }>(
            `/api/approvals${q.size ? `?${q}` : ""}`,
          );
        if (ctx.json) {
          ctx.printJson(body);
          return EXIT_OK;
        }
        if (!body.approvals.length) {
          io.out(values.all || values.status ? "No requests." : "Nothing waits for approval.");
          return EXIT_OK;
        }
        printTable(
          io,
          ["ID", "STATUS", "TOOL", "ESTIMATE", "CREATED", "REASON"],
          body.approvals.map((a) => [
            a.id,
            a.status,
            a.tool,
            usd(a.estimate_usd),
            ago(a.created_at),
            truncate(a.reason, 60),
          ]),
        );
        if (body.pending) {
          io.out(`\n${body.pending} pending. Decide with "plughive approvals approve|deny <id>".`);
        }
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "approvals show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<apr_id>" },
        );
        const { approval } = await ctx
          .api()
          .get<{ approval: ApprovalView }>(`/api/approvals/${enc(positionals[0] ?? "")}`);
        if (ctx.json) ctx.printJson(approval);
        else printApproval(io, approval);
        return EXIT_OK;
      },
      approve: decide("approve", io),
      deny: decide("deny", io),
    },
    "list",
  );
}

// ---- policy -----------------------------------------------------------------

export const POLICY_HELP = `Usage: plughive policy <command> [options]

The spend policy: caps (a limit in USD per day or month, for all calls,
one provider or one profile) and the rules that decide when to ask.

Commands:
  show                  caps with what was spent, and the rules (the default)
  get                   the policy as JSON (edit it, then "policy set")
  set <JSON|@file|->    replace the policy with this JSON (validated by the
                        daemon; nothing changes if it is not valid)

${COMMON_HELP}

Example:
  plughive policy get > policy.json && $EDITOR policy.json && plughive policy set @policy.json`;

interface PolicyReport {
  valid: boolean;
  exists: boolean;
  error?: string;
  policy: {
    caps: {
      scope: string;
      id?: string | null;
      period: string;
      limit_usd: number;
      mode?: string;
    }[];
    rules: Record<string, unknown>;
    profiles: Record<string, unknown>;
    [k: string]: unknown;
  };
  caps: {
    cap: { scope: string; id?: string | null; period: string; limit_usd: number; mode?: string };
    since: number | string;
    spent_usd: number | null;
    remaining_usd: number;
  }[];
}

function printPolicy(ctx: Ctx, r: PolicyReport): void {
  const io = ctx.io;
  if (!r.valid)
    io.out(
      `The policy file is not valid: ${r.error ?? "?"}\nThe default policy applies until it is fixed.\n`,
    );
  else if (!r.exists) io.out("No policy file: no caps, the default rules.\n");
  if (r.caps.length) {
    io.out("Caps");
    printTable(
      io,
      ["SCOPE", "PERIOD", "LIMIT", "SPENT", "LEFT", "WHEN OVER"],
      r.caps.map((c) => [
        c.cap.scope + (c.cap.id ? `:${c.cap.id}` : ""),
        c.cap.period,
        usd(c.cap.limit_usd),
        c.spent_usd === null ? "unknown" : usd(c.spent_usd) || "$0.00",
        usd(c.remaining_usd) || "$0.00",
        c.cap.mode ?? "",
      ]),
    );
  } else io.out("Caps: none");
  io.out("\nRules");
  printFields(
    io,
    Object.entries(r.policy.rules ?? {}).map(([k, v]) => [
      k,
      Array.isArray(v) ? v.join(", ") || "none" : (v ?? "off"),
    ]),
  );
  const profiles = Object.keys(r.policy.profiles ?? {});
  if (profiles.length)
    io.out(`\nProfile overrides: ${profiles.join(", ")} ("plughive policy get" shows them)`);
}

export async function runPolicy(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "policy",
    POLICY_HELP,
    argv,
    io,
    {
      show: async (args) => {
        const { ctx } = sub("policy show", args, io, {});
        const r = await ctx.api().get<PolicyReport>("/api/policy");
        if (ctx.json) ctx.printJson(r);
        else printPolicy(ctx, r);
        return EXIT_OK;
      },
      get: async (args) => {
        const { ctx } = sub("policy get", args, io, {});
        const r = await ctx.api().get<PolicyReport>("/api/policy");
        if (!r.valid)
          io.err(
            `The policy file is not valid (${r.error ?? "?"}); this is the default policy that applies meanwhile.`,
          );
        ctx.printJson(r.policy);
        return EXIT_OK;
      },
      set: async (args) => {
        const { positionals, ctx } = sub(
          "policy set",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<JSON|@file|->" },
        );
        const policy = readJsonInput(positionals[0] ?? "", "policy");
        await ctx.api().put("/api/policy", { policy });
        const r = await ctx.api().get<PolicyReport>("/api/policy");
        if (ctx.json) ctx.printJson(r);
        else {
          io.out("Policy saved.\n");
          printPolicy(ctx, r);
        }
        return EXIT_OK;
      },
    },
    "show",
  );
}
