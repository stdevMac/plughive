// A job's progress bar with the percent (or "Working") and the time since it
// started, as text next to the bar so it does not rely on the bar alone.
import { t } from "../i18n";
import { formatDuration } from "../lib/format";
import { useNow } from "../lib/hooks";
import { isTerminal, jobProgress } from "../lib/jobs";
import type { JobView } from "../lib/types";

export function JobProgress({
  job,
  small,
  elapsed = true,
}: { job: JobView; small?: boolean; elapsed?: boolean }) {
  const live = !isTerminal(job.status);
  const now = useNow(live && elapsed);
  const p = jobProgress(job);
  const pct = p === null ? null : Math.round(p * 100);
  const end = live ? now : new Date(job.updated_at).getTime();
  const ms = end - new Date(job.created_at).getTime();
  const time = elapsed ? formatDuration(Math.max(0, ms)) : "";
  // A queued job has not started: no bar and no clock, just say so.
  if (job.status === "queued")
    return <span className="progress-text muted">{t("jobs.progress.waiting")}</span>;
  return (
    <span className="progress-row">
      {/* biome-ignore lint/a11y/useFocusableInteractive: a progressbar is read-only and not focusable */}
      <span
        className={`progress ${small ? "progress-sm" : ""}`}
        role="progressbar"
        aria-label={t("jobs.progress.ariaLabel", { tool: job.tool })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={
          pct === null ? t("jobs.progress.noPercent") : t("jobs.progress.pct", { pct })
        }
      >
        <span
          className={pct === null ? "progress-indeterminate" : ""}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </span>
      <span className="progress-text">
        {pct === null ? t("jobs.progress.working") : t("jobs.progress.pct", { pct })}
        {time ? ` · ${time}` : ""}
      </span>
    </span>
  );
}
