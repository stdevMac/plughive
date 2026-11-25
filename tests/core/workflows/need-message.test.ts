import { describe, expect, it } from "vitest";
import { needMessage } from "../../../src/core/workflows/planner.js";

describe("needMessage no_provider", () => {
  it("names only the packs that really provide the capability", () => {
    const m = needMessage({
      type: "no_provider",
      capability: "chat",
      packs: ["gemini", "openrouter"],
    });
    expect(m).toBe(
      "no configured provider for chat: set up one of the packs that provide it (gemini, openrouter)",
    );
    expect(m).not.toContain("elevenlabs");
    expect(m).not.toContain("local pack");
  });

  it("points to setup_plan when no installed pack provides it", () => {
    expect(needMessage({ type: "no_provider", capability: "3d.generate" })).toContain("setup_plan");
  });
});
