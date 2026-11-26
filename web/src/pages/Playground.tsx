import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
// Playground: pick a tool, fill in its form, run it and see what comes back.
import { useCancelJob } from "../components/CancelJob";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { JobProgress } from "../components/JobProgress";
import { ResultView } from "../components/ResultView";
import { SchemaForm } from "../components/SchemaForm";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  HumanErrorAlert,
  InlineAlert,
  Loading,
  PageHeader,
  SearchInput,
  Segmented,
} from "../components/ui";
import { t } from "../i18n";
import { useLocale } from "../i18n/react";
import { ApiError, api } from "../lib/api";
import { useApp } from "../lib/app-context";
import { useEvent } from "../lib/events";
import { displayName, formatDuration } from "../lib/format";
import { useDocumentTitle, useNow, useResource } from "../lib/hooks";
import { isTerminal, jobErrorText, jobStatusLabel, jobTone, rememberJobInput } from "../lib/jobs";
import { triedFlag } from "../lib/onboarding";
import { toolNeedsConfirm } from "../lib/packs";
import { Link, useRouter } from "../lib/router";
import {
  type Draft,
  type FieldError,
  buildValue,
  draftFrom,
  formFor,
  initialDraft,
} from "../lib/schemaForm";
import type { JobView, ToolInfo } from "../lib/types";

type Run =
  | { kind: "idle" }
  | { kind: "running"; startedAt: number }
  | { kind: "done"; result: unknown; ms: number }
  | { kind: "job"; job: JobView; startedAt: number }
  | { kind: "error"; error: unknown };

// ---- tool picker ---------------------------------------------------------------

