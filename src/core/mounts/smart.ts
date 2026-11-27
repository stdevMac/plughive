// src/core/mounts/smart.ts
//
// Smart mount: tells which mounts earn their place and takes the ones that
// do not out of the agent's way. An enabled mount is not free: its tools sit
// in every tools/list a list-mode profile sends (tokens on every agent turn),
// and a stdio mount keeps a process running.
//
// For every mount the report gives:
//   - last use and calls in the last 30 days, from the usage ledger (a
//     mounted tool is `<prefix>__<tool>`, recorded with vendor = prefix),
//   - an estimate of the tokens its tool definitions cost (same estimate as
//     the profile preview),
//   - how long it has been idle: since its last call, or since smart mount
//     first saw it switched on, whichever is later. A mount just switched on
//     (or switched back on) starts a fresh grace period.
//
// Suggestions, by what acting on them does:
//   park (switch the mount off; keys and sign-in stay)
//     idle          on and not called for `idleDays`
//     heavy         costs many tokens and is rarely called
//     overlap       does the same job as another mount (or a built-in
//                   capability) that gets the calls
//   change a profile (only list-mode profiles pay for tool definitions)
//     profile_unused  other profiles call this mount, this one never does:
//                     hide `mount:<id>` from it
//     unused_tools    the profile uses the mount, but not these tools of it:
//                     hide `tool:<name>` for each
//     search_mode     a list-mode profile whose tools cost many tokens:
//                     switch it to auto (search mode over the threshold)
//   health (nothing to apply; says what to fix)
//     sign_in       an OAuth mount that is signed out
//     missing_key   a key the mount needs is not set
//     failing       on but not connected
//     failing_tool  a mounted tool that failed most of its recent calls
//                   (reconnects already back off on their own: packs/mounts.ts)
//
// Nothing is lost by acting: a parked mount's tool list is remembered, so
// search_tools still finds its tools (describe_tool says it is parked, and
// never wakes it), and calling one switches
// the mount back on (settings.wake "auto", the default) or answers that it is
// parked ("ask"). A tool smart mount hid from a profile comes back the same
// way. Every change is recorded and can be undone, and the report sums up the
// last week: what was parked, woken and hidden, and the tokens per tools/list
// that saves.
//
// Modes: "off" (no suggestions, no sweep), "suggest" (the default:
// suggestions only), "auto" (an hourly sweep parks idle mounts; nothing
// else is ever applied without being asked). Mounts in `keep` are never
// suggested or parked.
//
// State lives in <home>/smart-mounts.json, owner-only, written atomically.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../lib/platform.js";
import type { ToolUse, UsageLedger } from "../../lib/usage.js";
import {
  type Profile,
  type ProfileStore,
  estimateTokens,
  profileAllows,
  resolveExposure,
  selectorMatches,
  toDescriptor,
} from "../profiles.js";
import { MOUNT_PACK_ID, type RegisteredTool } from "../tools/registry.js";
import type { MountInfo, MountManager } from "./manager.js";

export const SMART_MOUNTS_FILE = "smart-mounts.json";
const DAY_MS = 86_400_000;
/** Calls are counted over this many days. */
export const USE_WINDOW_DAYS = 30;
/** A mount whose tools cost at least this many tokens... */
export const HEAVY_TOKENS = 3000;
/** ...and that had fewer calls than this in the window is "heavy". */
export const HEAVY_MAX_CALLS = 5;
/** A list-mode profile whose tools cost more than this is told about search mode. */
export const SEARCH_MODE_TOKENS = 15_000;
/** unused_tools needs at least this many unused tools... */
export const UNUSED_TOOLS_MIN = 2;
/** ...costing at least this many tokens together. */
export const UNUSED_TOOLS_MIN_TOKENS = 500;
/** failing_tool: at least this many calls in FAILING_WINDOW_DAYS... */
export const FAILING_TOOL_MIN_CALLS = 5;
/** ...and at least this share of them failed. */
export const FAILING_TOOL_RATE = 0.8;
export const FAILING_WINDOW_DAYS = 7;
/** overlap: the mount kept must have this many calls... */
export const OVERLAP_MIN_CALLS = 5;
/** ...and at least this many times the calls of the one parked. */
export const OVERLAP_RATIO = 4;
export const SUMMARY_DAYS = 7;
export const SWEEP_INTERVAL_MS = 60 * 60_000;
const EVENTS_KEPT_DAYS = 90;
const MAX_EVENTS = 500;
const MAX_CACHED_TOOLS = 300;
const MAX_CACHED_DESCRIPTION = 300;
const MOUNT_ID = /^[a-z][a-z0-9-]{1,31}\/[a-z][a-z0-9-]{1,31}$/;

export const SmartMountSettingsSchema = z
  .object({
    mode: z.enum(["off", "suggest", "auto"]).default("suggest"),
    /** Days without a call before a mount counts as idle. */
    idleDays: z.number().int().min(1).max(365).default(14),
    /** Mount ids that are never suggested or parked. */
    keep: z.array(z.string().regex(MOUNT_ID)).max(256).default([]),
    /**
     * A parked or hidden tool an agent asks for: "auto" brings it back on the
     * spot, "ask" answers that it is parked and how to bring it back.
     */
    wake: z.enum(["auto", "ask"]).default("auto"),
  })
  .strict();
