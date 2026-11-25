// Smart mount: which mounts and tools cost tokens without being used, what
// to park or hide, which mounts need fixing, and the profile changes it made.
// Talks to /api/mounts/smart (src/core/mounts/smart.ts).
import { useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import { formatRelative } from "../lib/format";
import { useResource } from "../lib/hooks";
import { useToast } from "./Toast";
import { Badge, Button, Card, FieldRow, Segmented, TextInput } from "./ui";

type Mode = "off" | "suggest" | "auto";
type Wake = "auto" | "ask";
type ParkKind = "idle" | "heavy" | "overlap";
type ProfileKind = "profile_unused" | "unused_tools" | "search_mode";
type HealthKind = "sign_in" | "missing_key" | "failing" | "failing_tool";
type Kind = ParkKind | ProfileKind | HealthKind;

const PARK: readonly Kind[] = ["idle", "heavy", "overlap"];
const PROFILE: readonly Kind[] = ["profile_unused", "unused_tools", "search_mode"];

interface Insight {
  id: string;
  name: string;
  enabled: boolean;
  est_tokens: number;
  last_used_at: string | null;
  calls_30d: number;
  idle_days: number | null;
  parked: { at: string; idle_days: number; tokens: number } | null;
  kept: boolean;
}

interface Suggestion {
  kind: Kind;
  key: string;
  id: string;
  tokens?: number;
  profile?: string;
  tools?: string[];
  with?: string;
  calls?: number;
  with_calls?: number;
  error_rate?: number;
  secrets?: string[];
}

interface Change {
  key: string;
  kind: ProfileKind;
  profile: string;
  mount: string | null;
  selectors: string[];
  tokens: number;
  at: string;
}

interface Report {
  settings: { mode: Mode; idleDays: number; keep: string[]; wake: Wake };
  mounts: Insight[];
  suggestions: Suggestion[];
  changes: Change[];
  summary: {
    days: number;
    parked: number;
    woken: number;
    hidden: number;
    undone: number;
    saved_tokens: number;
  };
  enabled_tokens: number;
  reclaimable_tokens: number;
}

/** A mounted tool name without its `<prefix>__`. */
const short = (tool: string) => tool.slice(tool.indexOf("__") + 2);

function reason(s: Suggestion, m: Insight | undefined, nameOf: (id: string) => string): string {
  switch (s.kind) {
    case "idle":
      return t("mounts.smart.reason.idle", { count: m?.idle_days ?? 0 });
    case "heavy":
      return t("mounts.smart.reason.heavy", {
        tokens: m?.est_tokens ?? 0,
        calls: m?.calls_30d ?? 0,
      });
    case "overlap":
      return t("mounts.smart.reason.overlap", {
        with: s.with?.startsWith("capability:") ? t("mounts.smart.builtin") : nameOf(s.with ?? ""),
        withCalls: s.with_calls ?? 0,
        calls: s.calls ?? 0,
      });
    case "profile_unused":
      return t("mounts.smart.reason.profile_unused", { profile: s.profile ?? "" });
    case "unused_tools":
      return t("mounts.smart.reason.unused_tools", {
        profile: s.profile ?? "",
        count: s.tools?.length ?? 0,
        tools: (s.tools ?? []).map(short).join(", "),
      });
    case "search_mode":
      return t("mounts.smart.reason.search_mode", { profile: s.profile ?? "" });
    case "sign_in":
      return t("mounts.smart.reason.sign_in");
    case "missing_key":
      return t("mounts.smart.reason.missing_key", { secrets: (s.secrets ?? []).join(", ") });
    case "failing_tool":
      return t("mounts.smart.reason.failing_tool", {
        tool: short(s.tools?.[0] ?? ""),
        percent: Math.round((s.error_rate ?? 0) * 100),
        calls: s.calls ?? 0,
      });
    default:
      return t("mounts.smart.reason.failing");
  }
}

function changeLabel(c: Change, nameOf: (id: string) => string): string {
  const mount = c.mount ? nameOf(c.mount) : "";
  if (c.kind === "unused_tools") {
    return t("mounts.smart.change.unused_tools", {
      count: c.selectors.length,
      mount,
      profile: c.profile,
    });
  }
  return t(`mounts.smart.change.${c.kind}`, { mount, profile: c.profile });
}

/** The Smart mount card. `version` reloads it; `onChanged` runs after a mount was parked. */
export function SmartMountsCard({
  version,
  onChanged,
}: { version: number; onChanged: () => void }) {
  const toast = useToast();
  const data = useResource(
    (signal) => api.get<Report>("/api/mounts/smart", undefined, signal),
    [version],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [days, setDays] = useState<string | null>(null);

  const r = data.data;
  if (!r) return null;
  const byId = new Map(r.mounts.map((m) => [m.id, m]));
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const parked = r.mounts.filter((m) => m.parked && !m.enabled);
  const parkable = r.suggestions.filter((s) => PARK.includes(s.kind));
  const s7 = r.summary;
  const anyActivity = s7.parked + s7.woken + s7.hidden + s7.undone > 0 || s7.saved_tokens > 0;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
      await data.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = (patch: Partial<Report["settings"]>) =>
    run("settings", async () => {
      await api.put("/api/mounts/smart", patch);
    });

  const park = (ids?: string[]) =>
    run(ids?.[0] ?? "all", async () => {
      const out = await api.post<{ parked: string[] }>(
        "/api/mounts/smart/park",
        ids ? { ids } : {},
      );
      toast.ok(t("mounts.smart.parked", { count: out.parked.length }));
      onChanged();
    });

  const apply = (key: string) =>
    run(key, async () => {
      const out = await api.post<{ applied: string[] }>("/api/mounts/smart/apply", {
        keys: [key],
      });
      toast.ok(t("mounts.smart.applied", { count: out.applied.length }));
    });

  const undo = (key: string) =>
    run(key, async () => {
      await api.post("/api/mounts/smart/undo", { keys: [key] });
      toast.ok(t("mounts.smart.undone"));
    });

  const saveDays = () => {
    const n = Number(days);
    if (days === null || !Number.isInteger(n) || n < 1 || n > 365) {
      setDays(null);
      return;
    }
    setDays(null);
    if (n !== r.settings.idleDays) void save({ idleDays: n });
  };

  return (
    <Card
      title={t("mounts.smart.title")}
      actions={
        parkable.length > 1 ? (
          <Button size="sm" busy={busy === "all"} onClick={() => park()}>
            {t("mounts.smart.parkAll")}
          </Button>
        ) : null
      }
    >
      <div className="stack">
        <p className="small muted">
          {t("mounts.smart.summary", {
            tokens: r.enabled_tokens,
            reclaimable: r.reclaimable_tokens,
          })}
        </p>
        {anyActivity ? (
          <p className="small">
            {t("mounts.smart.week", {
              days: s7.days,
              parked: s7.parked,
              woken: s7.woken,
              hidden: s7.hidden,
              tokens: s7.saved_tokens,
            })}
            {s7.undone > 0 ? ` ${t("mounts.smart.weekUndone", { count: s7.undone })}` : null}
          </p>
        ) : null}
        <div className="row-gap">
          <Segmented<Mode>
            label={t("mounts.smart.mode.label")}
            value={r.settings.mode}
            onChange={(mode) => void save({ mode })}
            options={[
              { value: "off", label: t("mounts.smart.mode.off") },
              { value: "suggest", label: t("mounts.smart.mode.suggest") },
              { value: "auto", label: t("mounts.smart.mode.auto") },
            ]}
          />
        </div>
        <p className="small muted">{t(`mounts.smart.modeHint.${r.settings.mode}`)}</p>
        <FieldRow label={t("mounts.smart.idleDays")} htmlFor="smart-idle-days">
          <TextInput
            id="smart-idle-days"
            type="number"
            min={1}
            max={365}
            value={days ?? String(r.settings.idleDays)}
            onChange={(e) => setDays(e.target.value)}
            onBlur={saveDays}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveDays();
            }}
            style={{ maxWidth: "8rem" }}
          />
        </FieldRow>
        <div className="row-gap">
          <Segmented<Wake>
            label={t("mounts.smart.wake.label")}
            value={r.settings.wake}
            onChange={(wake) => void save({ wake })}
            options={[
              { value: "auto", label: t("mounts.smart.wake.auto") },
              { value: "ask", label: t("mounts.smart.wake.ask") },
            ]}
          />
        </div>
        <p className="small muted">{t(`mounts.smart.wakeHint.${r.settings.wake}`)}</p>

        {r.settings.mode !== "off" && r.suggestions.length === 0 ? (
          <p className="small">{t("mounts.smart.nothing")}</p>
        ) : null}
        {r.suggestions.length > 0 ? (
          <ul className="mount-list" aria-label={t("mounts.smart.suggestionsAria")}>
            {r.suggestions.map((s) => {
              const m = byId.get(s.id);
              const isPark = PARK.includes(s.kind);
              const isProfile = PROFILE.includes(s.kind);
              const title = s.kind === "search_mode" ? (s.profile ?? s.id) : nameOf(s.id);
              return (
                <li key={s.key} className="mount">
                  <div className="mount-main">
                    <div className="mount-text">
                      <div className="mount-title">
                        <span className="mount-name">{title}</span>
                        <Badge tone={isPark || isProfile ? "warn" : "danger"}>
                          {t(`mounts.smart.kind.${s.kind}`)}
                        </Badge>
                      </div>
                      <p className="small muted">
                        {reason(s, m, nameOf)}
                        {isPark && m?.last_used_at
                          ? ` ${t("mounts.smart.lastUsed", { when: formatRelative(m.last_used_at) })}`
                          : ""}
                        {(isPark || isProfile) && s.tokens
                          ? ` ${t("mounts.smart.saves", { tokens: s.tokens })}`
                          : ""}
                      </p>
                    </div>
                    {s.kind !== "search_mode" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void save({ keep: [...r.settings.keep, s.id] })}
                      >
                        {t("mounts.smart.keep")}
                      </Button>
                    ) : null}
                    {isPark ? (
                      <Button size="sm" busy={busy === s.id} onClick={() => park([s.id])}>
                        {t("mounts.smart.park")}
                      </Button>
                    ) : null}
                    {isProfile ? (
                      <Button size="sm" busy={busy === s.key} onClick={() => apply(s.key)}>
                        {s.kind === "search_mode"
                          ? t("mounts.smart.switchAuto")
                          : t("mounts.smart.hide")}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {r.changes.length > 0 ? (
          <div className="stack">
            <p className="small">
              <strong>{t("mounts.smart.changes")}</strong>
            </p>
            <ul className="mount-list" aria-label={t("mounts.smart.changesAria")}>
              {r.changes.map((c) => (
                <li key={c.key} className="mount">
                  <div className="mount-main">
                    <div className="mount-text">
                      <span className="small">{changeLabel(c, nameOf)}</span>
                      <p className="small muted">
                        {formatRelative(c.at)}
                        {c.tokens ? ` · ${t("mounts.smart.saves", { tokens: c.tokens })}` : ""}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      busy={busy === c.key}
                      onClick={() => undo(c.key)}
                    >
                      {t("mounts.smart.undo")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {parked.length > 0 ? (
          <p className="small muted">
            {t("mounts.smart.parkedList", { names: parked.map((m) => m.name).join(", ") })}
          </p>
        ) : null}
        {r.settings.keep.length > 0 ? (
          <p className="small muted">
            {t("mounts.smart.keptList", {
              names: r.settings.keep.map(nameOf).join(", "),
            })}{" "}
            <button type="button" className="link-btn" onClick={() => void save({ keep: [] })}>
              {t("mounts.smart.clearKeep")}
            </button>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
