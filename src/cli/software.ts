// src/cli/software.ts
//
//   plughive software [list|show|install|uninstall]
//   plughive setup [goals|plan]
//
// The Software page (programs plughive installs into its own folder, no admin
// rights) and the setup advisor (what a goal still needs on this machine).
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK } from "./args.js";
import {
  COMMON_HELP,
  type Ctx,
  confirm,
  enc,
  printFields,
  printTable,
  runGroup,
  sub,
  truncate,
} from "./common.js";
import { waitForJob } from "./jobs.js";

interface SoftwareView {
  id: string;
  name: string;
  summary: string;
  version: string;
  license: string;
  size_mb: number;
  gated: boolean;
  homepage: string;
  install_url?: string;
  tags: string[];
  bins: string[];
  method: string;
  command?: string;
  needs_approval: boolean;
  installed: boolean;
  managed: boolean;
  path: string | null;
  detected_version: string | null;
  running?: boolean;
  job_id?: string;
}

type InstallStart =
  | { status: "started"; id: string; job_id: string }
  | { status: "already_installed"; id: string; path: string | null; version: string | null }
  | { status: "approval_required"; id: string; message: string; size_mb: number; license: string }
  | { status: "manual"; id: string; message: string; url?: string; command?: string }
  | { status: "unsupported"; id: string; message: string };

export const SOFTWARE_HELP = `Usage: plughive software <command> [options]

Programs the tools use (ffmpeg, whisper, ...). plughive installs them into its
own folder, without admin rights.

Commands:
  list                  every program: installed or not, how it installs (the default)
      --fresh           look again now instead of using the 5-minute cache
      --installed       only installed ones
  show <id>             one program, checked now
  install <id>          install it; a large, gated or package-manager install
                        asks first (-y to say yes), then waits for the job
      --force           install again even when it is installed
      --no-wait         start the install and print the job id
  uninstall <id>        remove what plughive installed (-y to skip the question)

${COMMON_HELP}`;

const stateOf = (s: SoftwareView) =>
  s.job_id
    ? "installing"
    : s.installed
      ? s.managed
        ? "installed"
        : "found on this computer"
      : "not installed";

function printSoftware(io: CliIo, s: SoftwareView): void {
  printFields(io, [
    ["id", s.id],
    ["name", s.name],
    ["state", stateOf(s)],
    ["version", s.detected_version ?? s.version],
    ["path", s.path],
    ["installs with", s.method],
    ["command", s.command],
    ["size", `${s.size_mb} MB`],
    ["license", s.license],
    ["needs approval", s.needs_approval ? "yes" : null],
    ["programs", s.bins.join(", ") || null],
    ["job", s.job_id],
    ["homepage", s.homepage],
    ["about", s.summary],
  ]);
}

async function install(
  ctx: Ctx,
  id: string,
  values: { force?: boolean; yes?: boolean; "no-wait"?: boolean },
) {
  const io = ctx.io;
  const path = `/api/software/${enc(id)}/install`;
  const force = values.force ? { force: true } : {};
  let start = (await ctx.api().post<{ result: InstallStart }>(path, force)).result;
  if (start.status === "approval_required") {
    // The daemon's message points at the dashboard; here the question is ours.
    io.err(`${id} is ${start.size_mb} MB, licence ${start.license}.`);
    await confirm(io, "Install it?", values.yes === true);
    start = (await ctx.api().post<{ result: InstallStart }>(path, { ...force, approve: true }))
      .result;
  }
  switch (start.status) {
    case "already_installed":
      if (ctx.json) ctx.printJson(start);
      else
        io.out(
          `Already installed${start.version ? ` (${start.version})` : ""}${start.path ? ` at ${start.path}` : ""}.`,
        );
      return EXIT_OK;
    case "manual":
      if (ctx.json) ctx.printJson(start);
      else {
        io.out(start.message);
        if (start.command) io.out(`  ${start.command}`);
        if (start.url) io.out(`  ${start.url}`);
      }
      return EXIT_FAIL;
    case "unsupported":
      throw new CliError(start.message);
    case "approval_required":
      throw new CliError(start.message);
    case "started": {
      if (values["no-wait"]) {
        if (ctx.json) ctx.printJson(start);
        else
          io.out(
            `Installing as job ${start.job_id}. Follow it with "plughive jobs wait ${start.job_id}".`,
          );
        return EXIT_OK;
      }
      const job = await waitForJob(ctx, start.job_id, { quiet: ctx.json });
      if (ctx.json) ctx.printJson(job);
      else if (job.status === "succeeded") io.out(`Installed ${id}.`);
      else
        io.err(
          `The install ${job.status}${
            job.error
              ? `: ${typeof job.error === "string" ? job.error : (job.error.message ?? "")}`
              : ""
          }`,
        );
      return job.status === "succeeded" ? EXIT_OK : EXIT_FAIL;
    }
  }
}

