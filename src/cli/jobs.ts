// src/cli/jobs.ts
//
//   plughive jobs [list|show|wait|cancel]
//   plughive artifacts [list|show|download|delete]
//   plughive usage [--since DATE]
//
// The Jobs, Library and Usage pages of the dashboard, through the same /api.
import { constants, closeSync, createWriteStream, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openSyncNoFollow } from "../lib/platform.js";
import { daemonTarget } from "./api.js";
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK, EXIT_USAGE, jsonText } from "./args.js";
import {
  COMMON_HELP,
  type Ctx,
  ago,
  confirm,
  enc,
  printFields,
  printTable,
  runGroup,
  sleep,
  sub,
  truncate,
  usd,
} from "./common.js";

export interface JobView {
  job_id: string;
  tool: string;
  status: string;
  progress: number | null;
  message: string | null;
  result: unknown;
  error: { code?: string; message?: string } | string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The statuses a job never leaves, as the daemon defines them (src/lib/jobs.ts):
 * submission_unknown is final until someone reconciles it by hand.
 */
export const FINISHED = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "submission_unknown",
]);

const pct = (p: number | null) => (p === null || p === undefined ? "" : `${Math.round(p * 100)}%`);
const errorText = (e: JobView["error"]) =>
  e === null || e === undefined
    ? ""
    : typeof e === "string"
      ? e
      : `${e.code ? `${e.code}: ` : ""}${e.message ?? ""}`;

export const JOBS_HELP = `Usage: plughive jobs <command> [options]

Background jobs: what runs, what finished, with progress and results.

Commands:
  list                  newest first, with counts by status (the default)
      --status S        only jobs with this status (queued, running, succeeded,
                        failed, cancelled, awaiting_approval, ...)
      --limit N         at most N jobs (default 50, max 200)
      --offset N        skip the first N
  show <job-id>         status, progress, result and error of one job
  wait <job-id>         wait until the job ends, showing progress; prints the result
      --timeout SEC     give up after SEC seconds (default: wait as long as it takes)
  cancel <job-id>       cancel a job that has not finished

${COMMON_HELP}

Exit codes: wait exits 1 when the job did not succeed.`;

function printJob(ctx: Ctx, job: JobView): void {
  printFields(ctx.io, [
    ["job", job.job_id],
    ["tool", job.tool],
    ["status", job.status],
    ["progress", pct(job.progress)],
    ["message", job.message],
    ["created", `${job.created_at} (${ago(job.created_at)})`],
    ["updated", `${job.updated_at} (${ago(job.updated_at)})`],
    ["error", errorText(job.error)],
  ]);
  if (job.result !== null && job.result !== undefined) {
    ctx.io.out("result:");
    ctx.io.out(jsonText(job.result, 2));
  }
}

/** Polls a job until it ends. Progress lines go to stderr; resolves the final job. */
export async function waitForJob(
  ctx: Ctx,
  id: string,
  opts: { timeoutS?: number; quiet?: boolean } = {},
): Promise<JobView> {
  const deadline = opts.timeoutS ? Date.now() + opts.timeoutS * 1000 : Number.POSITIVE_INFINITY;
  let last = "";
  for (;;) {
    const { job } = await ctx.api().get<{ job: JobView }>(`/api/jobs/${enc(id)}`);
    const line = `${job.status}${job.progress !== null ? ` ${pct(job.progress)}` : ""}${
      job.message ? ` ${job.message}` : ""
    }`;
    if (!opts.quiet && line !== last) {
      ctx.io.err(`[${job.job_id}] ${line}`);
      last = line;
    }
    if (FINISHED.has(job.status)) return job;
    if (Date.now() > deadline) {
      throw new CliError(`the job is still ${job.status} after ${opts.timeoutS} s`);
    }
    await sleep(1000);
  }
}

const JOB_ID_USAGE = "<job-id>";

