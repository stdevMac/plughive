// Software: the programs tools run (ffmpeg, yt-dlp, whisper.cpp, Ollama, ...).
// What is installed, install or remove what plughive manages, and approve an
// install an agent asked for (`/software?install=<id>`): size and license are
// shown before anything downloads.
import { useEffect, useState } from "react";
import { Dialog } from "../components/Dialog";
import { GoalPicker, GoalPlan } from "../components/GoalPlan";
import { Icon } from "../components/Icon";
import { JobProgress } from "../components/JobProgress";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  CopyField,
  EmptyState,
  ErrorState,
  ExternalLink,
  InlineAlert,
  KeyValues,
  Loading,
  PageHeader,
  Segmented,
} from "../components/ui";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import { useEvent } from "../lib/events";
import { useDocumentTitle, useResource } from "../lib/hooks";
import { isTerminal, jobErrorText } from "../lib/jobs";
import { useRouter } from "../lib/router";
import {
  canInstallHere,
  installRequest,
  methodLabel,
  sizeLabel,
  softwareState,
  softwareTags,
  sortSoftware,
} from "../lib/software";
import type { GoalInfo, InstallStart, JobView, SoftwareView } from "../lib/types";

function StateBadge({ s, installing }: { s: SoftwareView; installing: boolean }) {
  const state = softwareState(s, installing);
  if (state === "installing")
    return (
      <Badge tone="accent" dot>
        {t("software.state.installing")}
      </Badge>
    );
  if (state === "running")
    return (
      <Badge tone="ok" dot>
        {t("software.state.running")}
      </Badge>
    );
  if (state === "installed")
    return (
      <Badge tone="ok" dot>
        {t("software.state.installed")}
        {s.detected_version ? ` · ${s.detected_version}` : ""}
      </Badge>
    );
  return <Badge>{t("software.state.missing")}</Badge>;
}

function InstallDialog({
  item,
  asked,
  onClose,
  onStarted,
}: {
  item: SoftwareView;
  /** Opened from an agent's approval link. */
  asked: boolean;
  onClose: () => void;
  onStarted: (start: InstallStart) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const here = canInstallHere(item);
  const install = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ result: InstallStart }>(
        `/api/software/${encodeURIComponent(item.id)}/install`,
        { approve: true },
      );
      onStarted(r.result);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("software.install.title", { name: item.name })}
      description={asked ? t("software.install.askedDescription") : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("software.install.cancel")}
          </Button>
          {here && !item.installed ? (
            <Button variant="primary" icon="download" busy={busy} onClick={install} data-autofocus>
              {asked ? t("software.install.approve") : t("software.install.install")}
            </Button>
          ) : null}
        </>
      }
    >
      <p>{item.summary}</p>
      <KeyValues
        rows={[
          [t("software.install.downloadSize"), sizeLabel(item.size_mb)],
          [t("software.install.license"), item.license],
          [t("software.install.version"), item.version],
          [t("software.install.how"), methodLabel(item)],
          ...(item.bins.length > 0
            ? [[t("software.install.commands"), item.bins.join(", ")] as [string, string]]
            : [[t("software.install.kind"), t("software.install.kindModel")] as [string, string]]),
          [
            t("software.install.homepage"),
            <ExternalLink key="h" href={item.homepage}>
              {item.homepage.replace(/^https:\/\//, "")}
            </ExternalLink>,
          ],
        ]}
      />
      {item.installed ? (
        <InlineAlert tone="ok">
          {t("software.install.already")}
          {item.path ? t("software.install.at", { path: item.path }) : ""}.
        </InlineAlert>
      ) : item.method === "apt" && item.command ? (
        <InlineAlert tone="info" title={t("software.install.terminalTitle")}>
          {t("software.install.terminalBody")}
          <CopyField value={item.command} label={t("software.install.command")} />
        </InlineAlert>
      ) : item.method === "link" ? (
        <InlineAlert tone="info">
          {t("software.install.linkBefore")}
          <ExternalLink href={item.install_url ?? item.homepage}>
            {t("software.install.linkLink")}
          </ExternalLink>
          {t("software.install.linkAfter")}
        </InlineAlert>
      ) : item.method === "unsupported" ? (
        <InlineAlert tone="warn">{t("software.install.unsupported")}</InlineAlert>
      ) : (
        <p className="small muted">
          {item.method === "model"
            ? t("software.install.methodModel")
            : t("software.install.methodOther")}
          {item.method === "archive" ? t("software.install.archiveChecksum") : ""}
          {t("software.install.removeAnytime")}
        </p>
      )}
    </Dialog>
  );
}

