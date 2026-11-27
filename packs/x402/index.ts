// packs/x402/index.ts
//
// Pay-per-call HTTP with x402 (https://x402.org), "exact" scheme on EVM chains,
// in USDC only, from a small wallet the user dedicates to it.
//
//   x402_quote   asks the URL without paying and lists what it would cost
//   x402_fetch   pays (once, up to max_usd) and returns the paid response
//   x402_wallet  the wallet address, limits, what was spent, recent payments
//
// The protocol (v2, with v1 still accepted):
//   1. The request comes back 402 with the payment options: v2 in a base64
//      JSON `PAYMENT-REQUIRED` header, v1 as a JSON body ({x402Version: 1,
//      accepts: [...]}).
//   2. We pick an option and sign an EIP-3009 TransferWithAuthorization for
//      exactly its amount to its payTo (EIP-712, domain = the USDC contract).
//   3. The same request is sent again with the signed payload: base64 JSON in
//      `PAYMENT-SIGNATURE` (v2) or `X-PAYMENT` (v1). The server (through its
//      facilitator) settles it on chain and answers, with the settlement in
//      `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE`.
//
// Safety:
//   - x402_fetch is tagged "paid" and "approval": the policy gate asks a person
//     every time, even under auto-approve or inside an approved workflow run.
//     The approval shows the URL and max_usd, which is a hard ceiling here.
//   - Only USDC at its known contract on an allowed network is ever signed,
//     so an amount is always dollars (6 decimals) and the verifyingContract
//     cannot be swapped for a look-alike token.
//   - The amount must fit min(max_usd, per-call limit, what is left of the
//     rolling 24 h limit). Every signed payment is logged to
//     <dataDir>/payments.jsonl BEFORE it is sent and counts against the
//     limit from then on, whatever the server answers: a signature can be
//     settled later, until it expires.
//   - Payments are made one at a time (a lock per wallet) so two calls cannot
//     both fit under the same remaining limit.
//   - The result carries cost_usd, so the usage ledger and spend caps see it.
//   - The private key is read from the secret store for each payment, never
//     logged or returned. Every signature is checked by recovery before use.
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { addressOf, checksumAddress, isAddress, parsePrivateKey, signTransfer } from "./evm.js";

const SECRET = "X402_PRIVATE_KEY";
const USDC_DECIMALS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_IN = 1024 * 1024;
const MAX_TEXT_OUT = 256 * 1024;
const MAX_BINARY_OUT = 50 * 1024 * 1024;
const MAX_HEADER_CHARS = 64 * 1024;
const USER_AGENT = "plughive-x402/0.1";

/** USDC per CAIP-2 network: the only assets this pack signs for. */
export const USDC: Readonly<
  Record<string, { address: string; name: string; version: string; label: string; v1?: string }>
> = {
  "eip155:8453": {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "USD Coin",
    version: "2",
    label: "Base",
    v1: "base",
  },
  "eip155:84532": {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "USDC",
    version: "2",
    label: "Base Sepolia (testnet)",
    v1: "base-sepolia",
  },
  "eip155:1": {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    name: "USD Coin",
    version: "2",
    label: "Ethereum",
    v1: "ethereum",
  },
  "eip155:137": {
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    name: "USD Coin",
    version: "2",
    label: "Polygon",
    v1: "polygon",
  },
  "eip155:42161": {
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    name: "USD Coin",
    version: "2",
    label: "Arbitrum One",
    v1: "arbitrum",
  },
  "eip155:10": {
    address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    name: "USD Coin",
    version: "2",
    label: "OP Mainnet",
    v1: "optimism",
  },
  "eip155:43114": {
    address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    name: "USD Coin",
    version: "2",
    label: "Avalanche C-Chain",
    v1: "avalanche",
  },
};

const V1_NETWORKS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(USDC).flatMap(([caip, u]) => (u.v1 ? [[u.v1, caip]] : [])),
);

export const DEFAULTS = {
  allowedNetworks: ["eip155:8453", "eip155:84532"],
  maxPerCallUsd: 0.1,
  dailyCapUsd: 1,
} as const;
const MAX_PER_CALL_CEILING = 25;
const DAILY_CEILING = 250;

// ---------------------------------------------------------------------------
// settings

