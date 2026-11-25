// The exposure composer: which tools each endpoint (profile) shows, and how.
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConnectAgent } from "../components/ConnectAgent";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { JsonView } from "../components/ResultView";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  CopyField,
  EmptyState,
  ErrorState,
  FieldRow,
  InlineAlert,
  Loading,
  PageHeader,
  SearchInput,
  Segmented,
  Tabs,
  TextInput,
  TriCheckbox,
} from "../components/ui";
import { t } from "../i18n";
import { ApiError, api, errorMessage } from "../lib/api";
import { endpointFor, useApp } from "../lib/app-context";
import {
  type Section,
  type ToolGroup,
  buildGroups,
  contextShare,
  diffProfiles,
  enabledTools,
  groupState,
  normalizeSelection,
  parseThreshold,
  selectionChanges,
  toggleGroup,
  toggleTool,
  tokenScale,
  toolMatchesQuery,
} from "../lib/composer";
import { displayName, formatNumber } from "../lib/format";
import { useDebounced, useDocumentTitle, useResource } from "../lib/hooks";
import { useBlocker, useRouter } from "../lib/router";
import type { Profile, ProfilePreview, ToolInfo } from "../lib/types";

function sectionLabel(section: Section): string {
  switch (section) {
    case "core":
      return t("exposure.section.core");
    case "packs":
      return t("exposure.section.packs");
    case "workflows":
      return t("exposure.section.workflows");
    case "mounts":
      return t("exposure.section.mounts");
  }
}

function modeHelp(mode: Profile["mode"]): string {
  switch (mode) {
    case "list":
      return t("exposure.mode.help.list");
    case "search":
      return t("exposure.mode.help.search");
    case "auto":
      return t("exposure.mode.help.auto");
  }
}

function modeWord(mode: ProfilePreview["mode"]): string {
  return mode === "search" ? t("exposure.mode.word.search") : t("exposure.mode.word.list");
}

const MAX_PINS = 64;
/** Open every group on arrival when the catalogue is this small. */
const OPEN_ALL_UNDER = 40;

function slugify(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!/^[a-z]/.test(s)) s = `p-${s}`.slice(0, 32);
  return s.length < 2 ? `${s}x` : s;
}

interface Draft {
  profile: Profile;
  enabled: Set<string>;
  /** The selection was edited, so include/exclude are recomputed on save. */
  selectionEdited: boolean;
}

function draftFor(p: Profile, tools: ToolInfo[]): Draft {
  return { profile: { ...p }, enabled: enabledTools(p, tools), selectionEdited: false };
}

function draftProfile(d: Draft, tools: ToolInfo[], groups: ToolGroup[], saved: Profile): Profile {
  if (!d.selectionEdited) return d.profile;
  return { ...d.profile, ...normalizeSelection(d.enabled, tools, groups, saved) };
}

/** Something waiting on "Discard unsaved changes?". */
type Pending = { kind: "switch"; id: string } | { kind: "leave"; proceed: () => void };

// ---- Tree ----------------------------------------------------------------------

