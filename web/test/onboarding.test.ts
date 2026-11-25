import { describe, expect, it } from "vitest";
import {
  agentNames,
  agentSummary,
  doneCount,
  firstOpen,
  goalSummary,
  keySummary,
  makesImages,
  suggestTool,
  toggleOpen,
} from "../src/lib/onboarding";

const none = { connect: false, goal: false, key: false, try: false };

describe("first-run checklist", () => {
  it("opens the first item not done, in path order", () => {
    expect(firstOpen(none)).toBe("connect");
    expect(firstOpen({ ...none, connect: true })).toBe("goal");
    expect(firstOpen({ ...none, connect: true, goal: true })).toBe("key");
    expect(firstOpen({ connect: true, goal: true, key: true, try: false })).toBe("try");
    expect(firstOpen({ connect: true, goal: true, key: true, try: true })).toBeNull();
  });

  it("moves past a step put off for later, wrapping to an earlier one", () => {
    expect(firstOpen(none, "connect")).toBe("goal");
    expect(firstOpen(none, "goal")).toBe("key");
    expect(firstOpen({ ...none, goal: true, key: true }, "connect")).toBe("try");
    expect(firstOpen({ connect: false, goal: true, key: true, try: true }, "connect")).toBe(
      "connect",
    );
  });

  it("counts done items", () => {
    expect(doneCount(none)).toBe(0);
    expect(doneCount({ connect: true, goal: false, key: false, try: true })).toBe(2);
  });

  it("names connected agents once each", () => {
    const names = agentNames([{ name: "cursor" }, { name: "claude-code" }, { name: "cursor" }]);
    expect(names).toEqual(["cursor", "claude-code"]);
    expect(agentSummary([])).toMatch(/No agent/);
    expect(agentSummary(["cursor"])).toBe("cursor is connected.");
    expect(agentSummary(["a", "b"])).toBe("a and b are connected.");
    expect(agentSummary(["a", "b", "c", "d"])).toBe("a, b and 2 more are connected.");
  });

  it("summarises the goal item", () => {
    expect(goalSummary({ title: "Edit images" }, false)).toMatch(/^Edit images\./);
    expect(goalSummary(null, true)).toMatch(/setup_plan/);
    expect(goalSummary(null, false)).toMatch(/Pick what you want/);
  });

  it("summarises the key item", () => {
    expect(keySummary(false, ["fal"])).toBe("Key added for fal.");
    expect(keySummary(true, [])).toMatch(/Skipped/);
    expect(keySummary(false, [])).toMatch(/One key/);
  });

  it("suggests an image tool from a keyed pack, else the free check", () => {
    const packs = [
      { id: "fal", tools: ["fal_video_generate", "fal_image_generate"] },
      { id: "gemini", tools: ["gemini_transcribe"] },
    ];
    expect(suggestTool(packs, ["fal"])).toBe("fal_image_generate");
    expect(suggestTool(packs, ["gemini"])).toBe("gemini_transcribe");
    const fal = [
      {
        id: "fal",
        tools: [
          "fal_run",
          "fal_search_models",
          "fal_kling_video_v3_pro_image_to_video",
          "fal_nano_banana_pro_edit",
          "fal_flux_dev",
        ],
      },
    ];
    expect(suggestTool(fal, ["fal"])).toBe("fal_flux_dev");
    expect(makesImages("fal_flux_dev")).toBe(true);
    expect(makesImages("gateway_status")).toBe(false);
    expect(suggestTool(packs, [])).toBe("gateway_status");
  });

  it("keeps one provider form open at a time", () => {
    expect(toggleOpen(null, "fal")).toBe("fal");
    expect(toggleOpen("fal", "fal")).toBeNull();
    expect(toggleOpen("fal", "gemini")).toBe("gemini");
  });
});