export interface Limits {
  allowedNetworks: string[];
  maxPerCallUsd: number;
  dailyCapUsd: number;
  allowedHosts: string[];
}

const clampNum = (v: unknown, dflt: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : dflt;

const strList = (v: unknown): string[] | null =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : null;

export function limitsFrom(settings: Readonly<Record<string, unknown>>): Limits {
  const nets = strList(settings.allowedNetworks);
  return {
    // A network we hold no USDC address for can never be paid on, so it is
    // dropped here rather than offered.
    allowedNetworks: (nets && nets.length > 0 ? nets : [...DEFAULTS.allowedNetworks])
      .map((n) => V1_NETWORKS[n] ?? n)
      .filter((n) => USDC[n] !== undefined),
    maxPerCallUsd: clampNum(settings.maxPerCallUsd, DEFAULTS.maxPerCallUsd, MAX_PER_CALL_CEILING),
    dailyCapUsd: clampNum(settings.dailyCapUsd, DEFAULTS.dailyCapUsd, DAILY_CEILING),
    allowedHosts: (strList(settings.allowedHosts) ?? []).map((h) => h.toLowerCase()),
  };
}

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const h = host.toLowerCase();
  return allowed.some((p) =>
    p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p,
  );
}

// ---------------------------------------------------------------------------
// parsing the 402

export interface Requirement {
  x402Version: 1 | 2;
  scheme: string;
  /** CAIP-2, or the raw name when it is not one we know. */
  network: string;
  amount: bigint | null;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
  description: string | null;
  /** The option exactly as the server sent it (echoed back in v2). */
  raw: Record<string, unknown>;
}

