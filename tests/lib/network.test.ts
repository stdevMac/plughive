// tests/lib/network.test.ts
import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { preferIpv4Lookup } from "../../src/lib/network.js";

function fakeDns(addrs: LookupAddress[]) {
  return (
    _host: string,
    _opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void,
  ) => cb(null, addrs);
}

function run(
  lookup: ReturnType<typeof preferIpv4Lookup>,
  opts: { all?: boolean } = {},
): Promise<unknown[]> {
  return new Promise((resolve) => {
    lookup("host.test", opts, (err, address, family) => resolve([err, address, family]));
  });
}

describe("R4-M5: the global dispatcher's lookup", () => {
  it("prefers an IPv4 address when the name has one", async () => {
    const l = preferIpv4Lookup(
      fakeDns([
        { address: "2001:db8::1", family: 6 },
        { address: "192.0.2.1", family: 4 },
      ]),
    );
    expect(await run(l)).toEqual([null, "192.0.2.1", 4]);
  });

  it("falls back to IPv6 when there is no IPv4 address", async () => {
    const l = preferIpv4Lookup(fakeDns([{ address: "::1", family: 6 }]));
    expect(await run(l)).toEqual([null, "::1", 6]);
    expect(await run(l, { all: true })).toEqual([null, [{ address: "::1", family: 6 }], undefined]);
  });

  it("reports a name with no addresses as not found", async () => {
    const [err] = await run(preferIpv4Lookup(fakeDns([])));
    expect((err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});