function ToolTree({
  groups,
  tools,
  enabled,
  pinned,
  showPins,
  query,
  onToggleGroup,
  onToggleTool,
  onTogglePin,
}: {
  groups: ToolGroup[];
  tools: Map<string, ToolInfo>;
  enabled: Set<string>;
  pinned: Set<string>;
  showPins: boolean;
  query: string;
  onToggleGroup: (g: ToolGroup) => void;
  onToggleTool: (name: string) => void;
  onTogglePin: (name: string) => void;
}) {
  // The first group starts open so a tool toggle is visible on arrival; a
  // small catalogue starts fully open.
  const [open, setOpen] = useState<Set<string>>(() =>
    tools.size < OPEN_ALL_UNDER
      ? new Set(groups.map((g) => g.id))
      : new Set(groups[0] ? [groups[0].id] : []),
  );
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const searching = query.trim().length > 0;

  const visible = useMemo(
    () =>
      groups
        .map((g) => ({
          g,
          tools: g.tools.filter((t) => {
            const info = tools.get(t);
            return info ? toolMatchesQuery(info, g.label, query) : false;
          }),
        }))
        .filter((x) => x.tools.length > 0),
    [groups, tools, query],
  );

  const isOpen = (id: string) => searching || open.has(id);
  const rows: string[] = [];
  for (const { g, tools: ts } of visible) {
    rows.push(`g:${g.id}`);
    if (isOpen(g.id)) for (const t of ts) rows.push(`t:${t}`);
  }
  const current = focusKey && rows.includes(focusKey) ? focusKey : (rows[0] ?? null);

  const focusRow = (key: string) => {
    setFocusKey(key);
    requestAnimationFrame(() =>
      treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus(),
    );
  };

  const flip = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const onKey = (e: KeyboardEvent<HTMLElement>, key: string, group: ToolGroup) => {
    const i = rows.indexOf(key);
    const isGroup = key.startsWith("g:");
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (i < rows.length - 1) focusRow(rows[i + 1] as string);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (i > 0) focusRow(rows[i - 1] as string);
        break;
      case "Home":
        e.preventDefault();
        if (rows[0]) focusRow(rows[0]);
        break;
      case "End":
        e.preventDefault();
        if (rows.length) focusRow(rows[rows.length - 1] as string);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (isGroup && !isOpen(group.id)) setOpen((s) => new Set(s).add(group.id));
        else if (isGroup && rows[i + 1]?.startsWith("t:")) focusRow(rows[i + 1] as string);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isGroup && open.has(group.id)) flip(group.id);
        else if (!isGroup) focusRow(`g:${group.id}`);
        break;
      case " ":
        e.preventDefault();
        if (isGroup) onToggleGroup(group);
        else onToggleTool(key.slice(2));
        break;
      case "Enter":
        e.preventDefault();
        if (isGroup) flip(group.id);
        else onToggleTool(key.slice(2));
        break;
      case "p":
      case "P":
        if (!isGroup && showPins) {
          e.preventDefault();
          onTogglePin(key.slice(2));
        }
        break;
    }
  };

  if (visible.length === 0) {
    return (
      <EmptyState
        icon="search"
        title={searching ? t("exposure.empty.noToolsMatch") : t("exposure.empty.noToolsLoaded")}
      >
        {searching ? t("exposure.empty.searchHint") : t("exposure.empty.packsHint")}
      </EmptyState>
    );
  }

  let lastSection: Section | null = null;
  return (
    <ul className="tree" role="tree" aria-label={t("exposure.tree.label")} ref={treeRef}>
      {visible.map(({ g, tools: ts }) => {
        const state = groupState(g, enabled);
        const header = g.section !== lastSection ? sectionLabel(g.section) : null;
        lastSection = g.section;
        const gkey = `g:${g.id}`;
        const expanded = isOpen(g.id);
        const on = g.tools.filter((t) => enabled.has(t)).length;
        return (
          // biome-ignore lint/a11y/useValidAriaRole: presentational wrapper inside the ARIA tree
          <li key={g.id} role="none" className="tree-group-wrap">
            {header ? (
              <div className="tree-section" aria-hidden="true">
                <span>{header}</span>
                {showPins ? (
                  <span className="tree-section-pin">{t("exposure.tree.alwaysListed")}</span>
                ) : null}
              </div>
            ) : null}
            <div
              role="treeitem"
              aria-expanded={expanded}
              aria-checked={state === "on" ? true : state === "off" ? false : "mixed"}
              aria-level={1}
              aria-label={t("exposure.tree.groupAria", {
                label: g.label,
                on,
                total: g.tools.length,
              })}
              data-key={gkey}
              tabIndex={current === gkey ? 0 : -1}
              className="tree-row tree-group"
              onFocus={() => setFocusKey(gkey)}
              onKeyDown={(e) => onKey(e, gkey, g)}
              onClick={() => flip(g.id)}
            >
              <Icon name={expanded ? "chevronDown" : "chevronRight"} className="tree-chevron" />
              <TriCheckbox
                decorative
                state={state}
                onToggle={() => onToggleGroup(g)}
                label={
                  state === "on"
                    ? t("exposure.tree.turnOffAll", { label: g.label })
                    : t("exposure.tree.turnOnAll", { label: g.label })
                }
              />
              <span className="tree-label">{g.label}</span>
              <span className="tree-count">
                {on}/{g.tools.length}
              </span>
            </div>
            {expanded ? (
              // biome-ignore lint/a11y/useSemanticElements: ARIA tree subgroup
              <ul role="group" className="tree-children">
                {ts.map((name) => {
                  const info = tools.get(name);
                  const key = `t:${name}`;
                  const isOn = enabled.has(name);
                  const isPinned = pinned.has(name);
                  return (
                    // biome-ignore lint/a11y/useValidAriaProps: a checkable tree: treeitem takes aria-checked (ARIA 1.2)
                    <li
                      key={name}
                      role="treeitem"
                      aria-checked={isOn}
                      aria-level={2}
                      aria-label={
                        showPins && isPinned
                          ? t("exposure.tree.toolAriaPinned", { name })
                          : t("exposure.tree.toolAria", { name })
                      }
                      aria-description={info?.description || undefined}
                      data-key={key}
                      tabIndex={current === key ? 0 : -1}
                      className={`tree-row tree-tool ${isOn ? "" : "tree-off"}`}
                      onFocus={() => setFocusKey(key)}
                      onKeyDown={(e) => onKey(e, key, g)}
                      onClick={() => onToggleTool(name)}
                    >
                      <TriCheckbox
                        decorative
                        state={isOn ? "on" : "off"}
                        onToggle={() => onToggleTool(name)}
                        label={
                          isOn
                            ? t("exposure.tree.turnOff", { name })
                            : t("exposure.tree.turnOn", { name })
                        }
                      />
                      <span className="tree-text">
                        <span className="tree-name mono">{name}</span>
                        {info?.description ? (
                          <span className="tree-desc" title={info.description}>
                            {info.description}
                          </span>
                        ) : null}
                      </span>
                      {showPins ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          className={`pin ${isPinned ? "pin-on" : ""}`}
                          aria-pressed={isPinned}
                          aria-label={
                            isPinned
                              ? t("exposure.tree.pinOff", { name })
                              : t("exposure.tree.pinOn", { name })
                          }
                          title={
                            isPinned
                              ? t("exposure.tree.pinTitleOff")
                              : t("exposure.tree.pinTitleOn")
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            onTogglePin(name);
                          }}
                        >
                          <Icon name="pin" size={14} />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---- Preview -------------------------------------------------------------------

interface PreviewFacts {
  total: number;
  direct: number;
  listed: number;
  mode: ProfilePreview["mode"];
}

function previewFacts(p: ProfilePreview): PreviewFacts {
  return {
    total: p.cost.totalTokens,
    direct: p.direct_tokens,
    listed: p.tools.length,
    mode: p.mode,
  };
}

/** "7 tools · 883 tokens · listed" — the one-line summary shown above the tree on narrow screens. */
function summaryLine(f: PreviewFacts): string {
  return `${t("exposure.summary.tools", { count: f.listed })} · ${t("exposure.summary.tokens", { count: f.total })} · ${f.mode === "search" ? t("exposure.summary.foundBySearch") : t("exposure.summary.listed")}`;
}

function TokenBar({
  total,
  direct,
  threshold,
  showDirect,
}: { total: number; direct: number; threshold: number; showDirect: boolean }) {
  const s = tokenScale(total, direct, threshold);
  const directAt = showDirect ? s.directPercent : null;
  const label =
    t("exposure.tokenBar.label", { total, threshold }) +
    (directAt !== null ? t("exposure.tokenBar.labelDirect", { direct }) : "");
  return (
    <div className="token-meter">
      <div className={`token-bar ${s.over ? "token-bar-over" : ""}`} role="img" aria-label={label}>
        <span className="token-fill" style={{ width: `${s.fillPercent}%` }} />
        <span className="token-tick" style={{ left: `${s.tickPercent}%` }} aria-hidden="true" />
        {directAt !== null ? (
          <span className="token-direct" style={{ left: `${directAt}%` }} aria-hidden="true" />
        ) : null}
      </div>
      <div className="token-scale" aria-hidden="true">
        <span>0</span>
        <span>{s.offScale ? `${formatNumber(s.max)}+` : formatNumber(s.max)}</span>
      </div>
      <div className="token-tick-row" aria-hidden="true">
        <span className="token-tick-label" style={{ left: `${s.tickPercent}%` }}>
          {t("exposure.tokenBar.tick", { threshold })}
        </span>
      </div>
      {directAt !== null ? (
        <p className="token-legend small muted" aria-hidden="true">
          <span className="token-direct-key" /> {t("exposure.tokenBar.legend", { direct })}
        </p>
      ) : null}
    </div>
  );
}

function PreviewPanel({
  preview,
  error,
  loading,
  draft,
  chosen,
}: {
  preview: ProfilePreview | null;
  error: unknown;
  loading: boolean;
  draft: Profile;
  chosen: ReadonlySet<string>;
}) {
  if (error && !preview)
    return <ErrorState error={error} title={t("exposure.preview.errorTitle")} />;
  if (!preview) return <Loading lines={5} label={t("exposure.preview.loading")} />;
  const f = previewFacts(preview);
  const share = contextShare(f.total);
  const per = new Map(preview.cost.perTool.map((x) => [x.name, x.tokens]));
  const listedNames = preview.tools.map((t) => t.name);
  const extra = listedNames.filter((n) => !chosen.has(n));
  const pinnedListed = listedNames.filter((n) => draft.pinned.includes(n)).length;
  const threshold = draft.autoThresholdTokens > 0 ? draft.autoThresholdTokens : 8000;
  const saving = f.direct - f.total;

  let explain: string;
  if (f.mode === "search") {
    const pinnedPart = pinnedListed
      ? t("exposure.preview.pinnedPart", { count: pinnedListed })
      : "";
    explain = `${t("exposure.preview.searchList", { count: f.listed, pinned: pinnedPart })} ${t("exposure.preview.canFindAll", { count: preview.exposed_tools })}`;
    if (saving > 0) explain += t("exposure.preview.savesTokens", { count: saving });
  } else if (extra.length > 0) {
    explain = t("exposure.preview.extraListed", {
      chosen: f.listed - extra.length,
      extra: extra.length,
      names: extra.join(", "),
    });
  } else {
    explain = t("exposure.preview.chosenList", { count: f.listed });
  }
  if (draft.mode === "auto" && f.mode === "list") {
    explain += t("exposure.preview.autoNote", {
      tokens: draft.autoThresholdTokens,
      tools: draft.autoThresholdTools,
    });
  }

  return (
    <div className={`preview ${loading ? "preview-stale" : ""}`} aria-busy={loading || undefined}>
      <div className="preview-stats">
        <div className="stat">
          <span className="stat-value">{formatNumber(f.listed)}</span>
          <span className="stat-label">{t("exposure.preview.tools")}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatNumber(f.total)}</span>
          <span className="stat-label">{t("exposure.preview.tokens")}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{modeWord(f.mode)}</span>
          <span className="stat-label">{t("exposure.preview.mode")}</span>
        </div>
      </div>
      <p className="small">{t("exposure.preview.contextShare", { share: share.label })}</p>
      <TokenBar
        total={f.total}
        direct={f.direct}
        threshold={threshold}
        showDirect={f.mode === "search"}
      />
      <p className="small muted">{explain}</p>
      <ul className="preview-list" aria-label={t("exposure.preview.listAria")}>
        {preview.tools.map((tool) => (
          <li key={tool.name}>
            <details className="preview-tool">
              <summary>
                <Icon name="chevronRight" className="details-chevron" />
                <span className="mono">{tool.name}</span>
                <span className="preview-tokens">
                  {t("exposure.preview.toolTokens", { count: per.get(tool.name) ?? 0 })}
                </span>
              </summary>
              {tool.description ? <p className="small">{tool.description}</p> : null}
              <JsonView
                value={tool.inputSchema}
                label={t("exposure.preview.inputSchema", { name: tool.name })}
              />
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Thresholds ------------------------------------------------------------------

function ThresholdField({
  id,
  value,
  onCommit,
  label,
}: {
  id: string;
  value: number;
  onCommit: (v: number) => void;
  label: string;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  // Follow the profile when it changes from outside (discard, another profile).
  useEffect(() => {
    setText(String(value));
    setError(null);
  }, [value]);
  return (
    <span className="threshold-field">
      <TextInput
        id={id}
        inputMode="numeric"
        className="input-sm threshold-input"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const r = parseThreshold(e.target.value);
          if ("value" in r) {
            setError(null);
            if (r.value !== value) onCommit(r.value);
          }
        }}
        onBlur={() => {
          const r = parseThreshold(text);
          if ("error" in r) setError(r.error);
          else setText(String(r.value));
        }}
      />
      {error ? (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

// ---- Page ----------------------------------------------------------------------

export function ExposurePage() {
  useDocumentTitle(t("exposure.page.title"));
  const toast = useToast();
  const { info, catalogVersion } = useApp();
  const { query, setQuery } = useRouter();
  const data = useResource(
    async (signal) => {
      const [p, t] = await Promise.all([
        api.get<{ profiles: Profile[] }>("/api/profiles", undefined, signal),
        api.get<{ tools: ToolInfo[] }>("/api/tools", undefined, signal),
      ]);
      return { profiles: p.profiles, tools: t.tools };
    },
    [catalogVersion],
  );

  const profiles = data.data?.profiles ?? [];
  const tools = data.data?.tools ?? [];
  const selectedId = query.get("profile") ?? "default";
  const saved =
    profiles.find((p) => p.id === selectedId) ??
    profiles.find((p) => p.id === "default") ??
    profiles[0];

  const groups = useMemo(
    () => buildGroups(tools, (kind, id) => (kind === "pack" ? displayName(id) : id)),
    [tools],
  );
  const toolMap = useMemo(() => new Map(tools.map((t) => [t.name, t])), [tools]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A fresh draft whenever the saved profile (or the catalog) changes.
  const savedKey = saved ? JSON.stringify(saved) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey stands for saved
  useEffect(() => {
    if (saved) setDraft(draftFor(saved, tools));
    setSaveError(null);
  }, [savedKey, tools]);

  const current =
    draft && saved && draft.profile.id === saved.id ? draft : saved ? draftFor(saved, tools) : null;
  const candidate = current && saved ? draftProfile(current, tools, groups, saved) : null;
  const changed = candidate && saved ? diffProfiles(saved, candidate) : [];
  const savedEnabled = useMemo(
    () => (saved ? enabledTools(saved, tools) : new Set<string>()),
    [saved, tools],
  );
  const sel = current
    ? selectionChanges(savedEnabled, current.enabled)
    : { added: [], removed: [] };
  const dirty = changed.length > 0;

  // Live preview of the draft, debounced.
  const previewBody = candidate
    ? JSON.stringify({
        name: candidate.name,
        mode: candidate.mode,
        include: candidate.include,
        exclude: candidate.exclude,
        pinned: candidate.pinned,
        autoThresholdTokens: candidate.autoThresholdTokens,
        autoThresholdTools: candidate.autoThresholdTools,
      })
    : "";
  const debouncedBody = useDebounced(previewBody, 250);
  const preview = useResource(async () => {
    if (!debouncedBody) return null;
    return api.post<ProfilePreview>("/api/profiles/preview", JSON.parse(debouncedBody));
  }, [debouncedBody]);
  const [lastPreview, setLastPreview] = useState<ProfilePreview | null>(null);
  useEffect(() => {
    if (preview.data) setLastPreview(preview.data);
  }, [preview.data]);

  // Warn before closing or reloading the tab with unsaved changes...
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  // ...and before leaving the page inside the app (sidebar, links, back button).
  useBlocker(dirty, (proceed) => setPending({ kind: "leave", proceed }));

  const update = useCallback((fn: (d: Draft) => Draft) => setDraft((d) => (d ? fn(d) : d)), []);

  const save = async () => {
    if (!candidate || !saved) return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api.put<{ profile: Profile }>(
        `/api/profiles/${encodeURIComponent(saved.id)}`,
        candidate,
      );
      data.mutate((d) =>
        d ? { ...d, profiles: d.profiles.map((p) => (p.id === saved.id ? r.profile : p)) } : d,
      );
      toast.ok(
        t("exposure.toast.saved", {
          name: r.profile.name,
        }),
      );
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (saved) setDraft(draftFor(saved, tools));
    setSaveError(null);
  };

  const switchTo = (id: string) => {
    if (id === saved?.id) return;
    if (dirty) setPending({ kind: "switch", id });
    else setQuery({ profile: id === "default" ? null : id });
  };

  const confirmPending = () => {
    const p = pending;
    setPending(null);
    discard();
    if (!p) return;
    if (p.kind === "switch") setQuery({ profile: p.id === "default" ? null : p.id });
    else p.proceed();
  };

  const remove = async () => {
    if (!saved) return;
    try {
      await api.del(`/api/profiles/${encodeURIComponent(saved.id)}`);
      toast.ok(t("exposure.toast.deleted", { name: saved.name }));
      setConfirmDelete(false);
      setQuery({ profile: null });
      await data.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const canDelete = saved !== undefined && saved.id !== "default";
  const header = (
    <PageHeader
      title={t("exposure.page.title")}
      description={t("exposure.page.description")}
      actions={
        <>
          {canDelete ? (
            <Button variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>
              {t("exposure.actions.deleteProfile", { name: saved.name })}
            </Button>
          ) : null}
          <Button icon="plus" onClick={() => setCreating(true)}>
            {t("exposure.actions.newProfile")}
          </Button>
        </>
      }
    />
  );

  if (data.loading && !data.data) {
    return (
      <>
        {header}
        <Loading lines={8} />
      </>
    );
  }
  if (data.error && !data.data) {
    return (
      <>
        {header}
        <ErrorState error={data.error} onRetry={data.reload} />
      </>
    );
  }
  if (!saved || !current || !candidate) {
    return (
      <>
        {header}
        <EmptyState
          title={t("exposure.empty.noProfilesTitle")}
          action={
            <Button onClick={() => setCreating(true)}>{t("exposure.actions.newProfile")}</Button>
          }
        >
          {t("exposure.empty.noProfilesBody")}
        </EmptyState>
      </>
    );
  }

  const pinned = new Set(current.profile.pinned);
  const showPins = current.profile.mode !== "list";
  const facts = lastPreview ? previewFacts(lastPreview) : null;

  return (
    <>
      {header}
      <Tabs
        manual
        items={profiles.map((p) => ({
          id: p.id,
          label: (
            <>
              {p.name}
              {p.id === saved.id && dirty ? (
                <>
                  <span className="dirty-dot" aria-hidden="true" />
                  <span className="visually-hidden">{t("exposure.tabs.unsaved")}</span>
                </>
              ) : null}
            </>
          ),
        }))}
        value={saved.id}
        onChange={switchTo}
        label={t("exposure.tabs.label")}
        idPrefix="profile"
      />
      <div
        role="tabpanel"
        id="profile-panel"
        aria-labelledby={`profile-tab-${saved.id}`}
        className={`composer ${dirty ? "composer-dirty" : ""}`}
      >
        <div className="composer-top">
          <div className="composer-name">
            <FieldRow label={t("exposure.form.profileName")} htmlFor="profile-name">
              <TextInput
                id="profile-name"
                value={current.profile.name}
                maxLength={64}
                onChange={(e) => {
                  const name = e.target.value;
                  update((d) => ({ ...d, profile: { ...d.profile, name } }));
                }}
              />
            </FieldRow>
          </div>
          <div className="composer-endpoint">
            <span className="field-label">{t("exposure.form.endpoint")}</span>
            <div className="composer-endpoint-row">
              <CopyField
                value={endpointFor(info, saved.id)}
                label={t("exposure.form.endpointUrl", { name: saved.name })}
              />
              <Button icon="plug" onClick={() => setConnecting(true)}>
                {t("exposure.actions.connectClient")}
              </Button>
            </div>
          </div>
        </div>

        <div className="composer-mode">
          <span className="field-label" id="mode-label">
            {t("exposure.form.howShown")}
          </span>
          <div className="composer-mode-row">
            <Segmented
              label={t("exposure.form.howShown")}
              value={current.profile.mode}
              onChange={(mode) => update((d) => ({ ...d, profile: { ...d.profile, mode } }))}
              options={[
                { value: "auto", label: t("exposure.mode.auto") },
                { value: "list", label: t("exposure.mode.listAll") },
                { value: "search", label: t("exposure.mode.search") },
              ]}
            />
            <p className="small muted">{modeHelp(current.profile.mode)}</p>
          </div>
          {current.profile.mode === "auto" ? (
            <details className="advanced">
              <summary>
                <Icon name="chevronRight" className="details-chevron" />
                {t("exposure.advanced.summary")}
              </summary>
              <p className="threshold-sentence">
                <label htmlFor="th-tokens">{t("exposure.advanced.switchOver")}</label>{" "}
                <ThresholdField
                  id="th-tokens"
                  label={t("exposure.advanced.tokenLimit")}
                  value={current.profile.autoThresholdTokens}
                  onCommit={(v) =>
                    update((d) => ({ ...d, profile: { ...d.profile, autoThresholdTokens: v } }))
                  }
                />{" "}
                {t("exposure.advanced.tokensOr")}{" "}
                <ThresholdField
                  id="th-tools"
                  label={t("exposure.advanced.toolLimit")}
                  value={current.profile.autoThresholdTools}
                  onCommit={(v) =>
                    update((d) => ({ ...d, profile: { ...d.profile, autoThresholdTools: v } }))
                  }
                />{" "}
                {t("exposure.advanced.toolsDot")}
              </p>
            </details>
          ) : null}
        </div>

        {facts ? (
          <p className="composer-summary" aria-hidden="true">
            {summaryLine(facts)}
          </p>
        ) : null}

        <div className="composer-grid">
          <section className="card composer-tree" aria-labelledby="tree-title">
            <div className="card-head">
              <h2 className="card-title" id="tree-title">
                {t("exposure.tree.label")}
              </h2>
              <span className="small muted">
                {t("exposure.tree.count", { on: current.enabled.size, total: tools.length })}
              </span>
            </div>
            <SearchInput
              value={search}
              onChange={setSearch}
              label={t("exposure.tree.search")}
              placeholder={t("exposure.tree.search")}
            />
            <details className="tree-help small muted">
              <summary>
                <Icon name="chevronRight" className="details-chevron" />
                {t("exposure.tree.shortcuts")}
              </summary>
              <p>
                {t("exposure.tree.shortcutsBase")}
                {showPins ? t("exposure.tree.shortcutsPin") : ""}.
              </p>
            </details>
            {showPins ? (
              <p className="small muted">{t("exposure.tree.pinsNote", { max: MAX_PINS })}</p>
            ) : null}
            <ToolTree
              groups={groups}
              tools={toolMap}
              enabled={current.enabled}
              pinned={pinned}
              showPins={showPins}
              query={search}
              onToggleGroup={(g) =>
                update((d) => ({ ...d, enabled: toggleGroup(g, d.enabled), selectionEdited: true }))
              }
              onToggleTool={(n) =>
                update((d) => ({ ...d, enabled: toggleTool(n, d.enabled), selectionEdited: true }))
              }
              onTogglePin={(n) => {
                if (!pinned.has(n) && pinned.size >= MAX_PINS) {
                  toast.error(t("exposure.toast.maxPins", { max: MAX_PINS }));
                  return;
                }
                update((d) => ({
                  ...d,
                  profile: {
                    ...d.profile,
                    pinned: d.profile.pinned.includes(n)
                      ? d.profile.pinned.filter((x) => x !== n)
                      : [...d.profile.pinned, n],
                  },
                }));
              }}
            />
          </section>
          <section className="card composer-preview" aria-labelledby="preview-title">
            <div className="card-head">
              <h2 className="card-title" id="preview-title">
                {t("exposure.preview.title")}
              </h2>
              {preview.loading ? (
                <span className="small muted">{t("exposure.preview.updating")}</span>
              ) : null}
            </div>
            <PreviewPanel
              preview={lastPreview}
              error={preview.error}
              loading={preview.loading}
              draft={candidate}
              chosen={current.enabled}
            />
          </section>
        </div>
      </div>

      {dirty ? (
        <section className="savebar" aria-label={t("exposure.savebar.aria")}>
          <div className="savebar-text">
            <Badge tone="warn" dot>
              {t("exposure.savebar.badge")}
            </Badge>
            <span className="small">
              {[
                sel.added.length ? t("exposure.savebar.added", { count: sel.added.length }) : "",
                sel.removed.length
                  ? t("exposure.savebar.removed", { count: sel.removed.length })
                  : "",
                changed.includes("pinned") ? t("exposure.savebar.pinsChanged") : "",
                changed.includes("mode") ? t("exposure.savebar.modeChanged") : "",
                changed.includes("name") ? t("exposure.savebar.renamed") : "",
                changed.some((f) => f.startsWith("autoThreshold"))
                  ? t("exposure.savebar.limitsChanged")
                  : "",
              ]
                .filter(Boolean)
                .join(", ") || t("exposure.savebar.fallback")}
            </span>
            {saveError ? (
              <span className="field-error" role="alert">
                {saveError}
              </span>
            ) : null}
          </div>
          <div className="savebar-actions">
            <Button onClick={discard}>{t("exposure.savebar.discard")}</Button>
            <Button variant="primary" busy={saving} onClick={save}>
              {t("exposure.savebar.save")}
            </Button>
          </div>
        </section>
      ) : null}

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t("exposure.discardDialog.title")}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button data-autofocus onClick={() => setPending(null)}>
              {t("exposure.discardDialog.keepEditing")}
            </Button>
            <Button variant="danger" onClick={confirmPending}>
              {t("exposure.discardDialog.discardChanges")}
            </Button>
          </>
        }
      >
        <p>{t("exposure.discardDialog.body", { name: saved.name })}</p>
      </Dialog>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("exposure.deleteDialog.title", { name: saved.name })}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button data-autofocus onClick={() => setConfirmDelete(false)}>
              {t("exposure.deleteDialog.keep")}
            </Button>
            <Button variant="danger" onClick={remove}>
              {t("exposure.deleteDialog.delete")}
            </Button>
          </>
        }
      >
        <p>
          {t("exposure.deleteDialog.bodyBefore")}
          <span className="mono">{endpointFor(info, saved.id)}</span>
          {t("exposure.deleteDialog.bodyAfter")}
        </p>
      </Dialog>

      <Dialog
        open={connecting}
        onClose={() => setConnecting(false)}
        title={t("exposure.connectDialog.title", { name: saved.name })}
        size="lg"
      >
        <ConnectAgent profile={saved.id} />
      </Dialog>

      <CreateProfileDialog
        open={creating}
        onClose={() => setCreating(false)}
        existing={profiles.map((p) => p.id)}
        onCreated={async (p) => {
          setCreating(false);
          await data.reload();
          setQuery({ profile: p.id });
          toast.ok(t("exposure.toast.created", { name: p.name }));
        }}
      />
    </>
  );
}

function CreateProfileDialog({
  open,
  onClose,
  existing,
  onCreated,
}: { open: boolean; onClose: () => void; existing: string[]; onCreated: (p: Profile) => void }) {
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setId("");
      setIdEdited(false);
      setError(null);
    }
  }, [open]);

  const effectiveId = idEdited ? id : name ? slugify(name) : "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError(t("exposure.createDialog.errName"));
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(effectiveId))
      return setError(t("exposure.createDialog.errUrl"));
    if (existing.includes(effectiveId)) return setError(t("exposure.createDialog.errExists"));
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ profile: Profile }>(`/api/profiles/${effectiveId}`, {
        name: name.trim(),
        mode: "auto",
        include: [],
        exclude: [],
        pinned: [],
      });
      onCreated(r.profile);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "PROFILE_LIMIT"
          ? t("exposure.createDialog.errLimit")
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
      title={t("exposure.actions.newProfile")}
      description={t("exposure.createDialog.description")}
      footer={
        <>
          <Button onClick={onClose}>{t("exposure.createDialog.cancel")}</Button>
          <Button variant="primary" type="submit" form="new-profile" busy={busy}>
            {t("exposure.createDialog.submit")}
          </Button>
        </>
      }
    >
      <form id="new-profile" onSubmit={submit} noValidate>
        <FieldRow label={t("exposure.createDialog.nameLabel")} htmlFor="np-name">
          <TextInput
            id="np-name"
            data-autofocus
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("exposure.createDialog.namePlaceholder")}
          />
        </FieldRow>
        <FieldRow
          label={t("exposure.createDialog.urlLabel")}
          htmlFor="np-id"
          hint={
            effectiveId
              ? t("exposure.createDialog.urlHintSet", { id: effectiveId })
              : t("exposure.createDialog.urlHintEmpty")
          }
        >
          <TextInput
            id="np-id"
            className="input-mono"
            value={effectiveId}
            maxLength={32}
            onChange={(e) => {
              setIdEdited(true);
              setId(e.target.value.toLowerCase());
            }}
          />
        </FieldRow>
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      </form>
    </Dialog>
  );
}

export const __test = { slugify };
