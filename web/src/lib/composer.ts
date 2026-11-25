// The exposure composer's model: tool groups, tri-state toggles, turning a set
// of enabled tools back into include/exclude selectors, and the draft diff.
// Pure functions, no React; mirrors the selector rules in src/core/profiles.ts.
import { t } from "../i18n";
import type { Profile, ToolInfo } from "./types";

export type Section = "core" | "packs" | "workflows" | "mounts";

export interface ToolGroup {
  /** Also the selector that names exactly this group, e.g. "pack:fal". */
  id: string;
  section: Section;
  label: string;
  /** "pack" | "mount" | "workflow" with the value. */
  selector: string;
  tools: string[];
}

export type TriState = "on" | "off" | "mixed";

type Matchable = Pick<ToolInfo, "name" | "pack" | "origin" | "tags" | "capability">;

/** The daemon's selector rule (profiles.ts `matches`). */
export function matchesSelector(selector: string, t: Matchable): boolean {
  if (selector === "*") return true;
  const cut = selector.indexOf(":");
  if (cut < 0) return false;
  const kind = selector.slice(0, cut);
  const value = selector.slice(cut + 1);
  const any = value === "*";
  switch (kind) {
    case "pack":
      return any || t.pack === value;
    case "tool":
      return any || t.name === value;
    case "mount":
      return t.origin === "mounted" && (any || t.tags.includes(`mount:${value}`));
    case "capability":
      return t.capability !== null && t.capability !== undefined && (any || t.capability === value);
    case "workflow":
      return any
        ? t.tags.some((tag) => tag.startsWith("workflow:"))
        : t.tags.includes(`workflow:${value}`);
    case "tag":
      return any ? t.tags.length > 0 : t.tags.includes(value);
    default:
      return false;
  }
}

/** The tools a profile exposes before the search/list decision (exclude wins). */
export function enabledTools(
  profile: Pick<Profile, "include" | "exclude">,
  tools: readonly Matchable[],
): Set<string> {
  const out = new Set<string>();
  for (const t of tools) {
    if (
      profile.include.some((s) => matchesSelector(s, t)) &&
      !profile.exclude.some((s) => matchesSelector(s, t))
    ) {
      out.add(t.name);
    }
  }
  return out;
}

const SECTION_ORDER: Record<Section, number> = { core: 0, packs: 1, workflows: 2, mounts: 3 };

/** Core, then one group per pack, per workflow, per mount. Every tool is in exactly one group. */
export function buildGroups(
  tools: readonly ToolInfo[],
  labels: (kind: string, id: string) => string = (_k, id) => id,
): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  const add = (id: string, section: Section, selector: string, label: string, tool: string) => {
    let g = groups.get(id);
    if (!g) {
      g = { id, section, selector, label, tools: [] };
      groups.set(id, g);
    }
    g.tools.push(tool);
  };
  for (const t of tools) {
    const mountTag =
      t.origin === "mounted" ? t.tags.find((x) => x.startsWith("mount:")) : undefined;
    const workflowTag = t.tags.find((x) => x.startsWith("workflow:"));
    if (mountTag) {
      const id = mountTag.slice("mount:".length);
      add(`mount:${id}`, "mounts", `mount:${id}`, labels("mount", id), t.name);
    } else if (workflowTag) {
      const id = workflowTag.slice("workflow:".length);
      add(`workflow:${id}`, "workflows", `workflow:${id}`, labels("workflow", id), t.name);
    } else if (t.pack === "core") {
      add("pack:core", "core", "pack:core", labels("pack", "core"), t.name);
    } else {
      add(`pack:${t.pack}`, "packs", `pack:${t.pack}`, labels("pack", t.pack), t.name);
    }
  }
  return [...groups.values()].sort(
    (a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || a.label.localeCompare(b.label),
  );
}

export function groupState(
  group: Pick<ToolGroup, "tools">,
  enabled: ReadonlySet<string>,
): TriState {
  let on = 0;
  for (const t of group.tools) if (enabled.has(t)) on++;
  if (on === 0) return "off";
  return on === group.tools.length ? "on" : "mixed";
}

/** Clicking a group: a fully enabled group turns off, anything else turns fully on. */
export function toggleGroup(
  group: Pick<ToolGroup, "tools">,
  enabled: ReadonlySet<string>,
): Set<string> {
  const next = new Set(enabled);
  const turnOn = groupState(group, enabled) !== "on";
  for (const t of group.tools) {
    if (turnOn) next.add(t);
    else next.delete(t);
  }
  return next;
}