export type SmartMountSettings = z.infer<typeof SmartMountSettingsSchema>;
export const SmartMountSettingsPatch = SmartMountSettingsSchema.partial().strict();
export type SmartMountSettingsPatch = z.infer<typeof SmartMountSettingsPatch>;

// ---------------------------------------------------------------------------
// What the overlap check counts as doing the same job
// ---------------------------------------------------------------------------

interface Category {
  label: string;
  /** Catalog mount ids (and user mount ids or prefixes) in this category. */
  names: readonly string[];
  /** Words in a user mount's description that put it here. */
  words?: RegExp;
  /** A built-in capability that does the same job. */
  capability?: string;
}

export const OVERLAP_CATEGORIES: Readonly<Record<string, Category>> = {
  web_search: {
    label: "web search",
    names: ["exa", "tavily", "perplexity", "context-dev", "brave"],
    words: /\bweb search\b|\bsearch the web\b/i,
    capability: "web.search",
  },
  scraping: {
    label: "fetching and scraping pages",
    names: ["firecrawl", "jina", "apify", "browserbase", "cloudflare-browser"],
    words: /\bscrap(e|ing)\b|\bcrawl/i,
    capability: "web.fetch",
  },
  automation: {
    label: "app automation",
    names: ["composio", "pipedream", "zapier"],
  },
  library_docs: {
    label: "library and repository docs",
    names: ["context7", "deepwiki"],
  },
  linear: { label: "Linear", names: ["linear", "linear-oauth"] },
};

