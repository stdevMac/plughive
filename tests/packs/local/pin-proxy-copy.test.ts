// packs/local/lib/pin-proxy.ts is a copy of packs/web/pin-proxy.ts (packs do
// not import from each other). The web copy carries the proxy tests; this one
// fails if the two ever drift apart below their header comments.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function body(rel: string): string {
  const src = readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
  return src.slice(src.indexOf("\nimport "));
}

describe("local pin-proxy copy", () => {
  it("matches packs/web/pin-proxy.ts below the header", () => {
    expect(body("packs/local/lib/pin-proxy.ts")).toBe(body("packs/web/pin-proxy.ts"));
  });
});
