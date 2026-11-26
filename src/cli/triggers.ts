// src/cli/triggers.ts
//
//   plughive triggers [list|show|workflows|create|update|enable|disable|delete|run|rotate-secret]
//
// The Triggers page: workflows that run on a schedule (cron) or when a URL
// is called (webhook). A webhook's secret is printed once, when it is made
// or rotated, exactly as the dashboard shows it once.
import {
  CliError,
  type CliIo,
  EXIT_FAIL,
  EXIT_OK,
  EXIT_USAGE,
  cleanLine,
  jsonText,
} from "./args.js";
import {
  COMMON_HELP,
  type Ctx,
  ago,
  confirm,
  enc,
  parseAssignments,
  printFields,
  printTable,
  readJsonObject,
  runGroup,
  sub,
  truncate,
} from "./common.js";
import { waitForJob } from "./jobs.js";

interface TriggerView {
  id: string;
  name: string;
  kind: "cron" | "webhook";
  workflow: string;
  args: Record<string, unknown>;
  schedule: string | null;
  timezone: string;
  catch_up: boolean;
  use_body: boolean;
  enabled: boolean;
  profile: string | null;
  callback: { type: string; url?: string; chat_id?: string } | null;
  webhook_url: string | null;
  next_run_at: string | null;
  last_run: { at: string; job_id: string | null; status: string; error: string | null } | null;
  created_at: string;
  updated_at: string;
}

interface TriggerRun {
  id: number;
  jobId: string | null;
  source: string;
  firedAt: number;
  status: string;
  error: string | null;
  callbackState: string;
  callbackError: string | null;
}

export const TRIGGERS_HELP = `Usage: plughive triggers <command> [options]

Run a workflow on a schedule or when a URL is called.

Commands:
  list                    every trigger: kind, workflow, next and last run (the default)
  show <id>               one trigger and its recent runs
  workflows               the workflows a trigger can run
  create <name>           make a trigger
      --workflow NAME     the workflow to run (required)
      --cron "EXPR"       run on this schedule (5-field cron), or
      --webhook           run when its URL is called (a secret is printed once)
      --tz UTC|local      the schedule's time zone (default UTC)
      --catch-up          after downtime, run once for the missed schedule
      --use-body          a webhook's JSON body becomes the arguments
      --profile ID        run as this profile
      --callback-url URL  POST the result to this URL when the run ends
      --telegram          send the result to Telegram (--telegram-chat ID for another chat)
      --disabled          create it switched off
      k=v | k:=json ...   the workflow's arguments (or --args JSON|@file|-)
  update <id>             change a trigger: --name, --cron, --tz, --catch-up/--no-catch-up,
                          --use-body/--no-use-body, --callback-url, --telegram,
                          --no-callback, --args, k=v ... (k=v and --args are merged
                          into the stored arguments)
      --replace-args      replace the stored arguments instead of merging
  enable <id>             switch it on
  disable <id>            switch it off
  delete <id>             delete it (-y to skip the question)
  run <id>                run it now (--wait to wait for the job and print the result)
  rotate-secret <id>      make a new webhook secret (the old one stops working)

${COMMON_HELP}`;

function printTrigger(io: CliIo, t: TriggerView): void {
  printFields(io, [
    ["id", t.id],
    ["name", t.name],
    ["state", t.enabled ? "on" : "off"],
    ["kind", t.kind],
    ["workflow", t.workflow],
    ["arguments", Object.keys(t.args).length ? JSON.stringify(t.args) : null],
    ["schedule", t.schedule ? `${t.schedule} (${t.timezone})` : null],
    ["catch up", t.kind === "cron" ? (t.catch_up ? "yes" : "no") : null],
    ["webhook", t.webhook_url],
    ["body as args", t.kind === "webhook" ? (t.use_body ? "yes" : "no") : null],
    ["profile", t.profile],
    [
      "callback",
      t.callback
        ? t.callback.type === "webhook"
          ? `POST ${t.callback.url}`
          : `telegram ${t.callback.chat_id ?? ""}`
        : null,
    ],
    ["next run", t.next_run_at ? `${t.next_run_at} (${ago(t.next_run_at)})` : null],
    [
      "last run",
      t.last_run
        ? `${ago(t.last_run.at)}: ${t.last_run.status}${t.last_run.job_id ? ` (job ${t.last_run.job_id})` : ""}${
            t.last_run.error ? ` - ${t.last_run.error}` : ""
          }`
        : null,
    ],
    ["created", t.created_at],
  ]);
}

