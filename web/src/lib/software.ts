// The Software page and the setup plan: pure helpers, testable without a DOM.
import { t } from "../i18n";
import type { PlanOption, SoftwareView } from "./types";

const ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** The id in `?install=<id>` (the link an agent's install_software hands the user), or null. */
export function installRequest(query: URLSearchParams): string | null {
  const id = query.get("install");
  return id && ID.test(id) ? id : null;
}

/** "12 MB", "1.2 GB". */
export function sizeLabel(mb: number): string {
  if (mb >= 1000)
    return t("software.size.gb", { value: (mb / 1000).toFixed(mb >= 10_000 ? 0 : 1) });
  return t("software.size.mb", { value: Math.max(1, Math.round(mb)) });
}

/** How a program gets onto this computer, in plain words. */
export function methodLabel(s: Pick<SoftwareView, "method">): string {
  switch (s.method) {
    case "archive":
      return t("software.method.archive");
    case "uv":
      return t("software.method.uv");
    case "model":
      return t("software.method.model");
    case "brew":
      return "Homebrew";
    case "winget":
      return "winget";
    case "apt":
      return t("software.method.apt");
    case "link":
      return t("software.method.link");
    default:
      return t("software.method.default");
  }
}

/** Whether the Install button runs here (or only a link or a command is offered). */
export function canInstallHere(s: Pick<SoftwareView, "method">): boolean {
  return (
    s.method === "archive" ||
    s.method === "uv" ||
    s.method === "model" ||
    s.method === "brew" ||
    s.method === "winget"
  );
}

export type SoftwareState = "installed" | "running" | "installing" | "missing";

export function softwareState(
  s: Pick<SoftwareView, "installed" | "running" | "job_id">,
  jobRunning = false,
): SoftwareState {
  if (jobRunning || s.job_id) return "installing";
  if (s.installed && s.running) return "running";
  return s.installed ? "installed" : "missing";
}

/** Installed first, then what installs here, then link-only; by name inside each. */
export function sortSoftware(items: readonly SoftwareView[]): SoftwareView[] {
  const rank = (s: SoftwareView) =>
    s.installed ? 0 : canInstallHere(s) ? 1 : s.method === "apt" ? 2 : s.method === "link" ? 3 : 4;
  return [...items].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The `max` most used tags for the filter (ties by name), shown in name order. */
export function softwareTags(items: readonly SoftwareView[], max = 6): string[] {
  const count = new Map<string, number>();
  for (const t of items.flatMap((s) => s.tags)) count.set(t, (count.get(t) ?? 0) + 1);
  return [...count]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t)
    .sort();
}

/**
 * Where a plan option takes the user: a dashboard page (same origin only) or
 * an https link to an official page. Anything else is not linked.
 */
export function optionTarget(o: Pick<PlanOption, "how">): { to: string } | { href: string } | null {
  const d = o.how.dashboard;
  if (d?.startsWith("/") && !d.startsWith("//")) return { to: d };
  const u = o.how.url;
  if (u && /^https:\/\/[^\s]+$/.test(u)) return { href: u };
  return null;
}

/** The button text for a plan option. */
export function optionAction(o: Pick<PlanOption, "needs" | "name">): string {
  switch (o.needs) {
    case "install":
      return t("software.option.install", { name: o.name });
    case "key":
      return t("software.option.key");
    case "login":
      return t("software.option.login", { name: o.name });
    default:
      return t("software.option.default", { name: o.name });
  }
}

/** How many goals the goal picker shows before "More goals". */
export const GOALS_SHOWN = 6;

/**
 * The goals the picker shows: the first few, or all of them when expanded or
 * when the picked goal is past the cut (so the pick is never hidden).
 */
export function visibleGoals<T extends { id: string }>(
  goals: readonly T[],
  value: string | null,
  expanded: boolean,
  limit = GOALS_SHOWN,
): { shown: T[]; hidden: number } {
  const all = expanded || goals.length <= limit || goals.findIndex((g) => g.id === value) >= limit;
  const shown = all ? [...goals] : goals.slice(0, limit);
  return { shown, hidden: goals.length - shown.length };
}
