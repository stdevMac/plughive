// src/lib/network.ts
//
// Configure Node's global fetch (undici) at process startup. This module has
// only top-level side effects and must be imported FIRST in src/server.ts so
// the dispatcher is set before any fetch() runs.
//
// Why: on some macOS networks, undici's default happy-eyeballs (RFC 8305)
// races IPv4 and IPv6 SYNs against Cloudflare-fronted endpoints and stalls:
// fetch hangs with ETIMEDOUT while curl on the same host connects in about a
// second. Turning off auto family selection, preferring an IPv4 address and
// raising the connect timeout avoids it. A host that has only IPv6 addresses
// (an AAAA-only name, or `localhost` mapped to ::1 alone) still connects over
// IPv6, and an IPv6 literal such as http://[::1]:7777 is never looked up.
//
// This covers the daemon's own global fetch. Pack requests (ctx.fetch) go
// through the guarded fetch in src/core/net, which has its own dispatcher.

import { type LookupAddress, type LookupAllOptions, lookup as dnsLookup } from "node:dns";
import { Agent, setGlobalDispatcher } from "undici";

type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

type NetLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for net.connect that returns one address: the first IPv4 one
 * when the name has any, otherwise the first IPv6 one.
 */
export function preferIpv4Lookup(base: LookupAll = dnsLookup as unknown as LookupAll) {
  return (
    hostname: string,
    options: { all?: boolean; hints?: number } | NetLookupCallback,
    callback?: NetLookupCallback,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as NetLookupCallback;
    const opts = typeof options === "function" ? {} : options;
    base(
      hostname,
      { all: true, ...(opts.hints !== undefined ? { hints: opts.hints } : {}) },
      (err, addresses) => {
        if (err) return cb(err, "");
        const pick = addresses.find((a) => a.family === 4) ?? addresses[0];
        if (!pick) {
          const e = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: "ENOTFOUND",
            hostname,
          });
          return cb(e, "");
        }
        if (opts.all) return cb(null, [pick]);
        cb(null, pick.address, pick.family);
      },
    );
  };
}

setGlobalDispatcher(
  new Agent({
    connect: {
      // No RFC 8305 happy-eyeballs race: one address, IPv4 when there is one.
      autoSelectFamily: false,
      lookup: preferIpv4Lookup(),
      timeout: 30_000,
    },
    connectTimeout: 30_000,
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
  }),
);
