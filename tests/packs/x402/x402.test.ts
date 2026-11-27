import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { addressOf, toHex, transferDigest } from "../../../packs/x402/evm.js";
import x402Pack, {
  USDC,
  buildPayment,
  encodeB64Json,
  hostAllowed,
  limitsFrom,
  logUrl,
  parsePaymentRequired,
} from "../../../packs/x402/index.js";
import { expectNoSecrets, harness } from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { toolNames, toolOf } from "../support.js";

// A throwaway key made up for these tests. It never holds funds.
const KEY = toHex(createHash("sha256").update("plughive x402 test wallet").digest());
const WALLET = addressOf(Buffer.from(KEY, "hex"));
const SECRETS = { X402_PRIVATE_KEY: `0x${KEY}` };
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const SEPOLIA = USDC["eip155:84532"]!;
const BASE = USDC["eip155:8453"]!;
const URL_ = "https://api.paid.test/weather?city=lisbon";

const option = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000", // $0.01
  asset: SEPOLIA.address,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
  ...over,
});

interface Seen {
  payloads: Record<string, unknown>[];
}

/** A v2 resource server: 402 with PAYMENT-REQUIRED, then checks the signature like a facilitator. */
function v2Server(accepts: Record<string, unknown>[], seen: Seen, opts: { refuse?: boolean } = {}) {
  return routerFetch([
    {
      match: /^GET https:\/\/api\.paid\.test\/weather/,
      reply: ({ init }) => {
        const sent = new Headers(init?.headers).get("payment-signature");
        if (!sent) {
          return new Response(JSON.stringify({}), {
            status: 402,
            headers: {
              "content-type": "application/json",
              "PAYMENT-REQUIRED": encodeB64Json({
                x402Version: 2,
                error: "PAYMENT-SIGNATURE header is required",
                resource: { url: URL_, description: "Weather", mimeType: "application/json" },
                accepts,
              }),
            },
          });
        }
        const p = JSON.parse(Buffer.from(sent, "base64").toString("utf8"));
        seen.payloads.push(p);
        const accepted = p.accepted;
        const usdc = USDC[accepted.network]!;
        const a = p.payload.authorization;
        const digest = transferDigest(
          {
            name: accepted.extra.name,
            version: accepted.extra.version,
            chainId: BigInt(accepted.network.split(":")[1]),
            verifyingContract: usdc.address,
          },
          a,
        );
        const sig = Buffer.from(p.payload.signature.slice(2, 130), "hex");
        const valid =
          secp256k1.verify(sig, digest, secp256k1.getPublicKey(Buffer.from(KEY, "hex")), {
            prehash: false,
          }) &&
          a.value === accepted.amount &&
          a.to.toLowerCase() === accepted.payTo.toLowerCase() &&
          a.from === WALLET;
        if (!valid || opts.refuse) {
          return new Response("{}", {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": encodeB64Json({
                x402Version: 2,
                error: opts.refuse ? "insufficient_funds" : "invalid_signature",
                accepts,
              }),
            },
          });
        }
        return new Response(JSON.stringify({ city: "Lisbon", temp_c: 21 }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": encodeB64Json({
              success: true,
              transaction: `0x${"ab".repeat(32)}`,
              network: accepted.network,
              payer: WALLET,
            }),
          },
        });
      },
    },
  ]);
}

function setup(
  fetch: ReturnType<typeof routerFetch>,
  settings: Record<string, unknown> = {},
  tool = "x402_fetch",
) {
  return harness(x402Pack, "x402", tool, { secrets: SECRETS, fetch, settings });
}

