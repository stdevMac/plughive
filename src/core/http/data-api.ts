// src/core/http/data-api.ts
//
// Read side of the management API: usage, jobs and artifacts.
//
//   GET  /api/usage                 totals + calls and cost by provider and day
//                                   ?since=<ISO date> &limit=<1..2000 rows>
//   GET  /api/jobs                  background jobs, newest first, + counts by status
//                                   ?status=<job status> &limit=<1..200> &offset=<n>
//   GET  /api/jobs/:id              one job (status, progress, result, error)
//   POST /api/jobs/:id/cancel       cancel a job that has not finished
//   GET  /api/artifacts             the artifact library, newest first
//                                   ?kind=<artifact kind> &limit=<1..200> &offset=<n>
//   DELETE /api/artifacts/:id       delete one artifact: its row and its file
//
// All of it sits behind the admin token (app.use("/api")), the Origin guard
// and, for the writes, the CSRF rule. This API is the user's own view: it
// sees every job, whichever exposure profile started it. A job's stored
// arguments are never returned.
import type { Express } from "express";
import { z } from "zod";
import { ARTIFACT_ID_PATTERN } from "../../lib/library.js";
import type { UsageByProviderDay, UsageSummary } from "../../lib/usage.js";
import type { Artifact, ArtifactKind, JobStatus } from "../../types.js";
import { ARTIFACT_KINDS } from "../pack-api.js";
import { JOB_ID_PATTERN, type JobRow, artifactView, jobView } from "../tools/builtin/index.js";
import {
  type ApiLogger,
  apiRouter,
  fail,
  intQuery,
  isoQuery,
  mountApi,
  parse,
  route,
} from "./api-common.js";
import type { OriginPolicy } from "./origin.js";

export interface DataApiDeps {
  origin: OriginPolicy;
  logger?: ApiLogger;
  usage: {
    summarize(opts: { since?: string }): UsageSummary;
    byProviderAndDay(opts: { since?: string; limit?: number }): UsageByProviderDay[];
  };
  jobs: {
    list(opts: { status?: JobStatus; limit?: number; offset?: number }): JobRow[];
    get(id: string): JobRow | null;
    counts(): Record<string, number>;
    cancel(id: string): boolean;
  };
  library: {
    list(filter: { kind?: ArtifactKind }, limit?: number, offset?: number): Artifact[];
    count(kind?: ArtifactKind): number;
    /** Delete one artifact (row and file); null for an unknown id. */
    remove(id: string): { fileRemoved: boolean } | null;
  };
  /** Download URL of an artifact (signed when an access key is required). */
  artifactUrl(id: string): string;
  /** Applied to job results: signs the artifact links inside them. */
  decorate?(value: unknown): unknown;
}

const JOB_STATUSES = [
  "queued",
  "running",
  "staging",
  "submitting",
  "submitted",
  "polling",
  "downloading",
  "awaiting_approval",
  "submission_unknown",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const satisfies readonly JobStatus[];

const UsageQuery = z.object({ since: isoQuery, limit: intQuery(1, 2000) }).strict();
const JobsQuery = z
  .object({
    status: z.enum(JOB_STATUSES).optional(),
    limit: intQuery(1, 200),
    offset: intQuery(0, 1_000_000),
  })
  .strict();
const ArtifactsQuery = z
  .object({
    kind: z.enum(ARTIFACT_KINDS as [ArtifactKind, ...ArtifactKind[]]).optional(),
    limit: intQuery(1, 200),
    offset: intQuery(0, 1_000_000),
  })
  .strict();

export function mountDataApi(app: Express, deps: DataApiDeps): void {
  const decorate = deps.decorate ?? ((v: unknown) => v);
  const view = (job: JobRow) => {
    const v = jobView(job);
    return { ...v, result: decorate(v.result) };
  };

  const usage = apiRouter(deps.origin);
  usage.get(
    "/",
    route((req, res) => {
      const q = parse(UsageQuery, req.query, res);
      if (!q) return;
      const since = q.since ? { since: q.since } : {};
      res.json({
        ok: true,
        since: q.since ?? null,
        summary: deps.usage.summarize(since),
        by_provider_day: deps.usage.byProviderAndDay({ ...since, limit: q.limit ?? 500 }),
      });
    }),
  );
  mountApi(app, "/api/usage", usage, deps.logger);

  const jobs = apiRouter(deps.origin);
  jobs.get(
    "/",
    route((req, res) => {
      const q = parse(JobsQuery, req.query, res);
      if (!q) return;
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const rows = deps.jobs.list({ ...(q.status ? { status: q.status } : {}), limit, offset });
      res.json({ ok: true, jobs: rows.map(view), counts: deps.jobs.counts(), limit, offset });
    }),
  );
  const jobOr404 = (id: string | undefined) =>
    id !== undefined && JOB_ID_PATTERN.test(id) ? deps.jobs.get(id) : null;
  jobs.get(
    "/:id",
    route((req, res) => {
      const job = jobOr404(req.params.id);
      if (!job) return fail(res, 404, "UNKNOWN_JOB", "no such job");
      res.json({ ok: true, job: view(job) });
    }),
  );
  jobs.post(
    "/:id/cancel",
    route((req, res) => {
      const job = jobOr404(req.params.id);
      if (!job) return fail(res, 404, "UNKNOWN_JOB", "no such job");
      const cancelled = deps.jobs.cancel(job.id);
      const now = deps.jobs.get(job.id) ?? job;
      if (!cancelled) {
        return fail(res, 409, "JOB_FINISHED", `the job already ended (${now.status})`);
      }
      res.json({ ok: true, job: view(now) });
    }),
  );
  mountApi(app, "/api/jobs", jobs, deps.logger);

  const artifacts = apiRouter(deps.origin);
  artifacts.get(
    "/",
    route((req, res) => {
      const q = parse(ArtifactsQuery, req.query, res);
      if (!q) return;
      const limit = q.limit ?? 50;
      const offset = q.offset ?? 0;
      const rows = deps.library.list(q.kind ? { kind: q.kind } : {}, limit, offset);
      res.json({
        ok: true,
        artifacts: rows.map((a) => artifactView(a, deps.artifactUrl)),
        total: deps.library.count(q.kind),
        limit,
        offset,
      });
    }),
  );
  // The user's own delete. Never an MCP tool: agents must not remove the
  // user's files. The id must be one this library could have issued; the file
  // path comes from the stored row only (Library.remove checks it lies inside
  // the artifacts folder).
  artifacts.delete(
    "/:id",
    route((req, res) => {
      const id = req.params.id;
      if (id === undefined || !ARTIFACT_ID_PATTERN.test(id)) {
        return fail(res, 400, "INVALID_ARTIFACT_ID", "not an artifact id");
      }
      const removed = deps.library.remove(id);
      if (!removed) return fail(res, 404, "UNKNOWN_ARTIFACT", "no such artifact");
      deps.logger?.info({ artifact: id, file_removed: removed.fileRemoved }, "artifact deleted");
      res.json({ ok: true, id, file_removed: removed.fileRemoved });
    }),
  );
  mountApi(app, "/api/artifacts", artifacts, deps.logger);
}
