// Approvals: paid or guarded calls waiting for a person, and what was decided.
import { useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineAlert,
  Loading,
  PageHeader,
  Segmented,
} from "../components/ui";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import {
  type ApprovalStatus,
  type ApprovalView,
  type ApprovalsResponse,
  statusLabel,
  statusTone,
} from "../lib/approvals";
import { useEvent } from "../lib/events";
import { formatRelative, formatTime, formatUsd } from "../lib/format";
import { useDocumentTitle, useNow, useResource } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";

type Filter = "all" | ApprovalStatus;

const KIND_KEY: Record<ApprovalView["kind"], string> = {
  tool: "approvals.kind.tool",
  provider: "approvals.kind.provider",
  workflow: "approvals.kind.workflow",
};

const kindLabel = (kind: ApprovalView["kind"]): string => t(KIND_KEY[kind]);

function ApprovalCard({
  a,
  highlight,
  onDecided,
}: { a: ApprovalView; highlight: boolean; onDecided: (a: ApprovalView) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const now = useNow(a.status === "pending", 30_000);
  const pending = a.status === "pending";
  const decide = async (verb: "approve" | "deny") => {
    setBusy(verb);
    try {
      const r = await api.post<{ approval: ApprovalView }>(
        `/api/approvals/${encodeURIComponent(a.id)}/${verb}`,
      );
      onDecided(r.approval);
      toast.ok(
        verb === "approve"
          ? t("approvals.card.approvedToast", { tool: a.tool })
          : t("approvals.card.deniedToast", { tool: a.tool }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <li id={`approval-${a.id}`} className={highlight ? "approval approval-on" : "approval"}>
      <div className="approval-head">
        <span className="mono approval-tool">{a.tool}</span>
        <Badge tone={statusTone(a.status)} dot>
          {statusLabel(a.status)}
        </Badge>
        <span className="small muted">{kindLabel(a.kind)}</span>
        <span className="spacer" />
        <span className="approval-cost" title={a.estimate_basis ?? undefined}>
          {a.estimate_usd === null
            ? t("approvals.card.costUnknown")
            : t("approvals.card.costUpTo", {
                amount: formatUsd(a.estimate_usd, { estimate: true }),
              })}
        </span>
      </div>
      <p className="approval-reason">{a.reason}</p>
      {a.args_summary ? <pre className="approval-args mono small">{a.args_summary}</pre> : null}
      <div className="approval-meta small muted">
        <span title={formatTime(a.created_at)}>
          {t("approvals.card.asked")} {formatRelative(a.created_at, now)}
        </span>
        {a.provider ? <span>{t("approvals.card.provider", { provider: a.provider })}</span> : null}
        {a.profile && a.profile !== "default" ? (
          <span>{t("approvals.card.profile", { profile: a.profile })}</span>
        ) : null}
        {a.job_id ? (
          <Link to={`/jobs?job=${encodeURIComponent(a.job_id)}`}>
            {t("approvals.card.jobWaiting")}
          </Link>
        ) : null}
        {pending ? (
          <span title={formatTime(a.expires_at)}>
            {t("approvals.card.expires")} {formatRelative(a.expires_at, now)}
          </span>
        ) : null}
        {a.decided_at ? (
          <span title={formatTime(a.decided_at)}>
            {statusLabel(a.status)} {formatRelative(a.decided_at, now)}
            {a.decided_by ? <> {t("approvals.card.via", { by: a.decided_by })}</> : null}
          </span>
        ) : null}
      </div>
      {pending ? (
        <div className="row-gap">
          <Button
            variant="primary"
            size="sm"
            icon="check"
            busy={busy === "approve"}
            disabled={busy !== null}
            onClick={() => decide("approve")}
          >
            {t("approvals.card.approve")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon="x"
            busy={busy === "deny"}
            disabled={busy !== null}
            onClick={() => decide("deny")}
          >
            {t("approvals.card.deny")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function ApprovalsPage() {
  useDocumentTitle(t("approvals.page.title"));
  const { query, setQuery } = useRouter();
  const highlight = query.get("id");
  const filter = (query.get("status") as Filter | null) ?? "all";
  const data = useResource(
    (signal) =>
      api.get<ApprovalsResponse>(
        "/api/approvals",
        { limit: 200, ...(filter === "all" ? {} : { status: filter }) },
        signal,
      ),
    [filter],
  );

  // Any change (a new request, a decision elsewhere, an expiry) reloads the list.
  useEvent("approval", () => {
    void data.reload();
  });

  useEffect(() => {
    if (!highlight || !data.data) return;
    document.getElementById(`approval-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [highlight, data.data]);

  const rows = data.data?.approvals ?? [];
  const pending = rows.filter((a) => a.status === "pending");
  const rest = rows.filter((a) => a.status !== "pending");
  const onDecided = (a: ApprovalView) =>
    data.mutate((prev) =>
      prev
        ? {
            ...prev,
            approvals: prev.approvals.map((x) => (x.id === a.id ? a : x)),
            pending: Math.max(0, prev.pending - 1),
          }
        : prev,
    );
  const missing = highlight && data.data && !rows.some((a) => a.id === highlight);

  return (
    <>
      <PageHeader
        title={t("approvals.page.headerTitle")}
        description={
          <>
            {t("approvals.page.descriptionBefore")}
            <Link to="/usage">{t("approvals.page.descriptionLink")}</Link>{" "}
            {t("approvals.page.descriptionAfter")}
          </>
        }
      />
      <div className="toolbar">
        <Segmented<Filter>
          label={t("approvals.page.show")}
          value={filter}
          onChange={(v) => setQuery({ status: v === "all" ? null : v })}
          options={[
            { value: "all", label: t("approvals.filter.all") },
            { value: "pending", label: t("approvals.filter.pending") },
            { value: "consumed", label: t("approvals.filter.consumed") },
            { value: "denied", label: t("approvals.filter.denied") },
            { value: "expired", label: t("approvals.filter.expired") },
          ]}
        />
      </div>
      {data.loading && !data.data ? (
        <Loading lines={4} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : (
        <div className="stack-lg">
          {missing ? <InlineAlert tone="info">{t("approvals.page.missing")}</InlineAlert> : null}
          {filter === "all" || filter === "pending" ? (
            <Card title={t("approvals.waiting.title", { count: pending.length })}>
              {pending.length === 0 ? (
                <p className="small muted">{t("approvals.page.nothingWaiting")}</p>
              ) : (
                <ul className="approval-list">
                  {pending.map((a) => (
                    <ApprovalCard
                      key={a.id}
                      a={a}
                      highlight={a.id === highlight}
                      onDecided={onDecided}
                    />
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
          {filter !== "pending" ? (
            rest.length === 0 && filter !== "all" ? (
              <EmptyState icon="shield" title={t("approvals.page.emptyTitle")}>
                {t("approvals.page.emptyBody")}
              </EmptyState>
            ) : rest.length > 0 ? (
              <Card title={t("approvals.page.history")}>
                <ul className="approval-list">
                  {rest.map((a) => (
                    <ApprovalCard
                      key={a.id}
                      a={a}
                      highlight={a.id === highlight}
                      onDecided={onDecided}
                    />
                  ))}
                </ul>
              </Card>
            ) : null
          ) : null}
          <p className="small muted">{t("approvals.page.footerNote")}</p>
        </div>
      )}
    </>
  );
}
