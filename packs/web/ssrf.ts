// packs/web/ssrf.ts
//
// Target checks for the headless browser. The pack API's `ctx.fetch` guards
// HTTP calls the pack makes itself, but a browser opens its own sockets, so
// the pack has to apply the same policy to every request the page makes.
// This file is that policy: it classifies addresses, resolves hostnames and
// returns a verdict. It uses only node:dns and node:net.
//
// Two tiers of blocked address:
//  - "local": loopback, RFC 1918 private ranges, CGNAT, unique-local IPv6,
//    unspecified. Allowed only when the `allowLocalUrls` pack setting is on.
//  - "never": link-local (including the cloud metadata endpoints), multicast,
//    broadcast and other reserved ranges. Blocked even with `allowLocalUrls`.
//
// DNS rebinding: a check here followed by the browser resolving the name again
// would leave a window in which a hostile DNS server answers differently. The
// browser therefore never resolves anything: it is launched behind the local
// proxy in pin-proxy.ts, which runs this check and connects to the very
// address the check classified.
//
// The daemon's own port(s) on a local address are refused whatever the
// settings say: a page must never be able to render the management API.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressClass =
  | { kind: "public" }
  | { kind: "local"; label: string }
  | { kind: "never"; label: string };

/** Resolve a hostname to every address it has. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => a.address);
};

const PUBLIC: AddressClass = { kind: "public" };
const local = (label: string): AddressClass => ({ kind: "local", label });
const never = (label: string): AddressClass => ({ kind: "never", label });

function parseV4(text: string): [number, number, number, number] | null {
  if (isIP(text) !== 4) return null;
  const p = text.split(".").map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0];
}

/** IPv6 literal (no brackets) to 8 groups of 16 bits, or null. */
function parseV6(input: string): number[] | null {
  let text = input;
  if (isIP(text) !== 6) return null;
  let tail: number[] = [];
  if (text.includes(".")) {
    const cut = text.lastIndexOf(":");
    const v4 = parseV4(text.slice(cut + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, cut + 1) + (tail.length ? "0:0" : "");
  }
  const dbl = text.indexOf("::");
  const parse = (s: string): number[] =>
    s === "" ? [] : s.split(":").map((g) => Number.parseInt(g, 16));
  let groups: number[];
  if (dbl === -1) {
    groups = parse(text);
  } else {
    const head = parse(text.slice(0, dbl));
    const rest = parse(text.slice(dbl + 2));
    groups = [...head, ...new Array(8 - head.length - rest.length).fill(0), ...rest];
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  if (tail.length) {
    groups[6] = tail[0] as number;
    groups[7] = tail[1] as number;
  }
  return groups;
}

export function classifyV4(a: number, b: number, c: number, d: number): AddressClass {
  if (a === 0) return local("unspecified address (0.0.0.0/8)");
  if (a === 10) return local("private network (10.0.0.0/8)");
  if (a === 127) return local("loopback (127.0.0.0/8)");
  if (a === 100 && b === 100 && c === 100 && d === 200) return never("cloud metadata endpoint");
  if (a === 100 && b >= 64 && b <= 127) return local("carrier-grade NAT (100.64.0.0/10)");
  if (a === 169 && b === 254) return never("link-local / cloud metadata (169.254.0.0/16)");
  if (a === 172 && b >= 16 && b <= 31) return local("private network (172.16.0.0/12)");
  if (a === 192 && b === 168) return local("private network (192.168.0.0/16)");
  if (a === 192 && b === 88 && c === 99) return never("6to4 relay anycast (192.88.99.0/24)");
  if (a === 192 && b === 0 && c === 0) return never("IETF protocol assignments (192.0.0.0/24)");
  if (a === 192 && b === 0 && c === 2) return never("documentation range");
  if (a === 198 && (b === 18 || b === 19)) return never("benchmarking range (198.18.0.0/15)");
  if (a === 198 && b === 51 && c === 100) return never("documentation range");
  if (a === 203 && b === 0 && c === 113) return never("documentation range");
  if (a >= 224) return never("multicast or reserved (224.0.0.0/3)");
  return PUBLIC;
}

export function classifyV6(g: number[]): AddressClass {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const high = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (high && g5 === 0 && g6 === 0 && g7 === 0) return local("unspecified address (::)");
  if (high && g5 === 0 && g6 === 0 && g7 === 1) return local("loopback (::1)");
  // IPv4-mapped (::ffff:a.b.c.d) is that IPv4 address as far as the kernel cares.
  if (high && g5 === 0xffff) return classifyV4(g6 >> 8, g6 & 255, g7 >> 8, g7 & 255);
  if (high && g5 === 0) return never("deprecated IPv4-compatible address (::/96)");
  // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return classifyV4(g6 >> 8, g6 & 255, g7 >> 8, g7 & 255);
  }
  // 6to4 (2002::/16) reaches an arbitrary IPv4 address through a relay.
  if (g0 === 0x2002) return never("6to4 (2002::/16)");
  // Local-use NAT64 (64:ff9b:1::/48) translates to whatever the site chose.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return never("local-use NAT64 (64:ff9b:1::/48)");
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0)
    return never("discard-only range (100::/64)");
  // 2001::/23 holds Teredo (2001::/32, which tunnels to an IPv4 address),
  // benchmarking and ORCHID ranges; none is an ordinary public host.
  if (g0 === 0x2001 && g1 < 0x200)
    return never("IETF protocol assignments (2001::/23, incl. Teredo)");
  if (g0 === 0x2001 && g1 === 0x0db8) return never("documentation range (2001:db8::/32)");
  if (g0 === 0x3fff && g1 < 0x1000) return never("documentation range (3fff::/20)");
  if (g0 === 0xfd00 && g1 === 0x0ec2) return never("cloud metadata endpoint (fd00:ec2::)");
  if ((g0 & 0xfe00) === 0xfc00) return local("unique local address (fc00::/7)");
  if ((g0 & 0xffc0) === 0xfe80) return never("link-local (fe80::/10)");
  if ((g0 & 0xffc0) === 0xfec0) return never("deprecated site-local (fec0::/10)");
  if ((g0 & 0xff00) === 0xff00) return never("multicast (ff00::/8)");
  // Only global unicast (2000::/3) is public; the rest is reserved.
  if ((g0 & 0xe000) !== 0x2000) return never("reserved IPv6 range (outside 2000::/3)");
  return PUBLIC;
}