function SoftwareRow({
  s,
  job,
  onInstall,
  onRemove,
  removing,
}: {
  s: SoftwareView;
  job: JobView | undefined;
  onInstall: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const installing = !!job && !isTerminal(job.status);
  return (
    <li className="mount sw-row">
      <div className="mount-main">
        <Icon name="package" />
        <div className="mount-text">
          <div className="mount-title">
            <span className="mount-name">{s.name}</span>
            <StateBadge s={s} installing={installing} />
            {s.needs_approval && !s.installed ? (
              <Badge tone="warn">{t("software.needsApproval")}</Badge>
            ) : null}
          </div>
          <span className="small muted">{s.summary}</span>
          <span className="mount-meta">
            <span>{sizeLabel(s.size_mb)}</span>
            <span>{s.license}</span>
            {/^\d/.test(s.version) ? <span>v{s.version}</span> : null}
            <span>{methodLabel(s)}</span>
          </span>
          {s.installed && s.path ? <span className="mount-target">{s.path}</span> : null}
          {installing && job ? <JobProgress job={job} small /> : null}
          {job?.status === "failed" ? (
            <span className="mount-error">
              {jobErrorText(job.error) ?? t("software.installFailed")}
            </span>
          ) : null}
        </div>
        <div className="mount-actions">
          {s.installed ? (
            s.managed ? (
              <Button size="sm" variant="ghost" icon="trash" busy={removing} onClick={onRemove}>
                {t("software.remove")}
              </Button>
            ) : (
              <span className="small muted">{t("software.installedOutside")}</span>
            )
          ) : installing ? null : (
            <Button
              size="sm"
              variant={canInstallHere(s) ? "secondary" : "ghost"}
              icon={canInstallHere(s) ? "download" : "info"}
              onClick={onInstall}
            >
              {canInstallHere(s) ? t("software.installButton") : t("software.howToInstall")}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

export function SoftwarePage() {
  useDocumentTitle(t("software.title"));
  const toast = useToast();
  const { query, setQuery } = useRouter();
  const list = useResource(
    (signal) =>
      api.get<{ items: SoftwareView[] }>("/api/software", undefined, signal).then((r) => r.items),
    [],
  );
  const [jobs, setJobs] = useState<Record<string, JobView>>({});
  const [dialog, setDialog] = useState<{ id: string; asked: boolean } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [tag, setTag] = useState("all");
  const [goal, setGoal] = useState<GoalInfo | null>(null);
  const [planVersion, setPlanVersion] = useState(0);

  // An agent's approval link opens the dialog for that program.
  const asked = installRequest(query);
  useEffect(() => {
    if (asked) setDialog({ id: asked, asked: true });
  }, [asked]);

  // Jobs that were already running when the page opened.
  useEffect(() => {
    for (const s of list.data ?? []) {
      if (s.job_id && !jobs[s.id]) {
        const id = s.id;
        void api
          .get<{ job: JobView }>(`/api/jobs/${encodeURIComponent(s.job_id)}`)
          .then((r) => setJobs((j) => ({ ...j, [id]: r.job })))
          .catch(() => undefined);
      }
    }
  }, [list.data, jobs]);

  useEvent("job", (job) => {
    const entry = Object.entries(jobs).find(([, j]) => j.job_id === job.job_id);
    if (!entry) return;
    const [id, before] = entry;
    setJobs((j) => ({ ...j, [id]: job }));
    if (!isTerminal(before.status) && isTerminal(job.status)) {
      const name = list.data?.find((s) => s.id === id)?.name ?? id;
      if (job.status === "succeeded") toast.ok(t("software.installedToast", { name }));
      else toast.error(t("software.notInstalledToast", { name }));
      void api
        .get<{ items: SoftwareView[] }>("/api/software", { fresh: 1 })
        .then((r) => list.mutate(r.items));
      setPlanVersion((v) => v + 1);
    }
  });

  const closeDialog = () => {
    setDialog(null);
    if (asked) setQuery({ install: null });
  };

  const started = (start: InstallStart) => {
    closeDialog();
    if (start.status === "started") {
      const now = new Date().toISOString();
      setJobs((j) => ({
        ...j,
        [start.id]: {
          job_id: start.job_id,
          tool: "install_software",
          status: "queued",
          progress: null,
          message: null,
          result: null,
          error: null,
          created_at: now,
          updated_at: now,
        },
      }));
      toast.ok(t("software.installingToast"));
    } else if (start.status === "already_installed") {
      toast.ok(t("software.alreadyToast"));
      void list.reload();
    } else {
      toast.show({ tone: "info", text: start.message });
    }
  };

  const remove = async (s: SoftwareView) => {
    setRemoving(s.id);
    try {
      await api.post(`/api/software/${encodeURIComponent(s.id)}/uninstall`);
      toast.ok(t("software.removedToast", { name: s.name }));
      setJobs((j) => {
        const { [s.id]: _gone, ...rest } = j;
        return rest;
      });
      const r = await api.get<{ items: SoftwareView[] }>("/api/software", { fresh: 1 });
      list.mutate(r.items);
      setPlanVersion((v) => v + 1);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setRemoving(null);
    }
  };

  const items = sortSoftware(list.data ?? []);
  const tags = softwareTags(items);
  const shown = tag === "all" ? items : items.filter((s) => s.tags.includes(tag));
  const dialogItem = dialog ? items.find((s) => s.id === dialog.id) : undefined;

  return (
    <>
      <PageHeader
        title={t("software.title")}
        description={t("software.description")}
        actions={
          <Button
            variant="ghost"
            icon="refresh"
            onClick={() =>
              api
                .get<{ items: SoftwareView[] }>("/api/software", { fresh: 1 })
                .then((r) => list.mutate(r.items))
                .catch((e) => toast.error(errorMessage(e)))
            }
          >
            {t("software.checkAgain")}
          </Button>
        }
      />
      <Card title={t("software.goalTitle")}>
        <p className="small muted">{t("software.goalHint")}</p>
        <GoalPicker value={goal?.id ?? null} onPick={setGoal} />
        {goal ? <GoalPlan goal={goal.id} version={planVersion} /> : null}
      </Card>
      <Card title={t("software.programs")}>
        {tags.length > 1 ? (
          <div className="sw-filter">
            <Segmented
              label={t("software.show")}
              value={tag}
              onChange={setTag}
              options={[
                { value: "all", label: t("software.showAll") },
                ...tags.map((t) => ({ value: t, label: t[0]?.toUpperCase() + t.slice(1) })),
              ]}
            />
          </div>
        ) : null}
        {list.loading && !list.data ? (
          <Loading lines={6} />
        ) : list.error && !list.data ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : shown.length === 0 ? (
          <EmptyState icon="package" title={t("software.nothingToShow")} />
        ) : (
          <ul className="mount-list">
            {shown.map((s) => (
              <SoftwareRow
                key={s.id}
                s={s}
                job={jobs[s.id]}
                removing={removing === s.id}
                onInstall={() => setDialog({ id: s.id, asked: false })}
                onRemove={() => remove(s)}
              />
            ))}
          </ul>
        )}
      </Card>
      {dialog && dialogItem ? (
        <InstallDialog
          item={dialogItem}
          asked={dialog.asked}
          onClose={closeDialog}
          onStarted={started}
        />
      ) : null}
      {dialog && list.data && !dialogItem ? (
        <Dialog open onClose={closeDialog} title={t("software.unknownTitle")}>
          <p>{t("software.unknownBody", { id: dialog.id })}</p>
        </Dialog>
      ) : null}
    </>
  );
}
