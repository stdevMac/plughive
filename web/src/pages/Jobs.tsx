// Jobs: long-running tool calls, live.
import { useEffect, useMemo, useState } from "react";
import { useCancelJob } from "../components/CancelJob";
import { Drawer } from "../components/Dialog";
import { JobProgress } from "../components/JobProgress";
import { JsonView, ResultView } from "../components/ResultView";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  HumanErrorAlert,
  InlineAlert,
  KeyValues,
  Loading,
  PageHeader,
  Segmented,
} from "../components/ui";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import { useEvent, useStreamState } from "../lib/events";
import { formatDuration, formatRelative, formatTime } from "../lib/format";
import { useDocumentTitle, useNow, useResource } from "../lib/hooks";
import { oneLine } from "../lib/humanError";
import { isTerminal, jobErrorText, jobInput, jobStatusLabel, jobTone } from "../lib/jobs";
import { Link, useRouter } from "../lib/router";
import type { JobView } from "../lib/types";

type Filter = "all" | "active" | "succeeded" | "failed" | "cancelled";
const PAGE = 50;

interface JobsResponse {
  jobs: JobView[];
  counts: Record<string, number>;
  limit: number;
  offset: number;
}

function emptyTitle(filter: Filter): string {
  switch (filter) {
    case "active":
      return t("jobs.empty.active");
    case "failed":
      return t("jobs.empty.failed");
    case "all":
      return t("jobs.empty.all");
    default:
      return t("jobs.empty.other");
  }
}

function JobDetails({
  id,
  fallback,
  onClose,
  onChanged,
}: {
  id: string;
  fallback: JobView | undefined;
  onClose: () => void;
  onChanged: (j: JobView) => void;
}) {
  const res = useResource(
    (signal) => api.get<{ job: JobView }>(`/api/jobs/${encodeURIComponent(id)}`, undefined, signal),
    [id],
  );
  const [live, setLive] = useState<JobView | null>(null);
  useEvent("job", (j) => {
    if (j.job_id === id) setLive((cur) => ({ ...(cur ?? res.data?.job ?? fallback ?? j), ...j }));
  });
  const job = live ?? res.data?.job ?? fallback;
  const done = job ? isTerminal(job.status) : true;
  // Pick up the full result once the job ends.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the job finishes; live and reload are read at that moment
  useEffect(() => {
    if (done && live) void res.reload().then(() => setLive(null));
  }, [done]);
  const now = useNow(!done);
  const { ask, busy, dialog } = useCancelJob((j) => {
    setLive(j);
    onChanged(j);
  });
  const input = jobInput(id);
  const err = job ? jobErrorText(job.error) : null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={job ? job.tool : t("jobs.details.titleFallback")}
      footer={
        job && !done ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("jobs.details.close")}
            </Button>
            <Button variant="secondary" icon="stop" busy={busy === id} onClick={() => ask(job)}>
              {t("jobs.details.stop")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("jobs.details.close")}
            </Button>
            {job && (job.status === "failed" || job.status === "expired") ? (
              <Link
                to={`/playground?tool=${encodeURIComponent(job.tool)}`}
                className="btn btn-secondary"
              >
                {t("jobs.details.tryAgain")}
              </Link>
            ) : null}
          </>
        )
      }
    >
      {!job && res.loading ? (
        <Loading lines={4} />
      ) : !job ? (
        <ErrorState error={res.error} onRetry={res.reload} title={t("jobs.details.loadFailed")} />
      ) : (
        <div className="stack">
          <div className="row-gap">
            <Badge tone={jobTone(job.status)} dot>
              {jobStatusLabel(job.status)}
            </Badge>
          </div>
          {!done ? <JobProgress job={job} /> : null}
          {job.message && !done ? <p className="small muted">{job.message}</p> : null}
          <KeyValues
            rows={[
              [
                t("jobs.details.jobId"),
                <span className="row-gap" key="id">
                  <code className="small">{job.job_id}</code>
                  <CopyButton
                    text={job.job_id}
                    what={t("jobs.copy.jobId")}
                    variant="ghost"
                    iconOnly
                  />
                </span>,
              ],
              [
                t("jobs.details.tool"),
                <Link
                  key="t"
                  to={`/playground?tool=${encodeURIComponent(job.tool)}`}
                  className="mono"
                >
                  {job.tool}
                </Link>,
              ],
              [t("jobs.details.started"), formatTime(job.created_at)],
              [
                done ? t("jobs.details.took") : t("jobs.details.runningFor"),
                formatDuration(
                  (done ? Date.parse(job.updated_at) : now) - Date.parse(job.created_at),
                ),
              ],
            ]}
          />
          {job.status === "failed" || job.status === "expired" ? (
            <HumanErrorAlert
              error={
                job.error ?? (job.status === "expired" ? t("jobs.details.expiredFallback") : null)
              }
            />
          ) : err && job.status === "cancelled" ? (
            <InlineAlert tone="info" title={t("jobs.details.stopped")}>
              {err}
            </InlineAlert>
          ) : null}
          {job.status === "submission_unknown" ? (
            <InlineAlert tone="warn" title={t("jobs.details.submissionUnknownTitle")}>
              {t("jobs.details.submissionUnknownBody")}
            </InlineAlert>
          ) : null}
          {job.status === "succeeded" ? (
            <section aria-labelledby="job-result">
              <h3 className="h-sub" id="job-result">
                {t("jobs.details.result")}
              </h3>
              <ResultView result={job.result} />
            </section>
          ) : null}
          <section aria-labelledby="job-input">
            <h3 className="h-sub" id="job-input">
              {t("jobs.details.input")}
            </h3>
            {input === undefined ? (
              <p className="small muted">{t("jobs.details.inputUnavailable")}</p>
            ) : (
              <JsonView value={input} label={t("jobs.details.inputJsonLabel")} />
            )}
          </section>
        </div>
      )}
      {dialog}
    </Drawer>
  );
}