/** Classify an IP literal. Anything that is not a valid literal is treated as "never". */
export function classifyAddress(address: string): AddressClass {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  // A zone index ("%en0") names an interface, not a destination.
  if (bare.includes("%")) return never("an IPv6 address with a zone index");
  const v4 = parseV4(bare);
  if (v4) return classifyV4(...v4);
  const v6 = parseV6(bare);
  if (v6) return classifyV6(v6);
  return never("not a valid IP address");
}

export interface UrlPolicy {
  /** Allow the "local" tier (loopback and private ranges). Default false. */
  allowLocal: boolean;
  /** Injected for tests. Default: the OS resolver. */
  resolve?: Resolver;
  /** Ports the daemon itself listens on. Refused on any local address, always. */
  daemonPorts?: readonly number[];
}

export type Verdict =
  | {
      ok: true;
      /** Addresses that were classified, in resolver order. Empty for data: and blob:. */
      addresses: string[];
      /** At least one address is in the "local" tier. */
      local: boolean;
      port: number;
    }
  | { ok: false; reason: string };

const deny = (reason: string): Verdict => ({ ok: false, reason });

/**
 * Check a URL the browser is about to request. Navigations and sub-resources
 * must be http(s). `data:` and `blob:` URLs make no network request, so
 * sub-resources may use them; pass `topLevel: true` to forbid them for the
 * navigation itself.
 */
export async function checkUrl(
  raw: string,
  policy: UrlPolicy,
  opts: { topLevel?: boolean } = {},
): Promise<Verdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return deny("the URL is not valid");
  }
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return opts.topLevel
      ? deny(`scheme ${url.protocol} is not allowed`)
      : { ok: true, addresses: [], local: false, port: 0 };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return deny(`scheme ${url.protocol} is not allowed (only http and https)`);
  }
  // WHATWG parsing canonicalises decimal, octal and hex IPv4 forms.
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "") return deny("the URL has no host");

  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await (policy.resolve ?? defaultResolver)(host);
    } catch {
      return deny(`host ${host} could not be resolved`);
    }
    if (addresses.length === 0) return deny(`host ${host} could not be resolved`);
  }

  const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  let anyLocal = false;
  for (const address of addresses) {
    const c = classifyAddress(address);
    if (c.kind === "never") return deny(`${host} -> ${address}: ${c.label} is always blocked`);
    if (c.kind === "local") {
      if (policy.daemonPorts?.includes(port)) {
        return deny(`${host}:${port} is the plughive daemon itself, which is always blocked`);
      }
      if (!policy.allowLocal) {
        return deny(
          `${host} -> ${address}: ${c.label} is blocked (enable the allowLocalUrls setting to allow local URLs)`,
        );
      }
      anyLocal = true;
    }
  }
  return { ok: true, addresses, local: anyLocal, port };
}
