import { describe, expect, it } from "vitest";
import {
  buildGroups,
  contextShare,
  diffProfiles,
  enabledTools,
  groupState,
  matchesSelector,
  normalizeSelection,
  selectionChanges,
  toggleGroup,
  toggleTool,
} from "../src/lib/composer";
import type { Profile, ToolInfo } from "../src/lib/types";

const tool = (name: string, pack: string, extra: Partial<ToolInfo> = {}): ToolInfo => ({
  name,
  pack,
  origin: "pack",
  description: "",
  tags: [],
  capability: null,
  requires_secrets: [],
  long_running: false,
  input_schema: {},
  ...extra,
});

const TOOLS: ToolInfo[] = [
  tool("gateway_status", "core", { origin: "core" }),
  tool("list_artifacts", "core", { origin: "core" }),
  tool("fal_image", "fal", { capability: "image.generate" }),
  tool("fal_video", "fal"),
  tool("fal_upscale", "fal"),
  tool("rep_image", "replicate", { capability: "image.generate" }),
  tool("gh_issue", "user", { origin: "mounted", tags: ["mount:github"] }),
  tool("thumbs", "workflows", { tags: ["workflow:thumbs"] }),
];

const profile = (p: Partial<Profile> = {}): Profile => ({
  id: "p",
  name: "P",
  mode: "list",
  include: ["*"],
  exclude: [],
  pinned: [],
  autoThresholdTokens: 8000,
  autoThresholdTools: 40,
  ...p,
});

describe("selectors", () => {
  it("follows the daemon's rules", () => {
    const [core, , fal, , , , gh, wf] = TOOLS as [
      ToolInfo,
      ToolInfo,
      ToolInfo,
      ToolInfo,
      ToolInfo,
      ToolInfo,
      ToolInfo,
      ToolInfo,
    ];
    expect(matchesSelector("*", core)).toBe(true);
    expect(matchesSelector("pack:fal", fal)).toBe(true);
    expect(matchesSelector("pack:fal", core)).toBe(false);
    expect(matchesSelector("capability:image.generate", fal)).toBe(true);
    expect(matchesSelector("capability:*", core)).toBe(false);
    expect(matchesSelector("mount:github", gh)).toBe(true);
    expect(matchesSelector("mount:*", fal)).toBe(false);
    expect(matchesSelector("workflow:*", wf)).toBe(true);
    expect(matchesSelector("nonsense", core)).toBe(false);
  });

  it("exclude wins over include", () => {
    const on = enabledTools({ include: ["pack:fal"], exclude: ["tool:fal_video"] }, TOOLS);
    expect([...on].sort()).toEqual(["fal_image", "fal_upscale"]);
  });
});

describe("groups and tri-state", () => {
  const groups = buildGroups(TOOLS);
  const fal = groups.find((g) => g.id === "pack:fal");
  if (!fal) throw new Error("no fal group");

  it("puts every tool in exactly one group, core first", () => {
    expect(groups.map((g) => g.id)).toEqual([
      "pack:core",
      "pack:fal",
      "pack:replicate",
      "workflow:thumbs",
      "mount:github",
    ]);
    expect(groups.flatMap((g) => g.tools).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("reports on, off and mixed", () => {
    expect(groupState(fal, new Set())).toBe("off");
    expect(groupState(fal, new Set(["fal_image"]))).toBe("mixed");
    expect(groupState(fal, new Set(fal.tools))).toBe("on");
  });

  it("a mixed or off group turns fully on; a full group turns off", () => {
    const mixed = new Set(["fal_image", "gateway_status"]);
    const on = toggleGroup(fal, mixed);
    expect(groupState(fal, on)).toBe("on");
    expect(on.has("gateway_status")).toBe(true);
    const off = toggleGroup(fal, on);
    expect(groupState(fal, off)).toBe("off");
    expect(off.has("gateway_status")).toBe(true);
    expect(groupState(fal, toggleGroup(fal, new Set()))).toBe("on");
  });

  it("toggles single tools without touching the input set", () => {
    const start = new Set(["fal_image"]);
    const next = toggleTool("fal_video", start);
    expect(groupState(fal, next)).toBe("mixed");
    expect(start.size).toBe(1);
    expect(toggleTool("fal_image", start).size).toBe(0);
  });
});

describe("normalizeSelection", () => {
  const groups = buildGroups(TOOLS);

  it("uses everything-except when most tools are on", () => {
    const enabled = new Set(
      TOOLS.map((t) => t.name).filter((n) => n !== "fal_video" && !n.startsWith("rep_")),
    );
    const sel = normalizeSelection(enabled, TOOLS, groups, profile());
    expect(sel.include).toEqual(["*"]);
    expect(sel.exclude.sort()).toEqual(["pack:replicate", "tool:fal_video"]);
    expect(enabledTools(sel, TOOLS)).toEqual(enabled);
  });

  it("uses an allow list when few tools are on, naming whole groups by selector", () => {
    const enabled = new Set(["fal_image", "fal_video", "fal_upscale", "gateway_status"]);
    const sel = normalizeSelection(enabled, TOOLS, groups, profile({ include: ["pack:core"] }));
    expect(sel.include.sort()).toEqual(["pack:fal", "tool:gateway_status"]);
    expect(sel.exclude).toEqual([]);
    expect(enabledTools(sel, TOOLS)).toEqual(enabled);
  });

  it("keeps selectors that match nothing loaded today", () => {
    const sel = normalizeSelection(
      new Set(["gateway_status"]),
      TOOLS,
      groups,
      profile({ include: ["pack:openrouter"], exclude: ["mount:gone"] }),
    );
    expect(sel.include).toContain("pack:openrouter");
    expect(sel.exclude).toContain("mount:gone");
  });
});

describe("diff", () => {
  it("compares selector lists as sets", () => {
    const saved = profile({ include: ["pack:fal", "pack:core"] });
    expect(diffProfiles(saved, profile({ include: ["pack:core", "pack:fal"] }))).toEqual([]);
    expect(
      diffProfiles(
        saved,
        profile({
          include: ["pack:core"],
          mode: "search",
          pinned: ["fal_image"],
          autoThresholdTools: 10,
        }),
      ),
    ).toEqual(["mode", "include", "pinned", "autoThresholdTools"]);
  });

  it("lists added and removed tools, sorted", () => {
    expect(selectionChanges(new Set(["b", "a", "c"]), new Set(["c", "e", "d"]))).toEqual({
      added: ["d", "e"],
      removed: ["a", "b"],
    });
  });

  it("describes context share in plain words", () => {
    expect(contextShare(0).label).toBe("about 0% of a 200k context");
    expect(contextShare(1000).label).toBe("less than 1% of a 200k context");
    expect(contextShare(5000).label).toBe("about 2.5% of a 200k context");
    expect(contextShare(50_000).label).toBe("about 25% of a 200k context");
  });
});
