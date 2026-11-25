import { describe, expect, it } from "vitest";
import {
  capabilityLabel,
  freeFirstOrders,
  orderedProviders,
  shortHint,
  wouldUse,
} from "../src/lib/capabilities";
import type { Capability, CapabilityProvider } from "../src/lib/types";

function p(id: string, over: Partial<CapabilityProvider> = {}): CapabilityProvider {
  return {
    capability: "image.generate",
    id,
    pack: id,
    priority: 0,
    configured: true,
    autoRoute: true,
    cost: "paid",
    coolingDownUntil: null,
    ...over,
  };
}

function cap(providers: CapabilityProvider[], over: Partial<Capability> = {}): Capability {
  return { name: "image.generate", preference: [], providers, ...over };
}

describe("preferred services", () => {
  it("orders by the saved preference, then the daemon's order", () => {
    const c = cap([p("a"), p("b"), p("c")], { preference: ["c"] });
    expect(orderedProviders(c).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("uses the server's answer for what runs now", () => {
    const c = cap([p("a"), p("b")], { wouldUse: "b" });
    expect(wouldUse(c)?.id).toBe("b");
    expect(wouldUse(cap([p("a")], { wouldUse: null }))).toBeNull();
  });

  it("works out what runs now without the server's answer", () => {
    const later = new Date(Date.now() + 60_000).toISOString();
    const c = cap([
      p("missing", { configured: false }),
      p("named", { autoRoute: false }),
      p("cool", { coolingDownUntil: later }),
      p("ok"),
    ]);
    expect(wouldUse(c)?.id).toBe("ok");
    // Every ready one rate limited: the first is still what a call tries.
    expect(wouldUse(cap([p("cool", { coolingDownUntil: later })]))?.id).toBe("cool");
    expect(wouldUse(cap([p("missing", { configured: false })]))).toBeNull();
  });

  it("free first puts local services on top and leaves opt-in ones out", () => {
    const caps = [
      cap([
        p("fal"),
        p("local", { cost: "local" }),
        p("bridge", { autoRoute: false, cost: "account" }),
      ]),
      cap([p("local", { cost: "local" }), p("fal")], { name: "image.edit" }),
      cap([p("only", { cost: "local" })], { name: "image.upscale" }),
    ];
    expect(freeFirstOrders(caps)).toEqual({ "image.generate": ["local", "fal"] });
    // An opt-in service the user already listed keeps its place after local ones.
    const listed = cap(
      [p("bridge", { autoRoute: true, cost: "account" }), p("local", { cost: "local" })],
      { name: "chat", preference: ["bridge"] },
    );
    expect(freeFirstOrders([listed])).toEqual({ chat: ["local", "bridge"] });
  });
});

describe("shortHint", () => {
  it("keeps the first sentence and capitalises it", () => {
    expect(shortHint("install ffmpeg (lanczos). Install it from the Software page.")).toBe(
      "Install ffmpeg (lanczos)",
    );
    expect(
      shortHint(
        "start Ollama and pull a model (setting ollamaUrl, default http://127.0.0.1:11434)",
      ),
    ).toBe("Start Ollama and pull a model (setting ollamaUrl, default http://127.0.0.1:11434)");
    expect(shortHint("  ")).toBeNull();
    expect(shortHint(null)).toBeNull();
  });
});

describe("capabilityLabel", () => {
  it("names known capabilities in plain words and falls back for new ones", () => {
    expect(capabilityLabel("image.upscale").title).toBe("Upscale images");
    expect(capabilityLabel("thing.new")).toEqual({ title: "Thing.new", blurb: "thing new" });
  });
});
