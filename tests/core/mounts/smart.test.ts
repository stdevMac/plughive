// Smart mount: idle, costly and duplicate mounts are found from the usage
// ledger and the tool definitions, suggested, and parked (switched off) only in
// auto mode or when asked; a parked mount switched on again gets a fresh grace
// period. Per profile it hides mounts and tools that profile never calls and
// moves costly list-mode profiles to auto; health suggestions name what to fix.
// Parked and hidden tools stay findable and come back when asked for, and
// every change can be undone.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MountInfo } from "../../../src/core/mounts/manager.js";
import {
  SMART_MOUNTS_FILE,
  SmartMounts,
  type Suggestion,
  categoryOf,
} from "../../../src/core/mounts/smart.js";
import { ProfileSchema, ProfileStore } from "../../../src/core/profiles.js";
import type { RegisteredTool } from "../../../src/core/tools/registry.js";
import { type ToolUse, UsageLedger } from "../../../src/lib/usage.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");

function mount(id: string, prefix: string, over: Partial<MountInfo> = {}): MountInfo {
  const [pack = "", mountId = ""] = id.split("/");
  return {
    id,
    pack,
    mountId,
    name: mountId,
    description: null,
    url: "https://x.example/mcp",
    transport: "http",
    prefix,
    auth: "header",
    docsUrl: null,
    enabled: true,
    mountable: true,
    note: null,
    secrets: [],
    source: pack === "user" ? "user" : "pack",
    command: null,
    connected: true,
    tools: 1,
    error: null,
    oauth: null,
    ...over,
  };
}

function tool(mountId: string, name: string, descriptionLength = 40): RegisteredTool {
  return {
    name,
    packId: "gateway",
    origin: "mounted",
    description: "d".repeat(descriptionLength),
    inputSchema: { type: "object" },
    tags: [`mount:${mountId}`],
    requiresSecrets: [],
    longRunning: false,
    input: {} as RegisteredTool["input"],
    run: async () => null,
  };
}

