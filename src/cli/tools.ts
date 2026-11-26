// src/cli/tools.ts
//
//   plughive tools [list|show|call]
//
// The Playground and Capabilities pages: every tool the daemon serves, its
// input, and a way to run one exactly as the dashboard does (as the default
// profile, through the spend policy, queued when it runs long).
import { ApiError, issueLines } from "./api.js";
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK, EXIT_USAGE, jsonText } from "./args.js";
import {
  COMMON_HELP,
  type Ctx,
  enc,
  parseAssignments,
  printFields,
  printTable,
  readJsonObject,
  runGroup,
  sub,
  truncate,
} from "./common.js";
import { FINISHED, type JobView, waitForJob } from "./jobs.js";

interface ToolView {
  name: string;
  pack: string;
  origin: string;
  description: string;
  tags: string[];
  capability: string | null;
  requires_secrets: string[];
  long_running: boolean;
  input_schema: JsonSchema;
}

interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  [k: string]: unknown;
}

export const TOOLS_HELP = `Usage: plughive tools <command> [options]

Every tool the daemon serves (built-in, packs, mounted MCP servers, workflows).

Commands:
  list                  name, pack and summary of each tool (the default)
      --pack ID         only the tools of this pack
      --search TEXT     only tools whose name, description or tags match
  show <name>           the description and every argument, with types
      --schema          print the raw JSON schema of the input
  call <name> [k=v | k:=json ...]
                        run a tool as the dashboard's Playground does
      --args JSON       the arguments as one JSON object (or @file, or - for stdin);
                        k=v pairs given as well are merged over it
      --background      queue it as a job and print the job id
      --wait            with --background (or a long-running tool): wait for
                        the job and print its result
      --idempotency-key K
                        sending the same queued call twice returns the first job

${COMMON_HELP}

Arguments: k=v sets a text value, k:=json a number, boolean, list or object
(n:=2, tags:='["a","b"]'), and a.b=v nests. When a call needs approval
(a cap or a rule of the policy), the request id is printed: approve it with
"plughive approvals approve <id>" and run the call again.`;

function typeOf(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join("|");
  if (s.anyOf) return s.anyOf.map(typeOf).join("|");
  const t = Array.isArray(s.type) ? s.type.join("|") : (s.type ?? "any");
  if (t === "array" && s.items) return `${typeOf(s.items)}[]`;
  return t;
}

async function listTools(ctx: Ctx): Promise<ToolView[]> {
  const { tools } = await ctx.api().get<{ tools: ToolView[] }>("/api/tools");
  return tools;
}

/** The approval id inside an APPROVAL_REQUIRED error (its link ends with it). */
export function approvalIdOf(e: ApiError): string | null {
  const body = e.body as { error?: { message?: string; approval_id?: string } } | null;
  if (body?.error?.approval_id) return body.error.approval_id;
  const m = /apr_[0-9A-HJKMNP-TV-Z]{26}/.exec(body?.error?.message ?? e.message);
  return m ? m[0] : null;
}

async function call(ctx: Ctx, name: string, pairs: string[], values: Record<string, unknown>) {
  const io = ctx.io;
  const args = {
    ...parseAssignments(
      pairs,
      typeof values.args === "string" ? readJsonObject(values.args, "--args") : {},
    ),
  };
  const background = values.background === true;
  const headers: Record<string, string> = {};
  if (typeof values["idempotency-key"] === "string")
    headers["idempotency-key"] = values["idempotency-key"];
  let res: { result?: unknown; job_id?: string };
  try {
    res = await ctx
      .api()
      .post<{ result?: unknown; job_id?: string }>(
        `/api/tools/${enc(name)}/call`,
        { arguments: args, ...(background ? { background: true } : {}) },
        { headers, timeoutMs: 0 },
      );
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const err = (e.body as { error?: { issues?: unknown } } | null)?.error;
    const lines = issueLines(err?.issues);
    if (e.code === "INVALID_ARGUMENTS" && lines.length) {
      throw new CliError(
        `the arguments are not valid for ${name}:\n${lines.join("\n")}\nRun "plughive tools show ${name}" for its arguments.`,
        EXIT_USAGE,
      );
    }
    if (e.code === "APPROVAL_REQUIRED") {
      const id = approvalIdOf(e);
      throw new CliError(
        `${e.message}${
          id
            ? `\nApprove it with "plughive approvals approve ${id}", then run this call again.`
            : ""
        }`,
      );
    }
    if (e.code === "MISSING_SECRET") {
      const b = (e.body as { error?: { pack?: string; secret?: string } } | null)?.error;
      throw new CliError(
        `${e.message}${b?.secret ? `\nSet it with "plughive secrets set ${b.pack ?? "<pack>"} ${b.secret}".` : ""}`,
      );
    }
    throw e;
  }
  if (res.job_id) {
    if (values.wait === true) {
      const job: JobView = await waitForJob(ctx, res.job_id, { quiet: ctx.json });
      if (ctx.json) ctx.printJson(job);
      else if (job.status === "succeeded") io.out(jsonText(job.result, 2));
      else
        io.err(
          `Job ${job.job_id} ${job.status}${
            job.error
              ? `: ${typeof job.error === "string" ? job.error : (job.error.message ?? "")}`
              : ""
          }`,
        );
      return FINISHED.has(job.status) && job.status === "succeeded" ? EXIT_OK : EXIT_FAIL;
    }
    if (ctx.json) ctx.printJson(res);
    else {
      io.out(res.job_id);
      io.err(`Queued as job ${res.job_id}. Follow it with "plughive jobs wait ${res.job_id}".`);
    }
    return EXIT_OK;
  }
  ctx.printJson(ctx.json ? res : res.result);
  return EXIT_OK;
}

