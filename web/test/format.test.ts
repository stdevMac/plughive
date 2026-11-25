import { describe, expect, it } from "vitest";
import { artifactSource, displayName } from "../src/lib/format";

describe("displayName", () => {
  it("names the known packs and providers", () => {
    expect(displayName("openrouter")).toBe("OpenRouter");
    expect(displayName("finance-data")).toBe("Market data");
    expect(displayName("cli-bridge")).toBe("Agent CLIs");
    expect(displayName("stock")).toBe("Stock media");
    expect(displayName("browser")).toBe("Cloud browsers");
    expect(displayName("share")).toBe("Share links");
    expect(displayName("sandbox")).toBe("Sandboxes");
    expect(displayName("email")).toBe("Email");
  });
  it("capitalizes anything else", () => {
    expect(displayName("acme")).toBe("Acme");
    expect(displayName("")).toBe("");
  });

  it("names router output by pack and capability, with no tool to open", () => {
    expect(artifactSource("local/provider:image.upscale")).toEqual({
      label: "Local · image.upscale",
      tool: null,
    });
    expect(artifactSource("import_artifact")).toEqual({
      label: "import_artifact",
      tool: "import_artifact",
    });
  });
});
