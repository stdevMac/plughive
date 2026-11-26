import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import { humanError, oneLine } from "../src/lib/humanError";

describe("human errors", () => {
  it("turns a missing key into an Add-key link", () => {
    const e = new ApiError(
      400,
      "MISSING_SECRET",
      'Pack "fal" needs the secret FAL_KEY, which is not set.',
      [],
      { pack: "fal", secret: "FAL_KEY", label: "fal.ai API key" },
    );
    const h = humanError(e);
    expect(h.what).toMatch(/needs an API key/);
    expect(h.next?.to).toBe("/packs?pack=fal&key=1");
    expect(h.next?.label).toMatch(/^Add your .* key$/);
  });

  it("reads job error objects and provider failures", () => {
    expect(
      humanError({ code: "TOOL_ERROR", message: "fal returned 401 Unauthorized" }, { pack: "fal" })
        .next?.to,
    ).toBe("/packs?pack=fal&key=1");
    expect(oneLine({ code: "TOOL_ERROR", message: "HTTP 429 Too Many Requests" })).toMatch(
      /rate limiting/,
    );
    expect(
      oneLine({ code: "TOOL_ERROR", message: "Exhausted balance. Top up at fal.ai/billing" }),
    ).toMatch(/out of credit/);
    expect(humanError(new ApiError(0, "NETWORK", "Failed to fetch")).what).toMatch(
      /could not reach/,
    );
  });

  it("falls back to the first sentence", () => {
    expect(oneLine("The image was too large. Max is 10 MB. Retry")).toBe(
      "The image was too large.",
    );
    expect(oneLine("x".repeat(300)).length).toBeLessThanOrEqual(161);
    expect(oneLine(null)).toBe("Something went wrong.");
  });

  it("links to the key editor only for a tool error of a tool that uses a key (D-M14)", () => {
    for (const code of [
      "APPROVAL_DENIED",
      "APPROVAL_EXPIRED",
      "SPEND_BLOCKED",
      "UNAUTHORIZED",
      "HTTP_403",
      "PACK_ERROR",
    ]) {
      const h = humanError(
        new ApiError(403, code, "403 Forbidden: authentication or insufficient balance"),
        { pack: "fal" },
      );
      expect(h.next).toBeUndefined();
    }

    // Generic prose like "authentication", "403", "forbidden", "invalid key" on TOOL_ERROR.
    for (const msg of [
      "Target site returned 403 Forbidden",
      "Upstream page requires authentication",
      "JSON schema error: invalid key 'name'",
    ]) {
      expect(
        humanError({ code: "TOOL_ERROR", message: msg }, { pack: "web" }).next,
      ).toBeUndefined();
    }

    // Upstream network trouble inside a tool error is not "plughive is unreachable".
    expect(humanError({ code: "TOOL_ERROR", message: "network error" }).next?.to).not.toBe(
      "reload:",
    );

    // Tools with no secrets or non-pack namespaces (core, gateway) never link to a key editor.
    expect(
      humanError(
        { code: "TOOL_ERROR", message: "Upstream returned 401 Unauthorized" },
        { pack: "web", canUseKey: false },
      ).next,
    ).toBeUndefined();
    expect(
      humanError(
        { code: "TOOL_ERROR", message: "Upstream returned 401 Unauthorized" },
        { pack: "gateway" },
      ).next,
    ).toBeUndefined();
  });
});
