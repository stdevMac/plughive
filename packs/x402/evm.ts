// packs/x402/evm.ts
//
// The little Ethereum cryptography x402's "exact" scheme needs, with no
// dependencies (packs import only plughive/pack and node:*):
//
//   keccak256            Keccak-f[1600], 0x01 padding (Ethereum's, not SHA3's 0x06)
//   secp256k1 signing    RFC 6979 deterministic nonces (HMAC-SHA256), low-s
//                        (EIP-2), 65-byte r||s||v with v = 27 + parity
//   recovery             used to check every signature against the wallet
//                        address before it leaves the daemon
//   addresses            EIP-55 checksums
//   EIP-712              the EIP-3009 TransferWithAuthorization digest
//
// Tests cross-check all of this against the audited @noble libraries
// (dev dependencies only).
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// keccak256

const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS: bigint[] = (() => {
  const out: bigint[] = [];
  let r = 1;
  for (let round = 0; round < 24; round++) {
    let c = 0n;
    for (let j = 0; j < 7; j++) {
      // LFSR x^8 + x^6 + x^5 + x^4 + 1
      if (r & 1) c |= 1n << BigInt((1 << j) - 1);
      r = r & 0x80 ? ((r << 1) ^ 0x71) & 0xff : (r << 1) & 0xff;
    }
    out.push(c);
  }
  return out;
})();
const ROTATIONS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
] as const;

const rotl = (x: bigint, n: number) =>
  n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;

function keccakF(s: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[x] =
        (s[x] as bigint) ^
        (s[x + 5] as bigint) ^
        (s[x + 10] as bigint) ^
        (s[x + 15] as bigint) ^
        (s[x + 20] as bigint);
    }
    for (let x = 0; x < 5; x++) {
      const d = (c[(x + 4) % 5] as bigint) ^ rotl(c[(x + 1) % 5] as bigint, 1);
      for (let y = 0; y < 25; y += 5) s[x + y] = (s[x + y] as bigint) ^ d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + ((2 * x + 3 * y) % 5) * 5] = rotl(
          s[x + y * 5] as bigint,
          (ROTATIONS[x] as readonly number[])[y] as number,
        );
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 25; y += 5) {
        s[x + y] =
          (b[x + y] as bigint) ^
          (~(b[((x + 1) % 5) + y] as bigint) & MASK64 & (b[((x + 2) % 5) + y] as bigint));
      }
    }
    s[0] = (s[0] as bigint) ^ (ROUND_CONSTANTS[round] as bigint);
  }
}

const RATE = 136; // bytes, for a 256-bit output

export function keccak256(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((data.length + 1) / RATE) * RATE);
  padded.set(data);
  padded[data.length] = (padded[data.length] as number) ^ 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] as number) ^ 0x80;
  const s = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k] as number);
      s[i] = (s[i] as bigint) ^ lane;
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = s[i] as bigint;
    for (let k = 0; k < 8; k++) {
      out[i * 8 + k] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// bytes helpers

export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("not a hex string");
  return new Uint8Array(Buffer.from(h, "hex"));
}

const bytesToBig = (b: Uint8Array) => (b.length === 0 ? 0n : BigInt(`0x${toHex(b)}`));

function bigToBytes(n: bigint, len = 32): Uint8Array {
  if (n < 0n) throw new Error("negative");
  const hex = n.toString(16).padStart(len * 2, "0");
  if (hex.length > len * 2) throw new Error("number too large");
  return fromHex(hex);
}

const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

// ---------------------------------------------------------------------------
// secp256k1

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

type Point = { x: bigint; y: bigint } | null; // null is the point at infinity
const G: Point = { x: GX, y: GY };

const mod = (a: bigint, m: bigint) => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function inv(a: bigint, m: bigint): bigint {
  let [lo, hi] = [mod(a, m), m];
  let [x0, x1] = [1n, 0n];
  if (lo === 0n) throw new Error("no inverse");
  while (lo > 1n) {
    const q = hi / lo;
    [lo, hi] = [hi - q * lo, lo];
    [x0, x1] = [x1 - q * x0, x0];
  }
  return mod(x0, m);
}

