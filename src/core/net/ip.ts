// src/core/net/ip.ts
//
// IP address parsing and classification for the SSRF guard. Everything here is
// fail-closed: a string that is not a canonical IPv4/IPv6 literal is reported
// as private (that is, not safe to connect to).
import { isIPv4 } from "node:net";

/** Parse a canonical dotted-decimal IPv4 literal to 4 bytes, or null. */
export function parseIPv4(input: string): Uint8Array | null {
  // net.isIPv4 only accepts four decimal octets without leading zeros, so
  // legacy forms ("127.1", "0x7f.0.0.1", "0177.0.0.1") are rejected here and
  // must be canonicalised by the WHATWG URL parser before they reach us.
  if (!isIPv4(input)) return null;
  const parts = input.split(".");
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = Number(parts[i]);
  return out;
}

/** Parse an IPv6 literal (optional brackets, optional %zone) to 16 bytes, or null. */
export function parseIPv6(input: string): Uint8Array | null {
  let text = input;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text.length < 2 || text.length > 45) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;

  // Optional embedded IPv4 tail (for example ::ffff:127.0.0.1).
  let tail: Uint8Array | null = null;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    if (lastColon === -1) return null;
    tail = parseIPv4(text.slice(lastColon + 1));
    if (!tail) return null;
    // Replace the dotted tail with two zero groups; the bytes are set below.
    text = `${text.slice(0, lastColon)}:0:0`;
  }

  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups: number[] = [];
    for (const group of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  let groups: number[];
  if (doubleColon === -1) {
    const all = parseGroups(text);
    if (!all || all.length !== 8) return null;
    groups = all;
  } else {
    const head = parseGroups(text.slice(0, doubleColon));
    const rest = parseGroups(text.slice(doubleColon + 2));
    if (!head || !rest) return null;
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] ?? 0;
    out[i * 2] = group >> 8;
    out[i * 2 + 1] = group & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

function isPrivateV4(b: Uint8Array): boolean {
  const a = b[0] ?? 0;
  const c = b[1] ?? 0;
  const d = b[2] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8 "this network", unspecified
  if (a === 10) return true; // 10/8 private
  if (a === 100 && c >= 64 && c <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && c === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && c >= 16 && c <= 31) return true; // 172.16/12 private
  if (a === 192 && c === 0 && d === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && c === 0 && d === 2) return true; // TEST-NET-1
  if (a === 192 && c === 88 && d === 99) return true; // 6to4 relay anycast (deprecated)
  if (a === 192 && c === 168) return true; // 192.168/16 private
  if (a === 198 && (c === 18 || c === 19)) return true; // 198.18/15 benchmarking
  if (a === 198 && c === 51 && d === 100) return true; // TEST-NET-2
  if (a === 203 && c === 0 && d === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, broadcast
  return false;
}

function allZero(b: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (b[i] !== 0) return false;
  return true;
}

function isPrivateV6(b: Uint8Array): boolean {
  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;

  // IPv4-mapped ::ffff:a.b.c.d is that IPv4 address as far as the kernel cares.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateV4(b.subarray(12, 16));
  }
  // NAT64 well-known prefix 64:ff9b::/96 maps to the embedded IPv4 address.
  if (b0 === 0x00 && b1 === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
    return isPrivateV4(b.subarray(12, 16));
  }

  // Everything else must be global unicast, 2000::/3. This single rule rejects
  // :: and ::1, IPv4-compatible ::/96, 64:ff9b:1::/48 (local-use NAT64),
  // 100::/64 discard, fc00::/7 unique local (incl. fd00::/8), fe80::/10
  // link-local, fec0::/10 site-local and ff00::/8 multicast.
  if ((b0 & 0xe0) !== 0x20) return true;

  // Inside 2000::/3, reject special-purpose ranges.
  if (b0 === 0x20 && b1 === 0x01) {
    // 2001::/23 IETF protocol assignments: Teredo 2001::/32 (embeds IPv4),
    // benchmarking 2001:2::/48, ORCHID, and friends.
    if ((b[2] ?? 0) < 0x02) return true;
    // 2001:db8::/32 documentation
    if (b[2] === 0x0d && b[3] === 0xb8) return true;
  }
  // 2002::/16 6to4 embeds an arbitrary IPv4 address; reject outright.
  if (b0 === 0x20 && b1 === 0x02) return true;
  // 3fff::/20 documentation
  if (b0 === 0x3f && b1 === 0xff && ((b[2] ?? 0) & 0xf0) === 0x00) return true;
  return false;
}

/**
 * True when `ip` is NOT a publicly routable unicast address: private,
 * loopback, link-local, CGNAT, multicast, unspecified, reserved, documentation,
 * cloud metadata, or an IPv6 form that embeds one of those. Also true for any
 * string that is not a canonical IP literal (fail closed), and for any
 * address carrying a zone id ("%en0"): a scoped address names an interface,
 * not a public destination.
 */
export function isPrivateAddress(ip: string): boolean {
  if (typeof ip !== "string") return true;
  if (ip.includes("%")) return true;
  const v4 = parseIPv4(ip);
  if (v4) return isPrivateV4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return isPrivateV6(v6);
  return true;
}

/** 4 or 6 for a canonical literal (brackets and %zone tolerated for v6), else 0. */
export function ipVersion(ip: string): 0 | 4 | 6 {
  if (parseIPv4(ip)) return 4;
  if (parseIPv6(ip)) return 6;
  return 0;
}