export function toggleTool(name: string, enabled: ReadonlySet<string>): Set<string> {
  const next = new Set(enabled);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/** True when `selector` matches exactly the tools of `group` and nothing else. */
function selectorIsExact(group: ToolGroup, tools: readonly Matchable[]): boolean {
  const members = new Set(group.tools);
  for (const t of tools) {
    if (matchesSelector(group.selector, t) !== members.has(t.name)) return false;
  }
  return true;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/**
 * Selectors for a set of enabled tools.
 *
 * - "Everything except" (`include: ["*"]` plus excludes) when the profile
 *   already used "*" or more than half the tools are on, so tools added later
 *   are exposed too. Otherwise an allow list.
 * - A group is named by its selector (pack:fal) only when that selector
 *   matches exactly the group; otherwise its tools are named one by one.
 * - Selectors of the original profile that match no tool today (a pack that
 *   is not loaded, a mount that is off) are kept as they were.
 */
export function normalizeSelection(
  enabled: ReadonlySet<string>,
  tools: readonly ToolInfo[],
  groups: readonly ToolGroup[],
  original: Pick<Profile, "include" | "exclude">,
): { include: string[]; exclude: string[] } {
  const star = original.include.includes("*") || enabled.size * 2 > tools.length;
  const include: string[] = [];
  const exclude: string[] = [];
  const name = (g: ToolGroup) => selectorIsExact(g, tools);

  for (const g of groups) {
    const state = groupState(g, enabled);
    if (star) {
      if (state === "off") {
        if (name(g)) exclude.push(g.selector);
        else exclude.push(...g.tools.map((t) => `tool:${t}`));
      } else if (state === "mixed") {
        exclude.push(...g.tools.filter((t) => !enabled.has(t)).map((t) => `tool:${t}`));
      }
    } else if (state === "on") {
      if (name(g)) include.push(g.selector);
      else include.push(...g.tools.map((t) => `tool:${t}`));
    } else if (state === "mixed") {
      include.push(...g.tools.filter((t) => enabled.has(t)).map((t) => `tool:${t}`));
    }
  }
  if (star) include.unshift("*");

  const dangling = (s: string) => s !== "*" && !tools.some((t) => matchesSelector(s, t));
  include.push(...original.include.filter(dangling));
  exclude.push(...original.exclude.filter(dangling));
  return { include: dedupe(include), exclude: dedupe(exclude) };
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
};

export type ProfileField =
  | "name"
  | "mode"
  | "include"
  | "exclude"
  | "pinned"
  | "autoThresholdTokens"
  | "autoThresholdTools";

/** Which fields differ. Selector and pin lists compare as sets: order does not matter to the daemon. */
export function diffProfiles(saved: Profile, draft: Profile): ProfileField[] {
  const out: ProfileField[] = [];
  if (saved.name !== draft.name) out.push("name");
  if (saved.mode !== draft.mode) out.push("mode");
  if (!sameSet(saved.include, draft.include)) out.push("include");
  if (!sameSet(saved.exclude, draft.exclude)) out.push("exclude");
  if (!sameSet(saved.pinned, draft.pinned)) out.push("pinned");
  if (saved.autoThresholdTokens !== draft.autoThresholdTokens) out.push("autoThresholdTokens");
  if (saved.autoThresholdTools !== draft.autoThresholdTools) out.push("autoThresholdTools");
  return out;
}

/** What the enabled set changes against the saved profile, in tool names. */
export function selectionChanges(
  saved: ReadonlySet<string>,
  draft: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  return {
    added: [...draft].filter((t) => !saved.has(t)).sort(),
    removed: [...saved].filter((t) => !draft.has(t)).sort(),
  };
}

/** Case-insensitive match on tool name, description or group label. */
export function toolMatchesQuery(
  t: Pick<ToolInfo, "name" | "description">,
  groupLabel: string,
  q: string,
): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return (
    t.name.toLowerCase().includes(s) ||
    t.description.toLowerCase().includes(s) ||
    groupLabel.toLowerCase().includes(s)
  );
}

/** "about 2% of a 200k context" */
export function contextShare(
  tokens: number,
  context = 200_000,
): { percent: number; label: string } {
  const percent = (tokens / context) * 100;
  const contextK = Math.round(context / 1000);
  const label =
    percent > 0 && percent < 1
      ? t("capabilities.composer.contextShare.lessThanOne", { contextK })
      : t("capabilities.composer.contextShare.about", {
          pct:
            percent === 0
              ? 0
              : percent < 10
                ? Number(percent.toFixed(1).replace(/\.0$/, ""))
                : Math.round(percent),
          contextK,
        });
  return { percent, label };
}

export interface TokenScale {
  /** Tokens at the right end of the bar: twice the auto threshold. */
  max: number;
  /** Fill width, 0..100, clipped. */
  fillPercent: number;
  /** Where the threshold tick sits, 0..100. */
  tickPercent: number;
  /** Where the "list every tool" cost sits, 0..100, or null when not worth showing. */
  directPercent: number | null;
  over: boolean;
  offScale: boolean;
}

/**
 * The token bar is drawn against a fixed budget, not against the other
 * number: the auto threshold sits at the middle, so a bar that fills past the
 * tick means the list is big enough for auto mode to switch to search.
 */
export function tokenScale(total: number, direct: number, threshold: number): TokenScale {
  const t = threshold > 0 ? threshold : 8000;
  const max = t * 2;
  const pct = (n: number) => Math.max(0, Math.min(100, (n / max) * 100));
  return {
    max,
    fillPercent: pct(total),
    tickPercent: pct(t),
    directPercent: direct > total ? pct(direct) : null,
    over: total > t,
    offScale: total > max,
  };
}

/**
 * A threshold field's text, checked on blur: a whole number of at least 1.
 * Returns the number, or an error message to show under the field.
 */
export function parseThreshold(text: string): { value: number } | { error: string } {
  const s = text.trim();
  if (s === "") return { error: t("capabilities.composer.threshold.enterNumber") };
  if (!/^\d+$/.test(s)) return { error: t("capabilities.composer.threshold.wholeNumber") };
  const v = Number.parseInt(s, 10);
  if (v < 1) return { error: t("capabilities.composer.threshold.atLeastOne") };
  return { value: v };
}