export async function runJobs(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "jobs",
    JOBS_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { values, ctx } = sub("jobs list", args, io, {
          status: { type: "string" },
          limit: { type: "string" },
          offset: { type: "string" },
        });
        const q = new URLSearchParams();
        if (values.status) q.set("status", values.status);
        if (values.limit) q.set("limit", values.limit);
        if (values.offset) q.set("offset", values.offset);
        const body = await ctx
          .api()
          .get<{ jobs: JobView[]; counts: Record<string, number> }>(
            `/api/jobs${q.size ? `?${q}` : ""}`,
          );
        if (ctx.json) {
          ctx.printJson(body);
          return EXIT_OK;
        }
        if (!body.jobs.length) io.out("No jobs.");
        else
          printTable(
            io,
            ["JOB", "TOOL", "STATUS", "PROGRESS", "CREATED", "NOTE"],
            body.jobs.map((j) => [
              j.job_id,
              j.tool,
              j.status,
              pct(j.progress),
              ago(j.created_at),
              truncate(j.message ?? errorText(j.error), 60),
            ]),
          );
        const counts = Object.entries(body.counts ?? {})
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${n} ${s}`);
        if (counts.length) io.out(`\n${counts.join(", ")}`);
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "jobs show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: JOB_ID_USAGE },
        );
        const { job } = await ctx
          .api()
          .get<{ job: JobView }>(`/api/jobs/${enc(positionals[0] ?? "")}`);
        if (ctx.json) ctx.printJson(job);
        else printJob(ctx, job);
        return EXIT_OK;
      },
      wait: async (args) => {
        const { values, positionals, ctx } = sub(
          "jobs wait",
          args,
          io,
          { timeout: { type: "string" } },
          { min: 1, max: 1, usage: JOB_ID_USAGE },
        );
        const timeoutS = values.timeout ? Number(values.timeout) : undefined;
        if (timeoutS !== undefined && !(timeoutS > 0)) {
          throw new CliError("--timeout must be a number of seconds", EXIT_USAGE);
        }
        const job = await waitForJob(ctx, positionals[0] ?? "", {
          ...(timeoutS ? { timeoutS } : {}),
          quiet: ctx.json,
        });
        if (ctx.json) ctx.printJson(job);
        else printJob(ctx, job);
        return job.status === "succeeded" ? EXIT_OK : EXIT_FAIL;
      },
      cancel: async (args) => {
        const { positionals, ctx } = sub(
          "jobs cancel",
          args,
          io,
          {},
          { min: 1, max: 1, usage: JOB_ID_USAGE },
        );
        const { job } = await ctx
          .api()
          .post<{ job: JobView }>(`/api/jobs/${enc(positionals[0] ?? "")}/cancel`);
        if (ctx.json) ctx.printJson(job);
        else io.out(`Job ${job.job_id} is ${job.status}.`);
        return EXIT_OK;
      },
    },
    "list",
  );
}

// ---- artifacts --------------------------------------------------------------

interface ArtifactView {
  id: string;
  url: string;
  name: string;
  kind: string;
  mime: string;
  bytes: number;
  tool: string;
  model: string | null;
  prompt: string | null;
  cost_usd: number | null;
  meta: unknown;
  createdAt: string;
}

const size = (bytes: number) =>
  bytes >= 1 << 20
    ? `${(bytes / (1 << 20)).toFixed(1)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(0)} kB`
      : `${bytes} B`;

export const ARTIFACTS_HELP = `Usage: plughive artifacts <command> [options]

The library: every file the tools made (images, audio, video, documents).

Commands:
  list                  newest first (the default)
      --kind K          only this kind (image, audio, video, text, ...)
      --limit N         at most N (default 50, max 200)
      --offset N        skip the first N
  show <id>             everything known about one artifact, with its link
  download <id>         save the file
      -o, --output P    where to save it (default: its name, in this folder)
      --force           overwrite an existing file
  delete <id>           delete the artifact and its file (asks first)
      -y, --yes         do not ask

${COMMON_HELP}`;

/**
 * Where to download an artifact from. Its url comes from the daemon; it must
 * point at the daemon's own /artifacts/ path, so a daemon answer cannot make
 * the CLI fetch from (or report to) another host. It is fetched through the
 * local address, as every other call is.
 */
function artifactUrl(ctx: Ctx, a: ArtifactView): string {
  const target = daemonTarget(ctx.env);
  let url: URL;
  try {
    url = new URL(a.url);
  } catch {
    throw new CliError(`artifact ${a.id} has no usable url`);
  }
  const ours = [new URL(target.baseUrl).origin, new URL(target.localUrl).origin];
  if (!ours.includes(url.origin) || !url.pathname.startsWith("/artifacts/"))
    throw new CliError(
      `artifact ${a.id} points at ${url.origin}, not this daemon; not downloading`,
    );
  return new URL(`${url.pathname}${url.search}`, target.localUrl).toString();
}

async function findArtifact(ctx: Ctx, id: string): Promise<ArtifactView> {
  // There is no GET /api/artifacts/:id; page through the library.
  for (let offset = 0; ; offset += 200) {
    const page = await ctx
      .api()
      .get<{ artifacts: ArtifactView[]; total: number }>(
        `/api/artifacts?limit=200&offset=${offset}`,
      );
    const hit = page.artifacts.find((a) => a.id === id);
    if (hit) return hit;
    if (offset + page.artifacts.length >= page.total || !page.artifacts.length) break;
  }
  throw new CliError(`no artifact ${id}`);
}

export async function runArtifacts(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "artifacts",
    ARTIFACTS_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { values, ctx } = sub("artifacts list", args, io, {
          kind: { type: "string" },
          limit: { type: "string" },
          offset: { type: "string" },
        });
        const q = new URLSearchParams();
        if (values.kind) q.set("kind", values.kind);
        if (values.limit) q.set("limit", values.limit);
        if (values.offset) q.set("offset", values.offset);
        const body = await ctx
          .api()
          .get<{ artifacts: ArtifactView[]; total: number; offset: number }>(
            `/api/artifacts${q.size ? `?${q}` : ""}`,
          );
        if (ctx.json) {
          ctx.printJson(body);
          return EXIT_OK;
        }
        if (!body.artifacts.length) {
          io.out("The library is empty.");
          return EXIT_OK;
        }
        printTable(
          io,
          ["ID", "KIND", "SIZE", "TOOL", "COST", "CREATED", "NAME"],
          body.artifacts.map((a) => [
            a.id,
            a.kind,
            size(a.bytes),
            a.tool,
            usd(a.cost_usd),
            ago(a.createdAt),
            truncate(a.name, 40),
          ]),
        );
        io.out(`\n${body.artifacts.length} of ${body.total} shown`);
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "artifacts show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<id>" },
        );
        const a = await findArtifact(ctx, positionals[0] ?? "");
        if (ctx.json) ctx.printJson(a);
        else
          printFields(io, [
            ["id", a.id],
            ["name", a.name],
            ["kind", a.kind],
            ["mime", a.mime],
            ["size", size(a.bytes)],
            ["tool", a.tool],
            ["model", a.model],
            ["cost", usd(a.cost_usd)],
            ["created", `${a.createdAt} (${ago(a.createdAt)})`],
            ["prompt", a.prompt],
            ["url", a.url],
          ]);
        return EXIT_OK;
      },
      download: async (args) => {
        const { values, positionals, ctx } = sub(
          "artifacts download",
          args,
          io,
          { output: { type: "string", short: "o" }, force: { type: "boolean" } },
          { min: 1, max: 1, usage: "<id> [-o FILE]" },
        );
        const a = await findArtifact(ctx, positionals[0] ?? "");
        // The name comes from the daemon: keep only its last part, so a name
        // like "../../.bashrc" cannot write outside the current folder.
        const safeName = [...basename((a.name ?? "").replaceAll("\\", "/"))]
          .filter((ch) => ch.charCodeAt(0) >= 0x20)
          .join("");
        if (!values.output && (!safeName || safeName === "." || safeName === ".."))
          throw new CliError(`artifact ${a.id} has no usable file name; pass -o FILE`, EXIT_USAGE);
        const dest = resolve(values.output ?? safeName);
        const res = await fetch(artifactUrl(ctx, a), { redirect: "error" }).catch(() => null);
        if (!res?.ok || !res.body) {
          throw new CliError(`could not download ${a.id}${res ? ` (HTTP ${res.status})` : ""}`);
        }
        // O_NOFOLLOW: a symlink planted at the destination is refused, not
        // followed, even with --force.
        const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC } = constants;
        let fd: number;
        try {
          fd = openSyncNoFollow(
            dest,
            O_WRONLY | O_CREAT | (values.force ? O_TRUNC : O_EXCL),
            0o644,
          );
        } catch (e) {
          await res.body.cancel().catch(() => {});
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new CliError(`${dest} exists; pass --force to overwrite it`);
          if (code === "ELOOP") throw new CliError(`${dest} is a symlink; not writing through it`);
          throw new CliError(`could not write ${dest}: ${(e as Error).message}`);
        }
        try {
          await pipeline(
            Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
            createWriteStream(dest, { fd }),
          );
        } catch (e) {
          closeSync(fd);
          // Leave no half-written file behind to block the retry.
          rmSync(dest, { force: true });
          throw new CliError(
            `could not save ${a.id} to ${dest}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        if (ctx.json) ctx.printJson({ id: a.id, path: dest, bytes: a.bytes });
        else io.out(`Saved ${a.id} to ${dest}`);
        return EXIT_OK;
      },
      delete: async (args) => {
        const { values, positionals, ctx } = sub(
          "artifacts delete",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 1, max: 1, usage: "<id>" },
        );
        const id = positionals[0] ?? "";
        await confirm(
          io,
          `Delete artifact ${id} and its file? This cannot be undone.`,
          values.yes === true,
        );
        const body = await ctx
          .api()
          .delete<{ id: string; file_removed: boolean }>(`/api/artifacts/${enc(id)}`);
        if (ctx.json) ctx.printJson(body);
        else
          io.out(`Deleted ${body.id}${body.file_removed ? "" : " (its file was already gone)"}.`);
        return EXIT_OK;
      },
    },
    "list",
  );
}