export async function runTools(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "tools",
    TOOLS_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { values, ctx } = sub("tools list", args, io, {
          pack: { type: "string" },
          search: { type: "string" },
        });
        let tools = await listTools(ctx);
        if (values.pack) tools = tools.filter((t) => t.pack === values.pack);
        if (values.search) {
          const q = values.search.toLowerCase();
          tools = tools.filter((t) =>
            [t.name, t.description, ...t.tags, t.capability ?? ""].some((s) =>
              s.toLowerCase().includes(q),
            ),
          );
        }
        if (ctx.json) {
          ctx.printJson(tools);
          return EXIT_OK;
        }
        if (!tools.length) {
          io.out("No tools.");
          return EXIT_OK;
        }
        printTable(
          io,
          ["TOOL", "PACK", "KIND", "DESCRIPTION"],
          tools.map((t) => [
            t.name,
            t.pack,
            [t.long_running ? "job" : "", t.capability ? `cap:${t.capability}` : ""]
              .filter(Boolean)
              .join(" "),
            truncate(t.description, 70),
          ]),
        );
        io.out(`\n${tools.length} tools`);
        return EXIT_OK;
      },
      show: async (args) => {
        const { values, positionals, ctx } = sub(
          "tools show",
          args,
          io,
          { schema: { type: "boolean" } },
          { min: 1, max: 1, usage: "<name>" },
        );
        const name = positionals[0] ?? "";
        const tool = (await listTools(ctx)).find((t) => t.name === name);
        if (!tool) throw new CliError(`no tool "${name}"; "plughive tools list" shows them`);
        if (ctx.json) {
          ctx.printJson(tool);
          return EXIT_OK;
        }
        if (values.schema) {
          ctx.printJson(tool.input_schema);
          return EXIT_OK;
        }
        printFields(io, [
          ["tool", tool.name],
          ["pack", `${tool.pack} (${tool.origin})`],
          ["capability", tool.capability],
          ["runs as", tool.long_running ? "a background job" : "a direct call"],
          ["secrets", tool.requires_secrets.join(", ") || null],
          ["tags", tool.tags.join(", ") || null],
        ]);
        io.out(`\n${tool.description}`);
        const props = Object.entries(tool.input_schema.properties ?? {});
        if (props.length) {
          const required = new Set(tool.input_schema.required ?? []);
          io.out("\nArguments");
          printTable(
            io,
            ["NAME", "TYPE", "REQUIRED", "DEFAULT", "DESCRIPTION"],
            props.map(([k, s]) => [
              k,
              typeOf(s),
              required.has(k) ? "yes" : "",
              s.default === undefined ? "" : JSON.stringify(s.default),
              truncate(s.description, 70),
            ]),
          );
        } else io.out("\nNo arguments.");
        return EXIT_OK;
      },
      call: async (args) => {
        const { values, positionals, ctx } = sub(
          "tools call",
          args,
          io,
          {
            args: { type: "string" },
            background: { type: "boolean" },
            wait: { type: "boolean" },
            "idempotency-key": { type: "string" },
          },
          { min: 1, max: 1000, usage: "<name> [k=v | k:=json ...] [--args JSON]" },
        );
        const [name = "", ...pairs] = positionals;
        return call(ctx, name, pairs, values);
      },
    },
    "list",
  );
}
