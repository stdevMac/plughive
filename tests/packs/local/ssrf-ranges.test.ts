import { describe, expect, it } from "vitest";
import { classifyAddress } from "../../../packs/local/lib/ssrf.js";

// The local pack keeps its own copy of the web pack's classifier; it must
// refuse the same special-purpose ranges.
describe("local pack classifyAddress", () => {
  it.each([
    "192.88.99.1",
    "2001::5efe:7f00:1",
    "2001:2::1",
    "2001:db8::1",
    "3fff::1",
    "64:ff9b:1::a00:1",
    "100::1",
    "2002:7f00:1::",
    "::127.0.0.1",
    "fec0::1",
    "4000::1",
    "fe80::1%en0",
  ])("%s is never allowed", (addr) => {
    expect(classifyAddress(addr).kind).toBe("never");
  });

  it("keeps ordinary public IPv6 public", () => {
    expect(classifyAddress("2001:4860:4860::8888").kind).toBe("public");
  });
});
