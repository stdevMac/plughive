import { describe, expect, it } from "vitest";
import { matchScore, rankItems } from "../src/lib/palette";

describe("command palette matching", () => {
  it("ranks prefix over word start over substring over fuzzy", () => {
    const prefix = matchScore("lib", "Library") ?? 0;
    const word = matchScore("lib", "Open library") ?? 0;
    const sub = matchScore("ibr", "Library") ?? 0;
    const fuzzy = matchScore("lby", "Library") ?? 0;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(fuzzy);
    expect(matchScore("zzz", "Library")).toBeNull();
    // Letters spread across a long name are not a match.
    expect(matchScore("libr", "elevenlabs_isolate_voice_or_dub")).toBeNull();
  });

  it("finds by hint and keywords, label first", () => {
    const items = [
      { id: "a", group: "Pages", label: "What agents see", hint: "Exposure" },
      { id: "b", group: "Pages", label: "Remote servers", keywords: "mounts mcp" },
      { id: "c", group: "Tools", label: "exposure_preview" },
    ];
    expect(rankItems(items, "exposure").map((i) => i.id)).toEqual(["c", "a"]);
    expect(rankItems(items, "mounts").map((i) => i.id)).toEqual(["b"]);
    // Keywords match at word starts only, not inside words.
    expect(rankItems(items, "ounts").map((i) => i.id)).toEqual([]);
    expect(rankItems(items, "").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("drops letters-in-order matches when something contains the query", () => {
    const items = [
      { id: "lib", group: "Pages", label: "Library" },
      { id: "tool", group: "Tools", label: "lip_sync_bridge" },
    ];
    expect(matchScore("libr", "lip_sync_bridge")).not.toBeNull();
    expect(rankItems(items, "libr").map((i) => i.id)).toEqual(["lib"]);
    // With no direct match, the fuzzy one still shows.
    expect(rankItems(items, "lpsy").map((i) => i.id)).toEqual(["tool"]);
  });
});
