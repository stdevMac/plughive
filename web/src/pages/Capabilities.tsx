// Preferred services: which service does each job ("make an image",
// "transcribe audio"), grouped by goal, with what runs now and what to set up.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  Loading,
  PageHeader,
  SearchInput,
  Segmented,
} from "../components/ui";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import { useApp } from "../lib/app-context";
import {
  type ProviderCost,
  costOf,
  freeFirstOrders,
  isCooling,
  orderedProviders,
  shortHint,
  wouldUse,
} from "../lib/capabilities";
import { capabilityLabel } from "../lib/capabilities";
import { displayName, formatRelative, providerDisplayName } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import { Link, useRouter } from "../lib/router";
import type { Capability, CapabilityProvider } from "../lib/types";

const groupDefs = (): Array<{ id: string; title: string; icon: IconName; caps: string[] }> => [
  {
    id: "images",
    title: t("capabilities.groups.images"),
    icon: "image",
    caps: [
      "image.generate",
      "image.edit",
      "image.upscale",
      "image.remove_background",
      "3d.generate",
    ],
  },
  {
    id: "video",
    title: t("capabilities.groups.video"),
    icon: "video",
    caps: ["video.generate", "video.upscale", "video.lipsync", "media.transcript"],
  },
  {
    id: "audio",
    title: t("capabilities.groups.audio"),
    icon: "audio",
    caps: [
      "speech.generate",
      "music.generate",
      "audio.transcribe",
      "audio.separate_stems",
      "voice.clone",
      "sound.effect",
    ],
  },
  {
    id: "text",
    title: t("capabilities.groups.text"),
    icon: "sparkle",
    caps: ["chat", "text.translate", "text.embed", "text.rerank"],
  },
  {
    id: "documents",
    title: t("capabilities.groups.documents"),
    icon: "file",
    caps: ["document.parse", "document.convert"],
  },
  {
    id: "web",
    title: t("capabilities.groups.web"),
    icon: "search",
    caps: ["web.search", "web.fetch"],
  },
];

type Filter = "all" | "setup" | "paid" | "free";
type Cost = ProviderCost;

const costLabel = (cost: Cost): string =>
  cost === "local"
    ? t("capabilities.cost.local")
    : cost === "account"
      ? t("capabilities.cost.account")
      : t("capabilities.cost.paid");

const nameOf = (p: CapabilityProvider) => providerDisplayName(p.pack, p.id);
const metaOf = capabilityLabel;

/** Why a provider would not run now, in plain words, or null when it would. */
function skipReason(p: CapabilityProvider): string | null {
  if (!p.configured) {
    if (costOf(p) === "local") return t("capabilities.skip.notInstalled");
    if (costOf(p) === "account") return t("capabilities.skip.notSetup");
    return t("capabilities.skip.needsKey");
  }
  if (isCooling(p))
    return t("capabilities.skip.rateLimited", { when: formatRelative(p.coolingDownUntil) });
  if (p.autoRoute === false) return t("capabilities.skip.namedOnly");
  return null;
}

function setupLink(p: CapabilityProvider): { to: string; label: string } {
  if (p.pack === "local") return { to: "/software", label: t("capabilities.setup.install") };
  return {
    to: `/packs?pack=${encodeURIComponent(p.pack)}`,
    label: costOf(p) === "paid" ? t("capabilities.setup.addKey") : t("capabilities.setup.setUp"),
  };
}

function CostBadge({ cost }: { cost: Cost }) {
  return cost === "paid" ? (
    <Badge>{t("capabilities.badge.paid")}</Badge>
  ) : cost === "account" ? (
    <Badge tone="accent">{t("capabilities.badge.account")}</Badge>
  ) : (
    <Badge tone="ok">{t("capabilities.badge.free")}</Badge>
  );
}

