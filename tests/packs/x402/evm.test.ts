import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";
import {
  addressOf,
  checksumAddress,
  domainSeparator,
  isAddress,
  keccak256,
  parsePrivateKey,
  publicKey,
  recoverPublicKey,
  signDigest,
  signTransfer,
  toHex,
  transferDigest,
} from "../../../packs/x402/evm.js";
import { USDC } from "../../../packs/x402/index.js";

const hex = (b: Uint8Array) => toHex(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("keccak256", () => {
  it("matches the known vectors", () => {
    expect(hex(keccak256(new Uint8Array()))).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(hex(keccak256(utf8("abc")))).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("matches @noble/hashes on every length around the 136-byte rate", () => {
    for (const len of [0, 1, 55, 56, 135, 136, 137, 271, 272, 273, 1000]) {
      const data = randomBytes(len);
      expect(hex(keccak256(data))).toBe(hex(keccak_256(data)));
    }
  });
});

describe("secp256k1", () => {
  it("derives the known address of private key 1", () => {
    const key = new Uint8Array(32);
    key[31] = 1;
    expect(addressOf(key)).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
  });

  it("matches @noble/curves for public keys, signatures and recovery", () => {
    for (let i = 0; i < 25; i++) {
      const key = createHash("sha256").update(`key ${i}`).digest();
      const digest = keccak256(utf8(`message ${i}`));
      expect(hex(publicKey(key))).toBe(hex(secp256k1.getPublicKey(key, false).subarray(1)));
      const sig = signDigest(digest, key);
      const noble = secp256k1.sign(digest, key, { prehash: false, lowS: true });
      // RFC 6979: same k, so the same (low-s) signature, byte for byte.
      expect(hex(noble)).toBe(
        sig.r.toString(16).padStart(64, "0") + sig.s.toString(16).padStart(64, "0"),
      );
      expect(sig.s <= secp256k1.Point.CURVE().n / 2n).toBe(true);
      expect(secp256k1.verify(noble, digest, secp256k1.getPublicKey(key), { prehash: false })).toBe(
        true,
      );
      const recovered = recoverPublicKey(digest, sig);
      expect(recovered && hex(recovered)).toBe(hex(publicKey(key)));
      const nobleRecovered = secp256k1.sign(digest, key, { prehash: false, format: "recovered" });
      expect(nobleRecovered[0]).toBe(sig.recovery);
    }
  });

  it("recovers nothing useful from a tampered signature", () => {
    const key = createHash("sha256").update("k").digest();
    const digest = keccak256(utf8("m"));
    const sig = signDigest(digest, key);
    const other = recoverPublicKey(digest, { ...sig, recovery: sig.recovery === 0 ? 1 : 0 });
    expect(other === null || hex(other) !== hex(publicKey(key))).toBe(true);
  });

  it("refuses bad keys", () => {
    expect(() => parsePrivateKey("0x1234")).toThrow(/64 hex digits/);
    expect(() => parsePrivateKey(`0x${"0".repeat(64)}`)).toThrow(/out of range/);
    expect(() => parsePrivateKey("f".repeat(64))).toThrow(/out of range/);
    expect(parsePrivateKey(` 0x${"0".repeat(63)}1 `)[31]).toBe(1);
  });
});

describe("addresses", () => {
  it("checksums with EIP-55", () => {
    // Vectors from EIP-55.
    for (const a of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    ]) {
      expect(checksumAddress(a.toLowerCase())).toBe(a);
      expect(isAddress(a)).toBe(true);
    }
    expect(isAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toBe(false);
    expect(isAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(true);
    expect(isAddress("0x123")).toBe(false);
  });

  it("holds only valid checksummed USDC addresses", () => {
    for (const u of Object.values(USDC)) expect(checksumAddress(u.address)).toBe(u.address);
  });
});

describe("EIP-712 TransferWithAuthorization", () => {
  const domain = {
    name: "USDC",
    version: "2",
    chainId: 84532,
    verifyingContract: USDC["eip155:84532"]!.address,
  };
  const key = createHash("sha256").update("x402 test wallet").digest();
  const auth = {
    from: addressOf(key),
    to: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    value: "10000",
    validAfter: "1740672089",
    validBefore: "1740672154",
    nonce: `0x${"f3".repeat(32)}`,
  };

  it("builds the digest from the standard type hashes", () => {
    const enc = (...parts: Uint8Array[]) => keccak_256(Buffer.concat(parts));
    const word = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
    const expectedDomain = enc(
      keccak_256(
        utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      ),
      keccak_256(utf8(domain.name)),
      keccak_256(utf8(domain.version)),
      word(84532n),
      word(BigInt(domain.verifyingContract)),
    );
    expect(hex(domainSeparator(domain))).toBe(hex(expectedDomain));
    const struct = enc(
      keccak_256(
        utf8(
          "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
        ),
      ),
      word(BigInt(auth.from)),
      word(BigInt(auth.to)),
      word(10000n),
      word(1740672089n),
      word(1740672154n),
      Buffer.from("f3".repeat(32), "hex"),
    );
    const expected = keccak_256(Buffer.concat([Buffer.from([0x19, 0x01]), expectedDomain, struct]));
    expect(hex(transferDigest(domain, auth))).toBe(hex(expected));
  });

  it("signs a 65-byte signature that verifies for the wallet", () => {
    const sig = signTransfer(domain, auth, key);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    const v = Number.parseInt(sig.slice(130), 16);
    expect([27, 28]).toContain(v);
    const compact = Buffer.from(sig.slice(2, 130), "hex");
    expect(
      secp256k1.verify(compact, transferDigest(domain, auth), secp256k1.getPublicKey(key), {
        prehash: false,
      }),
    ).toBe(true);
  });

  it("refuses to sign for an address that is not the wallet", () => {
    expect(() => signTransfer(domain, { ...auth, from: auth.to }, key)).toThrow(/did not verify/);
  });
});