function printSecret(io: CliIo, secret: string, url: string | null): void {
  io.out(`\nWebhook secret (shown once; keep it somewhere safe):\n  ${secret}`);
  if (url)
    io.out(
      `URL: ${url}\nSign each call with it (x-plughive-timestamp, x-plughive-signature): see docs/triggers.md.`,
    );
}

const CALLBACK_OPTIONS = {
  "callback-url": { type: "string" },
  telegram: { type: "boolean" },
  "telegram-chat": { type: "string" },
  args: { type: "string" },
} as const;

function callbackOf(values: {
  "callback-url"?: string;
  telegram?: boolean;
  "telegram-chat"?: string;
}) {
  if (values["callback-url"] && (values.telegram || values["telegram-chat"])) {
    throw new CliError("give --callback-url or --telegram, not both", EXIT_USAGE);
  }
  if (values["callback-url"]) return { type: "webhook", url: values["callback-url"] };
  if (values.telegram || values["telegram-chat"]) {
    return {
      type: "telegram",
      ...(values["telegram-chat"] ? { chat_id: values["telegram-chat"] } : {}),
    };
  }
  return undefined;
}

function argsOf(values: { args?: string }, pairs: string[]): Record<string, unknown> | undefined {
  if (!values.args && !pairs.length) return undefined;
  return parseAssignments(pairs, values.args ? readJsonObject(values.args, "--args") : {});
}

async function getTrigger(ctx: Ctx, id: string) {
  return ctx.api().get<{ trigger: TriggerView; runs: TriggerRun[] }>(`/api/triggers/${enc(id)}`);
}

async function patch(ctx: Ctx, id: string, body: Record<string, unknown>): Promise<number> {
  const { trigger } = await ctx
    .api()
    .patch<{ trigger: TriggerView }>(`/api/triggers/${enc(id)}`, body);
  if (ctx.json) ctx.printJson(trigger);
  else printTrigger(ctx.io, trigger);
  return EXIT_OK;
}