/** The overlap category of a mount, or null. */
export function categoryOf(
  m: Pick<MountInfo, "mountId" | "prefix" | "description">,
): string | null {
  for (const [key, c] of Object.entries(OVERLAP_CATEGORIES)) {
    if (c.names.includes(m.mountId) || c.names.includes(m.prefix)) return key;
  }
  for (const [key, c] of Object.entries(OVERLAP_CATEGORIES)) {
    if (c.words && m.description && c.words.test(m.description)) return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Parked {
  at: string;
  idleDays: number;
  lastUsedAt: string | null;
  /** Tokens its tools cost when it was parked. */
  tokens: number;
}

interface CachedTool {
  name: string;
  description: string;
}

export type ProfileChangeKind = "profile_unused" | "unused_tools" | "search_mode";

interface Change {
  key: string;
  kind: ProfileChangeKind;
  profile: string;
  mount: string | null;
  /** Excludes added to the profile (profile_unused, unused_tools). */
  selectors: string[];
  /** The mode before search_mode changed it. */
  previousMode: Profile["mode"] | null;
  tokens: number;
  at: string;
}

export type SmartEventKind = "parked" | "woken" | "hidden" | "shown" | "search_mode" | "undone";

interface SmartEvent {
  at: string;
  kind: SmartEventKind;
  /** A mount id, or a profile id for search_mode. */
  id: string;
  profile?: string;
  tokens: number;
}

interface State {
  version: 1;
  settings: SmartMountSettings;
  /** When smart mount first saw each mount switched on. */
  since: Record<string, string>;
  /** Mounts smart mount switched off, until they are switched on again. */
  parked: Record<string, Parked>;
  /** The tool list of each mount as last seen connected (search finds parked tools here). */
  tools: Record<string, CachedTool[]>;
  /** Profile changes smart mount made, until undone. */
  changes: Change[];
  events: SmartEvent[];
}

const StateSchema = z.object({
  version: z.literal(1),
  settings: z.unknown(),
  since: z.record(z.string(), z.string()).default({}),
  parked: z
    .record(
      z.string(),
      z.object({
        at: z.string(),
        idleDays: z.number(),
        lastUsedAt: z.string().nullable(),
        tokens: z.number().default(0),
      }),
    )
    .default({}),
  tools: z
    .record(z.string(), z.array(z.object({ name: z.string(), description: z.string() })))
    .default({}),
  changes: z
    .array(
      z.object({
        key: z.string(),
        kind: z.enum(["profile_unused", "unused_tools", "search_mode"]),
        profile: z.string(),
        mount: z.string().nullable(),
        selectors: z.array(z.string()),
        previousMode: z.enum(["list", "search", "auto"]).nullable(),
        tokens: z.number(),
        at: z.string(),
      }),
    )
    .default([]),
  events: z
    .array(
      z.object({
        at: z.string(),
        kind: z.enum(["parked", "woken", "hidden", "shown", "search_mode", "undone"]),
        id: z.string(),
        profile: z.string().optional(),
        tokens: z.number(),
      }),
    )
    .default([]),
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface MountInsight {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
  tools: number;
  /** Estimated tokens of its tool definitions in a tools/list (0 when not connected). */
  est_tokens: number;
  last_used_at: string | null;
  calls_30d: number;
  /** Days since the later of its last call and when it was switched on; null when off. */
  idle_days: number | null;
  /** Set while smart mount keeps it switched off. */
  parked: { at: string; idle_days: number; tokens: number } | null;
  kept: boolean;
  /** Its overlap category (web_search, scraping, ...), or null. */
  category: string | null;
}

export type ParkKind = "idle" | "heavy" | "overlap";
export type HealthKind = "sign_in" | "missing_key" | "failing" | "failing_tool";
export type SuggestionKind = ParkKind | ProfileChangeKind | HealthKind;

export const PARK_KINDS: readonly SuggestionKind[] = ["idle", "heavy", "overlap"];
export const PROFILE_KINDS: readonly SuggestionKind[] = [
  "profile_unused",
  "unused_tools",
  "search_mode",
];

export interface Suggestion {
  kind: SuggestionKind;
  /** Stable while the situation lasts; what apply and the dashboard refer to. */
  key: string;
  /** The mount (a profile id for search_mode). */
  id: string;
  message: string;
  /** Tokens per tools/list that acting on it saves (park and profile kinds). */
  tokens?: number;
  /** profile_unused, unused_tools, search_mode: the profile it changes. */
  profile?: string;
  /** unused_tools: the tools it hides; failing_tool: the tool. */
  tools?: string[];
  /** overlap: the mount id, or `capability:<name>`, that keeps the job. */
  with?: string;
  /** overlap: the category. */
  category?: string;
  /** Calls in the window: overlap (this mount), failing_tool (the tool). */
  calls?: number;
  /** overlap: calls of the one kept. */
  with_calls?: number;
  /** failing_tool: share of failed calls, 0..1. */
  error_rate?: number;
  /** missing_key: the secret names to set on the Mounts page. */
  secrets?: string[];
}

export interface AppliedChange {
  key: string;
  kind: ProfileChangeKind;
  profile: string;
  mount: string | null;
  selectors: string[];
  tokens: number;
  at: string;
}

export interface SmartSummary {
  days: number;
  parked: number;
  woken: number;
  hidden: number;
  undone: number;
  /** Tokens per tools/list kept out right now by parked mounts and profile changes. */
  saved_tokens: number;
}

export interface SmartMountReport {
  settings: SmartMountSettings;
  mounts: MountInsight[];
  suggestions: Suggestion[];
  /** Profile changes smart mount made that are still in place. */
  changes: AppliedChange[];
  summary: SmartSummary;
  /** Estimated tokens of all switched-on mounts' tool definitions. */
  enabled_tokens: number;
  /** What parking every park suggestion would take off that. */
  reclaimable_tokens: number;
}

/** A tool an agent cannot see right now that smart mount can bring back. */
export interface DormantTool {
  name: string;
  description: string;
  packId: string;
  tags: string[];
  origin: "mounted";
  mount: string;
  /** parked: its mount is parked; hidden: a smart mount change hides it from this profile. */
  reason: "parked" | "hidden";
  /** hidden: the change to undo. */
  change?: string;
}

export type WakeResult =
  | { status: "none" }
  | { status: "ask"; tool: DormantTool; message: string }
  | { status: "woken"; tool: DormantTool; message: string };

export interface SmartMountsOptions {
  home: string;
  mounts: Pick<MountManager, "listMounts" | "setMountEnabled">;
  usage: Pick<UsageLedger, "lastUseByVendor" | "useByTool">;
  /** Every registered tool (mounted ones carry the tag `mount:<id>`). */
  tools: () => readonly RegisteredTool[];
  /** Profiles, for the profile suggestions (also settable with attachProfiles). */
  profiles?: ProfileAccess;
  logger: { info(o: object, msg: string): void; warn(o: object, msg: string): void };
  now?: () => number;
}

export type ProfileAccess = Pick<ProfileStore, "list" | "get" | "put">;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function shortDescription(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const clean = line.trim();
  return clean.length > MAX_CACHED_DESCRIPTION
    ? `${clean.slice(0, MAX_CACHED_DESCRIPTION - 1)}…`
    : clean;
}

const toolTokens = (t: RegisteredTool) => estimateTokens(toDescriptor(t));

function mountOf(t: Pick<RegisteredTool, "origin" | "tags">): string | null {
  if (t.origin !== "mounted") return null;
  const tag = t.tags.find((x) => x.startsWith("mount:"));
  return tag ? tag.slice("mount:".length) : null;
}

/**
 * State changes and concurrency: every change to smart-mounts.json reads the
 * file, changes it and writes it back (atomically) with no await in between,
 * so two changes can never interleave and one cannot overwrite the other with
 * stale data. The async operations (report, park, applyProfiles, wake, sweep)
 * also run one at a time, in call order, through `serial`.
 */
export class SmartMounts {
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private profiles: ProfileAccess | null;

  constructor(private readonly opts: SmartMountsOptions) {
    this.now = opts.now ?? Date.now;
    this.profiles = opts.profiles ?? null;
  }

  /** Give smart mount the profile store (it is built after the runtime). */
  attachProfiles(profiles: ProfileAccess): void {
    this.profiles = profiles;
  }

  /** Runs `fn` after every operation queued before it has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private get path(): string {
    return join(this.opts.home, SMART_MOUNTS_FILE);
  }

  private fresh(): State {
    return {
      version: 1,
      settings: SmartMountSettingsSchema.parse({}),
      since: {},
      parked: {},
      tools: {},
      changes: [],
      events: [],
    };
  }

  private read(): State {
    const fresh = this.fresh();
    if (!existsSync(this.path)) return fresh;
    try {
      const raw = StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      const settings = SmartMountSettingsSchema.safeParse(raw.settings);
      return {
        version: 1,
        settings: settings.success ? settings.data : fresh.settings,
        since: raw.since,
        parked: raw.parked,
        tools: raw.tools,
        changes: raw.changes,
        events: raw.events,
      };
    } catch (e) {
      this.opts.logger.warn({ err: (e as Error).message }, "smart-mounts.json unreadable: reset");
      return fresh;
    }
  }

  private write(state: State): void {
    const cutoff = new Date(this.now() - EVENTS_KEPT_DAYS * DAY_MS).toISOString();
    state.events = state.events.filter((e) => e.at >= cutoff).slice(-MAX_EVENTS);
    writeFileAtomicSync(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }

  private event(state: State, e: Omit<SmartEvent, "at">): void {
    state.events.push({ at: new Date(this.now()).toISOString(), ...e });
  }

  settings(): SmartMountSettings {
    return this.read().settings;
  }

  setSettings(patch: SmartMountSettingsPatch): SmartMountSettings {
    const state = this.read();
    state.settings = SmartMountSettingsSchema.parse({ ...state.settings, ...patch });
    this.write(state);
    return state.settings;
  }

  /** Looks at every mount and profile, records what it saw, and says what to change. */
  report(): Promise<SmartMountReport> {
    return this.serial(() => this.reportNow());
  }

  private async reportNow(): Promise<SmartMountReport> {
    // The mount list first: the state is read only after the last await, so a
    // change made meanwhile (setSettings, undo) is not written over.
    const mounts = await this.opts.mounts.listMounts();
    const state = this.read();
    const report = this.build(state, mounts);
    this.write(state);
    return report;
  }

  private build(state: State, mounts: MountInfo[]): SmartMountReport {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    const { settings } = state;
    const windowStart = new Date(now - USE_WINDOW_DAYS * DAY_MS).toISOString();
    const use = this.opts.usage.lastUseByVendor(
      [...new Set(mounts.map((m) => m.prefix))],
      windowStart,
    );
    const toolUse = this.opts.usage.useByTool(windowStart);
    const recentStart = new Date(now - FAILING_WINDOW_DAYS * DAY_MS).toISOString();
    const recentUse = this.opts.usage.useByTool(recentStart);
    const registry = this.opts.tools();

    // Tokens and tool list per mount, from the registry.
    const tokens = new Map<string, number>();
    const mountTools = new Map<string, RegisteredTool[]>();
    for (const t of registry) {
      const id = mountOf(t);
      if (!id) continue;
      tokens.set(id, (tokens.get(id) ?? 0) + toolTokens(t));
      const list = mountTools.get(id) ?? [];
      list.push(t);
      mountTools.set(id, list);
    }

    const ids = new Set(mounts.map((m) => m.id));
    for (const id of Object.keys(state.since)) if (!ids.has(id)) delete state.since[id];
    for (const id of Object.keys(state.parked)) if (!ids.has(id)) delete state.parked[id];
    for (const id of Object.keys(state.tools)) if (!ids.has(id)) delete state.tools[id];

    const insights: MountInsight[] = [];
    const suggestions: Suggestion[] = [];
    const suggested = new Set<string>();
    let enabledTokens = 0;
    let reclaimable = 0;
    const park = (s: Suggestion) => {
      suggestions.push(s);
      suggested.add(s.id);
      reclaimable += s.tokens ?? 0;
    };

    for (const m of mounts) {
      if (m.enabled) {
        // Switched on again after parking: a fresh grace period.
        if (state.parked[m.id]) {
          delete state.parked[m.id];
          state.since[m.id] = nowIso;
        }
        state.since[m.id] ??= nowIso;
      } else {
        delete state.since[m.id];
      }
      const own = mountTools.get(m.id);
      if (m.enabled && m.connected && own?.length) {
        state.tools[m.id] = own.slice(0, MAX_CACHED_TOOLS).map((t) => ({
          name: t.name,
          description: shortDescription(t.description),
        }));
      }
      const u = use.get(m.prefix);
      const lastUsedAt = u?.lastUsedAt ?? null;
      const onSince = state.since[m.id];
      const ref = Math.max(
        lastUsedAt ? Date.parse(lastUsedAt) : 0,
        onSince ? Date.parse(onSince) : 0,
      );
      const idleDays = m.enabled ? Math.max(0, Math.floor((now - ref) / DAY_MS)) : null;
      const est = m.enabled && m.connected ? (tokens.get(m.id) ?? 0) : 0;
      const kept = settings.keep.includes(m.id);
      const parked = state.parked[m.id];
      enabledTokens += est;
      insights.push({
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        connected: m.connected,
        tools: m.tools,
        est_tokens: est,
        last_used_at: lastUsedAt,
        calls_30d: u?.calls ?? 0,
        idle_days: idleDays,
        parked: parked
          ? { at: parked.at, idle_days: parked.idleDays, tokens: parked.tokens }
          : null,
        kept,
        category: categoryOf(m),
      });
      if (settings.mode === "off" || !m.enabled) continue;

      // Health first: a mount that is not connected costs no tokens and
      // cannot be called, so idle and heavy say nothing about it.
      if (!m.connected) {
        const missing = m.secrets.filter((s) => !s.present).map((s) => s.name);
        if (m.oauth && !m.oauth.signedIn && !m.oauth.pending) {
          suggestions.push({
            kind: "sign_in",
            key: `sign_in:${m.id}`,
            id: m.id,
            message:
              "switched on but signed out: sign in again on the Mounts page (connect_mount gives a link)",
          });
        } else if (missing.length) {
          suggestions.push({
            kind: "missing_key",
            key: `missing_key:${m.id}`,
            id: m.id,
            secrets: missing,
            message: `switched on but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set: the user sets ${missing.length === 1 ? "it" : "them"} on the Mounts page (never in chat)`,
          });
        } else if (m.error) {
          suggestions.push({
            kind: "failing",
            key: `failing:${m.id}`,
            id: m.id,
            message: `switched on but not connected (${m.error}): fix it on the Mounts page or disable it`,
          });
        }
        continue;
      }
      if (kept) continue;
      const tokenNote = est > 0 ? `, its tools cost ~${est} tokens in every tools/list` : "";
      if (idleDays !== null && idleDays >= settings.idleDays) {
        park({
          kind: "idle",
          key: `idle:${m.id}`,
          id: m.id,
          tokens: est,
          message: `not called for ${plural(idleDays, "day")}${tokenNote}: park it (disable_mount; enable_mount brings it back)`,
        });
      } else if (est >= HEAVY_TOKENS && (u?.calls ?? 0) < HEAVY_MAX_CALLS) {
        park({
          kind: "heavy",
          key: `heavy:${m.id}`,
          id: m.id,
          tokens: est,
          message: `${plural(m.tools, "tool")} cost ~${est} tokens in every tools/list for ${plural(u?.calls ?? 0, "call")} in ${USE_WINDOW_DAYS} days: park it, or serve it through a search-mode profile`,
        });
      }
    }

    if (settings.mode !== "off") {
      // A mount switched on recently has had no chance to be used.
      const settled = (id: string) => {
        const on = state.since[id];
        return on !== undefined && now - Date.parse(on) >= settings.idleDays * DAY_MS;
      };
      this.overlaps(insights, registry, toolUse, settings, suggested, settled, park);
      this.failingTools(mounts, recentUse, settings, suggestions);
      this.profileSuggestions(state, insights, registry, toolUse, suggested, suggestions, now);
    }

    // Drop changes whose profile is gone.
    if (this.profiles) {
      const live = new Set(this.profiles.list().map((p) => p.id));
      state.changes = state.changes.filter((c) => live.has(c.profile));
    }

    return {
      settings,
      mounts: insights,
      suggestions,
      changes: state.changes.map((c) => ({
        key: c.key,
        kind: c.kind,
        profile: c.profile,
        mount: c.mount,
        selectors: c.selectors,
        tokens: c.tokens,
        at: c.at,
      })),
      summary: this.summary(state, mounts, now),
      enabled_tokens: enabledTokens,
      reclaimable_tokens: reclaimable,
    };
  }

  /** Two mounts (or a mount and a built-in capability) that do the same job. */
  private overlaps(
    insights: MountInsight[],
    registry: readonly RegisteredTool[],
    toolUse: ToolUse[],
    settings: SmartMountSettings,
    suggested: Set<string>,
    settled: (id: string) => boolean,
    park: (s: Suggestion) => void,
  ): void {
    const callsByTool = new Map<string, number>();
    for (const r of toolUse) callsByTool.set(r.tool, (callsByTool.get(r.tool) ?? 0) + r.calls);
    for (const [key, category] of Object.entries(OVERLAP_CATEGORIES)) {
      const members: Array<{ id: string; calls: number; insight?: MountInsight }> = insights
        .filter((m) => m.category === key && m.enabled && m.connected)
        .map((m) => ({ id: m.id, calls: m.calls_30d, insight: m }));
      if (category.capability) {
        const builtin = registry.filter(
          (t) => t.origin !== "mounted" && t.capability === category.capability,
        );
        if (builtin.length) {
          members.push({
            id: `capability:${category.capability}`,
            calls: builtin.reduce((n, t) => n + (callsByTool.get(t.name) ?? 0), 0),
          });
        }
      }
      if (members.length < 2) continue;
      const keeper = members.reduce((a, b) => (b.calls > a.calls ? b : a));
      if (keeper.calls < OVERLAP_MIN_CALLS) continue;
      const keeperName = keeper.insight?.name ?? `the built-in ${category.label} tools`;
      for (const m of members) {
        const insight = m.insight;
        if (!insight || m === keeper) continue;
        if (suggested.has(m.id) || settings.keep.includes(m.id) || !settled(m.id)) continue;
        if (m.calls * OVERLAP_RATIO > keeper.calls) continue;
        park({
          kind: "overlap",
          key: `overlap:${m.id}`,
          id: m.id,
          tokens: insight.est_tokens,
          with: keeper.id,
          category: key,
          calls: m.calls,
          with_calls: keeper.calls,
          message: `does the same job (${category.label}) as ${keeperName}, which got ${plural(keeper.calls, "call")} to its ${m.calls} in ${USE_WINDOW_DAYS} days: park it and keep ${keeperName}`,
        });
      }
    }
  }

  /** Mounted tools that failed most of their calls in the last week. */
  private failingTools(
    mounts: MountInfo[],
    recentUse: ToolUse[],
    settings: SmartMountSettings,
    suggestions: Suggestion[],
  ): void {
    const byTool = new Map<string, { calls: number; errors: number }>();
    for (const r of recentUse) {
      const t = byTool.get(r.tool) ?? { calls: 0, errors: 0 };
      t.calls += r.calls;
      t.errors += r.errors;
      byTool.set(r.tool, t);
    }
    for (const m of mounts) {
      if (!m.enabled || settings.keep.includes(m.id)) continue;
      for (const [tool, t] of byTool) {
        if (!tool.startsWith(`${m.prefix}__`)) continue;
        if (t.calls < FAILING_TOOL_MIN_CALLS || t.errors / t.calls < FAILING_TOOL_RATE) continue;
        const rate = Math.round((t.errors / t.calls) * 100) / 100;
        suggestions.push({
          kind: "failing_tool",
          key: `failing_tool:${m.id}:${tool}`,
          id: m.id,
          tools: [tool],
          calls: t.calls,
          error_rate: rate,
          message: `${tool} failed ${t.errors} of its ${plural(t.calls, "call")} in ${FAILING_WINDOW_DAYS} days: check its key, sign-in or plan with the vendor, or hide it from profiles`,
        });
      }
    }
  }

  /** profile_unused, unused_tools and search_mode, for every list-mode profile. */
  private profileSuggestions(
    state: State,
    insights: MountInsight[],
    registry: readonly RegisteredTool[],
    toolUse: ToolUse[],
    suggested: Set<string>,
    suggestions: Suggestion[],
    now: number,
  ): void {
    if (!this.profiles) return;
    const { settings } = state;
    const reg = { list: () => [...registry] };
    const byId = new Map(insights.map((m) => [m.id, m]));
    // tool -> profiles that called it (null: outside a profile, counts for all)
    const callers = new Map<string, Set<string | null>>();
    for (const r of toolUse) {
      if (r.calls <= 0) continue;
      const set = callers.get(r.tool) ?? new Set();
      set.add(r.profile);
      callers.set(r.tool, set);
    }
    const usedBy = (tool: string, profile: string) => {
      const set = callers.get(tool);
      return set ? set.has(profile) || set.has(null) : false;
    };
    const usedByOthers = (tool: string, profile: string) => {
      const set = callers.get(tool);
      return set ? [...set].some((p) => p !== null && p !== profile) : false;
    };
    const applied = new Set(state.changes.map((c) => c.key));

    for (const p of this.profiles.list()) {
      const exposure = resolveExposure(p, reg);
      if (p.mode === "list" && exposure.directTokens > SEARCH_MODE_TOKENS) {
        const searchCost = resolveExposure({ ...p, mode: "search" }, reg).cost.totalTokens;
        const key = `search_mode:${p.id}`;
        if (!applied.has(key)) {
          suggestions.push({
            kind: "search_mode",
            key,
            id: p.id,
            profile: p.id,
            tokens: Math.max(0, exposure.cost.totalTokens - searchCost),
            message: `profile "${p.id}" lists ${plural(exposure.exposed.length, "tool")} costing ~${exposure.directTokens} tokens on every turn: switch it to auto, which serves them through search_tools above ${p.autoThresholdTokens} tokens (~${searchCost} tokens)`,
          });
        }
        continue;
      }
      if (exposure.mode !== "list") continue;

      const exposedByMount = new Map<string, RegisteredTool[]>();
      for (const t of exposure.exposed) {
        const id = mountOf(t);
        if (!id) continue;
        const list = exposedByMount.get(id) ?? [];
        list.push(t);
        exposedByMount.set(id, list);
      }
      for (const [mountId, tools] of exposedByMount) {
        const m = byId.get(mountId);
        if (!m || !m.enabled || !m.connected || m.kept || suggested.has(mountId)) continue;
        const onSince = state.since[mountId];
        // The same grace period as idle: a mount switched on recently has had
        // no chance to be used.
        if (!onSince || now - Date.parse(onSince) < settings.idleDays * DAY_MS) continue;
        const used = tools.filter((t) => usedBy(t.name, p.id));
        if (used.length === 0) {
          if (!tools.some((t) => usedByOthers(t.name, p.id))) continue;
          const key = `profile_unused:${p.id}:${mountId}`;
          if (applied.has(key)) continue;
          const cost = tools.reduce((n, t) => n + toolTokens(t), 0);
          suggestions.push({
            kind: "profile_unused",
            key,
            id: mountId,
            profile: p.id,
            tokens: cost,
            message: `other profiles call ${m.name}, profile "${p.id}" never did in ${USE_WINDOW_DAYS} days: hide it from "${p.id}" (~${cost} tokens a turn); calling one of its tools brings it back`,
          });
          continue;
        }
        const unused = tools.filter((t) => !usedBy(t.name, p.id));
        const cost = unused.reduce((n, t) => n + toolTokens(t), 0);
        if (unused.length < UNUSED_TOOLS_MIN || cost < UNUSED_TOOLS_MIN_TOKENS) continue;
        const key = `unused_tools:${p.id}:${mountId}`;
        if (applied.has(key)) continue;
        suggestions.push({
          kind: "unused_tools",
          key,
          id: mountId,
          profile: p.id,
          tools: unused.map((t) => t.name),
          tokens: cost,
          message: `profile "${p.id}" uses ${plural(used.length, "tool")} of ${m.name} but never ${unused.length === 1 ? "this one" : `these ${unused.length}`} in ${USE_WINDOW_DAYS} days: hide them from "${p.id}" (~${cost} tokens a turn); calling one brings it back`,
        });
      }
    }
  }

  private summary(state: State, mounts: MountInfo[], now: number): SmartSummary {
    const cutoff = new Date(now - SUMMARY_DAYS * DAY_MS).toISOString();
    const recent = state.events.filter((e) => e.at >= cutoff);
    const count = (...kinds: SmartEventKind[]) =>
      recent.filter((e) => kinds.includes(e.kind)).length;
    const off = new Set(mounts.filter((m) => !m.enabled).map((m) => m.id));
    const parkedTokens = Object.entries(state.parked)
      .filter(([id]) => off.has(id))
      .reduce((n, [, p]) => n + p.tokens, 0);
    const changeTokens = state.changes.reduce((n, c) => n + c.tokens, 0);
    return {
      days: SUMMARY_DAYS,
      parked: count("parked"),
      woken: count("woken", "shown"),
      hidden: count("hidden", "search_mode"),
      undone: count("undone"),
      saved_tokens: parkedTokens + changeTokens,
    };
  }

  /**
   * Switch off the given mounts and remember they were parked. Only mounts
   * the current report suggests parking (idle, heavy, overlap) are parked;
   * anything else in `ids` is returned in `skipped`.
   */
  park(ids?: readonly string[]): Promise<{ parked: string[]; skipped: string[] }> {
    return this.serial(() => this.parkNow(ids));
  }

  private async parkNow(ids?: readonly string[]): Promise<{ parked: string[]; skipped: string[] }> {
    const report = await this.reportNow();
    const parkable = new Map(
      report.suggestions.filter((s) => PARK_KINDS.includes(s.kind)).map((s) => [s.id, s]),
    );
    const wanted = ids ?? [...parkable.keys()];
    const parked: string[] = [];
    const skipped: string[] = [];
    for (const id of wanted) {
      const suggestion = parkable.get(id);
      if (!suggestion) {
        skipped.push(id);
        continue;
      }
      const insight = report.mounts.find((m) => m.id === id);
      await this.opts.mounts.setMountEnabled(id, false);
      const state = this.read();
      const tokens = insight?.est_tokens ?? 0;
      state.parked[id] = {
        at: new Date(this.now()).toISOString(),
        idleDays: insight?.idle_days ?? 0,
        lastUsedAt: insight?.last_used_at ?? null,
        tokens,
      };
      delete state.since[id];
      this.event(state, { kind: "parked", id, tokens });
      this.write(state);
      parked.push(id);
    }
    if (parked.length) this.opts.logger.info({ mounts: parked }, "smart mount parked mounts");
    return { parked, skipped };
  }

  /**
   * Apply profile suggestions (profile_unused, unused_tools, search_mode) by
   * key, or all of them. Returns what was applied and the keys it could not.
   */
  applyProfiles(keys?: readonly string[]): Promise<{ applied: string[]; skipped: string[] }> {
    return this.serial(() => this.applyProfilesNow(keys));
  }

  private async applyProfilesNow(
    keys?: readonly string[],
  ): Promise<{ applied: string[]; skipped: string[] }> {
    const profiles = this.profiles;
    const report = await this.reportNow();
    const open = new Map(
      report.suggestions.filter((s) => PROFILE_KINDS.includes(s.kind)).map((s) => [s.key, s]),
    );
    const wanted = keys ?? [...open.keys()];
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const key of wanted) {
      const s = open.get(key);
      const profile = s?.profile ? profiles?.get(s.profile) : undefined;
      if (!s || !profiles || !profile) {
        skipped.push(key);
        continue;
      }
      const state = this.read();
      const at = new Date(this.now()).toISOString();
      if (s.kind === "search_mode") {
        profiles.put({ ...profile, mode: "auto" });
        state.changes.push({
          key,
          kind: "search_mode",
          profile: profile.id,
          mount: null,
          selectors: [],
          previousMode: profile.mode,
          tokens: s.tokens ?? 0,
          at,
        });
        this.event(state, {
          kind: "search_mode",
          id: profile.id,
          profile: profile.id,
          tokens: s.tokens ?? 0,
        });
      } else {
        const selectors =
          s.kind === "profile_unused" ? [`mount:${s.id}`] : (s.tools ?? []).map((n) => `tool:${n}`);
        const added = selectors.filter((sel) => !profile.exclude.includes(sel));
        profiles.put({ ...profile, exclude: [...profile.exclude, ...added] });
        state.changes.push({
          key,
          kind: s.kind as ProfileChangeKind,
          profile: profile.id,
          mount: s.id,
          selectors: added,
          previousMode: null,
          tokens: s.tokens ?? 0,
          at,
        });
        this.event(state, { kind: "hidden", id: s.id, profile: profile.id, tokens: s.tokens ?? 0 });
      }
      this.write(state);
      applied.push(key);
    }
    if (applied.length) this.opts.logger.info({ changes: applied }, "smart mount changed profiles");
    return { applied, skipped };
  }

  /** Undo profile changes smart mount made, by key. */
  undo(keys: readonly string[], kind: "undone" | "shown" = "undone"): string[] {
    const profiles = this.profiles;
    const state = this.read();
    const done: string[] = [];
    for (const key of keys) {
      const c = state.changes.find((x) => x.key === key);
      if (!c) continue;
      const profile = profiles?.get(c.profile);
      if (profiles && profile) {
        if (c.kind === "search_mode") {
          if (c.previousMode && profile.mode === "auto") {
            profiles.put({ ...profile, mode: c.previousMode });
          }
        } else {
          profiles.put({
            ...profile,
            exclude: profile.exclude.filter((s) => !c.selectors.includes(s)),
          });
        }
      }
      state.changes = state.changes.filter((x) => x.key !== key);
      this.event(state, {
        kind,
        id: c.mount ?? c.profile,
        profile: c.profile,
        tokens: c.tokens,
      });
      done.push(key);
    }
    if (done.length) this.write(state);
    return done;
  }

  /**
   * The tools `profile` cannot see right now that smart mount can bring
   * back: the tools of parked mounts the profile would otherwise see, and
   * tools a smart mount change hides from it.
   */
  dormantTools(profile: Profile): DormantTool[] {
    const state = this.read();
    const out = new Map<string, DormantTool>();
    for (const id of Object.keys(state.parked)) {
      // The registry lists every mounted tool under one pack id.
      const packId = MOUNT_PACK_ID;
      for (const t of state.tools[id] ?? []) {
        const shape = {
          name: t.name,
          packId,
          origin: "mounted" as const,
          tags: [`mount:${id}`],
          capability: undefined,
        };
        if (!profileAllows(profile, shape)) continue;
        out.set(t.name, {
          ...shape,
          description: t.description,
          mount: id,
          reason: "parked",
        });
      }
    }
    const registry = this.opts.tools();
    for (const c of state.changes) {
      if (c.profile !== profile.id || c.selectors.length === 0) continue;
      const without = {
        ...profile,
        exclude: profile.exclude.filter((s) => !c.selectors.includes(s)),
      };
      for (const t of registry) {
        if (out.has(t.name)) continue;
        if (!c.selectors.some((s) => selectorMatches(s, t))) continue;
        if (!profileAllows(without, t)) continue;
        out.set(t.name, {
          name: t.name,
          description: shortDescription(t.description),
          packId: t.packId,
          origin: "mounted",
          tags: [...t.tags],
          mount: mountOf(t) ?? c.mount ?? "",
          reason: "hidden",
          change: c.key,
        });
      }
    }
    return [...out.values()];
  }

  /**
   * An agent asked for `name`, which `profile` cannot see. If smart mount
   * took it away, bring it back (wake "auto") or say how (wake "ask").
   */
  wake(profile: Profile, name: string): Promise<WakeResult> {
    return this.serial(() => this.wakeNow(profile, name));
  }

  private async wakeNow(profile: Profile, name: string): Promise<WakeResult> {
    const tool = this.dormantTools(profile).find((t) => t.name === name);
    if (!tool) return { status: "none" };
    const { settings } = this.read();
    if (tool.reason === "parked") {
      if (settings.wake === "ask") {
        return {
          status: "ask",
          tool,
          message: `${name} belongs to the mount ${tool.mount}, which smart mount parked (switched off) because it was not used. Ask the user whether to switch it back on, then call enable_mount with id "${tool.mount}" and try again.`,
        };
      }
      await this.opts.mounts.setMountEnabled(tool.mount, true);
      const state = this.read();
      const tokens = state.parked[tool.mount]?.tokens ?? 0;
      delete state.parked[tool.mount];
      state.since[tool.mount] = new Date(this.now()).toISOString();
      this.event(state, { kind: "woken", id: tool.mount, profile: profile.id, tokens });
      this.write(state);
      this.opts.logger.info({ mount: tool.mount, tool: name }, "smart mount woke a parked mount");
      return {
        status: "woken",
        tool,
        message: `the mount ${tool.mount} was parked and has been switched back on`,
      };
    }
    if (settings.wake === "ask") {
      return {
        status: "ask",
        tool,
        message: `${name} is hidden from this profile by smart mount because the profile never used it. Ask the user whether to show it again (Mounts page, or optimize_mounts with undo ["${tool.change}"]).`,
      };
    }
    this.undo([tool.change ?? ""], "shown");
    this.opts.logger.info(
      { profile: profile.id, tool: name },
      "smart mount showed a hidden tool again",
    );
    return {
      status: "woken",
      tool,
      message: `${name} was hidden from this profile by smart mount and is shown again`,
    };
  }

  /** In "auto" mode: park every mount idle for `idleDays`. */
  sweep(): Promise<string[]> {
    return this.serial(async () => {
      if (this.settings().mode !== "auto") return [];
      const report = await this.reportNow();
      // The user may have switched auto off while the report was made.
      if (this.settings().mode !== "auto") return [];
      const idle = report.suggestions.filter((s) => s.kind === "idle").map((s) => s.id);
      if (idle.length === 0) return [];
      return (await this.parkNow(idle)).parked;
    });
  }

  /** Run the sweep every hour (the first one a minute after start). */
  start(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.timer) return;
    const run = () => {
      this.sweep().catch((e) =>
        this.opts.logger.warn({ err: (e as Error).message }, "smart mount sweep failed"),
      );
    };
    const first = setTimeout(() => {
      run();
      this.timer = setInterval(run, intervalMs);
      this.timer.unref();
    }, 60_000);
    first.unref();
    this.timer = first;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
