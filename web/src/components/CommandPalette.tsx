// Cmd-K / Ctrl-K: jump to any page, pack, tool or file, or run a common action.
// A combobox over a listbox: arrows move, Enter runs, Esc closes, focus goes
// back to where it was. Packs, tools and recent files load when it opens.
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { api } from "../lib/api";
import { endpointFor, useApp } from "../lib/app-context";
import { artifactSource, displayName } from "../lib/format";
import { type PaletteItem, rankItems } from "../lib/palette";
import { useRouter } from "../lib/router";
import { saveTheme } from "../lib/theme";
import type { Artifact, PackStatus, ToolInfo } from "../lib/types";
import { useFocusTrap } from "./Dialog";
import { Icon, type IconName } from "./Icon";
import { useToast } from "./Toast";
import { copyText } from "./ui";

export interface PalettePage {
  path: string;
  label: string;
  term?: string;
  icon: IconName;
  keywords?: string;
}

interface Item extends PaletteItem {
  icon: IconName;
  run(): void;
}

const KIND_ICON: Record<string, IconName> = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "file",
  document: "file",
};

export function isPaletteShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

export function CommandPalette({
  open,
  onClose,
  pages,
  onConnect,
}: { open: boolean; onClose: () => void; pages: PalettePage[]; onConnect: () => void }) {
  if (!open) return null;
  return <PaletteBody onClose={onClose} pages={pages} onConnect={onConnect} />;
}