// ---- usage ------------------------------------------------------------------

export const USAGE_HELP = `Usage: plughive usage [options]

Calls and estimated cost: totals, by vendor, by capability and by tool, with
the vendors' rate-limit state.

Options:
  --since WHEN  only calls since then: an ISO date (2026-01-31, or a full
                timestamp) or a time ago (90m, 24h, 7d, 4w)
  --days N      only the last N days (the same as --since Nd)
  --by-day      also the table by provider and day
  --limit N     rows by provider and day (default 500, max 2000)
${COMMON_HELP}`;

interface UsageBody {
  since: string | null;
  summary: {
    total_calls: number;
    ok_calls: number | null;
    error_calls: number | null;
    fallback_calls: number | null;
    cached_calls: number;
    total_cost_usd: number;
    by_tool: { tool: string; calls: number; cost_usd: number }[];
    by_vendor: { vendor: string; calls: number; cost_usd: number }[];
    by_capability: { capability: string; calls: number; cost_usd: number }[];
    rate_limits: unknown[];
  };
  by_provider_day: {
    day: string;
    provider: string;
    calls: number;
    errors: number;
    cost_usd: number;
  }[];
}

const AGO_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** --since as an ISO timestamp: "7d", "24h" or "90m" ago, or a date. */
export function sinceOf(text: string, now = Date.now()): string {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(text.trim());
  if (m)
    return new Date(now - Number(m[1]) * (AGO_MS[(m[2] ?? "d").toLowerCase()] ?? 0)).toISOString();
  const t = Date.parse(text);
  if (Number.isNaN(t))
    throw new CliError(
      `--since: "${text}" is not a date (2026-01-31) or a time ago (7d, 24h)`,
      EXIT_USAGE,
    );
  return new Date(t).toISOString();
}