describe("smart mount", () => {
  let home: string;
  let now: number;
  let mounts: MountInfo[];
  let tools: RegisteredTool[];
  let lastUse: Map<string, { lastUsedAt: string; calls: number }>;
  let toolUse: ToolUse[];
  let profiles: ProfileStore | undefined;
  const switched: Array<[string, boolean]> = [];

  const smart = () =>
    new SmartMounts({
      home,
      mounts: {
        listMounts: async () => mounts,
        setMountEnabled: async (id, on) => {
          switched.push([id, on]);
          mounts = mounts.map((m) => (m.id === id ? { ...m, enabled: on, connected: on } : m));
        },
      },
      usage: {
        lastUseByVendor: () => lastUse,
        useByTool: (since) => toolUse.filter((r) => r.lastUsedAt >= since),
      },
      tools: () => tools,
      ...(profiles ? { profiles } : {}),
      logger: { info() {}, warn() {} },
      now: () => now,
    });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "smart-mounts-"));
    now = T0;
    mounts = [mount("mounts/exa", "exa"), mount("user/notes", "notes")];
    tools = [tool("mounts/exa", "exa__search"), tool("user/notes", "notes__find")];
    lastUse = new Map();
    toolUse = [];
    profiles = undefined;
    switched.length = 0;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("starts the idle clock when it first sees a mount on", async () => {
    const s = smart();
    const first = await s.report();
    expect(first.mounts.map((m) => m.idle_days)).toEqual([0, 0]);
    expect(first.suggestions).toEqual([]);

    now = T0 + 20 * DAY;
    lastUse.set("exa", { lastUsedAt: new Date(T0 + 19 * DAY).toISOString(), calls: 7 });
    const later = await s.report();
    expect(later.mounts.find((m) => m.id === "mounts/exa")).toMatchObject({
      idle_days: 1,
      calls_30d: 7,
    });
    expect(later.suggestions).toEqual([
      expect.objectContaining({ kind: "idle", id: "user/notes" }),
    ]);
    expect(later.suggestions[0]?.message).toMatch(/not called for 20 days/);
  });

  it("only suggests in suggest mode, and parks idle mounts in auto mode", async () => {
    const s = smart();
    await s.report();
    now = T0 + 15 * DAY;
    expect(await s.sweep()).toEqual([]);
    expect(switched).toEqual([]);

    s.setSettings({ mode: "auto", keep: ["mounts/exa"] });
    expect(await s.sweep()).toEqual(["user/notes"]);
    expect(switched).toEqual([["user/notes", false]]);
    const report = await s.report();
    expect(report.mounts.find((m) => m.id === "user/notes")?.parked).toMatchObject({
      idle_days: 15,
    });
    // Kept mounts are never suggested.
    expect(report.mounts.find((m) => m.id === "mounts/exa")?.kept).toBe(true);
    expect(report.suggestions).toEqual([]);
  });

  it("gives a mount switched back on a fresh grace period", async () => {
    const s = smart();
    await s.report();
    now = T0 + 30 * DAY;
    expect((await s.park(["user/notes"])).parked).toEqual(["user/notes"]);
    mounts = mounts.map((m) => (m.id === "user/notes" ? { ...m, enabled: true } : m));
    now = T0 + 31 * DAY;
    const r = await s.report();
    const notes = r.mounts.find((m) => m.id === "user/notes");
    expect(notes).toMatchObject({ parked: null, idle_days: 0 });
  });

  it("parks only what it suggests", async () => {
    const s = smart();
    await s.report();
    now = T0 + 2 * DAY;
    expect(await s.park(["mounts/exa"])).toEqual({ parked: [], skipped: ["mounts/exa"] });
    expect(switched).toEqual([]);
  });

  it("flags costly, rarely used mounts and failing ones", async () => {
    tools = [
      ...Array.from({ length: 10 }, (_, i) => tool("mounts/exa", `exa__t${i}`, 1500)),
      tool("user/notes", "notes__find"),
    ];
    mounts = [
      mount("mounts/exa", "exa", { tools: 10 }),
      mount("user/notes", "notes"),
      mount("user/broken", "broken", { connected: false, tools: 0, error: "connect ECONNREFUSED" }),
    ];
    lastUse.set("exa", { lastUsedAt: new Date(T0).toISOString(), calls: 2 });
    const r = await smart().report();
    expect(r.suggestions.map((x) => [x.kind, x.id])).toEqual([
      ["heavy", "mounts/exa"],
      ["failing", "user/broken"],
    ]);
    const exa = r.mounts.find((m) => m.id === "mounts/exa");
    expect(exa?.est_tokens).toBeGreaterThan(3000);
    expect(r.reclaimable_tokens).toBe(exa?.est_tokens);
    expect(r.enabled_tokens).toBeGreaterThan(r.reclaimable_tokens);
  });

  it("says nothing in off mode and survives a broken state file", async () => {
    writeFileSync(join(home, SMART_MOUNTS_FILE), "{not json");
    const s = smart();
    expect((await s.report()).settings.mode).toBe("suggest");
    s.setSettings({ mode: "off" });
    now = T0 + 100 * DAY;
    expect((await s.report()).suggestions).toEqual([]);
    expect(() => s.setSettings({ idleDays: 0 })).toThrow();
  });

  const iso = (ms: number) => new Date(ms).toISOString();
  const use = (tool: string, profile: string | null, calls: number, errors = 0): ToolUse => ({
    tool,
    profile,
    calls,
    errors,
    lastUsedAt: iso(now - DAY),
  });
  const kinds = (r: { suggestions: Suggestion[] }) => r.suggestions.map((x) => [x.kind, x.id]);
  const store = (...ps: Array<Record<string, unknown>>) => {
    const p = new ProfileStore();
    for (const x of ps) p.put(ProfileSchema.parse({ name: String(x.id), mode: "list", ...x }));
    return p;
  };

  it("puts catalog, user and described mounts in overlap categories", () => {
    expect(categoryOf({ mountId: "tavily", prefix: "tv", description: null })).toBe("web_search");
    expect(categoryOf({ mountId: "mine", prefix: "firecrawl", description: null })).toBe(
      "scraping",
    );
    expect(categoryOf({ mountId: "mine", prefix: "m", description: "Search the web fast" })).toBe(
      "web_search",
    );
    expect(categoryOf({ mountId: "mine", prefix: "m", description: "Notes" })).toBeNull();
  });

  it("suggests parking a duplicate the agent hardly uses, once its grace period is over", async () => {
    mounts = [mount("mounts/exa", "exa"), mount("mounts/tavily", "tavily")];
    tools = [tool("mounts/exa", "exa__search"), tool("mounts/tavily", "tavily__search")];
    const s = smart();
    await s.report();
    const used = (exa: number, tavily: number) => {
      lastUse.set("exa", { lastUsedAt: iso(now), calls: exa });
      lastUse.set("tavily", { lastUsedAt: iso(now), calls: tavily });
    };
    now = T0 + 3 * DAY;
    used(40, 2);
    // Switched on three days ago: too soon to call it a duplicate.
    expect((await s.report()).suggestions).toEqual([]);

    now = T0 + 20 * DAY;
    used(40, 2);
    const r = await s.report();
    expect(kinds(r)).toEqual([["overlap", "mounts/tavily"]]);
    expect(r.suggestions[0]).toMatchObject({
      key: "overlap:mounts/tavily",
      with: "mounts/exa",
      category: "web_search",
      calls: 2,
      with_calls: 40,
    });
    expect(r.mounts.find((m) => m.id === "mounts/tavily")?.category).toBe("web_search");
    expect(r.reclaimable_tokens).toBe(r.suggestions[0]?.tokens);

    // Close usage is not an overlap.
    used(40, 15);
    expect((await s.report()).suggestions).toEqual([]);
    used(40, 2);
    expect((await s.park(["mounts/tavily"])).parked).toEqual(["mounts/tavily"]);
  });

  it("counts a built-in capability as the one doing the job", async () => {
    mounts = [mount("mounts/exa", "exa")];
    tools = [
      tool("mounts/exa", "exa__search"),
      {
        ...tool("x/y", "web_search"),
        packId: "web",
        origin: "native",
        tags: [],
        capability: "web.search",
      },
    ];
    const s = smart();
    await s.report();
    now = T0 + 15 * DAY;
    lastUse.set("exa", { lastUsedAt: iso(now), calls: 1 });
    // The built-in was never used: it cannot be the keeper.
    expect((await s.report()).suggestions).toEqual([]);
    toolUse = [use("web_search", null, 12)];
    const r = await s.report();
    expect(r.suggestions).toEqual([
      expect.objectContaining({ kind: "overlap", id: "mounts/exa", with: "capability:web.search" }),
    ]);
    expect(r.suggestions[0]?.message).toMatch(/built-in web search tools/);
  });

  it("names what to fix on mounts that are on but not working", async () => {
    mounts = [
      mount("mounts/notion", "notion", {
        connected: false,
        tools: 0,
        oauth: { signedIn: false, pending: false } as MountInfo["oauth"],
      }),
      mount("mounts/exa", "exa", {
        connected: false,
        tools: 0,
        secrets: [
          { name: "EXA_API_KEY", present: false },
          { name: "OTHER", present: true },
        ],
      }),
      mount("user/off", "off", { enabled: false, connected: false, error: "nope" }),
    ];
    tools = [];
    const r = await smart().report();
    expect(kinds(r)).toEqual([
      ["sign_in", "mounts/notion"],
      ["missing_key", "mounts/exa"],
    ]);
    expect(r.suggestions[1]).toMatchObject({ secrets: ["EXA_API_KEY"] });
    expect(r.suggestions[1]?.message).toMatch(/Mounts page \(never in chat\)/);
    // Health suggestions are never parked.
    expect(await smart().park(["mounts/exa"])).toEqual({ parked: [], skipped: ["mounts/exa"] });
    expect(r.reclaimable_tokens).toBe(0);
  });

  it("flags a mounted tool that fails most of its calls this week", async () => {
    toolUse = [
      use("exa__search", null, 6, 5),
      use("exa__other", null, 6, 1),
      use("notes__find", "a", 3, 3),
      use("notes__find", "b", 2, 2),
    ];
    lastUse.set("exa", { lastUsedAt: iso(now), calls: 12 });
    lastUse.set("notes", { lastUsedAt: iso(now), calls: 5 });
    const r = await smart().report();
    expect(r.suggestions).toEqual([
      expect.objectContaining({
        kind: "failing_tool",
        key: "failing_tool:mounts/exa:exa__search",
        tools: ["exa__search"],
        calls: 6,
        error_rate: 0.83,
      }),
      // Calls from every profile are counted together.
      expect.objectContaining({ kind: "failing_tool", id: "user/notes", calls: 5, error_rate: 1 }),
    ]);
    // Older failures do not count.
    toolUse = [{ ...use("exa__search", null, 6, 6), lastUsedAt: iso(now - 8 * DAY) }];
    expect((await smart().report()).suggestions).toEqual([]);
  });

  it("hides a mount from a profile that never calls it, and brings it back on a call", async () => {
    profiles = store({ id: "pa" }, { id: "pb" });
    const s = smart();
    await s.report();
    now = T0 + 20 * DAY;
    lastUse.set("exa", { lastUsedAt: iso(now), calls: 9 });
    lastUse.set("notes", { lastUsedAt: iso(now), calls: 4 });
    toolUse = [
      use("exa__search", "pa", 5),
      use("exa__search", "pb", 4),
      use("notes__find", "pb", 4),
    ];
    const r = await s.report();
    const forPa = r.suggestions.filter((x) => x.profile === "pa");
    expect(forPa).toEqual([
      expect.objectContaining({
        kind: "profile_unused",
        key: "profile_unused:pa:user/notes",
        id: "user/notes",
      }),
    ]);
    expect(r.suggestions.filter((x) => x.profile === "pb")).toEqual([]);
    expect(forPa[0]?.tokens).toBeGreaterThan(0);

    expect(await s.applyProfiles(["profile_unused:pa:user/notes", "nope"])).toEqual({
      applied: ["profile_unused:pa:user/notes"],
      skipped: ["nope"],
    });
    const a = profiles.get("pa");
    expect(a?.exclude).toEqual(["mount:user/notes"]);
    const after = await s.report();
    expect(after.changes).toEqual([
      expect.objectContaining({
        key: "profile_unused:pa:user/notes",
        profile: "pa",
        mount: "user/notes",
        selectors: ["mount:user/notes"],
      }),
    ]);
    // Applied once: not suggested again.
    expect(after.suggestions.filter((x) => x.profile === "pa")).toEqual([]);
    expect(after.summary).toMatchObject({ hidden: 1, saved_tokens: forPa[0]?.tokens });

    // The hidden tool is still there to be found, and asking for it shows it again.
    if (!a) throw new Error("no profile a");
    expect(s.dormantTools(a)).toEqual([
      expect.objectContaining({ name: "notes__find", reason: "hidden", mount: "user/notes" }),
    ]);
    expect(s.dormantTools(profiles.get("pb") ?? a)).toEqual([]);
    expect(await s.wake(a, "exa__search")).toEqual({ status: "none" });
    expect(await s.wake(a, "notes__find")).toMatchObject({ status: "woken" });
    expect(profiles.get("pa")?.exclude).toEqual([]);
    const shown = await s.report();
    expect(shown.changes).toEqual([]);
    expect(shown.summary).toMatchObject({ hidden: 1, woken: 1, saved_tokens: 0 });
  });

  it("hides the tools of a mount a profile uses only in part", async () => {
    mounts = [mount("mounts/exa", "exa", { tools: 4 })];
    tools = [0, 1, 2, 3].map((i) => tool("mounts/exa", `exa__t${i}`, 900));
    profiles = store({ id: "pa", exclude: ["tool:other"] });
    const s = smart();
    await s.report();
    now = T0 + 20 * DAY;
    lastUse.set("exa", { lastUsedAt: iso(now), calls: 20 });
    toolUse = [use("exa__t0", "pa", 20)];
    const r = await s.report();
    const forPa = r.suggestions.filter((x) => x.profile === "pa");
    expect(forPa).toEqual([
      expect.objectContaining({
        kind: "unused_tools",
        key: "unused_tools:pa:mounts/exa",
        tools: ["exa__t1", "exa__t2", "exa__t3"],
      }),
    ]);
    expect(forPa[0]?.message).toMatch(/uses 1 tool of exa but never these 3/);
    await s.applyProfiles(["unused_tools:pa:mounts/exa"]);
    expect(profiles.get("pa")?.exclude).toEqual([
      "tool:other",
      "tool:exa__t1",
      "tool:exa__t2",
      "tool:exa__t3",
    ]);
    // Undo removes only what smart mount added.
    expect(s.undo(["unused_tools:pa:mounts/exa", "nope"])).toEqual(["unused_tools:pa:mounts/exa"]);
    expect(profiles.get("pa")?.exclude).toEqual(["tool:other"]);
    expect((await s.report()).summary.undone).toBe(1);
  });

  it("leaves small leftovers, search-mode profiles and fresh mounts alone", async () => {
    profiles = store({ id: "pa" }, { id: "ps", mode: "search" });
    const s = smart();
    await s.report();
    now = T0 + 5 * DAY;
    lastUse.set("exa", { lastUsedAt: iso(now), calls: 9 });
    lastUse.set("notes", { lastUsedAt: iso(now), calls: 4 });
    toolUse = [use("notes__find", "pb", 4), use("exa__search", "pa", 4)];
    // Only 5 days on: inside the 14-day grace period.
    expect((await s.report()).suggestions).toEqual([]);
    now = T0 + 20 * DAY;
    lastUse.set("exa", { lastUsedAt: iso(now), calls: 9 });
    lastUse.set("notes", { lastUsedAt: iso(now), calls: 4 });
    // Profile "ps" pays nothing for definitions; "pa" has no unused tool worth hiding
    // (no profile calls notes now: that is idle, not a profile matter).
    toolUse = [use("exa__search", "pa", 4)];
    const r = await s.report();
    expect(r.suggestions.filter((x) => x.profile === "pa" || x.profile === "ps")).toEqual([]);
    // The default profile never called exa while "pa" did: that one is worth hiding.
    expect(kinds(r)).toEqual([["profile_unused", "mounts/exa"]]);
  });

  it("moves a costly list-mode profile to auto, and back on undo", async () => {
    mounts = [mount("mounts/exa", "exa", { tools: 60 })];
    tools = Array.from({ length: 60 }, (_, i) => tool("mounts/exa", `exa__t${i}`, 1500));
    profiles = store({ id: "big" });
    lastUse.set("exa", { lastUsedAt: iso(now), calls: 50 });
    const s = smart();
    const r = await s.report();
    const sm = r.suggestions.find((x) => x.kind === "search_mode");
    expect(sm).toMatchObject({ key: "search_mode:big", id: "big", profile: "big" });
    expect(sm?.tokens).toBeGreaterThan(15_000);
    // The default profile is auto already: nothing to suggest for it.
    expect(r.suggestions.filter((x) => x.profile === "default")).toEqual([]);

    await s.applyProfiles(["search_mode:big"]);
    expect(profiles.get("big")?.mode).toBe("auto");
    const after = await s.report();
    expect(after.changes.map((c) => c.key)).toEqual(["search_mode:big"]);
    expect(after.suggestions.find((x) => x.kind === "search_mode")).toBeUndefined();
    s.undo(["search_mode:big"]);
    expect(profiles.get("big")?.mode).toBe("list");

    // A deleted profile's changes are dropped.
    await s.applyProfiles(["search_mode:big"]);
    profiles.delete("big");
    expect((await s.report()).changes).toEqual([]);
  });

  it("keeps a parked mount's tools findable and switches it back on when one is asked for", async () => {
    profiles = store({ id: "media", include: ["mount:mounts/exa"] });
    const s = smart();
    await s.report();
    now = T0 + 30 * DAY;
    expect((await s.park(["user/notes"])).parked).toEqual(["user/notes"]);
    tools = tools.filter((t) => !t.tags.includes("mount:user/notes"));
    const all = profiles.get("default");
    const media = profiles.get("media");
    if (!all || !media) throw new Error("profiles missing");

    expect(s.dormantTools(all)).toEqual([
      expect.objectContaining({
        name: "notes__find",
        packId: "gateway",
        mount: "user/notes",
        reason: "parked",
        tags: ["mount:user/notes"],
      }),
    ]);
    // A profile that would not see the mount does not get its tools either.
    expect(s.dormantTools(media)).toEqual([]);
    expect(await s.wake(media, "notes__find")).toEqual({ status: "none" });

    s.setSettings({ wake: "ask" });
    const asked = await s.wake(all, "notes__find");
    expect(asked).toMatchObject({ status: "ask" });
    expect(asked.status === "ask" && asked.message).toMatch(/enable_mount with id "user\/notes"/);
    expect(switched).toEqual([["user/notes", false]]);

    s.setSettings({ wake: "auto" });
    expect(await s.wake(all, "notes__find")).toMatchObject({ status: "woken" });
    expect(switched).toEqual([
      ["user/notes", false],
      ["user/notes", true],
    ]);
    expect(s.dormantTools(all)).toEqual([]);
    const r = await s.report();
    expect(r.mounts.find((m) => m.id === "user/notes")).toMatchObject({
      parked: null,
      idle_days: 0,
    });
    expect(r.summary).toMatchObject({ days: 7, parked: 1, woken: 1 });
  });

  it("sums up the week and what parked mounts save now", async () => {
    tools = [tool("mounts/exa", "exa__search"), tool("user/notes", "notes__find", 2000)];
    const s = smart();
    await s.report();
    now = T0 + 20 * DAY;
    const before = (await s.report()).mounts.find((m) => m.id === "user/notes")?.est_tokens;
    await s.park();
    const r = await s.report();
    expect(r.summary).toMatchObject({ parked: 2, woken: 0, hidden: 0 });
    expect(r.summary.saved_tokens).toBeGreaterThanOrEqual(before ?? 0);
    expect(r.mounts.find((m) => m.id === "user/notes")?.parked?.tokens).toBe(before);
    // Older than a week: out of the counts, the savings stay while parked.
    now = T0 + 30 * DAY;
    expect((await s.report()).summary).toMatchObject({ parked: 0 });
  });

  it("forgets mounts that were removed", async () => {
    const s = smart();
    await s.report();
    now = T0 + 20 * DAY;
    await s.park(["user/notes"]);
    mounts = mounts.filter((m) => m.id !== "user/notes");
    await s.report();
    const state = JSON.parse(readFileSync(join(home, SMART_MOUNTS_FILE), "utf8"));
    expect(Object.keys(state.parked)).toEqual([]);
    expect(Object.keys(state.tools)).toEqual(["mounts/exa"]);
    expect(Object.keys(state.since)).toEqual(["mounts/exa"]);
  });

  it("R4-H2: a settings change made while a report waits for the mount list is kept", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = new SmartMounts({
      home,
      mounts: {
        listMounts: async () => {
          await gate;
          return mounts;
        },
        setMountEnabled: async () => {},
      },
      usage: { lastUseByVendor: () => lastUse, useByTool: () => [] },
      tools: () => tools,
      logger: { info() {}, warn() {} },
      now: () => now,
    });
    const pending = s.report();
    await new Promise((r) => setImmediate(r));
    s.setSettings({ wake: "ask", keep: ["mounts/exa"] });
    release();
    await pending;
    expect(s.settings()).toMatchObject({ wake: "ask", keep: ["mounts/exa"] });
  });

  it("R4-H2: concurrent park, wake and report run one at a time and lose nothing", async () => {
    const s = smart();
    await s.report();
    now = T0 + 20 * DAY;
    const [parked] = await Promise.all([s.park(["user/notes"]), s.report(), s.report()]);
    expect(parked.parked).toEqual(["user/notes"]);
    s.setSettings({ wake: "ask" });
    await Promise.all([s.report(), s.sweep(), s.report()]);
    const state = JSON.parse(readFileSync(join(home, SMART_MOUNTS_FILE), "utf8"));
    expect(state.settings.wake).toBe("ask");
    expect(Object.keys(state.parked)).toEqual(["user/notes"]);
    expect(state.events.filter((e: { kind: string }) => e.kind === "parked")).toHaveLength(1);
  });

  it("reads a state file from before profile changes and wake", async () => {
    writeFileSync(
      join(home, SMART_MOUNTS_FILE),
      JSON.stringify({
        version: 1,
        settings: { mode: "suggest", idleDays: 10, keep: [] },
        since: { "mounts/exa": iso(T0) },
        parked: { "user/notes": { at: iso(T0), idleDays: 3, lastUsedAt: null } },
      }),
    );
    mounts = mounts.map((m) => (m.id === "user/notes" ? { ...m, enabled: false } : m));
    const r = await smart().report();
    expect(r.settings).toEqual({ mode: "suggest", idleDays: 10, keep: [], wake: "auto" });
    expect(r.mounts.find((m) => m.id === "user/notes")?.parked).toEqual({
      at: iso(T0),
      idle_days: 3,
      tokens: 0,
    });
  });
});