function PaletteBody({
  onClose,
  pages,
  onConnect,
}: { onClose: () => void; pages: PalettePage[]; onConnect: () => void }) {
  const ref = useFocusTrap(true, onClose, "#palette-input");
  const { navigate } = useRouter();
  const { info, signOut, sessionSupported } = useApp();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [packs, setPacks] = useState<PackStatus[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [files, setFiles] = useState<Artifact[]>([]);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const quiet = () => undefined;
    api
      .get<{ packs: PackStatus[] }>("/api/packs", undefined, ctrl.signal)
      .then((r) => setPacks(r.packs))
      .catch(quiet);
    api
      .get<{ tools: ToolInfo[] }>("/api/tools", undefined, ctrl.signal)
      .then((r) => setTools(r.tools))
      .catch(quiet);
    api
      .get<{ artifacts: Artifact[] }>("/api/artifacts", { limit: 20 }, ctrl.signal)
      .then((r) => setFiles(r.artifacts))
      .catch(quiet);
    return () => ctrl.abort();
  }, []);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const actions: Item[] = [
      {
        id: "a:connect",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.connect"),
        keywords: "client claude cursor codex snippet",
        icon: "plug",
        run: () => {
          onClose();
          onConnect();
        },
      },
      {
        id: "a:copy",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.copyEndpoint"),
        hint: "MCP URL",
        keywords: "url address",
        icon: "copy",
        run: () => {
          onClose();
          void copyText(endpointFor(info)).then((ok) =>
            ok
              ? toast.ok(t("common.palette.endpointCopied"))
              : toast.error(t("common.palette.copyFailed")),
          );
        },
      },
      {
        id: "a:try",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.tryTool"),
        keywords: "playground run",
        icon: "play",
        run: go("/playground"),
      },
      {
        id: "a:key",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.addKey"),
        keywords: "secret api key fal openrouter replicate",
        icon: "key",
        run: go("/packs?missing=1"),
      },
      {
        id: "a:server",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.addServer"),
        keywords: "mount mcp",
        icon: "plus",
        run: go("/mounts?add=1"),
      },
      {
        id: "a:light",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.lightTheme"),
        keywords: "appearance",
        icon: "sun",
        run: () => {
          saveTheme("light");
          onClose();
        },
      },
      {
        id: "a:dark",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.darkTheme"),
        keywords: "appearance",
        icon: "moon",
        run: () => {
          saveTheme("dark");
          onClose();
        },
      },
      {
        id: "a:system",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.systemTheme"),
        keywords: "appearance auto",
        icon: "monitor",
        run: () => {
          saveTheme("system");
          onClose();
        },
      },
    ];
    if (sessionSupported)
      actions.push({
        id: "a:out",
        group: t("common.palette.group.actions"),
        label: t("common.palette.action.signOut"),
        icon: "signOut",
        run: () => {
          onClose();
          void signOut();
        },
      });
    const pageItems: Item[] = pages.map((p) => ({
      id: `p:${p.path}`,
      group: t("common.palette.group.pages"),
      label: p.label,
      ...(p.term ? { hint: p.term } : {}),
      ...(p.keywords ? { keywords: p.keywords } : {}),
      icon: p.icon,
      run: go(p.path),
    }));
    const packItems: Item[] = packs.map((p) => ({
      id: `k:${p.id}`,
      group: t("common.palette.group.packs"),
      label: p.name || displayName(p.id),
      hint: p.enabled
        ? t("common.palette.toolsCount", { count: p.tools.length })
        : t("common.palette.packOff"),
      keywords: p.id,
      icon: "package",
      run: go(`/packs?pack=${encodeURIComponent(p.id)}`),
    }));
    const toolItems: Item[] = tools.map((tool) => ({
      id: `t:${tool.name}`,
      group: t("common.palette.group.tools"),
      label: tool.name,
      hint: displayName(tool.pack),
      keywords: tool.description.slice(0, 120),
      icon: "play",
      run: go(`/playground?tool=${encodeURIComponent(tool.name)}`),
    }));
    const fileItems: Item[] = files.map((a) => ({
      id: `f:${a.id}`,
      group: t("common.palette.group.recentFiles"),
      label: a.prompt?.slice(0, 80) || (a.tool ? artifactSource(a.tool).label : a.kind),
      hint: a.kind,
      keywords: `${a.tool ?? ""} ${a.model ?? ""}`,
      icon: KIND_ICON[a.kind] ?? "file",
      run: go(`/library?artifact=${encodeURIComponent(a.id)}`),
    }));
    return [...pageItems, ...actions, ...packItems, ...toolItems, ...fileItems];
  }, [
    pages,
    packs,
    tools,
    files,
    info,
    navigate,
    onClose,
    onConnect,
    toast,
    signOut,
    sessionSupported,
  ]);

  const shown = useMemo(() => {
    // Without a query: pages and actions only; typing searches everything.
    const pool = q.trim()
      ? items
      : items.filter(
          (i) =>
            i.group === t("common.palette.group.pages") ||
            i.group === t("common.palette.group.actions"),
        );
    return rankItems(pool, q, 40);
  }, [items, q]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlighted row whenever the query changes
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Home" && e.ctrlKey) {
      setActive(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      shown[active]?.run();
    }
  };

  // Group headings in ranked order (with a query, the best group comes first).
  const rows: ReactNode[] = [];
  let lastGroup = "";
  shown.forEach((item, i) => {
    if (!q.trim() && item.group !== lastGroup) {
      rows.push(
        <div key={`g:${item.group}`} className="palette-group" role="presentation">
          {item.group}
        </div>,
      );
    }
    lastGroup = item.group;
    rows.push(
      // biome-ignore lint/a11y/useKeyWithClickEvents: the search input moves the active option from the keyboard (aria-activedescendant)
      <div
        key={item.id}
        id={`${listId}-${i}`}
        // biome-ignore lint/a11y/useSemanticElements: option in an aria-activedescendant listbox
        data-index={i}
        role="option"
        tabIndex={-1}
        aria-selected={i === active}
        className={i === active ? "palette-item palette-item-on" : "palette-item"}
        onMouseMove={() => setActive(i)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => item.run()}
      >
        <Icon name={item.icon} />
        <span
          className={
            item.group === t("common.palette.group.tools") ? "palette-label mono" : "palette-label"
          }
        >
          {item.label}
        </span>
        {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
        {q.trim() ? <span className="palette-kind">{item.group}</span> : null}
      </div>,
    );
  });

  return createPortal(
    <div
      className="overlay overlay-palette"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        // biome-ignore lint/a11y/useSemanticElements: palette with its own focus trap and backdrop; a native dialog changes both
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("common.palette.label")}
        tabIndex={-1}
      >
        <div className="palette-search">
          <Icon name="search" />
          <input
            id="palette-input"
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("common.palette.placeholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <div
          ref={listRef}
          id={listId}
          // biome-ignore lint/a11y/useSemanticElements: aria-activedescendant listbox driven from the search input
          className="palette-list"
          role="listbox"
          tabIndex={-1}
          aria-label={t("common.palette.results")}
        >
          {shown.length ? (
            rows
          ) : (
            <p className="palette-empty">{t("common.palette.empty", { q })}</p>
          )}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> {t("common.palette.footerMove")}
          </span>
          <span>
            <kbd className="kbd">↵</kbd> {t("common.palette.footerOpen")}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
