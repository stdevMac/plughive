// Job status wording, and the inputs of jobs started from this page.
import { t } from "../i18n";
import type { JobStatus, JobView } from "./types";

const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "cancelled", "expired"]);

export const isTerminal = (s: JobStatus | string): boolean => TERMINAL.has(s as JobStatus);

export function jobStatusLabel(s: string): string {
  switch (s) {
    case "queued":
      return t("jobs.status.queued");
    case "running":
      return t("jobs.status.running");
    case "staging":
      return t("jobs.status.staging");
    case "submitting":
      return t("jobs.status.submitting");
    case "submitted":
      return t("jobs.status.submitted");
    case "polling":
      return t("jobs.status.polling");
    case "downloading":
      return t("jobs.status.downloading");
    case "awaiting_approval":
      return t("jobs.status.awaitingApproval");
    case "submission_unknown":
      return t("jobs.status.submissionUnknown");
    case "succeeded":
      return t("jobs.status.succeeded");
    case "failed":
      return t("jobs.status.failed");
    case "cancelled":
      return t("jobs.status.cancelled");
    case "expired":
      return t("jobs.status.expired");
    default:
      return s;
  }
}

export function jobTone(s: string): "ok" | "warn" | "danger" | "neutral" | "accent" {
  if (s === "succeeded") return "ok";
  if (s === "failed" || s === "expired") return "danger";
  if (s === "submission_unknown" || s === "awaiting_approval") return "warn";
  if (s === "cancelled") return "neutral";
  return "accent";
}

/** Progress as 0..1, or null when the job does not report it. */
export function jobProgress(j: Pick<JobView, "progress">): number | null {
  if (typeof j.progress !== "number" || !Number.isFinite(j.progress)) return null;
  const p = j.progress > 1 ? j.progress / 100 : j.progress;
  return Math.min(1, Math.max(0, p));
}

/** The API never returns a job's arguments; keep the ones sent from this tab. */
const inputs = new Map<string, unknown>();
export const rememberJobInput = (id: string, input: unknown) => {
  inputs.set(id, input);
  if (inputs.size > 200) inputs.delete(inputs.keys().next().value as string);
};
export const jobInput = (id: string): unknown => inputs.get(id);

/** A short reason from a job's error value. */
export function jobErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { message?: unknown; code?: unknown };
    if (typeof e.message === "string") return e.message;
    if (typeof e.code === "string") return e.code;
  }
  return JSON.stringify(error);
}
