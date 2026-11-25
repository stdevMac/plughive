import { describe, expect, it } from "vitest";
import {
  canInstallHere,
  installRequest,
  methodLabel,
  optionAction,
  optionTarget,
  sizeLabel,
  softwareState,
  softwareTags,
  sortSoftware,
  visibleGoals,
} from "../src/lib/software";
import type { SoftwareView } from "../src/lib/types";

function sw(over: Partial<SoftwareView>): SoftwareView {
  return {
    id: "x",
    name: "X",
    summary: "",
    version: "1.0",
    license: "MIT",
    size_mb: 10,
    gated: false,
    homepage: "https://example.org",
    tags: [],
    bins: ["x"],
    method: "archive",
    needs_approval: false,
    installed: false,
    managed: false,
    path: null,
    detected_version: null,
    ...over,
  };
}

describe("software helpers", () => {
  it("reads only a well-formed id from ?install=", () => {
    expect(installRequest(new URLSearchParams("install=yt-dlp"))).toBe("yt-dlp");
    expect(installRequest(new URLSearchParams("install=whisper.cpp"))).toBe("whisper.cpp");
    expect(installRequest(new URLSearchParams("install=../etc"))).toBeNull();
    expect(installRequest(new URLSearchParams("install=FFmpeg"))).toBeNull();
    expect(installRequest(new URLSearchParams("install=<script>"))).toBeNull();
    expect(installRequest(new URLSearchParams(""))).toBeNull();
  });

  it("formats sizes", () => {
    expect(sizeLabel(0.2)).toBe("1 MB");
    expect(sizeLabel(42)).toBe("42 MB");
    expect(sizeLabel(1500)).toBe("1.5 GB");
    expect(sizeLabel(12000)).toBe("12 GB");
  });

  it("says how a program installs and whether the button runs here", () => {
    for (const m of ["archive", "uv", "model", "brew", "winget"] as const)
      expect(canInstallHere({ method: m })).toBe(true);
    for (const m of ["apt", "link", "unsupported"] as const)
      expect(canInstallHere({ method: m })).toBe(false);
    expect(methodLabel({ method: "archive" })).toMatch(/checksum/);
    expect(methodLabel({ method: "apt" })).toMatch(/you run/);
    expect(methodLabel({ method: "model" })).toMatch(/^Model file.*checksum/);
  });

  it("works out the state", () => {
    expect(softwareState(sw({}))).toBe("missing");
    expect(softwareState(sw({ installed: true }))).toBe("installed");
    expect(softwareState(sw({ installed: true, running: true }))).toBe("running");
    expect(softwareState(sw({ job_id: "j1" }))).toBe("installing");
    expect(softwareState(sw({}), true)).toBe("installing");
  });

  it("sorts installed first, then installable, then command and link only", () => {
    const items = [
      sw({ id: "l", name: "L", method: "link" }),
      sw({ id: "a", name: "A", method: "apt" }),
      sw({ id: "z", name: "Z" }),
      sw({ id: "b", name: "B" }),
      sw({ id: "i", name: "I", installed: true, method: "link" }),
    ];
    expect(sortSoftware(items).map((s) => s.id)).toEqual(["i", "b", "z", "a", "l"]);
  });

  it("collects tags once, sorted", () => {
    expect(softwareTags([sw({ tags: ["video", "audio"] }), sw({ tags: ["audio"] })])).toEqual([
      "audio",
      "video",
    ]);
  });

  it("keeps the most used tags, not the first ones by name", () => {
    const items = [
      sw({ tags: ["agent", "video"] }),
      sw({ tags: ["audio", "video"] }),
      sw({ tags: ["container", "video"] }),
      sw({ tags: ["image"] }),
      sw({ tags: ["image"] }),
    ];
    expect(softwareTags(items, 2)).toEqual(["image", "video"]);
  });

  it("links plan options only to this dashboard or an https page", () => {
    expect(optionTarget({ how: { dashboard: "/software?install=ffmpeg", text: "" } })).toEqual({
      to: "/software?install=ffmpeg",
    });
    expect(optionTarget({ how: { dashboard: "//evil.example/x", text: "" } })).toBeNull();
    expect(optionTarget({ how: { url: "https://ollama.com/download", text: "" } })).toEqual({
      href: "https://ollama.com/download",
    });
    expect(optionTarget({ how: { url: "javascript:alert(1)", text: "" } })).toBeNull();
    expect(optionTarget({ how: { url: "http://example.org", text: "" } })).toBeNull();
  });

  it("names the action", () => {
    expect(optionAction({ needs: "install", name: "ffmpeg" })).toBe("Install ffmpeg");
    expect(optionAction({ needs: "key", name: "Gemini" })).toBe("Add the key");
    expect(optionAction({ needs: "login", name: "Drive" })).toBe("Connect Drive");
  });
});

describe("visibleGoals", () => {
  const goals = Array.from({ length: 9 }, (_, i) => ({ id: `g${i}` }));
  it("shows the first six and counts the rest", () => {
    const v = visibleGoals(goals, null, false);
    expect(v.shown.map((g) => g.id)).toEqual(["g0", "g1", "g2", "g3", "g4", "g5"]);
    expect(v.hidden).toBe(3);
  });
  it("shows all when expanded or when the pick is past the cut", () => {
    expect(visibleGoals(goals, null, true)).toMatchObject({ hidden: 0 });
    expect(visibleGoals(goals, "g7", false).shown).toHaveLength(9);
    expect(visibleGoals(goals, "g2", false).hidden).toBe(3);
  });
  it("needs no toggle for a short list", () => {
    expect(visibleGoals(goals.slice(0, 6), null, false)).toMatchObject({ hidden: 0 });
  });
});