export async function runSoftware(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "software",
    SOFTWARE_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { values, ctx } = sub("software list", args, io, {
          fresh: { type: "boolean" },
          installed: { type: "boolean" },
        });
        let { items } = await ctx
          .api()
          .get<{ items: SoftwareView[] }>(`/api/software${values.fresh ? "?fresh=1" : ""}`, {
            timeoutMs: 60_000,
          });
        if (values.installed) items = items.filter((s) => s.installed);
        if (ctx.json) {
          ctx.printJson(items);
          return EXIT_OK;
        }
        printTable(
          io,
          ["ID", "STATE", "VERSION", "METHOD", "SIZE", "ABOUT"],
          items.map((s) => [
            s.id,
            stateOf(s),
            s.detected_version ?? "",
            s.method,
            `${s.size_mb} MB`,
            truncate(s.summary, 50),
          ]),
        );
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "software show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<id>" },
        );
        const { item } = await ctx
          .api()
          .get<{ item: SoftwareView }>(`/api/software/${enc(positionals[0] ?? "")}`, {
            timeoutMs: 60_000,
          });
        if (ctx.json) ctx.printJson(item);
        else printSoftware(io, item);
        return EXIT_OK;
      },
      install: async (args) => {
        const { values, positionals, ctx } = sub(
          "software install",
          args,
          io,
          {
            force: { type: "boolean" },
            yes: { type: "boolean", short: "y" },
            "no-wait": { type: "boolean" },
          },
          { min: 1, max: 1, usage: "<id>" },
        );
        return install(ctx, positionals[0] ?? "", values);
      },
      uninstall: async (args) => {
        const { values, positionals, ctx } = sub(
          "software uninstall",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 1, max: 1, usage: "<id>" },
        );
        const id = positionals[0] ?? "";
        await confirm(io, `Remove ${id}?`, values.yes === true);
        const { result } = await ctx
          .api()
          .post<{ result: { status: string; message: string } }>(
            `/api/software/${enc(id)}/uninstall`,
            {},
          );
        if (ctx.json) ctx.printJson(result);
        else io.out(result.message);
        return result.status === "removed" ? EXIT_OK : EXIT_FAIL;
      },
    },
    "list",
  );
}

// ---- setup advisor ----------------------------------------------------------

interface PlanOption {
  id: string;
  name: string;
  why: string;
  cost_hint: string;
  local: boolean;
  how: { tool?: string; dashboard?: string; url?: string; text: string };
  step: string;
  size_mb?: number;
  needs_approval?: boolean;
  needs: string;
  pack?: string;
}

interface SetupPlan {
  goal: string;
  title: string;
  summary: string;
  ready: boolean;
  steps: {
    need: string;
    optional: boolean;
    done: boolean;
    done_by: string | null;
    options: PlanOption[];
  }[];
  next: PlanOption[];
}

export const SETUP_HELP = `Usage: plughive setup <command> [options]

What a goal (make images, transcribe audio, ...) still needs on this machine,
with the free and local options first.

Commands:
  goals                 the goals it knows (the default)
  plan <goal>           the steps for a goal: done or not, and how to do each
  <goal>                the same as "plan <goal>"
                        (the goal is an id, a title or a few words)

${COMMON_HELP}`;

/** The CLI command that does what an option's `how` describes, when there is one. */
function cliHint(o: PlanOption): string | null {
  if (o.needs === "install") return `plughive software install ${o.id}`;
  if (o.needs === "key" && o.pack) return `plughive secrets set ${o.pack} ${o.id}`;
  if (o.needs === "enable_pack") return `plughive pack enable ${o.id}`;
  if (o.needs === "login")
    return `plughive mounts show ${o.id}  (then "mounts enable" or "mounts login")`;
  return null;
}

export async function runSetup(input: string[], io: CliIo): Promise<number> {
  // "plughive setup make music" is "plughive setup plan make music".
  const first = input[0];
  const argv =
    first !== undefined && !first.startsWith("-") && !["goals", "plan", "help"].includes(first)
      ? ["plan", ...input]
      : input;
  return runGroup(
    "setup",
    SETUP_HELP,
    argv,
    io,
    {
      goals: async (args) => {
        const { ctx } = sub("setup goals", args, io, {});
        const { goals } = await ctx
          .api()
          .get<{ goals: { id: string; title: string; summary: string }[] }>("/api/advisor/goals");
        if (ctx.json) ctx.printJson(goals);
        else
          printTable(
            io,
            ["GOAL", "TITLE", "ABOUT"],
            goals.map((g) => [g.id, g.title, truncate(g.summary, 60)]),
          );
        return EXIT_OK;
      },
      plan: async (args) => {
        const { positionals, ctx } = sub(
          "setup plan",
          args,
          io,
          {},
          { min: 1, max: 20, usage: "<goal>" },
        );
        const goal = positionals.join(" ");
        const { plan } = await ctx
          .api()
          .get<{ plan: SetupPlan }>(`/api/advisor/plan?goal=${enc(goal)}`, { timeoutMs: 60_000 });
        if (ctx.json) {
          ctx.printJson(plan);
          return EXIT_OK;
        }
        io.out(`${plan.title}: ${plan.ready ? "ready" : "not ready yet"}`);
        io.out(plan.summary);
        for (const s of plan.steps) {
          io.out(
            `\n[${s.done ? "x" : " "}] ${s.need}${s.optional ? " (optional)" : ""}${s.done_by ? ` - ${s.done_by}` : ""}`,
          );
          if (s.done) continue;
          for (const o of s.options) {
            const hint = cliHint(o);
            io.out(`    - ${o.name} (${o.cost_hint}): ${o.why}`);
            io.out(`      ${hint ?? o.how.text}${o.size_mb ? ` [${o.size_mb} MB]` : ""}`);
          }
        }
        if (plan.next.length) {
          io.out("\nNext:");
          for (const o of plan.next) io.out(`  ${cliHint(o) ?? o.how.text}`);
        }
        return EXIT_OK;
      },
    },
    "goals",
  );
}
