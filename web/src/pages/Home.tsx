import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentStatus } from "../components/ConnectAgent";
import { GoalPicker, GoalPlan } from "../components/GoalPlan";
import { Icon } from "../components/Icon";
import { JobProgress } from "../components/JobProgress";
import { LanguagePicker } from "../components/LanguagePicker";
import { MediaView } from "../components/ResultView";
import { SecretEditor } from "../components/SecretEditor";
import { Sparkline } from "../components/Sparkline";
import { Badge, Button, Card, CopyField, ErrorState, Loading, PageHeader } from "../components/ui";
import { t } from "../i18n";
import { useAgents } from "../lib/agents";
import { api } from "../lib/api";
import { endpointFor, useApp } from "../lib/app-context";
import { useEvent } from "../lib/events";
import { artifactSource, displayName, formatRelative, formatUsd } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import {
  type Progress,
  STEPS,
  type StepId,
  agentSummary,
  doneCount,
  firstOpen,
  goalFlag,
  goalSummary,
  keySummary,
  keysSkippedFlag,
  makesImages,
  suggestTool,
  toggleOpen,
  triedFlag,
} from "../lib/onboarding";
import { Link, useRouter } from "../lib/router";
import type {
  Artifact,
  Capability,
  GoalInfo,
  JobView,
  PackStatus,
  SecretRow,
  UsageResponse,
} from "../lib/types";
import { daySeries, sinceFor } from "../lib/usage";

/** The provider rows on the "Add one key" step, in order; blurbs follow the chosen language. */
export function providers(): { id: string; blurb: string }[] {
  return [
    { id: "openrouter", blurb: t("home.providers.openrouter") },
    { id: "fal", blurb: t("home.providers.fal") },
    { id: "replicate", blurb: t("home.providers.replicate") },
    { id: "gemini", blurb: t("home.providers.gemini") },
    { id: "elevenlabs", blurb: t("home.providers.elevenlabs") },
    { id: "local", blurb: t("home.providers.local") },
  ];
}

const ONBOARDED_KEY = "plughive.onboarded";
const ACTIVE: JobView["status"][] = [
  "queued",
  "running",
  "staging",
  "submitting",
  "submitted",
  "polling",
  "downloading",
  "awaiting_approval",
  "submission_unknown",
];

function readOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}
/** The checklist was shown once: keep it (with "You're set.") until the user leaves it. */
const setupStarted = {
  read: () => {
    try {
      return window.localStorage.getItem("plughive.setup-started") === "1";
    } catch {
      return false;
    }
  },
  set: () => {
    try {
      window.localStorage.setItem("plughive.setup-started", "1");
    } catch {
      // ignore
    }
  },
};
function writeOnboarded(v: boolean) {
  try {
    if (v) window.localStorage.setItem(ONBOARDED_KEY, "1");
    else window.localStorage.removeItem(ONBOARDED_KEY);
  } catch {
    // ignore
  }
}

interface HomeData {
  packs: PackStatus[];
  secrets: SecretRow[];
  backend: string;
}

function providerReady(id: string, data: HomeData): boolean {
  const pack = data.packs.find((p) => p.id === id);
  const rows = data.secrets.filter((s) => s.pack === id && s.required);
  return (
    !!pack &&
    pack.enabled &&
    pack.state === "loaded" &&
    rows.length > 0 &&
    rows.every((s) => s.present)
  );
}