function ToolPicker({
  tools,
  value,
  onPick,
}: { tools: ToolInfo[]; value: string | null; onPick: (name: string) => void }) {
  const locale = useLocale();
  const [q, setQ] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale re-derives the translated group label
  const groups = useMemo(() => {
    const builtIn = t("playground.picker.builtIn");
    const s = q.trim().toLowerCase();
    const list = s
      ? tools.filter((tool) =>
          `${tool.name} ${tool.description} ${tool.pack} ${tool.tags.join(" ")}`
            .toLowerCase()
            .includes(s),
        )
      : tools;
    const map = new Map<string, ToolInfo[]>();
    for (const tool of list) {
      const key = tool.origin === "core" || tool.pack === "core" ? builtIn : displayName(tool.pack);
      map.set(key, [...(map.get(key) ?? []), tool]);
    }
    return [...map.entries()].sort((a, b) =>
      a[0] === builtIn ? -1 : b[0] === builtIn ? 1 : a[0].localeCompare(b[0]),
    );
  }, [tools, q, locale]);
  const count = groups.reduce((n, [, l]) => n + l.length, 0);

  return (
    <div className="picker">
      <SearchInput
        value={q}
        onChange={setQ}
        label={t("playground.picker.searchLabel")}
        placeholder={t("playground.picker.searchPlaceholder", { count: tools.length })}
      />
      <p className="visually-hidden" aria-live="polite">
        {t("playground.picker.shown", { count })}
      </p>
      {/* biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: ARIA listbox of buttons; focus stays on the filter input and the buttons */}
      <div className="picker-list" role="listbox" aria-label={t("playground.picker.listLabel")}>
        {count === 0 ? (
          <p className="small muted picker-empty">{t("playground.picker.noMatch")}</p>
        ) : null}
        {groups.map(([group, list]) => (
          // biome-ignore lint/a11y/useSemanticElements: listbox option group; a fieldset would add form semantics and change layout
          <div key={group} role="group" aria-label={group}>
            <p className="picker-group">{group}</p>
            {list.map((tool) => (
              <button
                key={tool.name}
                // biome-ignore lint/a11y/useSemanticElements: buttons act as the listbox options
                type="button"
                role="option"
                aria-selected={tool.name === value}
                className={`picker-item ${tool.name === value ? "picker-item-on" : ""}`}
                onClick={() => onPick(tool.name)}
              >
                <span className="picker-name mono">{tool.name}</span>
                <span className="picker-desc">{tool.description}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- run panel -----------------------------------------------------------------

function JobPanel({
  job,
  pack,
  canUseKey,
  startedAt,
  onCancel,
  cancelling,
}: {
  job: JobView;
  pack: string;
  canUseKey: boolean;
  startedAt: number;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const done = isTerminal(job.status);
  const now = useNow(!done);
  const err = jobErrorText(job.error);
  return (
    <div className="job-panel">
      <div className="job-panel-head">
        <Badge tone={jobTone(job.status)} dot>
          {jobStatusLabel(job.status)}
        </Badge>
        <span className="small muted">
          {done
            ? t("playground.job.took", {
                duration: formatDuration(Date.parse(job.updated_at) - Date.parse(job.created_at)),
              })
            : t("playground.job.soFar", { duration: formatDuration(now - startedAt) })}
        </span>
        <span className="spacer" />
        <Link to={`/jobs?job=${encodeURIComponent(job.job_id)}`} className="small">
          {t("playground.job.openInJobs")}
        </Link>
        {!done ? (
          <Button size="sm" variant="secondary" icon="stop" onClick={onCancel} busy={cancelling}>
            {t("playground.job.stop")}
          </Button>
        ) : null}
      </div>
      {!done ? <JobProgress job={job} elapsed={false} /> : null}
      {job.message && !done ? <p className="small muted">{job.message}</p> : null}
      {job.status === "succeeded" ? <ResultView result={job.result} /> : null}
      {job.status === "failed" || job.status === "expired" ? (
        <HumanErrorAlert
          error={job.error ?? { message: err || t("playground.job.failed") }}
          pack={pack}
          canUseKey={canUseKey}
        />
      ) : null}
      {job.status === "submission_unknown" ? (
        <InlineAlert tone="warn" title={t("playground.job.unknownTitle")}>
          {t("playground.job.unknownBody")}
        </InlineAlert>
      ) : null}
    </div>
  );
}

function CallError({ error, tool }: { error: unknown; tool: ToolInfo }) {
  // Field problems list each field; everything else is one human sentence and one next step.
  if (error instanceof ApiError && error.code === "INVALID_ARGUMENTS" && error.issues.length) {
    return (
      <InlineAlert tone="danger" title={t("playground.errors.invalidInputs")}>
        <ul className="issue-list">
          {error.issues.map((i) => (
            <li key={`${i.path}:${i.message}`}>
              {i.path ? <code>{i.path}</code> : null} {i.message}
            </li>
          ))}
        </ul>
      </InlineAlert>
    );
  }
  return (
    <HumanErrorAlert error={error} pack={tool.pack} canUseKey={tool.requires_secrets.length > 0} />
  );
}

function ToolRunner({ tool }: { tool: ToolInfo }) {
  const toast = useToast();
  const locale = useLocale();
  // biome-ignore lint/correctness/useExhaustiveDependencies: locale re-derives the translated root label
  const field = useMemo(() => formFor(tool.input_schema ?? { type: "object" }), [tool, locale]);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(field));
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState("{}");
  const [rawError, setRawError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [run, setRun] = useState<Run>({ kind: "idle" });
  const [confirmArgs, setConfirmArgs] = useState<Record<string, unknown> | null>(null);
  const jobId = run.kind === "job" ? run.job.job_id : null;
  const hasFields = (field.fields?.length ?? 0) > 0 || field.kind !== "object";
  const destructive = toolNeedsConfirm(tool);
  const canUseKey = tool.requires_secrets.length > 0;

  useEffect(() => {
    setDraft(initialDraft(field));
    setRun({ kind: "idle" });
    setConfirmArgs(null);
    setErrors([]);
    setRaw(false);
    setRawError(null);
  }, [field]);

  // Follow a job: live events, with a slow poll in case the stream drops.
  useEvent("job", (j) => {
    if (j.job_id === jobId)
      setRun((r) => (r.kind === "job" ? { ...r, job: { ...r.job, ...j } } : r));
  });
  const jobDone = run.kind === "job" && isTerminal(run.job.status);
  useEffect(() => {
    if (!jobId || jobDone) return;
    const t = setInterval(async () => {
      try {
        const r = await api.get<{ job: JobView }>(`/api/jobs/${encodeURIComponent(jobId)}`);
        setRun((cur) =>
          cur.kind === "job" && cur.job.job_id === jobId ? { ...cur, job: r.job } : cur,
        );
      } catch {
        // The next tick or an event will catch up.
      }
    }, 3000);
    return () => clearInterval(t);
  }, [jobId, jobDone]);
  // An event carries the status; fetch once more at the end for the full result.
  useEffect(() => {
    if (!jobId || !jobDone) return;
    api
      .get<{ job: JobView }>(`/api/jobs/${encodeURIComponent(jobId)}`)
      .then((r) =>
        setRun((cur) =>
          cur.kind === "job" && cur.job.job_id === jobId ? { ...cur, job: r.job } : cur,
        ),
      )
      .catch(() => undefined);
  }, [jobId, jobDone]);

  const currentArgs = (): { ok: true; value: Record<string, unknown> } | { ok: false } => {
    if (raw) {
      try {
        const v = JSON.parse(rawText || "{}");
        if (v === null || typeof v !== "object" || Array.isArray(v))
          throw new Error(t("playground.runner.argsNotObject"));
        setRawError(null);
        return { ok: true, value: v };
      } catch (e) {
        setRawError(
          e instanceof SyntaxError
            ? t("playground.runner.notValidJson", { message: e.message })
            : (e as Error).message,
        );
        return { ok: false };
      }
    }
    const built = buildValue(field, draft);
    setErrors(built.errors);
    if (built.errors.length) return { ok: false };
    return { ok: true, value: (built.value ?? {}) as Record<string, unknown> };
  };

  const switchMode = (mode: "form" | "json") => {
    if (mode === "json" && !raw) {
      const built = buildValue(field, draft);
      setRawText(JSON.stringify(built.value ?? {}, null, 2));
      setRaw(true);
    } else if (mode === "form" && raw) {
      try {
        const v = JSON.parse(rawText || "{}");
        setDraft(draftFrom(field, v));
        setRaw(false);
        setRawError(null);
      } catch (e) {
        setRawError(t("playground.runner.fixJsonFirst", { message: (e as Error).message }));
      }
    }
  };

  const executeCall = async (argsValue: Record<string, unknown>) => {
    setConfirmArgs(null);
    const startedAt = Date.now();
    setRun({ kind: "running", startedAt });
    try {
      const r = await api.request<{ result?: unknown; job_id?: string; tool?: string }>(
        `/api/tools/${encodeURIComponent(tool.name)}/call`,
        {
          method: "POST",
          body: { arguments: argsValue },
        },
      );
      if (r.job_id) {
        rememberJobInput(r.job_id, argsValue);
        const now = new Date().toISOString();
        setRun({
          kind: "job",
          startedAt,
          job: {
            job_id: r.job_id,
            tool: tool.name,
            status: "queued",
            progress: null,
            message: null,
            result: null,
            error: null,
            created_at: now,
            updated_at: now,
          },
        });
        toast.show({
          text: t("playground.runner.started"),
          tone: "info",
        });
      } else {
        setRun({ kind: "done", result: r.result, ms: Date.now() - startedAt });
        triedFlag.set();
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_ARGUMENTS" && !raw)
        setErrors(err.issues.map((i) => ({ path: i.path, message: i.message })));
      setRun({ kind: "error", error: err });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const args = currentArgs();
    if (!args.ok) return;
    if (destructive) {
      setConfirmArgs(args.value);
      return;
    }
    await executeCall(args.value);
  };

  const stopper = useCancelJob((j) =>
    setRun((cur) => (cur.kind === "job" && cur.job.job_id === j.job_id ? { ...cur, job: j } : cur)),
  );
  const cancel = () => {
    if (run.kind === "job") stopper.ask(run.job);
  };
  const cancelling = jobId !== null && stopper.busy === jobId;

  const jobOk = run.kind === "job" && run.job.status === "succeeded";
  useEffect(() => {
    if (jobOk) triedFlag.set();
  }, [jobOk]);

  const busy = run.kind === "running" || (run.kind === "job" && !isTerminal(run.job.status));

  return (
    <div className="runner">
      <Card
        title={
          <span className="runner-title">
            <span className="mono">{tool.name}</span>
            <CopyButton
              text={tool.name}
              what={t("playground.runner.copyToolName")}
              variant="ghost"
              iconOnly
            />
          </span>
        }
        actions={
          hasFields ? (
            <Segmented
              label={t("playground.runner.editAs")}
              value={raw ? "json" : "form"}
              onChange={switchMode}
              options={[
                { value: "form", label: t("playground.runner.modeForm") },
                { value: "json", label: t("playground.runner.modeJson") },
              ]}
            />
          ) : null
        }
      >
        <p className="runner-desc">{tool.description}</p>
        <p className="small muted runner-meta">
          <span>
            {tool.pack === "core" ? t("playground.picker.builtIn") : displayName(tool.pack)}
          </span>
          {tool.long_running ? (
            <span>
              <Icon name="clock" /> {t("playground.runner.longRunning")}
            </span>
          ) : null}
          {tool.requires_secrets.length ? (
            <span>
              <Icon name="key" />{" "}
              {t("playground.runner.needsSecrets", {
                secrets: tool.requires_secrets.join(", "),
              })}
            </span>
          ) : null}
          {tool.tags.includes("paid") || tool.capability ? (
            <span>{t("playground.runner.mayCost")}</span>
          ) : null}
          {destructive ? (
            <span className="perm-risk">
              <Icon name="alert" /> {t("playground.runner.destructive")}
            </span>
          ) : null}
        </p>
        <form
          onSubmit={submit}
          noValidate
          className="runner-form"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }
          }}
        >
          {raw ? (
            <div className="field">
              <label htmlFor="raw-args" className="field-label">
                {t("playground.runner.argsLabel")}
              </label>
              <textarea
                id="raw-args"
                className={`input mono raw-json ${rawError ? "input-invalid" : ""}`}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                spellCheck={false}
                rows={12}
                aria-invalid={!!rawError}
                aria-describedby={rawError ? "raw-args-error" : undefined}
              />
              {rawError ? (
                <p className="field-error" id="raw-args-error" role="alert">
                  {rawError}
                </p>
              ) : null}
            </div>
          ) : hasFields ? (
            <SchemaForm
              field={{ ...field, required: true }}
              draft={draft}
              onChange={setDraft}
              errors={errors}
              idPrefix={`pg-${tool.name}`}
            />
          ) : (
            <p className="small muted">{t("playground.runner.noArguments")}</p>
          )}
          <div className="form-actions">
            {run.kind !== "idle" && !busy ? (
              <Button variant="ghost" size="sm" onClick={() => setRun({ kind: "idle" })}>
                {t("playground.runner.clearResult")}
              </Button>
            ) : null}
            <span className="kbd-hint" aria-hidden="true">
              <kbd className="kbd">{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}</kbd>
              <kbd className="kbd">Enter</kbd>
            </span>
            <Button
              type="submit"
              variant="primary"
              icon="play"
              busy={run.kind === "running"}
              disabled={busy}
              aria-keyshortcuts="Meta+Enter Control+Enter"
            >
              {t("playground.runner.run")}
            </Button>
          </div>
        </form>
      </Card>
      <section
        className="card runner-result"
        aria-labelledby="result-title"
        aria-live="polite"
        aria-busy={busy}
      >
        <h2 className="card-title" id="result-title">
          {t("playground.runner.resultTitle")}
        </h2>
        {run.kind === "idle" ? (
          <p className="small muted">{t("playground.runner.idleHint")}</p>
        ) : run.kind === "running" ? (
          <Loading label={t("playground.runner.running")} lines={2} />
        ) : run.kind === "done" ? (
          <ResultView result={run.result} durationMs={run.ms} />
        ) : run.kind === "job" ? (
          <JobPanel
            job={run.job}
            pack={tool.pack}
            canUseKey={canUseKey}
            startedAt={run.startedAt}
            onCancel={cancel}
            cancelling={cancelling}
          />
        ) : (
          <CallError error={run.error} tool={tool} />
        )}
      </section>
      <Dialog
        open={confirmArgs !== null}
        onClose={() => setConfirmArgs(null)}
        title={t("playground.confirm.title", { tool: tool.name })}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmArgs(null)} data-autofocus>
              {t("playground.confirm.cancel")}
            </Button>
            <Button
              variant="danger"
              icon="play"
              onClick={() => confirmArgs && void executeCall(confirmArgs)}
            >
              {t("playground.confirm.run")}
            </Button>
          </>
        }
      >
        <div className="stack">
          <p>{t("playground.confirm.body")}</p>
          {confirmArgs && Object.keys(confirmArgs).length > 0 ? (
            <pre className="approval-args mono small">{JSON.stringify(confirmArgs, null, 2)}</pre>
          ) : null}
        </div>
      </Dialog>
      {stopper.dialog}
    </div>
  );
}

// ---- page ----------------------------------------------------------------------

export function PlaygroundPage() {
  useDocumentTitle(t("playground.page.title"));
  const { query, setQuery } = useRouter();
  const { catalogVersion } = useApp();
  const tools = useResource(
    (signal) => api.get<{ tools: ToolInfo[] }>("/api/tools", undefined, signal),
    [catalogVersion],
  );
  const list = useMemo(
    () => [...(tools.data?.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [tools.data],
  );
  const name = query.get("tool");
  const selected = list.find((t) => t.name === name) ?? null;
  const pick = useCallback((n: string) => setQuery({ tool: n }, { replace: false }), [setQuery]);
  const runnerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected)
      runnerRef.current
        ?.querySelector<HTMLElement>("input, textarea, select")
        ?.focus({ preventScroll: true });
  }, [selected]);

  return (
    <>
      <PageHeader
        title={t("playground.page.title")}
        description={t("playground.page.description")}
      />
      {tools.loading && !tools.data ? (
        <Loading lines={8} />
      ) : tools.error && !tools.data ? (
        <ErrorState error={tools.error} onRetry={tools.reload} />
      ) : list.length === 0 ? (
        <EmptyState
          icon="package"
          title={t("playground.empty.noToolsTitle")}
          action={<Link to="/packs">{t("playground.empty.noToolsAction")}</Link>}
        >
          {t("playground.empty.noToolsBody")}
        </EmptyState>
      ) : (
        <div className="playground">
          <ToolPicker tools={list} value={selected?.name ?? null} onPick={pick} />
          <div ref={runnerRef} className="playground-main">
            {selected ? (
              <ToolRunner key={selected.name} tool={selected} />
            ) : name ? (
              <EmptyState
                icon="alert"
                title={t("playground.empty.unavailableTitle")}
                action={
                  <Button onClick={() => setQuery({ tool: null })}>
                    {t("playground.empty.unavailableClear")}
                  </Button>
                }
              >
                <code>{name}</code>
                {t("playground.empty.unavailableBody")}
              </EmptyState>
            ) : (
              <EmptyState icon="play" title={t("playground.empty.pickTitle")}>
                {t("playground.empty.pickBefore")}
                <Link to="/playground?tool=gateway_status">
                  {t("playground.empty.pickLinkStatus")}
                </Link>
                {t("playground.empty.pickOr")}
                <Link to="/playground?tool=list_artifacts">
                  {t("playground.empty.pickLinkFiles")}
                </Link>
                {t("playground.empty.pickAfter")}
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </>
  );
}
