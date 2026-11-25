// src/lib/network.ts
//
// Configure Node's global fetch (undici) at process startup. This module has
// only top-level side effects and must be imported FIRST in src/server.ts so
// the dispatcher is set before any fetch() runs.
//
// Why: on some macOS networks, undici's default happy-eyeballs (RFC 8305)
// races IPv4 and IPv6 SYNs against Cloudflare-fronted endpoints and stalls:
// fetch hangs with ETIMEDOUT while curl on the same host connects in about a
// second. Forcing IPv4, disabling auto family selection and raising the
// connect timeout avoids it.
//
// This covers the daemon's own global fetch. Pack requests (ctx.fetch) go
// through the guarded fetch in src/core/net, which has its own dispatcher.

import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(
  new Agent({
    connect: {
      // Disable RFC 8305 happy-eyeballs — try IPv4 only, no IPv6 race.
      autoSelectFamily: false,
      family: 4,
      timeout: 30_000,
    },
    connectTimeout: 30_000,
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
  }),
);