export interface PaymentRequired {
  x402Version: 1 | 2;
  error: string | null;
  resource: Record<string, unknown> | null;
  accepts: Requirement[];
  extensions: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function decodeB64Json(text: string): unknown {
  if (text.length > MAX_HEADER_CHARS) throw new Error("the payment header is too large");
  const t = text.trim();
  if (!/^[A-Za-z0-9+/_=-]+$/.test(t)) throw new Error("the payment header is not base64");
  return JSON.parse(
    Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
}

export const encodeB64Json = (v: unknown) =>
  Buffer.from(JSON.stringify(v), "utf8").toString("base64");

function atomic(v: unknown): bigint | null {
  if (typeof v === "string" && /^[0-9]{1,78}$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

function requirement(raw: unknown, version: 1 | 2): Requirement | null {
  if (!isObj(raw)) return null;
  const network = str(raw.network);
  return {
    x402Version: version,
    scheme: str(raw.scheme),
    network: version === 1 ? (V1_NETWORKS[network] ?? network) : network,
    amount: atomic(version === 1 ? raw.maxAmountRequired : raw.amount),
    asset: str(raw.asset),
    payTo: str(raw.payTo),
    maxTimeoutSeconds:
      typeof raw.maxTimeoutSeconds === "number" && Number.isFinite(raw.maxTimeoutSeconds)
        ? raw.maxTimeoutSeconds
        : 60,
    extra: isObj(raw.extra) ? raw.extra : {},
    description: typeof raw.description === "string" ? raw.description.slice(0, 500) : null,
    raw,
  };
}

/** The payment options of a 402, or null when it carries none we can read. */
export function parsePaymentRequired(
  headerValue: string | null,
  bodyText: string,
): PaymentRequired | null {
  let doc: unknown = null;
  if (headerValue) {
    try {
      doc = decodeB64Json(headerValue);
    } catch {
      doc = null;
    }
  }
  if (!isObj(doc)) {
    try {
      doc = JSON.parse(bodyText);
    } catch {
      return null;
    }
  }
  if (!isObj(doc) || !Array.isArray(doc.accepts)) return null;
  const version: 1 | 2 = doc.x402Version === 1 ? 1 : 2;
  if (doc.x402Version !== 1 && doc.x402Version !== 2) return null;
  return {
    x402Version: version,
    error: typeof doc.error === "string" ? doc.error.slice(0, 500) : null,
    resource: isObj(doc.resource) ? doc.resource : null,
    accepts: doc.accepts
      .slice(0, 32)
      .map((r) => requirement(r, version))
      .filter((r): r is Requirement => r !== null),
    extensions: doc.extensions ?? null,
  };
}

export const usdOf = (atomicAmount: bigint) => Number(atomicAmount) / 10 ** USDC_DECIMALS;

/** Why this option cannot be paid (by this pack, under these limits), or null. */
export function whyNot(r: Requirement, limits: Limits, ceilingUsd: number): string | null {
  if (r.scheme !== "exact") return `scheme "${r.scheme}" is not supported (only "exact")`;
  const usdc = USDC[r.network];
  if (!usdc) return `network "${r.network}" is not supported (EVM USDC networks only)`;
  if (!limits.allowedNetworks.includes(r.network)) {
    return `network ${usdc.label} (${r.network}) is not in this pack's allowed networks`;
  }
  if (!isAddress(r.asset) || r.asset.toLowerCase() !== usdc.address.toLowerCase()) {
    return `asset ${r.asset || "(none)"} is not USDC on ${usdc.label}`;
  }
  const method = r.extra.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") {
    return `asset transfer method "${String(method)}" is not supported (only eip3009)`;
  }
  if (!isAddress(r.payTo) || /^0x0{40}$/i.test(r.payTo)) return "payTo is not a valid address";
  if (r.amount === null || r.amount <= 0n) return "the amount is missing or not a positive integer";
  const usd = usdOf(r.amount);
  if (usd > ceilingUsd + 1e-9)
    return `costs $${fmt(usd)}, over the $${fmt(ceilingUsd)} you can spend on this call`;
  return null;
}

const fmt = (usd: number) => (Math.round(usd * 1e6) / 1e6).toString();

// ---------------------------------------------------------------------------
// ledger

interface LedgerEntry {
  id: string;
  at: string;
  kind: "payment" | "outcome";
  url?: string;
  network?: string;
  payTo?: string;
  amount?: string;
  usd?: number;
  from?: string;
  validBefore?: string;
  outcome?: string;
  transaction?: string | null;
  status?: number;
}

const ledgerPath = (ctx: PackContext) => join(ctx.pack.dataDir, "payments.jsonl");

async function readLedger(ctx: PackContext): Promise<LedgerEntry[]> {
  let text: string;
  try {
    text = await readFile(ledgerPath(ctx), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (isObj(e) && typeof e.id === "string") out.push(e);
    } catch {
      // A torn last line (crash mid-write) is skipped; the payment line that
      // matters is written, and flushed, before anything is sent.
    }
  }
  return out;
}

async function appendLedger(ctx: PackContext, e: LedgerEntry): Promise<void> {
  await mkdir(ctx.pack.dataDir, { recursive: true });
  await appendFile(ledgerPath(ctx), `${JSON.stringify(e)}\n`, { mode: 0o600 });
}

/** Dollars signed in the last 24 h: every signed payment counts, whatever happened after. */
export function spentSince(entries: readonly LedgerEntry[], sinceMs: number): number {
  let total = 0;
  for (const e of entries) {
    if (e.kind !== "payment" || typeof e.usd !== "number") continue;
    if (Date.parse(e.at) >= sinceMs) total += e.usd;
  }
  return total;
}

// One payment at a time per wallet folder.
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => mine);
  locks.set(key, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// requests

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
/** A quote never mutates, so it is read-only: GET or HEAD, no body. */
const QUOTE_METHODS = ["GET", "HEAD"] as const;
const FORBIDDEN_HEADERS = new Set([
  "payment-signature",
  "x-payment",
  "payment-required",
  "payment-response",
  "x-payment-response",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "cookie",
]);

const requestInput = {
  url: z.string().url().max(4096).describe("The https URL of the paid resource."),
  method: z.enum(METHODS).default("GET"),
  body: z
    .string()
    .max(MAX_BODY_IN)
    .optional()
    .describe("Request body as text (JSON goes in as a string; set content-type in headers)."),
  headers: z
    .record(z.string().min(1).max(100), z.string().max(8192))
    .optional()
    .describe("Extra request headers. Payment headers cannot be set by hand."),
};

/** x402_quote's input: a quote must not mutate, so only GET/HEAD and no body. */
const quoteInput = {
  url: z.string().url().max(4096).describe("The https URL of the paid resource."),
  method: z.enum(QUOTE_METHODS).default("GET").describe("A quote is read-only: only GET or HEAD."),
  headers: requestInput.headers,
};

interface RequestSpec {
  url: string;
  method: (typeof METHODS)[number];
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
}

function checkRequest(spec: RequestSpec, limits: Limits): URL {
  const u = new URL(spec.url);
  if (u.protocol !== "https:") throw new Error("x402 payments are only made over https");
  if (u.username || u.password) throw new Error("URLs with credentials are not accepted");
  if (!hostAllowed(u.hostname, limits.allowedHosts)) {
    throw new Error(`${u.hostname} is not in this pack's allowed hosts`);
  }
  for (const name of Object.keys(spec.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new Error(`the ${name} header cannot be set by hand`);
    }
  }
  if (spec.body !== undefined && (spec.method === "GET" || spec.method === "HEAD")) {
    throw new Error(`a ${spec.method} request has no body`);
  }
  return u;
}

const MAX_REDIRECTS = 5;

/**
 * One request. Redirects are followed by hand so every hop is re-checked
 * against the pack's allowedHosts (the kernel only checks the manifest's
 * network list, which here is any public host). A paid request is never
 * redirected: the signature is for the original resource only.
 */
async function send(
  ctx: PackContext,
  spec: RequestSpec,
  limits: Limits,
  extra: Record<string, string> = {},
  final?: { url: string },
): Promise<Response> {
  const paying = Object.keys(extra).length > 0;
  let current = checkRequest(spec, limits);
  let method = spec.method;
  let body = spec.body;
  let headers = spec.headers;
  for (let hop = 0; ; hop++) {
    const res = await ctx.fetch(current.href, {
      method,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...(headers ?? {}), ...extra },
      ...(body !== undefined ? { body } : {}),
      redirect: paying ? "error" : "manual",
      signal: ctx.signal,
    });
    const location = res.headers.get("location");
    if (!paying && location !== null && res.status >= 300 && res.status < 400) {
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (over ${MAX_REDIRECTS})`);
      await res.body?.cancel().catch(() => undefined);
      // The redirect target is validated exactly like the first request.
      const next = checkRequest(
        { url: new URL(location, current).href, method, body, headers },
        limits,
      );
      // The caller's headers (an API key, say) are for the first origin only.
      if (next.origin !== current.origin) headers = undefined;
      current = next;
      // Like fetch, 303 (and 301/302 on a POST) turns the request into a GET.
      if (
        (res.status === 303 && method !== "GET" && method !== "HEAD") ||
        ((res.status === 301 || res.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    if (final) final.url = current.href;
    return res;
  }
}

/** A URL safe for logs and artifact metadata: the query and fragment can carry secrets, so they are stripped. */
export function logUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 2000);
  } catch {
    return url.slice(0, 2000);
  }
}

async function readCapped(
  res: Response,
  max: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const b = Buffer.from(value);
    if (size + b.length > max) {
      chunks.push(b.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(b);
    size += b.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

const isTextual = (mime: string) =>
  /^text\//.test(mime) ||
  /(json|xml|javascript|yaml|csv|x-www-form-urlencoded)/.test(mime) ||
  mime === "";

function kindOf(mime: string): "image" | "video" | "audio" | "pdf" | "data" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("zip") || mime === "application/octet-stream") return "data";
  return "other";
}

/** The response as a tool result: text inline, anything else into the library. */
async function responseOut(ctx: PackContext, res: Response, url: string) {
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const base = { status: res.status, content_type: mime || null };
  if (isTextual(mime)) {
    const { bytes, truncated } = await readCapped(res, MAX_TEXT_OUT);
    return { ...base, body: bytes.toString("utf8"), truncated };
  }
  const { bytes, truncated } = await readCapped(res, MAX_BINARY_OUT);
  if (truncated) {
    return {
      ...base,
      body: null,
      truncated: true,
      note: `binary response over ${MAX_BINARY_OUT} bytes was not kept`,
    };
  }
  const ref = await ctx.library.save({
    kind: kindOf(mime),
    mime: mime || "application/octet-stream",
    bytes,
    prompt: logUrl(url).slice(0, 500),
    meta: { source: "x402", url: logUrl(url) },
  });
  return { ...base, body: null, truncated: false, artifact: ref };
}

function settlementOf(res: Response): Record<string, unknown> | null {
  const h = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
  if (!h) return null;
  try {
    const v = decodeB64Json(h);
    if (!isObj(v)) return null;
    return {
      success: v.success === true,
      transaction: typeof v.transaction === "string" ? v.transaction.slice(0, 100) : null,
      network: typeof v.network === "string" ? v.network.slice(0, 64) : null,
      payer: typeof v.payer === "string" ? v.payer.slice(0, 64) : null,
      error: typeof v.errorReason === "string" ? v.errorReason.slice(0, 300) : null,
    };
  } catch {
    return null;
  }
}

async function readOptions(res: Response): Promise<PaymentRequired | null> {
  const header = res.headers.get("payment-required");
  const { bytes } = await readCapped(res, 256 * 1024);
  return parsePaymentRequired(header, bytes.toString("utf8"));
}

async function walletKey(ctx: PackContext): Promise<Uint8Array> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new Error(
      `No wallet: set ${SECRET} to the private key of a small wallet you use only for x402 (hold a few dollars of USDC on it, never your main wallet).`,
    );
  }
  return parsePrivateKey(await ctx.secrets.get(SECRET));
}

function describeOption(r: Requirement, limits: Limits, ceiling: number) {
  const reason = whyNot(r, limits, ceiling);
  const usdc = USDC[r.network];
  return {
    network: r.network,
    network_label: usdc?.label ?? null,
    scheme: r.scheme,
    usd: r.amount !== null && usdc ? usdOf(r.amount) : null,
    amount: r.amount?.toString() ?? null,
    asset: r.asset,
    pay_to: r.payTo,
    description: r.description,
    payable: reason === null,
    why_not: reason,
  };
}

/** The cheapest option payable under `ceiling`, or null. */
export function choose(
  options: readonly Requirement[],
  limits: Limits,
  ceiling: number,
): Requirement | null {
  let best: Requirement | null = null;
  for (const r of options) {
    if (whyNot(r, limits, ceiling) !== null) continue;
    if (best === null || (r.amount as bigint) < (best.amount as bigint)) best = r;
  }
  return best;
}

/** The signed payment header for an option. */
export function buildPayment(
  pr: PaymentRequired,
  r: Requirement,
  key: Uint8Array,
  nowSec: number,
  nonce: Uint8Array = randomBytes(32),
): { header: string; value: string; from: string; validBefore: string } {
  const usdc = USDC[r.network];
  if (!usdc || r.amount === null) throw new Error("not a payable option");
  const chainId = BigInt(r.network.split(":")[1] as string);
  const from = addressOf(key);
  const timeout = Math.min(Math.max(Math.floor(r.maxTimeoutSeconds), 30), 900);
  const authorization = {
    from,
    to: checksumAddress(r.payTo),
    value: r.amount.toString(),
    // A little in the past so a facilitator with a slow clock accepts it.
    validAfter: String(Math.max(0, nowSec - 600)),
    validBefore: String(nowSec + timeout),
    nonce: `0x${Buffer.from(nonce).toString("hex")}`,
  };
  const name = usdc.name;
  const version = usdc.version;
  // The EIP-712 domain is always the known USDC contract: a 402 server cannot
  // override name/version (in `extra`) to make the wallet sign another domain.
  const signature = signTransfer(
    { name, version, chainId, verifyingContract: usdc.address },
    authorization,
    key,
  );
  const payload = { signature, authorization };
  if (r.x402Version === 1) {
    const v1Network = str(r.raw.network);
    return {
      header: "X-PAYMENT",
      value: encodeB64Json({ x402Version: 1, scheme: r.scheme, network: v1Network, payload }),
      from,
      validBefore: authorization.validBefore,
    };
  }
  return {
    header: "PAYMENT-SIGNATURE",
    value: encodeB64Json({
      x402Version: 2,
      ...(pr.resource ? { resource: pr.resource } : {}),
      accepted: r.raw,
      payload,
      ...(pr.extensions ? { extensions: pr.extensions } : {}),
    }),
    from,
    validBefore: authorization.validBefore,
  };
}

// ---------------------------------------------------------------------------
// tools

const quote = defineTool({
  name: "x402_quote",
  description:
    "Ask an x402 paid URL what it costs, without paying: sends a read-only GET (or HEAD) with no payment and, when it answers 402 Payment Required, lists each payment option with its price in USD, network, recipient and whether this pack could pay it (and why not). A URL that does not ask for payment is reported as free.",
  annotations: {
    title: "x402 price check",
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  input: z.object(quoteInput),
  async run(input, ctx) {
    const limits = limitsFrom(ctx.settings);
    checkRequest(input, limits);
    // A quote runs without asking anyone. Without headers it is a plain public
    // GET, like fetch_web; caller headers (an API key, say) only go to hosts
    // the user listed.
    if (Object.keys(input.headers ?? {}).length > 0 && limits.allowedHosts.length === 0) {
      throw new Error(
        "x402_quote sends extra headers only to the pack's allowed hosts; set allowedHosts in the x402 pack settings, or quote without headers",
      );
    }
    const res = await send(ctx, input, limits);
    if (res.status !== 402) {
      await res.body?.cancel().catch(() => undefined);
      return { payment_required: false, status: res.status, options: [] };
    }
    const pr = await readOptions(res);
    if (!pr) {
      return {
        payment_required: true,
        status: 402,
        readable: false,
        options: [],
        note: "the 402 carries no x402 payment options",
      };
    }
    const spent = spentSince(await readLedger(ctx), Date.now() - DAY_MS);
    const ceiling = Math.min(limits.maxPerCallUsd, Math.max(0, limits.dailyCapUsd - spent));
    const best = choose(pr.accepts, limits, ceiling);
    return {
      payment_required: true,
      status: 402,
      x402_version: pr.x402Version,
      server_error: pr.error,
      options: pr.accepts.map((r) => describeOption(r, limits, ceiling)),
      cheapest_payable_usd: best?.amount != null ? usdOf(best.amount) : null,
      limit_left_usd: ceiling,
      wallet_set: await ctx.secrets.has(SECRET),
    };
  },
});

const pay = defineTool({
  name: "x402_fetch",
  description:
    "Fetch an x402 paid URL and pay for it in USDC from the pack's wallet: sends the request, and when it answers 402 picks the cheapest option this pack can pay (exact scheme, USDC on an allowed network) that costs at most max_usd and fits the pack's per-call and 24-hour limits, signs the payment and sends the request again with it. Always asks a person to approve first. Returns the paid response (text inline, files saved to the library), the settlement transaction and cost_usd. Never pays more than once per call. Use x402_quote first to see the price.",
  tags: ["x402", "paid", "approval"],
  secrets: [SECRET],
  annotations: {
    title: "x402 pay and fetch",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    ...requestInput,
    max_usd: z
      .number()
      .positive()
      .max(MAX_PER_CALL_CEILING)
      .describe(
        "The most this call may pay, in USD. The approval shows it; nothing above it is ever signed.",
      ),
  }),
  async run(input, ctx) {
    const limits = limitsFrom(ctx.settings);
    const url = checkRequest(input, limits);
    const key = await walletKey(ctx);
    const landed = { url: url.href };
    const first = await send(ctx, input, limits, {}, landed);
    if (first.status !== 402) {
      return { paid: false, cost_usd: 0, ...(await responseOut(ctx, first, input.url)) };
    }
    // The paid request goes to the URL asked for, never redirected, so a price
    // quoted by a page it redirected to is not signed: that page did not get
    // the payment, the first one would.
    if (landed.url !== url.href) {
      await first.body?.cancel().catch(() => undefined);
      throw new Error(
        `${url.hostname} redirected to ${logUrl(landed.url)}, which asked for payment; nothing was paid. Call x402_fetch with that URL directly to pay it.`,
      );
    }
    const pr = await readOptions(first);
    if (!pr || pr.accepts.length === 0) {
      throw new Error(
        `${url.hostname} answered 402 without x402 payment options; nothing was paid`,
      );
    }
    return withLock(ctx.pack.dataDir, async () => {
      const spent = spentSince(await readLedger(ctx), Date.now() - DAY_MS);
      const dailyLeft = Math.max(0, limits.dailyCapUsd - spent);
      const ceiling = Math.min(input.max_usd, limits.maxPerCallUsd, dailyLeft);
      const option = choose(pr.accepts, limits, ceiling);
      if (!option || option.amount === null) {
        const reasons = pr.accepts.map((r) => describeOption(r, limits, ceiling));
        throw new Error(
          `Nothing was paid: no payment option fits (max_usd $${fmt(input.max_usd)}, per-call limit $${fmt(limits.maxPerCallUsd)}, $${fmt(dailyLeft)} left of the 24-hour limit). Options: ${JSON.stringify(reasons).slice(0, 1500)}`,
        );
      }
      const usd = usdOf(option.amount);
      const payment = buildPayment(pr, option, key, Math.floor(Date.now() / 1000));
      const id = randomUUID();
      await appendLedger(ctx, {
        id,
        at: new Date().toISOString(),
        kind: "payment",
        url: logUrl(input.url),
        network: option.network,
        payTo: option.payTo,
        amount: option.amount.toString(),
        usd,
        from: payment.from,
        validBefore: payment.validBefore,
      });
      ctx.logger.info(
        `x402: paying $${fmt(usd)} on ${option.network} to ${option.payTo} for ${url.hostname}`,
      );
      let res: Response;
      try {
        res = await send(ctx, input, limits, { [payment.header]: payment.value });
      } catch (err) {
        await appendLedger(ctx, {
          id,
          at: new Date().toISOString(),
          kind: "outcome",
          outcome: "send_failed",
        });
        throw new Error(
          `The paid request failed to send (${(err as Error).message}). The signed payment ($${fmt(usd)}) counts against your limit until it expires, in case the server settles it.`,
        );
      }
      const settlement = settlementOf(res);
      const outcome = res.status === 402 ? "refused" : res.ok ? "paid" : `http_${res.status}`;
      await appendLedger(ctx, {
        id,
        at: new Date().toISOString(),
        kind: "outcome",
        outcome,
        status: res.status,
        transaction: (settlement?.transaction as string | null | undefined) ?? null,
      });
      if (res.status === 402) {
        const again = await readOptions(res);
        throw new Error(
          `${url.hostname} refused the payment${again?.error ? ` (${again.error})` : ""}. It counts against your limit until it expires (${new Date(Number(payment.validBefore) * 1000).toISOString()}) in case it was settled anyway.`,
        );
      }
      return {
        paid: true,
        // What was signed. Billed to spend caps even if the server fails after.
        cost_usd: usd,
        payment: {
          id,
          network: option.network,
          pay_to: option.payTo,
          amount: option.amount.toString(),
          from: payment.from,
          settlement,
        },
        ...(await responseOut(ctx, res, input.url)),
      };
    });
  },
});

const wallet = defineTool({
  name: "x402_wallet",
  description:
    "Show the x402 wallet: its address (never the key), the networks and limits in force, what was paid in the last 24 hours and the most recent payments.",
  annotations: { title: "x402 wallet", readOnlyHint: true, openWorldHint: false },
  input: z.object({ recent: z.number().int().min(0).max(100).default(10) }),
  async run(input, ctx) {
    const limits = limitsFrom(ctx.settings);
    let address: string | null = null;
    let problem: string | null = null;
    if (await ctx.secrets.has(SECRET)) {
      try {
        address = addressOf(parsePrivateKey(await ctx.secrets.get(SECRET)));
      } catch (err) {
        problem = (err as Error).message;
      }
    } else {
      problem = `${SECRET} is not set`;
    }
    const entries = await readLedger(ctx);
    const spent = spentSince(entries, Date.now() - DAY_MS);
    const outcomes = new Map<string, LedgerEntry>();
    for (const e of entries) if (e.kind === "outcome") outcomes.set(e.id, e);
    const payments = entries.filter((e) => e.kind === "payment");
    return {
      address,
      problem,
      networks: limits.allowedNetworks.map((n) => ({
        id: n,
        label: USDC[n]?.label,
        usdc: USDC[n]?.address,
      })),
      max_per_call_usd: limits.maxPerCallUsd,
      daily_cap_usd: limits.dailyCapUsd,
      spent_24h_usd: Math.round(spent * 1e6) / 1e6,
      left_24h_usd: Math.max(0, Math.round((limits.dailyCapUsd - spent) * 1e6) / 1e6),
      allowed_hosts: limits.allowedHosts.length > 0 ? limits.allowedHosts : "any",
      recent: payments
        .slice(-input.recent)
        .reverse()
        .map((p) => ({
          at: p.at,
          url: p.url,
          usd: p.usd,
          network: p.network,
          pay_to: p.payTo,
          outcome: outcomes.get(p.id)?.outcome ?? "unknown",
          transaction: outcomes.get(p.id)?.transaction ?? null,
        })),
    };
  },
});

export default definePack({ tools: [quote, pay, wallet] });