describe("UsageLedger.lastUseByVendor", () => {
  let root: string;
  let usage: UsageLedger;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "usage-vendor-"));
    usage = new UsageLedger({ root });
  });
  afterEach(() => {
    usage.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("gives the last call and the calls in the window per vendor", () => {
    usage.record({ tool: "exa__search", vendor: "exa", latencyMs: 1, status: "ok" });
    usage.record({ tool: "exa__search", vendor: "exa", latencyMs: 1, status: "error" });
    usage.record({ tool: "other__x", vendor: "other", latencyMs: 1, status: "ok" });
    const since = new Date(Date.now() - DAY).toISOString();
    const out = usage.lastUseByVendor(["exa", "nobody"], since);
    expect(out.get("exa")?.calls).toBe(2);
    expect(out.has("nobody")).toBe(false);
    expect(out.has("other")).toBe(false);
    expect(
      usage.lastUseByVendor(["exa"], new Date(Date.now() + DAY).toISOString()).get("exa")?.calls,
    ).toBe(0);
  });
});

describe("UsageLedger.useByTool", () => {
  let root: string;
  let usage: UsageLedger;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "usage-tool-"));
    usage = new UsageLedger({ root });
  });
  afterEach(() => {
    usage.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("gives calls and errors per tool and profile", () => {
    usage.record({ tool: "exa__search", vendor: "exa", latencyMs: 1, status: "ok", profile: "a" });
    usage.record({
      tool: "exa__search",
      vendor: "exa",
      latencyMs: 1,
      status: "error",
      profile: "a",
    });
    usage.record({ tool: "exa__search", vendor: "exa", latencyMs: 1, status: "ok" });
    const since = new Date(Date.now() - DAY).toISOString();
    const rows = usage
      .useByTool(since)
      .sort((x, y) => String(x.profile).localeCompare(String(y.profile)));
    expect(rows).toEqual([
      expect.objectContaining({ tool: "exa__search", profile: "a", calls: 2, errors: 1 }),
      expect.objectContaining({ tool: "exa__search", profile: null, calls: 1, errors: 0 }),
    ]);
    expect(usage.useByTool(new Date(Date.now() + DAY).toISOString())).toEqual([]);
  });
});