function CapabilityRow({
  cap,
  open,
  onToggle,
  onSave,
}: {
  cap: Capability;
  open: boolean;
  onToggle: () => void;
  onSave: (cap: Capability, order: string[], said: string) => Promise<void>;
}) {
  const meta = metaOf(cap.name);
  const ordered = orderedProviders(cap);
  const [order, setOrder] = useState<string[]>(ordered.map((p) => p.id));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const moveRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const pendingFocus = useRef<string | null>(null);
  const byId = new Map(cap.providers.map((p) => [p.id, p]));
  const using = wouldUse(cap);
  const panelId = `cap-panel-${cap.name.replace(/[^a-z0-9]/gi, "-")}`;
  const key = ordered.map((p) => p.id).join(",");

  useEffect(() => {
    setOrder(key ? key.split(",") : []);
  }, [key]);

  useEffect(() => {
    const k = pendingFocus.current;
    if (!k) return;
    pendingFocus.current = null;
    const [id, dir] = k.split(":");
    const want = moveRefs.current.get(`${id}:${dir}`);
    const other = moveRefs.current.get(`${id}:${dir === "up" ? "down" : "up"}`);
    (want && !want.disabled ? want : other)?.focus();
  });

  const move = async (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= order.length || busy) return;
    const next = [...order];
    [next[i], next[j]] = [next[j] as string, next[i] as string];
    const moved = byId.get(next[j] as string);
    const label = moved ? nameOf(moved) : (next[j] as string);
    pendingFocus.current = `${next[j]}:${by < 0 ? "up" : "down"}`;
    setOrder(next);
    const text = t("capabilities.row.moved", {
      label,
      position: j + 1,
      total: next.length,
      capability: meta.title.toLowerCase(),
    });
    setSaid(text);
    setBusy(true);
    try {
      await onSave(cap, next, text);
    } catch {
      setOrder(order);
    } finally {
      setBusy(false);
    }
  };

  const single = cap.providers.length === 1;
  const none = cap.providers.length === 0;
  const firstMissing = !using ? ordered.find((p) => !p.configured) : undefined;
  const freeOption = firstMissing ? ordered.find((p) => costOf(p) === "local") : undefined;

  return (
    <li className={`cap-item${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="cap-summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className="cap-what">
          <span className="cap-title">{meta.title}</span>
          <span className="cap-blurb small muted">{meta.blurb}</span>
        </span>
        <span className="cap-uses">
          {using ? (
            <>
              <span className="cap-uses-name">
                <span className="visually-hidden">{t("capabilities.row.uses")}</span>
                {nameOf(using)}
              </span>
              <CostBadge cost={costOf(using)} />
            </>
          ) : none ? (
            <Badge>{t("capabilities.row.noService")}</Badge>
          ) : (
            <Badge tone="warn" dot>
              {t("capabilities.row.nothingSetUp")}
            </Badge>
          )}
        </span>
        <Icon name={open ? "chevronUp" : "chevronDown"} />
      </button>
      {open ? (
        <div className="cap-panel" id={panelId}>
          <p className="visually-hidden" aria-live="polite">
            {said}
          </p>
          {none ? (
            <EmptyState icon="route" title={t("capabilities.panel.emptyTitle")}>
              {t("capabilities.panel.emptyBefore", { capability: meta.title.toLowerCase() })}
              <Link to="/packs">{t("capabilities.panel.emptyLink")}</Link>
              {t("capabilities.panel.emptyAfter")}
            </EmptyState>
          ) : (
            <>
              {!using && firstMissing ? (
                <p className="cap-hint small">
                  <Icon name="info" />
                  <span>
                    {t("capabilities.panel.hintSetup", { capability: meta.title.toLowerCase() })}
                    {freeOption
                      ? t("capabilities.panel.hintFree", { provider: nameOf(freeOption) })
                      : ""}
                  </span>
                </p>
              ) : !single ? (
                <p className="small muted cap-hint">{t("capabilities.panel.fallbackOrder")}</p>
              ) : null}
              <ol
                className={`cap-list${single ? " is-single" : ""}`}
                aria-label={t("capabilities.row.listLabel", {
                  capability: meta.title.toLowerCase(),
                })}
              >
                {order.map((id, i) => {
                  const p = byId.get(id);
                  if (!p) return null;
                  const reason = skipReason(p);
                  const isUsed = using?.id === p.id;
                  const link = !p.configured ? setupLink(p) : null;
                  return (
                    <li
                      key={id}
                      className={`cap-row${isUsed ? " is-used" : ""}${reason ? " is-skipped" : ""}`}
                    >
                      {single ? null : (
                        <span className="cap-rank" aria-hidden="true">
                          {i + 1}
                        </span>
                      )}
                      <span className="cap-main">
                        <span className="cap-name">
                          {nameOf(p)}
                          {isUsed ? (
                            <span className="cap-now small">{t("capabilities.row.usedNow")}</span>
                          ) : null}
                        </span>
                        <span className="small muted">
                          {costLabel(costOf(p))}
                          {reason ? ` · ${reason}` : ""}
                        </span>
                        {!p.configured && costOf(p) !== "paid" && shortHint(p.setupHint) ? (
                          <span className="cap-how small muted" title={p.setupHint ?? undefined}>
                            {shortHint(p.setupHint)}
                          </span>
                        ) : null}
                      </span>
                      <span className="cap-badges">
                        {link ? (
                          <Link to={link.to} className="btn btn-sm btn-secondary cap-setup">
                            {link.label}
                          </Link>
                        ) : (
                          <CostBadge cost={costOf(p)} />
                        )}
                      </span>
                      {single ? null : (
                        <span className="cap-move">
                          <IconButton
                            ref={(el) => {
                              moveRefs.current.set(`${id}:up`, el);
                            }}
                            icon="arrowUp"
                            label={t("capabilities.row.moveUp", {
                              provider: nameOf(p),
                              capability: meta.title.toLowerCase(),
                            })}
                            variant="ghost"
                            disabled={i === 0}
                            onClick={() => move(i, -1)}
                          />
                          <IconButton
                            ref={(el) => {
                              moveRefs.current.set(`${id}:down`, el);
                            }}
                            icon="arrowDown"
                            label={t("capabilities.row.moveDown", {
                              provider: nameOf(p),
                              capability: meta.title.toLowerCase(),
                            })}
                            variant="ghost"
                            disabled={i === order.length - 1}
                            onClick={() => move(i, 1)}
                          />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
              {!single && cap.preference.length > 0 ? (
                <div className="cap-foot">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await onSave(
                          cap,
                          [],
                          t("capabilities.panel.resetSaid", { capability: meta.title }),
                        );
                      } catch {
                        // the toast says why
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t("capabilities.panel.resetOrder")}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function matches(cap: Capability, q: string): boolean {
  if (!q) return true;
  const meta = metaOf(cap.name);
  const hay = [meta.title, meta.blurb, cap.name, ...cap.providers.map((p) => nameOf(p))]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function passes(cap: Capability, f: Filter): boolean {
  const using = wouldUse(cap);
  if (f === "setup") return !using;
  if (f === "paid") return !!using && costOf(using) === "paid";
  if (f === "free") return !!using && costOf(using) !== "paid";
  return true;
}

export function CapabilitiesPage() {
  useDocumentTitle(t("capabilities.page.title"));
  const { catalogVersion } = useApp();
  const toast = useToast();
  const { query } = useRouter();
  const data = useResource(
    (signal) => api.get<{ capabilities: Capability[] }>("/api/capabilities", undefined, signal),
    [catalogVersion],
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => {
    const c = query.get("cap");
    return new Set(c ? [c] : []);
  });
  const [busy, setBusy] = useState(false);
  const caps = data.data?.capabilities ?? [];

  const stats = useMemo(() => {
    let ready = 0;
    let free = 0;
    for (const c of caps) {
      const u = wouldUse(c);
      if (u) ready++;
      if (u && costOf(u) !== "paid") free++;
    }
    return { ready, free, missing: caps.length - ready, total: caps.length };
  }, [caps]);

  const replaceAll = (list: Capability[]) => data.mutate(() => ({ capabilities: list }));
  const replaceOne = (nc: Capability) =>
    data.mutate((d) =>
      d ? { capabilities: d.capabilities.map((x) => (x.name === nc.name ? nc : x)) } : d,
    );

  const saveBulk = async (orders: Record<string, string[]>) => {
    const r = await api.put<{ capabilities: Capability[] }>("/api/capabilities/preference", {
      orders,
    });
    replaceAll(r.capabilities);
  };

  const saveOne = async (cap: Capability, next: string[], said: string) => {
    const before = [...cap.preference];
    try {
      const r = await api.put<{ capability: Capability }>(
        `/api/capabilities/${encodeURIComponent(cap.name)}/preference`,
        { order: next },
      );
      replaceOne(r.capability);
      toast.undo(said, () => {
        api
          .put<{ capability: Capability }>(
            `/api/capabilities/${encodeURIComponent(cap.name)}/preference`,
            { order: before },
          )
          .then((u) => {
            replaceOne(u.capability);
            toast.ok(t("capabilities.page.backToOrder", { capability: metaOf(cap.name).title }));
          })
          .catch((e) => toast.error(errorMessage(e)));
      });
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };

  const applyPreset = async (kind: "free" | "default") => {
    const orders: Record<string, string[]> =
      kind === "free"
        ? freeFirstOrders(caps)
        : Object.fromEntries(caps.filter((c) => c.preference.length).map((c) => [c.name, []]));
    if (Object.keys(orders).length === 0) {
      toast.ok(
        kind === "free"
          ? t("capabilities.preset.freeAlready")
          : t("capabilities.preset.defaultAlready"),
      );
      return;
    }
    const before = Object.fromEntries(
      Object.keys(orders).map((n) => [n, caps.find((c) => c.name === n)?.preference ?? []]),
    );
    setBusy(true);
    try {
      await saveBulk(orders);
      const n = Object.keys(orders).length;
      toast.undo(
        kind === "free"
          ? t("capabilities.preset.freeApplied", { count: n })
          : t("capabilities.preset.defaultApplied", { count: n }),
        () => {
          saveBulk(before)
            .then(() => toast.ok(t("capabilities.page.earlierOrderBack")))
            .catch((e) => toast.error(errorMessage(e)));
        },
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (name: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });

  const visible = (name: string) => {
    const c = caps.find((x) => x.name === name);
    return !!c && passes(c, filter) && matches(c, q.trim());
  };
  const allGroups = groupDefs();
  const grouped = new Set(allGroups.flatMap((g) => g.caps));
  const groups = [
    ...allGroups,
    // A capability the dashboard does not know yet still shows up.
    ...(caps.some((c) => !grouped.has(c.name))
      ? [
          {
            id: "other",
            title: t("capabilities.groups.other"),
            icon: "layers" as IconName,
            caps: caps.filter((c) => !grouped.has(c.name)).map((c) => c.name),
          },
        ]
      : []),
  ]
    .map((g) => ({ ...g, shown: g.caps.filter(visible) }))
    .filter((g) => g.shown.length > 0);

  return (
    <>
      <PageHeader
        title={t("capabilities.page.title")}
        description={t("capabilities.page.description")}
        actions={
          caps.length ? (
            <div className="row-gap">
              <Button variant="secondary" busy={busy} onClick={() => applyPreset("free")}>
                {t("capabilities.page.freeFirst")}
              </Button>
              {caps.some((c) => c.preference.length) ? (
                <Button variant="ghost" disabled={busy} onClick={() => applyPreset("default")}>
                  {t("capabilities.page.resetAll")}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      />
      {data.loading && !data.data ? (
        <Loading lines={6} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : (
        <>
          <div className="cap-stats">
            <button
              type="button"
              className="cap-stat"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              <span className="cap-stat-n">
                {stats.ready}
                <span className="muted">
                  {t("capabilities.page.ofTotal", { total: stats.total })}
                </span>
              </span>
              <span className="small muted">{t("capabilities.page.jobsReady")}</span>
            </button>
            <button
              type="button"
              className="cap-stat"
              aria-pressed={filter === "free"}
              onClick={() => setFilter("free")}
            >
              <span className="cap-stat-n">{stats.free}</span>
              <span className="small muted">{t("capabilities.page.runFree")}</span>
            </button>
            <button
              type="button"
              className={`cap-stat${stats.missing ? " is-warn" : ""}`}
              aria-pressed={filter === "setup"}
              onClick={() => setFilter("setup")}
            >
              <span className="cap-stat-n">{stats.missing}</span>
              <span className="small muted">{t("capabilities.page.needSetup")}</span>
            </button>
          </div>
          <div className="cap-tools">
            <Segmented<Filter>
              label={t("capabilities.page.show")}
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("capabilities.page.filterAll") },
                { value: "setup", label: t("capabilities.page.filterSetup") },
                { value: "paid", label: t("capabilities.page.filterPaid") },
                { value: "free", label: t("capabilities.page.filterFree") },
              ]}
            />
            <SearchInput
              value={q}
              onChange={setQ}
              label={t("capabilities.page.searchLabel")}
              placeholder={t("capabilities.page.searchPlaceholder")}
            />
          </div>
          {groups.length === 0 ? (
            <EmptyState icon="search" title={t("capabilities.page.noMatchTitle")}>
              <Button
                variant="ghost"
                onClick={() => {
                  setFilter("all");
                  setQ("");
                }}
              >
                {t("capabilities.page.showEverything")}
              </Button>
            </EmptyState>
          ) : (
            <div className="cap-groups">
              {groups.map((g) => (
                <Card
                  key={g.id}
                  className="cap-group"
                  title={
                    <span className="cap-group-title">
                      <Icon name={g.icon} /> {g.title}
                    </span>
                  }
                >
                  <ul className="cap-items">
                    {g.shown.map((name) => {
                      const c = caps.find((x) => x.name === name) as Capability;
                      return (
                        <CapabilityRow
                          key={name}
                          cap={c}
                          open={open.has(name)}
                          onToggle={() => toggle(name)}
                          onSave={saveOne}
                        />
                      );
                    })}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
