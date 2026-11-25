// Usage: calls and estimated spend, by day, provider and tool.
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { SpendCaps } from "../components/SpendCaps";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Segmented,
} from "../components/ui";
import { getLocale, t } from "../i18n";
import { api } from "../lib/api";
import { displayName, formatNumber, formatRelative, formatTime, formatUsd } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import type { UsageResponse } from "../lib/types";
import {
  type DayPoint,
  type Range,
  daySeries,
  niceMax,
  providerTotals,
  sinceFor,
} from "../lib/usage";

type Metric = "cost" | "calls";

/** Calls that used no outside service are recorded under "none". */
const providerLabel = (id: string) => (!id || id === "none" ? t("usage.builtIn") : displayName(id));

/** The message keys for the "sub" line of each range; translated at render time. */
const RANGE_SUB: Record<Range, string> = {
  today: "usage.range.sub.today",
  "7d": "usage.range.sub.7d",
  "30d": "usage.range.sub.30d",
  all: "usage.range.sub.all",
};

function dayLabel(day: string, long = false): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(
    getLocale(),
    long
      ? { weekday: "short", month: "short", day: "numeric" }
      : { month: "short", day: "numeric" },
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

/** Width of an element in CSS pixels, so SVG text keeps its real size. */
function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function DayChart({ points, metric }: { points: DayPoint[]; metric: Metric }) {
  const [ref, W] = useWidth<HTMLElement>(720);
  const H = 200;
  const padL = 56;
  const padB = 24;
  const padT = 8;
  const value = (p: DayPoint) => (metric === "cost" ? p.cost : p.calls);
  const fmt = (v: number) => (metric === "cost" ? formatUsd(v) : formatNumber(Math.round(v)));
  const max = niceMax(Math.max(0, ...points.map(value)));
  const plotW = W - padL;
  const plotH = H - padB - padT;
  const slot = plotW / Math.max(1, points.length);
  const barW = Math.max(2, Math.min(40, slot * 0.7));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const total = points.reduce((n, p) => n + value(p), 0);
  return (
    <figure className="chart" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${metric === "cost" ? t("usage.estimatedSpend") : t("usage.calls")} ${t("usage.chart.aria", { days: String(points.length), total: fmt(total) })}`}
      >
        {[0, 0.5, 1].map((f) => {
          const y = padT + plotH * (1 - f);
          return (
            <g key={f}>
              <line className="chart-grid" x1={padL} x2={W} y1={y} y2={y} />
              {/* Counts are whole numbers: no "1, 1, 0" axis when the top is 1. */}
              {metric === "cost" || Number.isInteger(max * f) ? (
                <text className="chart-axis" x={padL - 8} y={y + 4} textAnchor="end">
                  {fmt(max * f)}
                </text>
              ) : null}
            </g>
          );
        })}
        {points.map((p, i) => {
          const v = value(p);
          const h = max > 0 ? (v / max) * plotH : 0;
          const x = padL + i * slot + (slot - barW) / 2;
          return (
            <g key={p.day}>
              <rect
                className="chart-bar"
                x={x}
                y={padT + plotH - h}
                width={barW}
                height={Math.max(h, v > 0 ? 1 : 0)}
                rx={2}
              >
                <title>
                  {dayLabel(p.day, true)}:{" "}
                  {metric === "cost"
                    ? formatUsd(p.cost, { estimate: true })
                    : t("usage.callCount", { count: p.calls })}
                  {p.errors ? `, ${t("usage.failedCount", { count: p.errors })}` : ""}
                </title>
              </rect>
              {i % labelEvery === 0 || i === points.length - 1 ? (
                <text
                  className="chart-axis"
                  x={padL + i * slot + slot / 2}
                  y={H - 6}
                  textAnchor="middle"
                >
                  {dayLabel(p.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <details className="chart-table">
        <summary>
          <Icon name="chevronRight" className="details-chevron" />
          {t("usage.chart.showTable")}
        </summary>
        <table className="table">
          <caption className="visually-hidden">{t("usage.chart.tableCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("usage.chart.day")}</th>
              <th scope="col">{t("usage.calls")}</th>
              <th scope="col">{t("usage.failed")}</th>
              <th scope="col">{t("usage.estimatedSpend")}</th>
            </tr>
          </thead>
          <tbody>
            {points
              .filter((p) => p.calls > 0)
              .reverse()
              .map((p) => (
                <tr key={p.day}>
                  <td>{dayLabel(p.day, true)}</td>
                  <td>{formatNumber(p.calls)}</td>
                  <td>{formatNumber(p.errors)}</td>
                  <td>{formatUsd(p.cost, { estimate: true })}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

interface BarRow {
  key: string;
  label: React.ReactNode;
  calls: number;
  cost: number;
}

function BarList({ rows, metric, label }: { rows: BarRow[]; metric: Metric; label: string }) {
  const value = (r: BarRow) => (metric === "cost" ? r.cost : r.calls);
  const max = Math.max(0, ...rows.map(value));
  const sorted = [...rows].sort((a, b) => value(b) - value(a) || b.calls - a.calls);
  return (
    <ul className="bar-list" aria-label={label}>
      {sorted.map((r) => (
        <li key={r.key} className="bar-row">
          <span className="bar-label">{r.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span
              className="bar-fill"
              style={{ width: `${max > 0 ? Math.max(1, (value(r) / max) * 100) : 0}%` }}
            />
          </span>
          <span className="bar-value">
            {metric === "cost" ? formatUsd(r.cost, { estimate: true }) : formatNumber(r.calls)}
            <span className="small muted">
              {" "}
              ·{" "}
              {metric === "cost"
                ? t("usage.callCount", { count: r.calls })
                : formatUsd(r.cost, { estimate: true })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function UsagePage() {
  useDocumentTitle(t("usage.title"));
  const { query, setQuery } = useRouter();
  const range = ((query.get("range") as Range | null) ?? "7d") as Range;
  // Until the person picks, show spend only when there is some.
  const [metricChoice, setMetric] = useState<Metric | null>(null);
  const [provider, setProvider] = useState<string>("");
  const since = useMemo(() => sinceFor(range), [range]);
  const data = useResource(
    (signal) => api.get<UsageResponse>("/api/usage", { since, limit: 2000 }, signal),
    [since],
  );

  const rows = data.data?.by_provider_day ?? [];
  const providers = useMemo(() => providerTotals(rows), [rows]);
  const points = useMemo(
    () => daySeries(rows, range, { provider: provider || null }),
    [rows, range, provider],
  );
  const s = data.data?.summary;
  const metric: Metric = metricChoice ?? ((s?.total_cost_usd ?? 0) > 0 ? "cost" : "calls");
  const chartTotal = points.reduce((n, p) => n + (metric === "cost" ? p.cost : p.calls), 0);
  const calls = s?.total_calls ?? 0;
  const errorRate = calls > 0 ? Math.round(((s?.error_calls ?? 0) / calls) * 100) : 0;
  const health = s?.rate_limits ?? [];

  return (
    <>
      <PageHeader title={t("usage.title")} description={t("usage.description")} />
      <div className="toolbar">
        <Segmented<Range>
          label={t("usage.range.label")}
          value={range}
          onChange={(v) => setQuery({ range: v === "7d" ? null : v })}
          options={[
            { value: "today", label: t("usage.range.option.today") },
            { value: "7d", label: t("usage.range.option.7d") },
            { value: "30d", label: t("usage.range.option.30d") },
            { value: "all", label: t("usage.range.option.all") },
          ]}
        />
        <Segmented<Metric>
          label={t("usage.measure.label")}
          value={metric}
          onChange={setMetric}
          options={[
            { value: "cost", label: t("usage.measure.cost") },
            { value: "calls", label: t("usage.calls") },
          ]}
        />
      </div>
      {data.loading && !data.data ? (
        <Loading lines={6} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : (
        <div className="stack-lg">
          <SpendCaps />
          <div className="stats" aria-label={t("usage.totals")}>
            <Stat
              label={t("usage.estimatedSpend")}
              value={formatUsd(s?.total_cost_usd, { estimate: true })}
              sub={t(RANGE_SUB[range])}
            />
            <Stat
              label={t("usage.calls")}
              value={formatNumber(calls)}
              sub={
                (s?.fallback_calls ?? 0) > 0
                  ? t("usage.stat.fallback", { count: s?.fallback_calls ?? 0 })
                  : t(RANGE_SUB[range])
              }
            />
            <Stat
              label={t("usage.failed")}
              value={formatNumber(s?.error_calls)}
              sub={
                calls > 0 ? t("usage.stat.errorRate", { rate: errorRate }) : t("usage.stat.noCalls")
              }
            />
            {(s?.cached_calls ?? 0) > 0 ? (
              <Stat
                label={t("usage.stat.cached")}
                value={formatNumber(s?.cached_calls)}
                sub={t("usage.stat.noCharge")}
              />
            ) : null}
          </div>
          {calls === 0 ? (
            <EmptyState
              icon="chart"
              title={range === "all" ? t("usage.empty.allTitle") : t("usage.empty.rangeTitle")}
              action={
                range === "all" ? (
                  <Link to="/playground" className="btn btn-secondary">
                    {t("usage.empty.openPlayground")}
                  </Link>
                ) : (
                  <Button variant="secondary" onClick={() => setQuery({ range: "all" })}>
                    {t("usage.empty.showAll")}
                  </Button>
                )
              }
            >
              {range === "all" ? t("usage.empty.allBody") : t("usage.empty.rangeBody")}
            </EmptyState>
          ) : (
            <>
              <Card
                title={metric === "cost" ? t("usage.chart.titleCost") : t("usage.chart.titleCalls")}
                actions={
                  providers.length > 1 ? (
                    <label className="inline-select">
                      <span className="small muted">{t("usage.provider.label")}</span>
                      <select
                        className="input input-sm"
                        value={provider}
                        onChange={(e) => setProvider(e.target.value)}
                        aria-label={t("usage.provider.showOne")}
                      >
                        <option value="">{t("usage.provider.all")}</option>
                        {providers.map((p) => (
                          <option key={p.provider} value={p.provider}>
                            {providerLabel(p.provider)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null
                }
              >
                {chartTotal > 0 ? (
                  <DayChart points={points} metric={metric} />
                ) : (
                  <p className="small muted">
                    {metric === "cost"
                      ? t("usage.chart.noSpend")
                      : t("usage.chart.noCallsProvider")}
                  </p>
                )}
              </Card>
              <div className="grid grid-2">
                <Card title={t("usage.provider.title")}>
                  {providers.length === 0 ? (
                    <p className="small muted">{t("usage.provider.empty")}</p>
                  ) : (
                    <BarList
                      metric={metric}
                      label={t("usage.provider.list")}
                      rows={providers.map((p) => ({
                        key: p.provider,
                        label: providerLabel(p.provider),
                        calls: p.calls,
                        cost: p.cost,
                      }))}
                    />
                  )}
                </Card>
                <Card title={t("usage.tool.title")}>
                  <BarList
                    metric={metric}
                    label={t("usage.tool.list")}
                    rows={(s?.by_tool ?? []).slice(0, 12).map((t) => ({
                      key: t.tool,
                      label: (
                        <Link
                          to={`/playground?tool=${encodeURIComponent(t.tool)}`}
                          className="mono"
                        >
                          {t.tool}
                        </Link>
                      ),
                      calls: t.calls,
                      cost: t.cost_usd ?? 0,
                    }))}
                  />
                  {(s?.by_tool.length ?? 0) > 12 ? (
                    <p className="small muted">
                      {t("usage.tool.more", { shown: "12", total: String(s?.by_tool.length ?? 0) })}
                    </p>
                  ) : null}
                </Card>
              </div>
            </>
          )}
          {health.length > 0 ? (
            <Card title={t("usage.health.title")}>
              <ul className="health-list">
                {health.map((h) => {
                  const name = String(h.vendor ?? h.provider ?? "unknown");
                  const last = typeof h.last_429_at === "string" ? h.last_429_at : null;
                  return (
                    <li key={name} className="health-row">
                      <span className="cap-name">{displayName(name)}</span>
                      {h.in_cooldown ? (
                        <Badge tone="warn" dot>
                          {t("usage.health.rateLimited", {
                            when: formatRelative(h.cooldown_until),
                          })}
                        </Badge>
                      ) : (
                        <Badge tone="ok" dot>
                          {t("usage.health.available")}
                        </Badge>
                      )}
                      {last ? (
                        <span className="small muted" title={formatTime(last)}>
                          {t("usage.health.lastAway", { when: formatRelative(last) })}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
          <p className="small muted">{t("usage.footnote")}</p>
        </div>
      )}
    </>
  );
}