export function JobsPage() {
  useDocumentTitle(t("jobs.title"));
  const { query, setQuery } = useRouter();
  const stream = useStreamState();
  const filter = (query.get("status") as Filter | null) ?? "all";
  const serverStatus = filter === "all" || filter === "active" ? undefined : filter;
  const [extra, setExtra] = useState<JobView[]>([]);
  const [more, setMore] = useState(false);
  const data = useResource(
    (signal) => api.get<JobsResponse>("/api/jobs", { status: serverStatus, limit: PAGE }, signal),
    [serverStatus],
  );
  const [jobs, setJobs] = useState<JobView[]>([]);
  const openId = query.get("job");

  useEffect(() => {
    setJobs(data.data?.jobs ?? []);
    setExtra([]);
  }, [data.data]);

  const upsert = (j: JobView) =>
    setJobs((list) => {
      const i = list.findIndex((x) => x.job_id === j.job_id);
      if (i >= 0) {
        const n = [...list];
        n[i] = { ...n[i], ...j } as JobView;
        return n;
      }
      if (serverStatus && j.status !== serverStatus) return list;
      return [j, ...list];
    });
  useEvent("job", upsert);
  const toast = useToast();
  const { ask, busy, dialog } = useCancelJob(upsert);

  const loadMore = async () => {
    setMore(true);
    try {
      const r = await api.get<JobsResponse>("/api/jobs", {
        status: serverStatus,
        limit: PAGE,
        offset: jobs.length + extra.length,
      });
      setExtra((e) => [...e, ...r.jobs.filter((j) => !jobs.some((x) => x.job_id === j.job_id))]);
    } catch (e) {
      toast.error(t("jobs.loadMoreFailed", { error: errorMessage(e) }));
    } finally {
      setMore(false);
    }
  };

  const all = useMemo(() => [...jobs, ...extra], [jobs, extra]);
  const shown = filter === "active" ? all.filter((j) => !isTerminal(j.status)) : all;
  const counts = data.data?.counts ?? {};
  const activeCount = Object.entries(counts).reduce((n, [s, c]) => (isTerminal(s) ? n : n + c), 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const failedCount = (counts.failed ?? 0) + (counts.expired ?? 0);
  const totalForFilter =
    filter === "all" ? total : filter === "active" ? activeCount : (counts[filter] ?? 0);
  const now = useNow(
    shown.some((j) => !isTerminal(j.status)),
    5000,
  );

  return (
    <>
      <PageHeader
        title={t("jobs.title")}
        description={t("jobs.header.description")}
        actions={
          // biome-ignore lint/a11y/useSemanticElements: inline live status in the page header; output is for form results
          <span className={`live live-${stream}`} role="status">
            <span className="live-dot" aria-hidden="true" />
            {stream === "open"
              ? t("jobs.live.open")
              : stream === "connecting"
                ? t("jobs.live.connecting")
                : t("jobs.live.closed")}
          </span>
        }
      />
      <div className="toolbar">
        <Segmented<Filter>
          label={t("jobs.filter.label")}
          value={filter}
          onChange={(v) => setQuery({ status: v === "all" ? null : v })}
          options={[
            { value: "all", label: t("jobs.filter.all", { count: total }) },
            { value: "active", label: t("jobs.filter.active", { count: activeCount }) },
            { value: "succeeded", label: t("jobs.filter.succeeded") },
            { value: "failed", label: t("jobs.filter.failed", { count: failedCount }) },
            { value: "cancelled", label: t("jobs.filter.cancelled") },
          ]}
        />
      </div>
      {data.loading && !data.data ? (
        <Loading lines={6} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="clock"
          title={emptyTitle(filter)}
          action={
            filter === "all" ? (
              <Link to="/playground" className="btn btn-secondary">
                {t("jobs.empty.openPlayground")}
              </Link>
            ) : (
              <Button variant="secondary" onClick={() => setQuery({ status: null })}>
                {t("jobs.empty.showAll")}
              </Button>
            )
          }
        >
          {filter === "all" ? t("jobs.empty.bodyAll") : t("jobs.empty.bodyOther")}
        </EmptyState>
      ) : (
        <div className="card table-card">
          <table className="table">
            <caption className="visually-hidden">{t("jobs.table.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("jobs.table.tool")}</th>
                <th scope="col">{t("jobs.table.status")}</th>
                <th scope="col">{t("jobs.table.started")}</th>
                <th scope="col">{t("jobs.table.duration")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("jobs.table.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((j) => {
                const done = isTerminal(j.status);
                return (
                  <tr key={j.job_id} className={openId === j.job_id ? "row-on" : ""}>
                    <td>
                      <button
                        type="button"
                        className="row-link mono"
                        onClick={() => setQuery({ job: j.job_id }, { replace: false })}
                        aria-label={t("jobs.row.ariaLabel", {
                          tool: j.tool,
                          time: formatRelative(j.created_at),
                        })}
                      >
                        {j.tool}
                      </button>
                      {j.message && !done ? (
                        <div className="small muted truncate">{j.message}</div>
                      ) : null}
                      {j.status === "failed" || j.status === "expired" ? (
                        <div className="small row-error truncate">
                          {oneLine(j.error ?? t("jobs.row.errorFallback"))}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <div className="status-cell">
                        <Badge tone={jobTone(j.status)} dot>
                          {jobStatusLabel(j.status)}
                        </Badge>
                        {!done ? <JobProgress job={j} small elapsed={false} /> : null}
                      </div>
                    </td>
                    <td className="nowrap" title={formatTime(j.created_at)}>
                      {formatRelative(j.created_at, now)}
                    </td>
                    <td>
                      {formatDuration(
                        (done ? Date.parse(j.updated_at) : now) - Date.parse(j.created_at),
                      )}
                    </td>
                    <td className="cell-actions">
                      {!done ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="stop"
                          busy={busy === j.job_id}
                          onClick={() => ask(j)}
                          aria-label={t("jobs.row.stopAria", { tool: j.tool })}
                        >
                          {t("jobs.row.stop")}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filter !== "active" && all.length < totalForFilter ? (
            <div className="table-foot">
              <Button variant="secondary" onClick={loadMore} busy={more}>
                {t("jobs.showMore")}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {openId ? (
        <JobDetails
          id={openId}
          fallback={all.find((j) => j.job_id === openId)}
          onClose={() => setQuery({ job: null }, { replace: false })}
          onChanged={upsert}
        />
      ) : null}
      {openId ? null : dialog}
    </>
  );
}
