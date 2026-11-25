// First run on Home: a four-item checklist in the order of the first-minute path.
// 1. connect an agent, 2. say what you want to do (a goal: its setup plan),
// 3. add one key (or skip), 4. run a tool in the playground.
// Pure functions so the checklist logic is testable without a DOM; the small
// localStorage flags live here too so Home and Playground share them.
import { t } from "../i18n";

export type StepId = "connect" | "goal" | "key" | "try";

export const STEPS: readonly StepId[] = ["connect", "goal", "key", "try"];

export type Progress = Record<StepId, boolean>;

const TRIED_KEY = "plughive.tried";
const SKIPPED_KEY = "plughive.keys-skipped";
const GOAL_KEY = "plughive.goal";
const GOAL_SKIPPED = "-";

/** The item to show expanded: the first one not done, or null when all are. */
export function firstOpen(p: Progress, after?: StepId): StepId | null {
  const from = after ? STEPS.indexOf(after) + 1 : 0;
  return STEPS.slice(from).find((s) => !p[s]) ?? STEPS.find((s) => !p[s]) ?? null;
}

export function doneCount(p: Progress): number {
  return STEPS.filter((s) => p[s]).length;
}

/** One provider form open at a time: clicking the open one closes it. */
export function toggleOpen(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/** Client names, each once, most recently seen first. */
export function agentNames(agents: ReadonlyArray<{ name: string }> | undefined): string[] {
  const out: string[] = [];
  for (const a of agents ?? []) if (!out.includes(a.name)) out.push(a.name);
  return out;
}

/** "Cursor is connected.", "Cursor and Codex are connected.", "A, B and 3 more are connected." */
export function agentSummary(names: readonly string[]): string {
  if (names.length === 0) return t("connect.agents.noAgent");
  if (names.length === 1) return t("connect.agents.oneAgent", { name: names[0] ?? "" });
  if (names.length === 2)
    return t("connect.agents.twoAgents", { first: names[0] ?? "", second: names[1] ?? "" });
  return t("connect.agents.manyAgents", {
    first: names[0] ?? "",
    second: names[1] ?? "",
    more: names.length - 2,
  });
}

/** One line for the goal item: the goal picked, skipped, or the prompt. */
export function goalSummary(goal: { title: string } | null, skipped: boolean): string {
  if (goal) return t("home.checklist.goalSummary.picked", { title: goal.title });
  if (skipped) return t("home.checklist.goalSummary.skipped");
  return t("home.checklist.goalSummary.prompt");
}

/** One line for the key item once it is done or skipped. */
export function keySummary(skipped: boolean, readyProviders: readonly string[]): string {
  if (readyProviders.length > 0)
    return t("home.checklist.keySummary.added", { providers: readyProviders.join(", ") });
  if (skipped) return t("home.checklist.keySummary.skipped");
  return t("home.checklist.keySummary.prompt");
}

/**
 * The tool the "Run a tool" item opens: an image tool from a pack the user
 * just gave a key, else any tool from it, else the free status check.
 */
const META_TOOL = /(_describe_model|_search_models|_get_result|_run|_status|_list[a-z_]*)$/;
const NOT_FIRST = /(video|edit|upscale|inpaint|remove|_to_)/;
const IMAGE_MAKER =
  /(generate_image|image_generate|text_to_image|flux|nano_banana|imagen|seedream|recraft)/;

/** The tool to try first: a text-to-image model from a pack with a key, else that pack's
 *  first plain tool, else the free status check. Video, edit and lookup tools come last. */
export function suggestTool(
  packs: ReadonlyArray<{ id: string; tools: string[] }>,
  readyIds: readonly string[],
): string {
  for (const id of readyIds) {
    const tools = (packs.find((p) => p.id === id)?.tools ?? []).filter((t) => !META_TOOL.test(t));
    const pick =
      tools.find((t) => IMAGE_MAKER.test(t) && !NOT_FIRST.test(t)) ??
      tools.find((t) => /image/.test(t) && !NOT_FIRST.test(t)) ??
      tools.find((t) => !NOT_FIRST.test(t)) ??
      tools[0];
    if (pick) return pick;
  }
  return "gateway_status";
}

/** Whether a suggested tool makes images (for the plain-words step text). */
export function makesImages(tool: string): boolean {
  return IMAGE_MAKER.test(tool) || /image/.test(tool);
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Private windows: the checklist still works for this visit.
  }
}

/** Set by the playground after any successful run. */
export const triedFlag = {
  read: () => readFlag(TRIED_KEY),
  set: () => writeFlag(TRIED_KEY, true),
};

export const keysSkippedFlag = {
  read: () => readFlag(SKIPPED_KEY),
  set: (on: boolean) => writeFlag(SKIPPED_KEY, on),
};

/** The goal picked on Home: an id, "skipped", or null when not answered yet. */
export const goalFlag = {
  read(): { id: string } | "skipped" | null {
    try {
      const v = window.localStorage.getItem(GOAL_KEY);
      if (v === GOAL_SKIPPED) return "skipped";
      return v && /^[a-z0-9-]{1,40}$/.test(v) ? { id: v } : null;
    } catch {
      return null;
    }
  },
  set(v: string | "skipped" | null) {
    try {
      if (v === null) window.localStorage.removeItem(GOAL_KEY);
      else window.localStorage.setItem(GOAL_KEY, v === "skipped" ? GOAL_SKIPPED : v);
    } catch {
      // Private windows: the checklist still works for this visit.
    }
  },
};