export async function runTriggers(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "triggers",
    TRIGGERS_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { ctx } = sub("triggers list", args, io, {});
        const { triggers } = await ctx.api().get<{ triggers: TriggerView[] }>("/api/triggers");
        if (ctx.json) {
          ctx.printJson(triggers);
          return EXIT_OK;
        }
        if (!triggers.length) {
          io.out('No triggers. Make one with "plughive triggers create".');
          return EXIT_OK;
        }
        printTable(
          io,
          ["ID", "NAME", "STATE", "KIND", "WORKFLOW", "WHEN", "NEXT", "LAST"],
          triggers.map((t) => [
            t.id,
            truncate(t.name, 30),
            t.enabled ? "on" : "off",
            t.kind,
            t.workflow,
            t.kind === "cron" ? (t.schedule ?? "") : "on call",
            t.next_run_at ? ago(t.next_run_at) : "",
            t.last_run ? `${t.last_run.status} ${ago(t.last_run.at)}` : "never",
          ]),
        );
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "triggers show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<id>" },
        );
        const body = await getTrigger(ctx, positionals[0] ?? "");
        if (ctx.json) {
          ctx.printJson(body);
          return EXIT_OK;
        }
        printTrigger(io, body.trigger);
        if (body.runs.length) {
          io.out("\nRuns");
          printTable(
            io,
            ["WHEN", "SOURCE", "STATUS", "JOB", "CALLBACK", "ERROR"],
            body.runs.map((r) => [
              ago(new Date(r.firedAt).toISOString()),
              r.source,
              r.status,
              r.jobId ?? "",
              r.callbackState === "none" ? "" : r.callbackState,
              truncate(r.error ?? r.callbackError, 60),
            ]),
          );
        }
        return EXIT_OK;
      },
      workflows: async (args) => {
        const { ctx } = sub("triggers workflows", args, io, {});
        const { workflows } = await ctx
          .api()
          .get<{ workflows: { name: string; description: string }[] }>("/api/triggers/workflows");
        if (ctx.json) ctx.printJson(workflows);
        else if (!workflows.length) io.out("No workflows. Packs with workflows add them.");
        else
          printTable(
            io,
            ["WORKFLOW", "DESCRIPTION"],
            workflows.map((w) => [w.name, truncate(w.description, 80)]),
          );
        return EXIT_OK;
      },
      create: async (args) => {
        const { values, positionals, ctx } = sub(
          "triggers create",
          args,
          io,
          {
            workflow: { type: "string" },
            cron: { type: "string" },
            webhook: { type: "boolean" },
            tz: { type: "string" },
            "catch-up": { type: "boolean" },
            "use-body": { type: "boolean" },
            profile: { type: "string" },
            disabled: { type: "boolean" },
            ...CALLBACK_OPTIONS,
          },
          {
            min: 1,
            max: 1000,
            usage: '<name> --workflow NAME (--cron "EXPR" | --webhook) [k=v ...]',
          },
        );
        const [name = "", ...pairs] = positionals;
        if (!values.workflow) throw new CliError("--workflow is required", EXIT_USAGE);
        if (!!values.cron === !!values.webhook)
          throw new CliError('give --cron "EXPR" or --webhook', EXIT_USAGE);
        const callback = callbackOf(values);
        const a = argsOf(values, pairs);
        const body = await ctx
          .api()
          .post<{ trigger: TriggerView; secret: string | null }>("/api/triggers", {
            name,
            kind: values.cron ? "cron" : "webhook",
            workflow: values.workflow,
            ...(a ? { args: a } : {}),
            ...(values.cron ? { schedule: values.cron } : {}),
            ...(values.tz ? { timezone: values.tz } : {}),
            ...(values["catch-up"] ? { catch_up: true } : {}),
            ...(values["use-body"] ? { use_body: true } : {}),
            ...(values.disabled ? { enabled: false } : {}),
            ...(values.profile ? { profile: values.profile } : {}),
            ...(callback ? { callback } : {}),
          });
        if (ctx.json) {
          ctx.printJson(body);
          return EXIT_OK;
        }
        io.out(`Created ${body.trigger.id}.\n`);
        printTrigger(io, body.trigger);
        if (body.secret) printSecret(io, body.secret, body.trigger.webhook_url);
        return EXIT_OK;
      },
      update: async (args) => {
        const { values, positionals, ctx } = sub(
          "triggers update",
          args,
          io,
          {
            name: { type: "string" },
            cron: { type: "string" },
            tz: { type: "string" },
            "catch-up": { type: "boolean" },
            "no-catch-up": { type: "boolean" },
            "use-body": { type: "boolean" },
            "no-use-body": { type: "boolean" },
            "no-callback": { type: "boolean" },
            "replace-args": { type: "boolean" },
            ...CALLBACK_OPTIONS,
          },
          { min: 1, max: 1000, usage: "<id> [options] [k=v ...]" },
        );
        const [id = "", ...pairs] = positionals;
        const callback = callbackOf(values);
        if (callback && values["no-callback"])
          throw new CliError("give a callback or --no-callback, not both", EXIT_USAGE);
        // k=v and --args change the stored arguments; --replace-args starts
        // from nothing instead.
        let a = argsOf(values, pairs);
        if (a && !values["replace-args"]) {
          const { trigger } = await getTrigger(ctx, id);
          a = parseAssignments(
            pairs,
            values.args
              ? { ...trigger.args, ...readJsonObject(values.args, "--args") }
              : trigger.args,
          );
        }
        const body: Record<string, unknown> = {
          ...(values.name ? { name: values.name } : {}),
          ...(a ? { args: a } : {}),
          ...(values.cron ? { schedule: values.cron } : {}),
          ...(values.tz ? { timezone: values.tz } : {}),
          ...(values["catch-up"]
            ? { catch_up: true }
            : values["no-catch-up"]
              ? { catch_up: false }
              : {}),
          ...(values["use-body"]
            ? { use_body: true }
            : values["no-use-body"]
              ? { use_body: false }
              : {}),
          ...(callback ? { callback } : values["no-callback"] ? { callback: null } : {}),
        };
        if (!Object.keys(body).length) throw new CliError("nothing to change", EXIT_USAGE);
        return patch(ctx, id, body);
      },
      enable: async (args) => {
        const { positionals, ctx } = sub(
          "triggers enable",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<id>" },
        );
        return patch(ctx, positionals[0] ?? "", { enabled: true });
      },
      disable: async (args) => {
        const { positionals, ctx } = sub(
          "triggers disable",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<id>" },
        );
        return patch(ctx, positionals[0] ?? "", { enabled: false });
      },
      delete: async (args) => {
        const { values, positionals, ctx } = sub(
          "triggers delete",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 1, max: 1, usage: "<id>" },
        );
        const id = positionals[0] ?? "";
        const { trigger } = await getTrigger(ctx, id);
        await confirm(
          io,
          `Delete trigger "${cleanLine(trigger.name)}" (${trigger.id})?`,
          values.yes === true,
        );
        await ctx.api().delete(`/api/triggers/${enc(id)}`);
        if (ctx.json) ctx.printJson({ deleted: id });
        else io.out(`Deleted ${id}.`);
        return EXIT_OK;
      },
      run: async (args) => {
        const { values, positionals, ctx } = sub(
          "triggers run",
          args,
          io,
          { wait: { type: "boolean" } },
          { min: 1, max: 1, usage: "<id> [--wait]" },
        );
        const body = await ctx
          .api()
          .post<{ job_id: string | null; run_id: number }>(
            `/api/triggers/${enc(positionals[0] ?? "")}/run`,
          );
        if (values.wait && body.job_id) {
          const job = await waitForJob(ctx, body.job_id, { quiet: ctx.json });
          if (ctx.json) ctx.printJson(job);
          else if (job.status === "succeeded") io.out(jsonText(job.result, 2));
          else io.err(`Job ${job.job_id} ${job.status}`);
          return job.status === "succeeded" ? EXIT_OK : EXIT_FAIL;
        }
        if (ctx.json) ctx.printJson(body);
        else
          io.out(`Started job ${body.job_id}. Follow it with "plughive jobs wait ${body.job_id}".`);
        return EXIT_OK;
      },
      "rotate-secret": async (args) => {
        const { values, positionals, ctx } = sub(
          "triggers rotate-secret",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 1, max: 1, usage: "<id>" },
        );
        const id = positionals[0] ?? "";
        const { trigger: current } = await getTrigger(ctx, id);
        if (current.kind !== "webhook")
          throw new CliError(`${id} is a ${current.kind} trigger; only webhooks have a secret`);
        await confirm(
          io,
          "Make a new secret? The old one stops working at once.",
          values.yes === true,
        );
        const { secret } = await ctx
          .api()
          .post<{ secret: string }>(`/api/triggers/${enc(id)}/rotate-secret`);
        if (ctx.json) ctx.printJson({ id, secret });
        else {
          const { trigger } = await getTrigger(ctx, id);
          printSecret(io, secret, trigger.webhook_url);
        }
        return EXIT_OK;
      },
    },
    "list",
  );
}
