// src/core/tools/builtin/jobs.ts
//
// get_job_status: one background job, read from its database row. A caller on
// a non-default exposure profile only sees the jobs that profile started; any
// other id answers exactly like an unknown one.
import { z } from "zod";
import type { Job } from "../../../types.js";
import { currentScopeSeesJob } from "../../mcp/scope.js";
import type { RegisteredTool } from "../registry.js";
import { coreTool } from "./define.js";

export type JobRow = Job & { profile?: string | null };

export interface JobToolDeps {
  jobs: { get(id: string): JobRow | null };
}

export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A job as tools and the API report it. The stored arguments are not included. */
export function jobView(job: JobRow) {
  const message = job.checkpoint.progress_message;
  const finished = ["succeeded", "failed", "cancelled", "expired"].includes(job.status);
  // Internal job types are shown by the tool that started them, so the name opens in the Playground.
  const tool =
    job.tool === "core.tool_call" && typeof job.input.tool === "string"
      ? job.input.tool
      : job.tool === "system.install_software"
        ? "install_software"
        : job.tool;
  return {
    job_id: job.id,
    tool,
    status: job.status,
    // A finished job's last step message ("saving vocals") is stale; a success is complete.
    progress: job.status === "succeeded" && job.progress !== null ? 1 : job.progress,
    message: typeof message === "string" && !finished ? message : null,
    result: job.result ?? null,
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  };
}

export function jobTools(deps: JobToolDeps): RegisteredTool[] {
  return [
    coreTool({
      name: "get_job_status",
      description:
        "Status, progress and result of a background job by id. Does not wait: use wait_for_job to block until it finishes.",
      input: z.object({ job_id: z.string().regex(JOB_ID_PATTERN, "invalid job id") }).strict(),
      tags: ["jobs"],
      run: ({ job_id }) => {
        const job = deps.jobs.get(job_id);
        if (!job || !currentScopeSeesJob(job.profile)) throw new Error(`job ${job_id} not found`);
        return jobView(job);
      },
    }),
  ];
}