export async function runUsage(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    io.out(USAGE_HELP);
    return EXIT_OK;
  }
  const { values, ctx } = sub("usage", argv, io, {
    since: { type: "string" },
    days: { type: "string" },
    limit: { type: "string" },
    "by-day": { type: "boolean" },
  });
  if (values.days && values.since)
    throw new CliError("give --since or --days, not both", EXIT_USAGE);
  const q = new URLSearchParams();
  if (values.days) {
    const days = Number(values.days);
    if (!(days > 0)) throw new CliError("--days must be a positive number", EXIT_USAGE);
    q.set("since", new Date(Date.now() - days * 86_400_000).toISOString());
  } else if (values.since) q.set("since", sinceOf(values.since));
  if (values.limit) q.set("limit", values.limit);
  const body = await ctx.api().get<UsageBody>(`/api/usage${q.size ? `?${q}` : ""}`);
  if (ctx.json) {
    ctx.printJson(body);
    return EXIT_OK;
  }
  const s = body.summary;
  io.out(`Usage${body.since ? ` since ${body.since}` : " (all time)"}`);
  printFields(io, [
    [
      "calls",
      `${s.total_calls} (${s.ok_calls ?? 0} ok, ${s.error_calls ?? 0} failed, ${s.fallback_calls ?? 0} fell back, ${s.cached_calls ?? 0} cached)`,
    ],
    ["estimated cost", usd(s.total_cost_usd) || "$0.00"],
  ]);
  const section = (
    title: string,
    head: string,
    rows: { name: string; calls: number; cost_usd: number }[],
  ) => {
    if (!rows.length) return;
    io.out(`\n${title}`);
    printTable(
      io,
      [head, "CALLS", "COST"],
      rows.map((r) => [r.name, r.calls, usd(r.cost_usd)]),
    );
  };
  section(
    "By vendor",
    "VENDOR",
    s.by_vendor.map((r) => ({ ...r, name: r.vendor })),
  );
  section(
    "By capability",
    "CAPABILITY",
    s.by_capability.map((r) => ({ ...r, name: r.capability })),
  );
  section(
    "By tool",
    "TOOL",
    s.by_tool.map((r) => ({ ...r, name: r.tool })),
  );
  if (values["by-day"] && body.by_provider_day.length) {
    io.out("\nBy provider and day");
    printTable(
      io,
      ["DAY", "PROVIDER", "CALLS", "ERRORS", "COST"],
      body.by_provider_day.map((r) => [r.day, r.provider, r.calls, r.errors, usd(r.cost_usd)]),
    );
  }
  if (s.rate_limits.length) {
    io.out("\nRate limits");
    io.out(jsonText(s.rate_limits, 2));
  }
  return EXIT_OK;
}
