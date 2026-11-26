import { describe, expect, it } from "vitest";
import { initialConsentGrants, toggleConsentGrant, toolNeedsConfirm } from "../src/lib/packs";

describe("consent secret grants (N-L1)", () => {
  it("excludes non-grantable secrets even when required or previously granted", () => {
    const secrets = [
      { name: "OPENAI_API_KEY", required: true, granted: true, grantable: false },
      { name: "CUSTOM_KEY", required: true, granted: false, grantable: true },
      { name: "OPT_KEY", required: false, granted: false, grantable: true },
      { name: "LEGACY_KEY", required: true, granted: false },
    ];
    expect([...initialConsentGrants(secrets)].sort()).toEqual(["CUSTOM_KEY", "LEGACY_KEY"]);
  });

  it("refuses toggling a non-grantable secret on", () => {
    const blocked = { name: "OPENAI_API_KEY", required: true, granted: false, grantable: false };
    const allowed = { name: "CUSTOM_KEY", required: false, granted: false, grantable: true };
    const start = new Set<string>(["OPENAI_API_KEY"]);
    expect([...toggleConsentGrant(start, blocked, true)]).toEqual([]);
    expect([...toggleConsentGrant(new Set<string>(), allowed, true)]).toEqual(["CUSTOM_KEY"]);
    expect([...toggleConsentGrant(new Set(["CUSTOM_KEY"]), allowed, false)]).toEqual([]);
  });
});

describe("toolNeedsConfirm (D-M14)", () => {
  it("requires confirmation for destructiveHint or sends tools", () => {
    expect(toolNeedsConfirm({ annotations: { destructiveHint: true }, tags: [] })).toBe(true);
    expect(toolNeedsConfirm({ annotations: { destructiveHint: false }, tags: ["sends"] })).toBe(
      true,
    );
    expect(
      toolNeedsConfirm({ annotations: { readOnlyHint: true, destructiveHint: false }, tags: [] }),
    ).toBe(false);
    expect(toolNeedsConfirm({ annotations: null, tags: ["paid"] })).toBe(false);
  });
});