function powMod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  let base = mod(b, m);
  let exp = e;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return r;
}

function add(a: Point, b: Point): Point {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x) {
    if (mod(a.y + b.y, P) === 0n) return null;
    const l = mod(3n * a.x * a.x * inv(2n * a.y, P), P);
    const x = mod(l * l - 2n * a.x, P);
    return { x, y: mod(l * (a.x - x) - a.y, P) };
  }
  const l = mod((b.y - a.y) * inv(b.x - a.x, P), P);
  const x = mod(l * l - a.x - b.x, P);
  return { x, y: mod(l * (a.x - x) - a.y, P) };
}

function mul(k: bigint, p: Point): Point {
  let r: Point = null;
  let q = p;
  let e = mod(k, N);
  while (e > 0n) {
    if (e & 1n) r = add(r, q);
    q = add(q, q);
    e >>= 1n;
  }
  return r;
}

const neg = (p: Point): Point => (p === null ? null : { x: p.x, y: mod(-p.y, P) });

function privateScalar(key: Uint8Array): bigint {
  if (key.length !== 32) throw new Error("a private key is 32 bytes");
  const d = bytesToBig(key);
  if (d <= 0n || d >= N) throw new Error("the private key is out of range");
  return d;
}

/** The 64-byte uncompressed public key (x || y, no 0x04 prefix). */
export function publicKey(key: Uint8Array): Uint8Array {
  const q = mul(privateScalar(key), G);
  if (q === null) throw new Error("bad key");
  return concat(bigToBytes(q.x), bigToBytes(q.y));
}

/** RFC 6979 section 3.2 with HMAC-SHA256 and qlen = 256. */
function* rfc6979(d: bigint, hash: Uint8Array): Generator<bigint> {
  const x = bigToBytes(d);
  const h = bigToBytes(mod(bytesToBig(hash), N));
  const hmac = (k: Uint8Array, ...data: Uint8Array[]) =>
    new Uint8Array(
      createHmac("sha256", k)
        .update(concat(...data))
        .digest(),
    );
  let v = new Uint8Array(32).fill(1);
  let k = new Uint8Array(32);
  k = hmac(k, v, Uint8Array.of(0), x, h);
  v = hmac(k, v);
  k = hmac(k, v, Uint8Array.of(1), x, h);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const t = bytesToBig(v);
    if (t >= 1n && t < N) yield t;
    k = hmac(k, v, Uint8Array.of(0));
    v = hmac(k, v);
  }
}

export interface Signature {
  r: bigint;
  s: bigint;
  /** 0 or 1: the parity of R.y after low-s normalisation. */
  recovery: 0 | 1;
}

/** Sign a 32-byte digest (no hashing here). Deterministic, low-s. */
export function signDigest(digest: Uint8Array, key: Uint8Array): Signature {
  if (digest.length !== 32) throw new Error("a digest is 32 bytes");
  const d = privateScalar(key);
  const e = mod(bytesToBig(digest), N);
  for (const k of rfc6979(d, digest)) {
    const R = mul(k, G);
    if (R === null) continue;
    // R.x >= N happens with probability ~2^-128; such a nonce is skipped so
    // the recovery id is always 0 or 1, the two values Ethereum's v carries.
    if (R.x >= N) continue;
    const r = R.x;
    if (r === 0n) continue;
    let s = mod(inv(k, N) * (e + r * d), N);
    if (s === 0n) continue;
    let recovery = Number(R.y & 1n) as 0 | 1;
    if (s > N / 2n) {
      s = N - s;
      recovery = (recovery ^ 1) as 0 | 1;
    }
    return { r, s, recovery };
  }
  throw new Error("unreachable");
}