function ProviderRow({
  id,
  blurb,
  pack,
  secrets,
  open,
  onToggle,
  onSaved,
}: {
  id: string;
  blurb: string;
  pack: PackStatus | undefined;
  secrets: SecretRow[];
  open: boolean;
  onToggle: () => void;
  onSaved: (row: SecretRow, action: "set" | "removed") => void;
}) {
  const formId = useId();
  const required = secrets.filter((s) => s.required);
  const keyless = required.length === 0;
  const ready =
    !!pack && pack.enabled && pack.state === "loaded" && required.every((s) => s.present);
  const name = displayName(id);
  const canAdd = !!pack && pack.enabled && !keyless;
  return (
    <li className={`provider-row ${open ? "provider-row-open" : ""}`}>
      <div className="provider-row-main">
        <div className="provider-row-text">
          <h3 className="provider-name">{name}</h3>
          <p className="provider-blurb">{blurb}</p>
        </div>
        <div className="provider-row-side">
          {!pack ? (
            <Badge>{t("home.provider.notInstalled")}</Badge>
          ) : !pack.enabled ? (
            <Link to={`/packs?pack=${pack.id}`} className="small">
              {t("home.provider.offLink")}
            </Link>
          ) : pack.state !== "loaded" ? (
            <Badge tone="danger">{t("home.provider.needsAttention")}</Badge>
          ) : ready ? (
            <Badge tone="ok" dot>
              {keyless ? t("home.provider.noKeyNeeded") : t("home.provider.keyAdded")}
            </Badge>
          ) : null}
          {canAdd && !ready ? (
            <Button
              size="sm"
              variant={open ? "ghost" : "secondary"}
              icon={open ? "chevronUp" : "key"}
              aria-expanded={open}
              aria-controls={formId}
              onClick={onToggle}
            >
              {open ? t("home.provider.close") : t("home.provider.addKey")}
              <span className="visually-hidden">{t("home.provider.forName", { name })}</span>
            </Button>
          ) : null}
        </div>
      </div>
      {open && canAdd ? (
        <div id={formId} className="provider-row-form">
          {required.map((s) => (
            <SecretEditor key={s.name} row={s} onChanged={onSaved} compact autoOpen focusOnOpen />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** One checklist item: a heading button that opens the body (accordion pattern). */
function CheckItem({
  step,
  n,
  title,
  summary,
  done,
  open,
  onToggle,
  children,
}: {
  step: StepId;
  n: number;
  title: string;
  summary: string;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = `check-${step}-body`;
  return (
    <li className={`check-item${done ? " check-done" : ""}${open ? " check-open" : ""}`}>
      <h2 className="check-heading">
        <button
          type="button"
          className="check-head"
          id={`check-${step}`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="check-mark" aria-hidden="true">
            {done ? <Icon name="check" size={14} /> : n}
          </span>
          <span className="check-text">
            <span className="check-title">
              {title}
              <span className="visually-hidden">
                {done ? t("home.check.done") : t("home.check.todo")}
              </span>
            </span>
            {!open ? <span className="check-summary">{summary}</span> : null}
          </span>
          <Icon name={open ? "chevronUp" : "chevronDown"} />
        </button>
      </h2>
      {open ? (
        <section id={bodyId} className="check-body" aria-labelledby={`check-${step}`}>
          {children}
        </section>
      ) : null}
    </li>
  );
}

const OPEN_STEP_KEY = "plughive.onboarding.open";
function readOpenStep(): StepId | null {
  try {
    const v = sessionStorage.getItem(OPEN_STEP_KEY);
    return v && (STEPS as readonly string[]).includes(v) ? (v as StepId) : null;
  } catch {
    return null;
  }
}
function writeOpenStep(s: StepId | null) {
  try {
    if (s) sessionStorage.setItem(OPEN_STEP_KEY, s);
    else sessionStorage.removeItem(OPEN_STEP_KEY);
  } catch {
    // Storage blocked: the list just opens the first unfinished item.
  }
}

function Checklist({
  data,
  reload,
  onDone,
}: { data: HomeData; reload: () => void; onDone: () => void }) {
  const { catalogChanged, openConnect } = useApp();
  const agents = useAgents(true);
  const byPack = useMemo(() => new Map(data.packs.map((p) => [p.id, p])), [data.packs]);
  const readyIds = providers()
    .filter((p) => p.id !== "local" && providerReady(p.id, data))
    .map((p) => p.id);
  const [skipped, setSkipped] = useState(keysSkippedFlag.read);
  const [goal, setGoal] = useState(goalFlag.read);
  const goals = useResource(
    (signal) =>
      api.get<{ goals: GoalInfo[] }>("/api/advisor/goals", undefined, signal).then((r) => r.goals),
    [],
  );
  const goalId = goal && goal !== "skipped" ? goal.id : null;
  const goalInfo = goalId ? (goals.data?.find((g) => g.id === goalId) ?? null) : null;
  // Files or usage from earlier runs count as "tried" too (an agent may have run a tool).
  const activity = useResource(
    (signal) =>
      api
        .get<{ artifacts: Artifact[]; total: number }>("/api/artifacts", { limit: 1 }, signal)
        .then((r) => r.total > 0),
    [],
  );
  const progress: Progress = {
    connect: agents.length > 0,
    goal: goal !== null,
    key: readyIds.length > 0 || skipped,
    try: triedFlag.read() || activity.data === true,
  };
  // Coming back to Home keeps the item you were on open, instead of jumping back to step 1.
  const [open, setOpen] = useState<StepId | null>(() => {
    const saved = readOpenStep();
    return saved && !progress[saved] ? saved : firstOpen(progress);
  });
  useEffect(() => writeOpenStep(open), [open]);
  const [providerOpen, setProviderOpen] = useState<string | null>(null);

  // When the open item gets done (an agent connects, a key saves), move to the next one.
  // Not for the goal: picking one shows its plan, and "Next" moves on.
  const prev = useRef(progress);
  useEffect(() => {
    const was = prev.current;
    prev.current = progress;
    if (open && open !== "goal" && progress[open] && !was[open]) setOpen(firstOpen(progress, open));
  });

  const toggle = (s: StepId) => setOpen((cur) => (cur === s ? null : s));
  const later = (s: StepId) => setOpen(firstOpen({ ...progress, [s]: true }, s));
  const tool = suggestTool(data.packs, readyIds);
  const allDone = doneCount(progress) === STEPS.length;

  return (
    <div className="checklist-wrap">
      <ol className="checklist">
        <CheckItem
          step="connect"
          n={1}
          title={t("home.checklist.connect.title")}
          summary={
            progress.connect ? agentSummary(agents) : t("home.checklist.connect.summaryTodo")
          }
          done={progress.connect}
          open={open === "connect"}
          onToggle={() => toggle("connect")}
        >
          <AgentStatus waiting={t("home.checklist.connect.waiting")} />
          <p className="muted">{t("home.checklist.connect.body")}</p>
          <div className="step-actions">
            <Button variant="primary" icon="plug" onClick={openConnect}>
              {t("home.checklist.connect.cta")}
            </Button>
            {!progress.connect ? (
              <Button variant="ghost" onClick={() => later("connect")}>
                {t("home.checklist.connect.later")}
              </Button>
            ) : null}
          </div>
        </CheckItem>

        <CheckItem
          step="goal"
          n={2}
          title={t("home.checklist.goal.title")}
          summary={goalSummary(goalInfo, goal === "skipped")}
          done={progress.goal}
          open={open === "goal"}
          onToggle={() => toggle("goal")}
        >
          <p className="muted">{t("home.checklist.goal.body")}</p>
          <GoalPicker
            value={goalId}
            onPick={(g) => {
              goalFlag.set(g.id);
              setGoal({ id: g.id });
            }}
          />
          {goalId ? <GoalPlan goal={goalId} /> : null}
          <div className="step-actions">
            {goalId ? (
              <>
                <Button variant="primary" onClick={() => setOpen(firstOpen(progress, "goal"))}>
                  {t("home.checklist.goal.next")}
                </Button>
                <Link className="btn btn-ghost" to="/software">
                  {t("home.checklist.goal.openSoftware")}
                </Link>
              </>
            ) : (
              <Button
                variant="ghost"
                onClick={() => {
                  goalFlag.set("skipped");
                  setGoal("skipped");
                  setOpen(firstOpen({ ...progress, goal: true }, "goal"));
                }}
              >
                {t("home.checklist.goal.skip")}
              </Button>
            )}
          </div>
        </CheckItem>

        <CheckItem
          step="key"
          n={3}
          title={t("home.checklist.key.title")}
          summary={keySummary(skipped && readyIds.length === 0, readyIds.map(displayName))}
          done={progress.key}
          open={open === "key"}
          onToggle={() => toggle("key")}
        >
          <p className="muted">{t("home.checklist.key.body")}</p>
          <ul className="provider-list">
            {providers().map((p) => (
              <ProviderRow
                key={p.id}
                id={p.id}
                blurb={p.blurb}
                pack={byPack.get(p.id)}
                secrets={data.secrets.filter((s) => s.pack === p.id)}
                open={providerOpen === p.id}
                onToggle={() => setProviderOpen((cur) => toggleOpen(cur, p.id))}
                onSaved={() => {
                  setProviderOpen(null);
                  reload();
                  catalogChanged();
                }}
              />
            ))}
          </ul>
          {readyIds.length === 0 ? (
            <div className="step-actions">
              <Button
                variant="ghost"
                onClick={() => {
                  keysSkippedFlag.set(true);
                  setSkipped(true);
                  setOpen(firstOpen({ ...progress, key: true }, "key"));
                }}
              >
                {t("home.checklist.key.skip")}
              </Button>
            </div>
          ) : null}
        </CheckItem>

        <CheckItem
          step="try"
          n={4}
          title={t("home.checklist.try.title")}
          summary={
            progress.try ? t("home.checklist.try.summaryDone") : t("home.checklist.try.summaryTodo")
          }
          done={progress.try}
          open={open === "try"}
          onToggle={() => toggle("try")}
        >
          <p className="muted">
            {tool === "gateway_status"
              ? t("home.checklist.try.bodyStatus")
              : makesImages(tool)
                ? t("home.checklist.try.bodyImage", { provider: displayName(readyIds[0] ?? "") })
                : t("home.checklist.try.bodyTool", { provider: displayName(readyIds[0] ?? "") })}
          </p>
          <div className="step-actions">
            <Link className="btn btn-primary" to={`/playground?tool=${encodeURIComponent(tool)}`}>
              <Icon name="play" /> {t("home.checklist.try.openPlayground")}
            </Link>
            {progress.try ? (
              <Link className="btn btn-ghost" to="/library">
                {t("home.checklist.try.seeLibrary")}
              </Link>
            ) : null}
          </div>
        </CheckItem>
      </ol>
      {allDone ? (
        // biome-ignore lint/a11y/useSemanticElements: block live status; output is for form results
        <div className="checklist-done" role="status">
          <span>
            <strong>{t("home.checklist.doneTitle")}</strong> {t("home.checklist.doneBody")}
          </span>
          <Button variant="primary" onClick={onDone}>
            {t("home.checklist.hideGuide")}
          </Button>
        </div>
      ) : (
        <p className="small muted checklist-foot">
          {t("home.checklist.progress", { done: doneCount(progress), total: STEPS.length })}
        </p>
      )}
    </div>
  );
}

function AttentionList({ data, caps }: { data: HomeData; caps: Capability[] | undefined }) {
  const items: Array<{
    id: string;
    tone: "warn" | "danger";
    text: string;
    to: string;
    action: string;
  }> = [];
  for (const p of data.packs) {
    if (p.enabled && p.state !== "loaded")
      items.push({
        id: `fail:${p.id}`,
        tone: "danger",
        text: t("home.attention.notLoaded", { name: displayName(p.id) }),
        to: `/packs?pack=${encodeURIComponent(p.id)}`,
        action: t("home.attention.notLoadedAction"),
      });
  }
  const seen = new Set<string>();
  for (const c of caps ?? [])
    for (const pr of c.providers) {
      if (
        seen.has(pr.pack) ||
        !pr.coolingDownUntil ||
        new Date(pr.coolingDownUntil).getTime() <= Date.now()
      )
        continue;
      seen.add(pr.pack);
      items.push({
        id: `cool:${pr.pack}`,
        tone: "warn",
        text: t("home.attention.rateLimited", {
          name: displayName(pr.pack),
          until: formatRelative(pr.coolingDownUntil),
        }),
        to: "/capabilities",
        action: t("home.attention.rateLimitedAction"),
      });
    }
  const anyKey = providers().some((p) => p.id !== "local" && providerReady(p.id, data));
  if (!anyKey)
    items.push({
      id: "nokey",
      tone: "warn",
      text: t("home.attention.noKey"),
      to: "/packs?missing=1",
      action: t("home.attention.noKeyAction"),
    });
  if (items.length === 0) return null;
  return (
    <Card title={t("home.attention.title")}>
      <ul className="health-list">
        {items.map((it) => (
          <li key={it.id} className="health-row">
            <span className={`health-dot health-${it.tone}`} aria-hidden="true" />
            <span className="health-text">{it.text}</span>
            <Link to={it.to} className="btn btn-secondary btn-sm">
              {it.action}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Overview({ data }: { data: HomeData }) {
  const { info } = useApp();
  const { navigate } = useRouter();
  const agents = useAgents(true, { everyMs: 5000 });
  const jobs = useResource(
    (signal) =>
      api.get<{ jobs: JobView[] }>("/api/jobs", { limit: 50 }, signal).then((r) => r.jobs),
    [],
  );
  const artifacts = useResource(
    (signal) =>
      api.get<{ artifacts: Artifact[]; total: number }>("/api/artifacts", { limit: 8 }, signal),
    [],
  );
  const usage = useResource(
    (signal) => api.get<UsageResponse>("/api/usage", { since: sinceFor("7d") }, signal),
    [],
  );
  const caps = useResource(
    (signal) =>
      api
        .get<{ capabilities: Capability[] }>("/api/capabilities", undefined, signal)
        .then((r) => r.capabilities),
    [],
  );

  useEvent("job", (j) => {
    jobs.mutate((list = []) => {
      const i = list.findIndex((x) => x.job_id === j.job_id);
      if (i < 0) return [j, ...list];
      const next = list.slice();
      next[i] = j;
      return next;
    });
  });

  const running = (jobs.data ?? []).filter((j) => ACTIVE.includes(j.status));
  const week = usage.data ? daySeries(usage.data.by_provider_day, "7d") : [];
  const spent = week.some((d) => d.cost > 0);

  return (
    <div className="overview">
      <div className="overview-top">
        <Card title={t("home.overview.agentsTitle")}>
          <div className="stat">
            <span className="stat-value">{agents.length}</span>
            <span className="stat-label">
              {agents.length ? agentSummary(agents) : t("home.overview.agentsNone")}
            </span>
          </div>
        </Card>
        <Card title={t("home.overview.endpointTitle")}>
          <CopyField value={endpointFor(info)} label={t("home.overview.endpointUrl")} />
          <p className="muted small">
            {t("home.overview.endpointHintBefore")}{" "}
            <Link to="/exposure">{t("home.overview.endpointHintLink")}</Link>
          </p>
        </Card>
        <Card
          title={t("home.overview.weekTitle")}
          actions={<Link to="/usage">{t("home.overview.usageAction")}</Link>}
        >
          {usage.loading && !usage.data ? (
            <Loading lines={2} />
          ) : usage.error ? (
            <ErrorState error={usage.error} onRetry={usage.reload} />
          ) : (
            <div className="stat-row">
              <div className="stat">
                <span className="stat-value">
                  {formatUsd(usage.data?.summary.total_cost_usd, { estimate: true })}
                </span>
                <span className="stat-label">
                  {t("home.overview.callsEstimated", {
                    count: usage.data?.summary.total_calls ?? 0,
                  })}
                </span>
              </div>
              {week.some((d) => d.calls > 0) ? (
                <Sparkline
                  values={week.map((d) => (spent ? d.cost : d.calls))}
                  label={spent ? t("home.overview.spendLabel") : t("home.overview.callsLabel")}
                />
              ) : null}
            </div>
          )}
        </Card>
      </div>

      <AttentionList data={data} caps={caps.data} />

      <Card
        title={t("home.overview.runningTitle")}
        actions={<Link to="/jobs">{t("home.overview.allJobs")}</Link>}
      >
        {jobs.loading && !jobs.data ? (
          <Loading lines={2} />
        ) : jobs.error ? (
          <ErrorState error={jobs.error} onRetry={jobs.reload} />
        ) : running.length === 0 ? (
          <p className="small muted card-empty">
            <Icon name="clock" /> {t("home.overview.runningEmpty")}
          </p>
        ) : (
          <ul className="job-mini">
            {running.slice(0, 5).map((j) => (
              <li key={j.job_id}>
                <button
                  type="button"
                  className="row-btn"
                  onClick={() => navigate(`/jobs?job=${j.job_id}`)}
                >
                  <span className="mono">{j.tool}</span>
                  <span className="muted small">{j.message ?? j.status}</span>
                  <JobProgress job={j} small />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t("home.overview.recentTitle")}
        actions={<Link to="/library">{t("home.overview.libraryAction")}</Link>}
      >
        {artifacts.loading && !artifacts.data ? (
          <Loading lines={2} />
        ) : artifacts.error ? (
          <ErrorState error={artifacts.error} onRetry={artifacts.reload} />
        ) : (artifacts.data?.artifacts.length ?? 0) === 0 ? (
          <p className="small muted card-empty">
            <Icon name="image" /> {t("home.overview.filesEmptyBefore")}{" "}
            <Link to="/playground">{t("home.overview.filesEmptyLink")}</Link>
          </p>
        ) : (
          <ul className="thumb-row">
            {artifacts.data?.artifacts.map((a) => (
              <li key={a.id}>
                <Link
                  to={`/library?artifact=${encodeURIComponent(a.id)}`}
                  className="thumb"
                  aria-label={t("home.overview.artifactLabel", {
                    kind: a.kind,
                    source: a.tool ? artifactSource(a.tool).label : t("home.overview.aTool"),
                    when: formatRelative(a.createdAt),
                  })}
                >
                  {a.kind === "image" ? (
                    <MediaView
                      media={{ url: a.url, kind: "image", label: a.prompt, mime: a.mime }}
                      compact
                    />
                  ) : (
                    <Icon
                      name={a.kind === "video" ? "video" : a.kind === "audio" ? "audio" : "file"}
                      size={24}
                    />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** First-run card: pick a language before anything else; it stays visible during setup. */
function LanguageWelcome() {
  const id = useId();
  return (
    <section className="card lang-welcome" aria-labelledby={id}>
      <div>
        <h2 id={id}>{t("language.welcome.title")}</h2>
        <p className="small muted">{t("language.welcome.body")}</p>
      </div>
      <LanguagePicker variant="choices" />
    </section>
  );
}

export function HomePage() {
  useDocumentTitle(t("home.title"));
  const { catalogVersion, info, openConnect } = useApp();
  const data = useResource(
    async (signal) => {
      const [packs, secrets] = await Promise.all([
        api.get<{ packs: PackStatus[] }>("/api/packs", undefined, signal),
        api.get<{ backend: string; secrets: SecretRow[] }>("/api/secrets", undefined, signal),
      ]);
      return { packs: packs.packs, secrets: secrets.secrets, backend: secrets.backend };
    },
    [catalogVersion],
  );
  const [onboarded, setOnboarded] = useState(readOnboarded);
  const [forceSetup, setForceSetup] = useState(false);

  const anyKey = (data.data?.secrets ?? []).some(
    (s) => s.present && providers().some((p) => p.id === s.pack),
  );
  const anyAgent = (info?.agents?.length ?? 0) > 0;
  // Once the checklist is showing, keep it until the user leaves it: ticking
  // an item must not swap the page out from under them.
  const [inSetup, setInSetup] = useState(setupStarted.read);
  const needsSetup =
    !!data.data && !!info && !onboarded && !(anyKey && anyAgent && triedFlag.read());
  useEffect(() => {
    if (needsSetup && !inSetup) {
      setupStarted.set();
      setInSetup(true);
    }
  }, [needsSetup, inSetup]);
  const firstRun = forceSetup || needsSetup || (inSetup && !onboarded);
  const leave = () => {
    writeOnboarded(true);
    setOnboarded(true);
    setForceSetup(false);
  };

  let actions: ReactNode;
  if (!firstRun)
    actions = (
      <>
        <Button variant="ghost" icon="sparkle" onClick={() => setForceSetup(true)}>
          {t("home.setupGuide")}
        </Button>
        {anyAgent ? (
          <Link className="btn btn-primary" to="/playground">
            <Icon name="play" /> {t("home.openPlayground")}
          </Link>
        ) : (
          <Button variant="primary" icon="plug" onClick={openConnect}>
            {t("home.header.connectAgent")}
          </Button>
        )}
      </>
    );
  else if (forceSetup && onboarded)
    actions = (
      <Button variant="ghost" onClick={() => setForceSetup(false)}>
        {t("home.backHome")}
      </Button>
    );
  else
    actions = (
      <Button variant="ghost" onClick={leave}>
        {t("home.skipSetup")}
      </Button>
    );

  return (
    <>
      <PageHeader
        title={firstRun ? t("home.getStarted") : t("home.title")}
        description={firstRun ? t("home.getStartedDescription") : undefined}
        actions={actions}
      />
      {(data.loading && !data.data) || (!info && !data.error) ? (
        <Loading lines={6} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : data.data ? (
        firstRun ? (
          <>
            <LanguageWelcome />
            <Checklist data={data.data} reload={data.reload} onDone={leave} />
          </>
        ) : (
          <Overview data={data.data} />
        )
      ) : null}
    </>
  );
}
