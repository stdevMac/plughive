// Spend caps on the Usage page: how much of each cap is used, and an editor.
// Saving writes policy.json through PUT /api/policy; every field other than
// the caps is sent back as it was read.
import { useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import {
  type CapDraft,
  type CapMode,
  type CapPeriod,
  type CapScope,
  type PolicyReport,
  capLabel,
  capProgress,
  capsFromDrafts,
  toDraft,
  withCaps,
} from "../lib/approvals";
import { formatUsd } from "../lib/format";
import { useResource } from "../lib/hooks";
import { Link } from "../lib/router";
import { useToast } from "./Toast";
import { Badge, Button, Card, ErrorState, IconButton, InlineAlert, Loading } from "./ui";

const BLANK: CapDraft = { scope: "global", id: "", period: "daily", limit: "5", mode: "ask" };

function CapEditor({
  report,
  onSaved,
  onCancel,
}: { report: PolicyReport; onSaved: (r: PolicyReport) => void; onCancel: () => void }) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<CapDraft[]>(() => report.policy.caps.map(toDraft));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<CapDraft>) =>
    setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    const parsed = capsFromDrafts(drafts);
    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const r = await api.put<PolicyReport>("/api/policy", {
        policy: withCaps(report.policy, parsed.caps),
      });
      toast.ok(t("usage.caps.saved"));
      onSaved(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      {drafts.length === 0 ? <p className="small muted">{t("usage.caps.none")}</p> : null}
      {drafts.map((d, i) => {
        const n = i + 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
          <fieldset key={i} className="cap-edit-row" aria-label={t("usage.caps.cap", { n })}>
            <select
              className="input input-sm"
              aria-label={t("usage.caps.capPeriod", { n })}
              value={d.period}
              onChange={(e) => set(i, { period: e.target.value as CapPeriod })}
            >
              <option value="daily">{t("usage.caps.period.daily")}</option>
              <option value="monthly">{t("usage.caps.period.monthly")}</option>
            </select>
            <select
              className="input input-sm"
              aria-label={t("usage.caps.capScope", { n })}
              value={d.scope}
              onChange={(e) => set(i, { scope: e.target.value as CapScope })}
            >
              <option value="global">{t("usage.caps.scope.global")}</option>
              <option value="provider">{t("usage.caps.scope.provider")}</option>
              <option value="profile">{t("usage.caps.scope.profile")}</option>
            </select>
            {d.scope !== "global" ? (
              <input
                className="input input-sm cap-id mono"
                aria-label={
                  d.scope === "provider"
                    ? t("usage.caps.capProviderId", { n })
                    : t("usage.caps.capProfileId", { n })
                }
                placeholder={d.scope === "provider" ? "fal" : t("usage.caps.profileIdPlaceholder")}
                value={d.id}
                onChange={(e) => set(i, { id: e.target.value })}
              />
            ) : null}
            <label className="row-gap small">
              <span className="muted">$</span>
              <input
                className="input input-sm cap-limit"
                inputMode="decimal"
                aria-label={t("usage.caps.capLimit", { n })}
                value={d.limit}
                onChange={(e) => set(i, { limit: e.target.value })}
              />
            </label>
            <select
              className="input input-sm"
              aria-label={t("usage.caps.capMode", { n })}
              value={d.mode}
              onChange={(e) => set(i, { mode: e.target.value as CapMode })}
            >
              <option value="ask">{t("usage.caps.mode.ask")}</option>
              <option value="block">{t("usage.caps.mode.block")}</option>
            </select>
            <IconButton
              icon="trash"
              label={t("usage.caps.remove", { n })}
              variant="ghost"
              size="sm"
              onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}
            />
          </fieldset>
        );
      })}
      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <div className="row-gap">
        <Button
          size="sm"
          icon="plus"
          onClick={() => setDrafts((d) => [...d, { ...BLANK }])}
          disabled={drafts.length >= 200}
        >
          {t("usage.caps.add")}
        </Button>
        <span className="spacer" />
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {t("usage.caps.cancel")}
        </Button>
        <Button size="sm" variant="primary" onClick={save} busy={saving}>
          {t("usage.caps.save")}
        </Button>
      </div>
      <p className="small muted">{t("usage.caps.help")}</p>
    </div>
  );
}

export function SpendCaps() {
  const data = useResource((signal) => api.get<PolicyReport>("/api/policy", undefined, signal), []);
  const [editing, setEditing] = useState(false);
  const r = data.data;

  return (
    <Card
      title={t("usage.caps.title")}
      actions={
        r?.valid && !editing ? (
          <Button size="sm" icon="edit" onClick={() => setEditing(true)}>
            {t("usage.caps.edit")}
          </Button>
        ) : null
      }
    >
      {data.loading && !r ? (
        <Loading lines={2} />
      ) : data.error && !r ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : r && !r.valid ? (
        <InlineAlert tone="danger" title={t("usage.caps.brokenTitle")}>
          {r.error ?? t("usage.caps.invalid")} {t("usage.caps.brokenBody")}
        </InlineAlert>
      ) : r && editing ? (
        <CapEditor
          report={r}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            data.mutate(next);
            setEditing(false);
          }}
        />
      ) : r && r.caps.length === 0 ? (
        <p className="small muted">{t("usage.caps.noneSet")}</p>
      ) : r ? (
        <ul className="spend-cap-list" aria-label={t("usage.caps.title")}>
          {r.caps.map((s) => {
            const p = capProgress(s);
            const key = `${s.cap.scope}|${s.cap.id ?? ""}|${s.cap.period}`;
            return (
              <li key={key} className="spend-cap-row">
                <span className="bar-label">
                  {capLabel(s.cap)}{" "}
                  <Badge tone={s.cap.mode === "block" ? "danger" : "accent"}>
                    {s.cap.mode === "block" ? t("usage.caps.badgeBlock") : t("usage.caps.badgeAsk")}
                  </Badge>
                </span>
                <span
                  className="bar-track"
                  role="meter"
                  aria-label={t("usage.caps.used", { cap: capLabel(s.cap) })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(p.pct)}
                >
                  <span
                    className={`bar-fill bar-fill-${p.tone}`}
                    style={{ width: `${p.pct > 0 ? Math.max(1, p.pct) : 0}%` }}
                  />
                </span>
                <span className="bar-value">
                  {s.spent_usd === null
                    ? t("usage.caps.unreadable")
                    : formatUsd(s.spent_usd, { estimate: true })}
                  <span className="small muted">
                    {t("usage.caps.of", { amount: formatUsd(s.cap.limit_usd) })}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {r?.valid && !editing ? (
        <p className="small muted">
          {t("usage.caps.footBefore")}
          <Link to="/approvals">{t("usage.caps.footLink")}</Link>
          {t("usage.caps.footAfter")}
        </p>
      ) : null}
    </Card>
  );
}