/** The 64-byte public key that made `sig` over `digest`, or null. */
export function recoverPublicKey(digest: Uint8Array, sig: Signature): Uint8Array | null {
  const { r, s, recovery } = sig;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;
  const alpha = mod(r * r * r + 7n, P);
  let y = powMod(alpha, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== alpha) return null;
  if (Number(y & 1n) !== recovery) y = P - y;
  const R: Point = { x: r, y };
  const e = mod(bytesToBig(digest), N);
  const rInv = inv(r, N);
  const q = mul(rInv, add(mul(s, R), neg(mul(e, G))));
  if (q === null) return null;
  return concat(bigToBytes(q.x), bigToBytes(q.y));
}

/** 65 bytes r || s || v, v = 27 + recovery, as 0x-hex (what EIP-3009 takes). */
export function signatureHex(sig: Signature): string {
  return `0x${toHex(concat(bigToBytes(sig.r), bigToBytes(sig.s), Uint8Array.of(27 + sig.recovery)))}`;
}

// ---------------------------------------------------------------------------
// addresses

/** EIP-55 checksummed form of a 20-byte address (any case in). */
export function checksumAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an address: ${address}`);
  const lower = address.slice(2).toLowerCase();
  const hash = toHex(keccak256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = lower[i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** True for a 0x + 40 hex address that is all lower, all upper or a valid EIP-55 mix. */
export function isAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return checksumAddress(address) === address;
}

export function addressOfPublicKey(pub: Uint8Array): string {
  if (pub.length !== 64) throw new Error("a public key is 64 bytes");
  return checksumAddress(`0x${toHex(keccak256(pub).subarray(12))}`);
}

export const addressOf = (key: Uint8Array) => addressOfPublicKey(publicKey(key));

/** A private key from 0x-hex (64 hex digits), checked to be in range. */
export function parsePrivateKey(text: string): Uint8Array {
  const t = text.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(t)) {
    throw new Error("the wallet key must be 64 hex digits (optionally starting with 0x)");
  }
  const key = fromHex(t);
  privateScalar(key);
  return key;
}

// ---------------------------------------------------------------------------
// EIP-712 for EIP-3009 TransferWithAuthorization

const utf8 = (s: string) => new TextEncoder().encode(s);
const DOMAIN_TYPEHASH = keccak256(
  utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const TRANSFER_TYPEHASH = keccak256(
  utf8(
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);

const addressWord = (a: string) => bigToBytes(BigInt(a));
const uintWord = (v: bigint | string | number) => {
  const n = BigInt(v);
  if (n < 0n || n >= 1n << 256n) throw new Error("uint256 out of range");
  return bigToBytes(n);
};

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: bigint | number;
  verifyingContract: string;
}

export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 0x + 64 hex */
  nonce: string;
}

export function domainSeparator(d: Eip712Domain): Uint8Array {
  return keccak256(
    concat(
      DOMAIN_TYPEHASH,
      keccak256(utf8(d.name)),
      keccak256(utf8(d.version)),
      uintWord(d.chainId),
      addressWord(d.verifyingContract),
    ),
  );
}

export function transferDigest(domain: Eip712Domain, a: TransferAuthorization): Uint8Array {
  const nonce = fromHex(a.nonce);
  if (nonce.length !== 32) throw new Error("the nonce is 32 bytes");
  const struct = keccak256(
    concat(
      TRANSFER_TYPEHASH,
      addressWord(a.from),
      addressWord(a.to),
      uintWord(a.value),
      uintWord(a.validAfter),
      uintWord(a.validBefore),
      nonce,
    ),
  );
  return keccak256(concat(Uint8Array.of(0x19, 0x01), domainSeparator(domain), struct));
}

/**
 * Sign a TransferWithAuthorization and check, by recovery, that the signature
 * belongs to `a.from` before returning it.
 */
export function signTransfer(
  domain: Eip712Domain,
  a: TransferAuthorization,
  key: Uint8Array,
): string {
  const digest = transferDigest(domain, a);
  const sig = signDigest(digest, key);
  const pub = recoverPublicKey(digest, sig);
  if (!pub || addressOfPublicKey(pub).toLowerCase() !== a.from.toLowerCase()) {
    throw new Error("the payment signature did not verify against the wallet address");
  }
  return signatureHex(sig);
}
