import { describe, expect, it } from "vitest";
import { ipVersion, isPrivateAddress, parseIPv4, parseIPv6 } from "../../../src/core/net/ip.js";

describe("isPrivateAddress", () => {
  const blocked: Array<[string, string]> = [
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback top"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "this network"],
    ["10.0.0.1", "rfc1918 10/8"],
    ["10.255.255.255", "rfc1918 10/8 top"],
    ["172.16.0.1", "rfc1918 172.16/12 bottom"],
    ["172.31.255.255", "rfc1918 172.16/12 top"],
    ["192.168.0.1", "rfc1918 192.168/16"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "cgnat bottom"],
    ["100.127.255.255", "cgnat top"],
    ["192.0.0.1", "ietf protocol assignments"],
    ["192.0.2.1", "test-net-1"],
    ["192.88.99.1", "6to4 relay anycast"],
    ["198.18.0.1", "benchmarking bottom"],
    ["198.19.255.255", "benchmarking top"],
    ["198.51.100.7", "test-net-2"],
    ["203.0.113.7", "test-net-3"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast top"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["::", "v6 unspecified"],
    ["::1", "v6 loopback"],
    ["0:0:0:0:0:0:0:1", "v6 loopback expanded"],
    ["::ffff:127.0.0.1", "v4-mapped loopback"],
    ["::ffff:7f00:1", "v4-mapped loopback hex"],
    ["::ffff:10.0.0.1", "v4-mapped private"],
    ["::ffff:169.254.169.254", "v4-mapped metadata"],
    ["0:0:0:0:0:ffff:c0a8:101", "v4-mapped 192.168.1.1 expanded"],
    ["::127.0.0.1", "v4-compatible loopback"],
    ["64:ff9b::a00:1", "nat64 of 10.0.0.1"],
    ["64:ff9b::7f00:1", "nat64 of loopback"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local with zone"],
    ["2606:4700::1111%en0", "public address with a zone id"],
    ["[2606:4700::1111%25en0]", "bracketed public address with an encoded zone id"],
    ["2606:4700::1111%", "empty zone id"],
    ["febf::1", "link-local top"],
    ["fec0::1", "site-local"],
    ["fc00::1", "unique local"],
    ["fd12:3456:789a::1", "unique local fd"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2001::1", "teredo / ietf"],
    ["2002:7f00:1::", "6to4"],
    ["3fff::1", "documentation 3fff::/20"],
    ["100::1", "discard only"],
    ["[::1]", "bracketed loopback"],
  ];
  for (const [address, label] of blocked) {
    it(`blocks ${address} (${label})`, () => {
      expect(isPrivateAddress(address)).toBe(true);
    });
  }

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:81b::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ];
  for (const address of allowed) {
    it(`allows public ${address}`, () => {
      expect(isPrivateAddress(address)).toBe(false);
    });
  }

  it("fails closed for anything that is not an IP literal", () => {
    for (const junk of ["", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::g"]) {
      expect(isPrivateAddress(junk)).toBe(true);
    }
    expect(isPrivateAddress(undefined as unknown as string)).toBe(true);
    expect(isPrivateAddress(127 as unknown as string)).toBe(true);
  });
});

describe("parsers", () => {
  it("parses strict dotted IPv4 only", () => {
    expect(Array.from(parseIPv4("1.2.3.4") ?? [])).toEqual([1, 2, 3, 4]);
    expect(parseIPv4("0x7f.0.0.1")).toBeNull();
    expect(parseIPv4("127.1")).toBeNull();
    expect(parseIPv4("01.2.3.4")).toBeNull();
  });

  it("parses IPv6 forms to 16 bytes", () => {
    const loop = parseIPv6("::1");
    expect(loop?.length).toBe(16);
    expect(loop?.[15]).toBe(1);
    const mapped = parseIPv6("[::ffff:1.2.3.4]");
    expect(Array.from(mapped ?? []).slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(parseIPv6("not-an-ip")).toBeNull();
    expect(parseIPv6("1.2.3.4")).toBeNull();
  });

  it("reports the IP version", () => {
    expect(ipVersion("1.2.3.4")).toBe(4);
    expect(ipVersion("::1")).toBe(6);
    expect(ipVersion("example.com")).toBe(0);
  });
});
