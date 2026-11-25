// Triggers: run a workflow on a schedule or when a signed webhook arrives.
import { type FormEvent, useState } from "react";
import { Dialog } from "../components/Dialog";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  CopyField,
  EmptyState,
  ErrorState,
  FieldRow,
  InlineAlert,
  Loading,
  PageHeader,
  Segmented,
  Switch,
  TextInput,
} from "../components/ui";
import { t } from "../i18n";
import { ApiError, api, errorMessage } from "../lib/api";
import { formatRelative, formatTime } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import { Link } from "../lib/router";
import {
  EMPTY_TRIGGER,
  type TriggerDraft,
  type TriggerInfo,
  type WorkflowInfo,
  describeSchedule,
  lastRunState,
  schedulePresets,
  triggerBody,
  workflowLabel,
} from "../lib/triggers";

interface Secret {
  name: string;
  secret: string;
  url: string | null;
}

function TriggerRow({
  trig,
  onChanged,
  onRemove,
  onSecret,
}: {
  trig: TriggerInfo;
  onChanged: (t: TriggerInfo) => void;
  onRemove: () => void;
  onSecret: (s: Secret) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const last = lastRunState(trig);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (on: boolean) =>
    act(async () => {
      const r = await api.request<{ trigger: TriggerInfo }>(`/api/triggers/${trig.id}`, {
        method: "PATCH",
        body: { enabled: on },
      });
      onChanged(r.trigger);
      toast.ok(
        t("triggers.row.turned", {
          name: trig.name,
          state: t(on ? "triggers.row.on" : "triggers.row.off"),
        }),
      );
    });
  const runNow = () =>
    act(async () => {
      await api.post(`/api/triggers/${trig.id}/run`);
      toast.ok(t("triggers.row.started", { name: trig.name }));
      const r = await api.get<{ trigger: TriggerInfo }>(`/api/triggers/${trig.id}`);
      onChanged(r.trigger);
    });
  const rotate = () =>
    act(async () => {
      const r = await api.post<{ trigger: TriggerInfo; secret: string }>(
        `/api/triggers/${trig.id}/rotate-secret`,
      );
      onChanged(r.trigger);
      onSecret({ name: trig.name, secret: r.secret, url: r.trigger.webhook_url });
    });

  return (
    <li className="mount">
      <div className="mount-main">
        <div className="mount-text">
          <div className="mount-title">
            <span className="mount-name">{trig.name}</span>
            {last ? (
              <Badge tone={last.tone} dot>
                {last.text}
              </Badge>
            ) : null}
          </div>
          <p className="small muted mount-meta">
            <span>
              {t("triggers.row.runs")} <code>{workflowLabel(trig.workflow)}</code>
            </span>
            <span>
              {trig.kind === "cron" ? describeSchedule(trig) : t("triggers.row.webhookKind")}
            </span>
            {trig.enabled && trig.next_run_at ? (
              <span title={formatTime(trig.next_run_at)}>
                {t("triggers.row.next")} {formatRelative(trig.next_run_at)}
              </span>
            ) : null}
            {trig.last_run ? (
              <span title={formatTime(trig.last_run.at)}>
                {t("triggers.row.last")} {formatRelative(trig.last_run.at)}
                {trig.last_run.job_id ? (
                  <>
                    {" "}
                    (
                    <Link to={`/jobs?job=${encodeURIComponent(trig.last_run.job_id)}`}>
                      {t("triggers.row.jobLink")}
                    </Link>
                    )
                  </>
                ) : null}
              </span>
            ) : (
              <span>{t("triggers.row.notRunYet")}</span>
            )}
            {trig.callback ? (
              <span>
                {t("triggers.row.reportsTo", {
                  target:
                    trig.callback.type === "telegram"
                      ? "Telegram"
                      : t("triggers.row.webhookCallback"),
                })}
              </span>
            ) : null}
          </p>
          {trig.last_run?.error ? (
            <p className="small mount-error mono">{trig.last_run.error}</p>
          ) : null}
          {trig.webhook_url ? (
            <CopyField
              value={trig.webhook_url}
              label={t("triggers.row.webhookAddressFor", { name: trig.name })}
            />
          ) : null}
        </div>
        <div className="mount-actions">
          <Button size="sm" variant="secondary" icon="play" busy={busy} onClick={runNow}>
            {t("triggers.row.runNow")}
          </Button>
          {trig.kind === "webhook" || trig.callback?.type === "webhook" ? (
            <Button size="sm" variant="ghost" icon="key" onClick={rotate} disabled={busy}>
              {t("triggers.row.newSecret")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            onClick={onRemove}
            aria-label={t("triggers.row.deleteFor", { name: trig.name })}
          >
            {t("triggers.row.delete")}
          </Button>
          <Switch
            checked={trig.enabled}
            onChange={toggle}
            label={
              trig.enabled
                ? t("triggers.row.turnOff", { name: trig.name })
                : t("triggers.row.turnOn", { name: trig.name })
            }
            disabled={busy}
          />
        </div>
      </div>
    </li>
  );
}

function AddTriggerDialog({
  open,
  workflows,
  onClose,
  onAdded,
}: {
  open: boolean;
  workflows: WorkflowInfo[];
  onClose: () => void;
  onAdded: (t: TriggerInfo, secret: string) => void;
}) {
  const [d, setD] = useState<TriggerDraft>(EMPTY_TRIGGER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const set = <K extends keyof TriggerDraft>(k: K, v: TriggerDraft[K]) =>
    setD((x) => ({ ...x, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = triggerBody(d);
    if ("issues" in r) {
      setIssues(r.issues);
      return;
    }
    setIssues({});
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ trigger: TriggerInfo; secret: string }>("/api/triggers", r.body);
      setD(EMPTY_TRIGGER);
      onAdded(res.trigger, res.secret);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "INVALID_INPUT"
          ? t("triggers.form.inputDoesNotFit", { message: err.message })
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("triggers.dialog.title")}
      description={t("triggers.dialog.description")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("triggers.dialog.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            form="add-trigger-form"
            disabled={workflows.length === 0}
          >
            {t("triggers.dialog.create")}
          </Button>
        </>
      }
    >
      <form id="add-trigger-form" className="stack" onSubmit={submit} noValidate>
        <Segmented
          label={t("triggers.form.startsWhen")}
          value={d.kind}
          onChange={(v) => set("kind", v)}
          options={[
            { value: "cron", label: t("triggers.form.kindCron") },
            { value: "webhook", label: t("triggers.form.kindWebhook") },
          ]}
        />
        <FieldRow label={t("triggers.form.name")} htmlFor="t-name" error={issues.name} required>
          <TextInput
            id="t-name"
            value={d.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("triggers.form.namePlaceholder")}
          />
        </FieldRow>
        <FieldRow
          label={t("triggers.form.workflow")}
          htmlFor="t-workflow"
          error={issues.workflow}
          required
        >
          <select
            id="t-workflow"
            className="input"
            value={d.workflow}
            onChange={(e) => set("workflow", e.target.value)}
          >
            <option value="">{t("triggers.form.chooseWorkflow")}</option>
            {workflows.map((w) => (
              <option key={w.name} value={w.name}>
                {workflowLabel(w.name)}
              </option>
            ))}
          </select>
        </FieldRow>
        {d.kind === "cron" ? (
          <>
            <div className="grid-2">
              <FieldRow
                label={t("triggers.form.schedule")}
                htmlFor="t-schedule"
                error={issues.schedule}
                hint={t("triggers.form.scheduleHint")}
              >
                <TextInput
                  id="t-schedule"
                  className="mono"
                  value={d.schedule}
                  onChange={(e) => set("schedule", e.target.value)}
                  list="t-presets"
                />
              </FieldRow>
              <FieldRow label={t("triggers.form.timezone")} htmlFor="t-zone">
                <select
                  id="t-zone"
                  className="input"
                  value={d.timezone}
                  onChange={(e) => set("timezone", e.target.value as TriggerDraft["timezone"])}
                >
                  <option value="local">{t("triggers.form.timezoneLocal")}</option>
                  <option value="UTC">{t("triggers.form.timezoneUtc")}</option>
                </select>
              </FieldRow>
            </div>
            <datalist id="t-presets">
              {schedulePresets().map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </datalist>
            <Switch
              checked={d.catchUp}
              onChange={(v) => set("catchUp", v)}
              label={t("triggers.form.catchUp")}
              showLabel
            />
          </>
        ) : (
          <Switch
            checked={d.useBody}
            onChange={(v) => set("useBody", v)}
            label={t("triggers.form.useBody")}
            showLabel
          />
        )}
        <FieldRow
          label={t("triggers.form.args")}
          htmlFor="t-args"
          error={issues.args}
          hint={d.kind === "webhook" && d.useBody ? t("triggers.form.argsHint") : undefined}
        >
          <textarea
            id="t-args"
            className={`input mono ${issues.args ? "input-invalid" : ""}`}
            rows={4}
            spellCheck={false}
            value={d.args}
            onChange={(e) => set("args", e.target.value)}
          />
        </FieldRow>
        <FieldRow label={t("triggers.form.callback")} htmlFor="t-callback">
          <select
            id="t-callback"
            className="input"
            value={d.callback}
            onChange={(e) => set("callback", e.target.value as TriggerDraft["callback"])}
          >
            <option value="none">{t("triggers.form.callbackNone")}</option>
            <option value="webhook">{t("triggers.form.callbackWebhook")}</option>
            <option value="telegram">{t("triggers.form.callbackTelegram")}</option>
          </select>
        </FieldRow>
        {d.callback === "webhook" ? (
          <FieldRow
            label={t("triggers.form.callbackUrl")}
            htmlFor="t-cb-url"
            error={issues.callbackUrl}
            hint={t("triggers.form.callbackUrlHint")}
          >
            <TextInput
              id="t-cb-url"
              value={d.callbackUrl}
              onChange={(e) => set("callbackUrl", e.target.value)}
              placeholder="https://example.com/done"
              inputMode="url"
            />
          </FieldRow>
        ) : null}
        {d.callback === "telegram" ? (
          <FieldRow
            label={t("triggers.form.chatId")}
            htmlFor="t-chat"
            hint={t("triggers.form.chatIdHint")}
          >
            <TextInput
              id="t-chat"
              value={d.chatId}
              onChange={(e) => set("chatId", e.target.value)}
            />
          </FieldRow>
        ) : null}
        {workflows.length === 0 ? (
          <InlineAlert tone="info">{t("triggers.form.noWorkflows")}</InlineAlert>
        ) : null}
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      </form>
    </Dialog>
  );
}

export function TriggersPage() {
  useDocumentTitle(t("triggers.page.title"));
  const toast = useToast();
  const data = useResource(async (signal) => {
    const [t, w] = await Promise.all([
      api.get<{ triggers: TriggerInfo[] }>("/api/triggers", undefined, signal),
      api.get<{ workflows: WorkflowInfo[] }>("/api/triggers/workflows", undefined, signal),
    ]);
    return { triggers: t.triggers, workflows: w.workflows };
  }, []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TriggerInfo | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (t: TriggerInfo) =>
    data.mutate((d) =>
      d ? { ...d, triggers: d.triggers.map((x) => (x.id === t.id ? t : x)) } : d,
    );

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.del(`/api/triggers/${removing.id}`);
      toast.ok(t("triggers.page.deleted", { name: removing.name }));
      setRemoving(null);
      void data.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t("triggers.page.headerTitle")}
        description={t("triggers.page.description")}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
            {t("triggers.page.newTrigger")}
          </Button>
        }
      />
      {data.loading && !data.data ? (
        <Loading lines={5} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : (
        <Card>
          {(data.data?.triggers.length ?? 0) === 0 ? (
            <EmptyState icon="clock" title={t("triggers.page.emptyTitle")}>
              {t("triggers.page.emptyBefore")}
              <strong>{t("triggers.page.emptyStrong")}</strong>
              {t("triggers.page.emptyAfter")}
            </EmptyState>
          ) : (
            <ul className="mount-list" aria-label={t("triggers.page.listLabel")}>
              {data.data?.triggers.map((t) => (
                <TriggerRow
                  key={t.id}
                  trig={t}
                  onChanged={update}
                  onRemove={() => setRemoving(t)}
                  onSecret={setSecret}
                />
              ))}
            </ul>
          )}
        </Card>
      )}
      <AddTriggerDialog
        open={adding}
        workflows={data.data?.workflows ?? []}
        onClose={() => setAdding(false)}
        onAdded={(trig, s) => {
          setAdding(false);
          toast.ok(t("triggers.page.created", { name: trig.name }));
          void data.reload();
          if (trig.kind === "webhook" || trig.callback?.type === "webhook")
            setSecret({ name: trig.name, secret: s, url: trig.webhook_url });
        }}
      />
      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title={t("triggers.secret.title", {
          name: secret?.name ?? t("triggers.secret.fallbackName"),
        })}
        description={t("triggers.secret.description")}
        size="md"
        footer={
          <Button variant="primary" onClick={() => setSecret(null)}>
            {t("triggers.secret.copied")}
          </Button>
        }
      >
        <div className="stack">
          {secret?.url ? (
            <CopyField value={secret.url} label={t("triggers.secret.webhookAddress")} />
          ) : null}
          {secret ? (
            <CopyField value={secret.secret} label={t("triggers.secret.signingSecret")} />
          ) : null}
          <p className="small muted">
            {t("triggers.secret.hint1")}
            <code>X-PlugHive-Timestamp</code>
            {t("triggers.secret.hint2")} <code>X-PlugHive-Signature: sha256=&lt;hex&gt;</code>
            {t("triggers.secret.hint3")} <code>timestamp.body</code>
            {t("triggers.secret.hint4")}
          </p>
        </div>
      </Dialog>
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t("triggers.delete.title", {
          name: removing?.name ?? t("triggers.delete.fallbackName"),
        })}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)} data-autofocus>
              {t("triggers.delete.keep")}
            </Button>
            <Button variant="danger" busy={busy} onClick={remove}>
              {t("triggers.delete.confirm")}
            </Button>
          </>
        }
      >
        <p>{t("triggers.delete.body")}</p>
      </Dialog>
    </>
  );
}