const ledger = async (dataDir: string) =>
  (await readFile(join(dataDir, "payments.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("x402 pack", () => {
  it("exposes quote, fetch and wallet; fetch is paid, always asks and is destructive", () => {
    expect(toolNames(x402Pack)).toEqual(["x402_quote", "x402_fetch", "x402_wallet"]);
    const pay = toolOf(x402Pack, "x402_fetch");
    expect(pay.tags).toEqual(expect.arrayContaining(["paid", "approval"]));
    expect(pay.annotations?.destructiveHint).toBe(true);
    expect(toolOf(x402Pack, "x402_wallet").annotations?.readOnlyHint).toBe(true);
    expect(toolOf(x402Pack, "x402_quote").tags ?? []).not.toContain("paid");
  });

  it("quotes without paying", async () => {
    const seen: Seen = { payloads: [] };
    const fetch = v2Server(
      [option(), option({ network: "eip155:8453", asset: BASE.address, amount: "5000" })],
      seen,
    );
    const h = setup(fetch, {}, "x402_quote");
    const out = (await h.call({ url: URL_ })) as Record<string, any>;
    expect(out.payment_required).toBe(true);
    expect(out.options).toHaveLength(2);
    expect(out.options[0]).toMatchObject({ usd: 0.01, payable: true, network: "eip155:84532" });
    expect(out.cheapest_payable_usd).toBe(0.005);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers["payment-signature"]).toBeUndefined();
    expect(seen.payloads).toHaveLength(0);
  });

  it("pays a v2 server once, with a signature the server can verify, and reports cost_usd", async () => {
    const seen: Seen = { payloads: [] };
    const fetch = v2Server([option()], seen);
    const h = setup(fetch);
    const out = (await h.call({ url: URL_, max_usd: 0.05 })) as Record<string, any>;
    expect(out).toMatchObject({ paid: true, cost_usd: 0.01, status: 200 });
    expect(JSON.parse(out.body)).toEqual({ city: "Lisbon", temp_c: 21 });
    expect(out.payment.settlement).toMatchObject({
      success: true,
      transaction: `0x${"ab".repeat(32)}`,
    });
    expect(fetch.calls).toHaveLength(2);
    const p = seen.payloads[0]!;
    expect(p.x402Version).toBe(2);
    expect(p.accepted).toEqual(option());
    expect(p.resource).toMatchObject({ url: URL_ });
    const a = (p.payload as any).authorization;
    expect(a.value).toBe("10000");
    expect(a.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(a.validBefore) - Number(a.validAfter)).toBe(660);
    const rows = await ledger(h.t.dataDir);
    expect(rows.map((r) => r.kind)).toEqual(["payment", "outcome"]);
    expect(rows[0]).toMatchObject({ usd: 0.01, network: "eip155:84532", from: WALLET });
    expect(rows[1]).toMatchObject({ outcome: "paid" });
    expectNoSecrets(out, [KEY]);
    expectNoSecrets(rows, [KEY]);
  });

  it("picks the cheapest option it may pay", async () => {
    const seen: Seen = { payloads: [] };
    const fetch = v2Server(
      [
        option({ amount: "30000" }),
        option({
          network: "eip155:8453",
          asset: BASE.address,
          amount: "20000",
          extra: { name: "USD Coin", version: "2" },
        }),
        option({ network: "eip155:137", asset: USDC["eip155:137"]!.address, amount: "1" }), // not allowed
      ],
      seen,
    );
    const out = (await setup(fetch).call({ url: URL_, max_usd: 0.05 })) as Record<string, any>;
    expect(out.cost_usd).toBe(0.02);
    expect((seen.payloads[0]!.accepted as any).network).toBe("eip155:8453");
  });

  it("pays a v1 server with X-PAYMENT", async () => {
    const seen: Record<string, any>[] = [];
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.paid\.test\/v1/,
        reply: ({ init }) => {
          const h = new Headers(init?.headers).get("x-payment");
          if (!h) {
            return new Response(
              JSON.stringify({
                x402Version: 1,
                error: "X-PAYMENT header is required",
                accepts: [
                  {
                    scheme: "exact",
                    network: "base-sepolia",
                    maxAmountRequired: "2500",
                    resource: "https://api.paid.test/v1",
                    description: "v1 thing",
                    mimeType: "application/json",
                    payTo: PAY_TO,
                    maxTimeoutSeconds: 300,
                    asset: SEPOLIA.address,
                    extra: { name: "USDC", version: "2" },
                  },
                ],
              }),
              { status: 402, headers: { "content-type": "application/json" } },
            );
          }
          seen.push(JSON.parse(Buffer.from(h, "base64").toString("utf8")));
          expect(init?.body).toBe('{"q":1}');
          return new Response("done", {
            status: 200,
            headers: {
              "content-type": "text/plain",
              "X-PAYMENT-RESPONSE": encodeB64Json({
                success: true,
                transaction: "0x01",
                network: "base-sepolia",
                payer: WALLET,
              }),
            },
          });
        },
      },
    ]);
    const out = (await setup(fetch).call({
      url: "https://api.paid.test/v1",
      method: "POST",
      body: '{"q":1}',
      headers: { "content-type": "application/json" },
      max_usd: 0.01,
    })) as Record<string, any>;
    expect(out).toMatchObject({ paid: true, cost_usd: 0.0025, body: "done" });
    expect(seen[0]).toMatchObject({ x402Version: 1, scheme: "exact", network: "base-sepolia" });
    expect(seen[0]!.payload.authorization.value).toBe("2500");
  });

  it("never pays above max_usd, the per-call limit or what is left of the day", async () => {
    const seen: Seen = { payloads: [] };
    let err = await failure(
      setup(v2Server([option({ amount: "60000" })], seen)).call({ url: URL_, max_usd: 0.05 }),
    );
    expect(err.message).toMatch(/Nothing was paid/);
    err = await failure(
      setup(v2Server([option({ amount: "200000" })], seen)).call({ url: URL_, max_usd: 1 }),
    );
    expect(err.message).toMatch(/per-call limit \$0\.1/);
    expect(seen.payloads).toHaveLength(0);

    // Daily cap of $0.025: two $0.01 payments fit, the third does not.
    const fetch = v2Server([option()], seen);
    const h = setup(fetch, { dailyCapUsd: 0.025 });
    await h.call({ url: URL_, max_usd: 0.05 });
    await h.call({ url: URL_, max_usd: 0.05 });
    err = await failure(h.call({ url: URL_, max_usd: 0.05 }));
    expect(err.message).toMatch(/\$0\.005 left of the 24-hour limit/);
    expect(seen.payloads).toHaveLength(2);
  });

  it("does not let parallel calls overshoot the daily limit", async () => {
    const seen: Seen = { payloads: [] };
    const h = setup(v2Server([option()], seen), { dailyCapUsd: 0.03 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => h.call({ url: URL_, max_usd: 0.05 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(seen.payloads).toHaveLength(3);
  });

  it("refuses tokens that are not USDC, unknown schemes and networks outside the allow list", async () => {
    const seen: Seen = { payloads: [] };
    const h = setup(
      v2Server(
        [
          option({ asset: "0x1111111111111111111111111111111111111111" }),
          option({ scheme: "upto" }),
          option({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }),
          option({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }),
          option({ payTo: "0x0000000000000000000000000000000000000000" }),
        ],
        seen,
      ),
      {},
      "x402_quote",
    );
    const out = (await h.call({ url: URL_ })) as Record<string, any>;
    expect(out.options.map((o: any) => o.payable)).toEqual([false, false, false, false, false]);
    expect(out.options[0].why_not).toMatch(/not USDC/);
    expect(out.options[1].why_not).toMatch(/scheme "upto"/);
    expect(out.options[2].why_not).toMatch(/permit2/);
    expect(out.options[3].why_not).toMatch(/not supported/);
    expect(out.options[4].why_not).toMatch(/payTo/);

    const onlyBase = setup(
      v2Server([option()], seen),
      { allowedNetworks: ["eip155:8453"] },
      "x402_quote",
    );
    const o2 = (await onlyBase.call({ url: URL_ })) as Record<string, any>;
    expect(o2.options[0].why_not).toMatch(/not in this pack's allowed networks/);
  });

  it("logs a refused payment and keeps counting it", async () => {
    const seen: Seen = { payloads: [] };
    const h = setup(v2Server([option()], seen, { refuse: true }));
    const err = await failure(h.call({ url: URL_, max_usd: 0.05 }));
    expect(err.message).toMatch(/refused the payment \(insufficient_funds\)/);
    const rows = await ledger(h.t.dataDir);
    expect(rows[1]).toMatchObject({ outcome: "refused", status: 402 });
    const w = harness(x402Pack, "x402", "x402_wallet", { secrets: SECRETS, dataDir: h.t.dataDir });
    const wallet = (await w.call({})) as Record<string, any>;
    expect(wallet).toMatchObject({ address: WALLET, spent_24h_usd: 0.01, left_24h_usd: 0.99 });
    expect(wallet.recent[0]).toMatchObject({ outcome: "refused", usd: 0.01 });
    expectNoSecrets(wallet, [KEY]);
  });

  it("returns a free resource without paying", async () => {
    const fetch = routerFetch([
      {
        match: /weather/,
        reply: () => new Response("free", { headers: { "content-type": "text/plain" } }),
      },
    ]);
    const out = (await setup(fetch).call({ url: URL_, max_usd: 0.05 })) as Record<string, any>;
    expect(out).toMatchObject({ paid: false, cost_usd: 0, body: "free" });
  });

  it("saves a binary paid response to the library", async () => {
    const seen: Seen = { payloads: [] };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const inner = v2Server([option()], seen);
    const fetch = routerFetch([
      {
        match: /weather/,
        reply: async (req) => {
          const r = await inner(req.url, req.init);
          if (r.status !== 200) return r;
          return new Response(png, {
            headers: {
              "content-type": "image/png",
              "PAYMENT-RESPONSE": r.headers.get("PAYMENT-RESPONSE")!,
            },
          });
        },
      },
    ]);
    const h = setup(fetch);
    const out = (await h.call({ url: URL_, max_usd: 0.05 })) as Record<string, any>;
    expect(out.artifact).toMatchObject({ mime: "image/png" });
    expect(h.t.library!.all()[0]!.kind).toBe("image");
  });

  it("refuses hand-set payment headers, plain http, credentials in URLs and hosts off the allow list", async () => {
    const fetch = routerFetch([]);
    const h = setup(fetch);
    expect(
      (await failure(h.call({ url: URL_, max_usd: 1, headers: { "X-PAYMENT": "x" } }))).message,
    ).toMatch(/cannot be set/);
    expect((await failure(h.call({ url: "http://api.paid.test/x", max_usd: 1 }))).message).toMatch(
      /https/,
    );
    expect(
      (await failure(h.call({ url: "https://u:p@api.paid.test/x", max_usd: 1 }))).message,
    ).toMatch(/credentials/);
    const limited = setup(fetch, { allowedHosts: ["*.trusted.test"] });
    expect((await failure(limited.call({ url: URL_, max_usd: 1 }))).message).toMatch(
      /allowed hosts/,
    );
    expect(fetch.calls).toHaveLength(0);
    expect(hostAllowed("a.trusted.test", ["*.trusted.test"])).toBe(true);
    expect(hostAllowed("trusted.test", ["*.trusted.test"])).toBe(false);
    expect(hostAllowed("eviltrusted.test", ["*.trusted.test"])).toBe(false);
  });

  it("explains a missing wallet without calling the server", async () => {
    const fetch = routerFetch([]);
    const h = harness(x402Pack, "x402", "x402_fetch", { secrets: {}, fetch });
    expect((await failure(h.call({ url: URL_, max_usd: 1 }))).message).toMatch(
      /No wallet: set X402_PRIVATE_KEY/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it("clamps settings and maps v1 network names", () => {
    expect(limitsFrom({})).toEqual({
      allowedNetworks: ["eip155:8453", "eip155:84532"],
      maxPerCallUsd: 0.1,
      dailyCapUsd: 1,
      allowedHosts: [],
    });
    expect(
      limitsFrom({ maxPerCallUsd: 1e9, dailyCapUsd: -1, allowedNetworks: ["base", "eip155:999"] }),
    ).toEqual({
      allowedNetworks: ["eip155:8453"],
      maxPerCallUsd: 25,
      dailyCapUsd: 1,
      allowedHosts: [],
    });
    expect(parsePaymentRequired(null, "not json")).toBeNull();
    expect(parsePaymentRequired("%%%", '{"x402Version":3,"accepts":[]}')).toBeNull();
  });
});

describe("x402 hardening", () => {
  it("x402_quote sends caller headers only when allowedHosts is set and matches (R2-M4)", async () => {
    const seen: Seen = { payloads: [] };
    const fetch = v2Server([option()], seen);
    const open = setup(fetch, {}, "x402_quote");
    await expect(open.call({ url: URL_, headers: { "x-api-key": "k" } })).rejects.toThrow(
      /set allowedHosts/,
    );
    expect(fetch.calls).toHaveLength(0);
    // A plain quote stays open, like fetch_web.
    expect(((await open.call({ url: URL_ })) as any).payment_required).toBe(true);
    const listed = setup(fetch, { allowedHosts: ["api.paid.test"] }, "x402_quote");
    await listed.call({ url: URL_, headers: { "x-api-key": "k" } });
    expect(fetch.calls.at(-1)!.headers["x-api-key"]).toBe("k");
    const other = setup(fetch, { allowedHosts: ["other.test"] }, "x402_quote");
    await expect(other.call({ url: URL_, headers: { "x-api-key": "k" } })).rejects.toThrow(
      /not in this pack's allowed hosts/,
    );
  });

  it("x402_quote accepts only GET/HEAD and no body (a quote must not mutate)", () => {
    const q = toolOf(x402Pack, "x402_quote");
    expect(q.input.safeParse({ url: URL_ }).success).toBe(true);
    expect(q.input.safeParse({ url: URL_, method: "HEAD" }).success).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(q.input.safeParse({ url: URL_, method }).success).toBe(false);
    }
    // A body key is stripped by the schema, so it can never be sent.
    expect("body" in q.input.parse({ url: URL_, body: "x" })).toBe(false);
    // x402_fetch may still send a body with a non-GET method.
    const pay = toolOf(x402Pack, "x402_fetch");
    expect(pay.input.safeParse({ url: URL_, method: "POST", body: "{}", max_usd: 1 }).success).toBe(
      true,
    );
  });

  it("refuses to follow a redirect to a host outside allowedHosts", async () => {
    const fetch = routerFetch([
      {
        match: /weather/,
        reply: () =>
          new Response(null, { status: 302, headers: { location: "https://evil.test/x" } }),
      },
    ]);
    const h = setup(fetch, { allowedHosts: ["api.paid.test"] });
    const err = await failure(h.call({ url: URL_, max_usd: 1 }));
    expect(err.message).toMatch(/evil\.test is not in this pack's allowed hosts/);
    expect(fetch.calls).toHaveLength(1);
  });

  it("follows a redirect within the allowed hosts, re-validating each hop", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/api\.paid\.test\/weather/,
        reply: () => new Response(null, { status: 302, headers: { location: "/v2/weather" } }),
      },
      {
        match: /^GET https:\/\/api\.paid\.test\/v2\/weather/,
        reply: () => new Response("free", { headers: { "content-type": "text/plain" } }),
      },
    ]);
    const h = setup(fetch, { allowedHosts: ["api.paid.test"] });
    const out = (await h.call({ url: URL_, max_usd: 1 })) as Record<string, any>;
    expect(out).toMatchObject({ paid: false, body: "free" });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[1]!.url).toBe("https://api.paid.test/v2/weather");
  });

  it("drops the caller's headers when a redirect leaves the origin", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/api\.paid\.test\/weather/,
        reply: () =>
          new Response(null, { status: 302, headers: { location: "https://cdn.paid.test/w" } }),
      },
      {
        match: /^GET https:\/\/cdn\.paid\.test\/w/,
        reply: () => new Response("free", { headers: { "content-type": "text/plain" } }),
      },
    ]);
    const h = setup(fetch, { allowedHosts: ["api.paid.test", "cdn.paid.test"] });
    await h.call({ url: URL_, max_usd: 1, headers: { "X-Api-Key": "k1" } });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]!.headers["x-api-key"]).toBe("k1");
    expect(fetch.calls[1]!.headers["x-api-key"]).toBeUndefined();
  });

  it("does not pay a price quoted by a page the request was redirected to", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/api\.paid\.test\/weather/,
        reply: () =>
          new Response(null, { status: 302, headers: { location: "https://cdn.paid.test/w?t=1" } }),
      },
      {
        match: /^GET https:\/\/cdn\.paid\.test\/w/,
        reply: () =>
          new Response("{}", {
            status: 402,
            headers: {
              "content-type": "application/json",
              "PAYMENT-REQUIRED": encodeB64Json({ x402Version: 2, accepts: [option()] }),
            },
          }),
      },
    ]);
    const h = setup(fetch, { allowedHosts: ["api.paid.test", "cdn.paid.test"] });
    const err = await failure(h.call({ url: URL_, max_usd: 0.05 }));
    expect(err.message).toBe(
      "api.paid.test redirected to https://cdn.paid.test/w, which asked for payment; nothing was paid. Call x402_fetch with that URL directly to pay it.",
    );
    // Only the probe and its redirect: nothing was signed or sent with a payment.
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls.every((c) => !c.headers["payment-signature"])).toBe(true);
  });

  it("never follows a redirect on the paid request", async () => {
    const seen: Seen = { payloads: [] };
    const inner = v2Server([option()], seen);
    const fetch = routerFetch([
      {
        match: /weather/,
        reply: async (req) => {
          const r = await inner(req.url, req.init);
          // The paid (second) request redirects somewhere else: it must not be followed.
          if (r.status === 200) {
            return new Response(null, {
              status: 302,
              headers: { location: "https://evil.test/x" },
            });
          }
          return r;
        },
      },
    ]);
    const h = setup(fetch);
    const out = (await h.call({ url: URL_, max_usd: 0.05 })) as Record<string, any>;
    expect(out.paid).toBe(true);
    expect(out.status).toBe(302);
    // Exactly two requests: the quote and the paid one; no third call to evil.test.
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls.some((c) => c.url.includes("evil.test"))).toBe(false);
  });

  it("pins the EIP-712 domain to the known USDC values whatever the 402 server sends", () => {
    const evil = option({ extra: { name: "Evil Coin", version: "9" } });
    const pr = parsePaymentRequired(null, JSON.stringify({ x402Version: 2, accepts: [evil] }))!;
    const r = pr.accepts[0]!;
    const key = Buffer.from(KEY, "hex");
    const p = buildPayment(pr, r, key, 1_800_000_000);
    const payload = JSON.parse(Buffer.from(p.value, "base64").toString("utf8")).payload;
    // The signature verifies against the real USDC domain, not the server's extra.
    const digest = transferDigest(
      {
        name: SEPOLIA.name,
        version: SEPOLIA.version,
        chainId: 84532n,
        verifyingContract: SEPOLIA.address,
      },
      payload.authorization,
    );
    const sig = Buffer.from(payload.signature.slice(2, 130), "hex");
    expect(secp256k1.verify(sig, digest, secp256k1.getPublicKey(key), { prehash: false })).toBe(
      true,
    );
  });

  it("strips query and fragment from URLs in the ledger, wallet and artifact metadata", async () => {
    const seen: Seen = { payloads: [] };
    const h = setup(v2Server([option()], seen));
    const out = (await h.call({
      url: "https://api.paid.test/weather?token=sekrit&sig=abc#frag",
      max_usd: 0.05,
    })) as Record<string, any>;
    expect(out.paid).toBe(true);
    const rows = await ledger(h.t.dataDir);
    expect(rows[0]!.url).toBe("https://api.paid.test/weather");
    expect(JSON.stringify(rows)).not.toContain("sekrit");
    const w = harness(x402Pack, "x402", "x402_wallet", { secrets: SECRETS, dataDir: h.t.dataDir });
    const wallet = (await w.call({})) as Record<string, any>;
    expect(wallet.recent[0].url).toBe("https://api.paid.test/weather");
    expect(logUrl("https://a.test/p?q=1#f")).toBe("https://a.test/p");
    expect(logUrl("not a url")).toBe("not a url");
  });
});
