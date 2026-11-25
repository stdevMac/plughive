import { describe, expect, it } from "vitest";
import {
  LONG_SECRET_LENGTH,
  MIN_REDACT_LENGTH,
  REDACTED,
  REDACTION_FAILED,
  Redactor,
} from "../../../src/core/secrets/redactor.js";

const SECRET = "sk-live_Abc123/+xyz=="; // has URL- and regex-special characters
const SIMPLE = "tok_9f8e7d6c5b4a3210";

function make(...values: string[]): Redactor {
  const redactor = new Redactor();
  for (const value of values) redactor.register(value);
  return redactor;
}

describe("Redactor.redact", () => {
  it("replaces the raw value everywhere it occurs", () => {
    const r = make(SIMPLE);
    const out = r.redact(`a ${SIMPLE} b ${SIMPLE}${SIMPLE} c`);
    expect(out).toBe(`a ${REDACTED} b ${REDACTED}${REDACTED} c`);
  });

  it("treats the value literally, not as a pattern", () => {
    const weird = "a.b*c+d?(e)[f]{g}|h^i$j\\k";
    const r = make(weird);
    expect(r.redact(`x ${weird} y`)).toBe(`x ${REDACTED} y`);
    expect(r.redact("aXb*c+d?(e)[f]{g}|h^i$j\\k")).not.toContain(REDACTED);
  });

  it("catches URL-encoded forms", () => {
    const r = make(SECRET);
    const forms = [
      encodeURIComponent(SECRET),
      encodeURIComponent(SECRET).toLowerCase().replace("sk-live_abc123", "sk-live_Abc123"),
      encodeURI(SECRET),
      new URLSearchParams({ key: SECRET }).toString().slice("key=".length),
    ];
    for (const form of forms) {
      const out = r.redact(`GET https://api.test/v1?key=${form}&x=1`);
      expect(out, form).toBe(`GET https://api.test/v1?key=${REDACTED}&x=1`);
    }
  });

  it("catches form encoding of spaces and strict percent-encoding", () => {
    const value = "my secret (v1)!*'";
    const r = make(value);
    const form = new URLSearchParams({ p: value }).toString();
    expect(r.redact(form)).toBe(`p=${REDACTED}`);
    const strict = encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    expect(r.redact(`v=${strict}`)).toBe(`v=${REDACTED}`);
    expect(r.redact(`v=${encodeURIComponent(value)}`)).toBe(`v=${REDACTED}`);
  });

  it("catches base64 and base64url of the value", () => {
    const r = make(SECRET);
    const b64 = Buffer.from(SECRET).toString("base64");
    const b64url = Buffer.from(SECRET).toString("base64url");
    expect(r.redact(`x ${b64} y`)).not.toContain(b64.replace(/=+$/, ""));
    expect(r.redact(`x ${b64url} y`)).not.toContain(b64url);
    expect(r.redact(`x ${b64} y`)).toContain(REDACTED);
  });

  it("catches the value inside a longer base64 payload at every alignment", () => {
    const r = make(SIMPLE);
    for (const prefix of ["", "u", "us", "use", "user:", "a-longer-user-name:"]) {
      for (const suffix of ["", "!", "!!", "!!!"]) {
        const header = Buffer.from(`${prefix}${SIMPLE}${suffix}`).toString("base64");
        const out = r.redact(`Authorization: Basic ${header}`);
        expect(out, `${prefix}|${suffix}`).toContain(REDACTED);
        // Whatever survives must no longer decode to something containing the secret.
        for (const piece of out.split(REDACTED)) {
          const tail = piece.split(" ").at(-1) ?? "";
          for (let skip = 0; skip < 4; skip++) {
            const decoded = Buffer.from(tail.slice(skip), "base64").toString("latin1");
            expect(decoded).not.toContain(SIMPLE.slice(4, 16));
          }
        }
      }
    }
    const urlSafe = Buffer.from(`??>>${SIMPLE}`).toString("base64url");
    expect(r.redact(urlSafe)).toContain(REDACTED);
  });

  it("catches the JSON-escaped form", () => {
    const value = 'pa"ss\\word\nline2';
    const r = make(value);
    const json = JSON.stringify({ password: value });
    const out = r.redact(json);
    expect(out).toBe(`{"password":"${REDACTED}"}`);
  });

  it("ignores values shorter than the minimum, registers at the minimum", () => {
    expect(MIN_REDACT_LENGTH).toBe(6);
    const r = make("", "a", "12345");
    expect(r.size).toBe(0);
    expect(r.redact("a 12345 b")).toBe("a 12345 b");
    r.register("123456");
    expect(r.size).toBe(1);
    expect(r.redact("a 123456 b")).toBe(`a ${REDACTED} b`);
    r.register(undefined as unknown as string);
    r.register(123456789 as unknown as string);
    expect(r.size).toBe(1);
  });

  it("handles several values, including one containing another", () => {
    const inner = "abcdef123456";
    const outer = `prefix-${inner}-suffix`;
    const r = make(inner, outer, SIMPLE);
    expect(r.redact(`${outer} | ${inner} | ${SIMPLE}`)).toBe(
      `${REDACTED} | ${REDACTED} | ${REDACTED}`,
    );
    r.register(inner); // duplicate
    expect(r.size).toBe(3);
  });

  it("values registered later take effect", () => {
    const r = make(SIMPLE);
    expect(r.redact("later-secret-value")).toBe("later-secret-value");
    r.register("later-secret-value");
    expect(r.redact("x later-secret-value")).toBe(`x ${REDACTED}`);
  });

  it("leaves unrelated text and non-strings alone", () => {
    const r = make(SIMPLE);
    const text = "The quick brown fox, https://example.com/a?b=c, dG9rZW4= and 12345.";
    expect(r.redact(text)).toBe(text);
    expect(r.redact("")).toBe("");
    expect(r.redact(42 as unknown as string)).toBe(42);
    expect(new Redactor().redact(SIMPLE)).toBe(SIMPLE);
  });

  it("handles non-ASCII secrets and lone surrogates", () => {
    const value = "pässwörd-\u{1f511}-key";
    const r = make(value, "bad\ud800surrogate");
    expect(r.redact(`a ${value} b`)).toBe(`a ${REDACTED} b`);
    expect(r.redact(`q=${encodeURIComponent(value)}`)).toBe(`q=${REDACTED}`);
    expect(r.redact(Buffer.from(value).toString("base64"))).toContain(REDACTED);
    expect(r.redact("x bad\ud800surrogate y")).toBe(`x ${REDACTED} y`);
  });
});

describe("Redactor.redactDeep", () => {
  it("redacts nested strings and keys without mutating the input", () => {
    const r = make(SIMPLE);
    const input = {
      url: `https://api.test/?key=${SIMPLE}`,
      nested: { list: [SIMPLE, 1, null, true, { deep: `Bearer ${SIMPLE}` }] },
      [SIMPLE]: "value under a secret key",
      n: 5,
      missing: undefined,
    };
    const snapshot = JSON.stringify(input);
    const out = r.redactDeep(input);
    expect(JSON.stringify(out)).not.toContain(SIMPLE);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out.n).toBe(5);
    expect(out.nested.list[1]).toBe(1);
    expect(out.nested.list[2]).toBeNull();
    expect((out as Record<string, unknown>)[REDACTED]).toBe("value under a secret key");
  });

  it("serialises errors with redacted message and stack", () => {
    const r = make(SIMPLE);
    const err = Object.assign(new Error(`request failed with key ${SIMPLE}`), {
      code: "E_FAIL",
      config: { headers: { authorization: `Bearer ${SIMPLE}` } },
    });
    const out = r.redactDeep({ err }) as unknown as { err: Record<string, unknown> };
    expect(JSON.stringify(out)).not.toContain(SIMPLE);
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toBe(`request failed with key ${REDACTED}`);
    expect(out.err.code).toBe("E_FAIL");
    expect(typeof out.err.stack).toBe("string");
  });

  it("survives cycles and honours toJSON", () => {
    const r = make(SIMPLE);
    const node: Record<string, unknown> = { value: SIMPLE };
    node.self = node;
    const out = r.redactDeep(node) as Record<string, unknown>;
    expect(out.self).toBe("[circular]");
    expect(out.value).toBe(REDACTED);

    const shared = { v: SIMPLE };
    const twice = r.redactDeep({ a: shared, b: shared }) as { a: unknown; b: unknown };
    expect(twice).toEqual({ a: { v: REDACTED }, b: { v: REDACTED } });

    const url = new URL(`https://api.test/?key=${SIMPLE}`);
    expect(r.redactDeep({ url })).toEqual({ url: `https://api.test/?key=${REDACTED}` });
    const when = new Date(0);
    expect(r.redactDeep({ when })).toEqual({ when: "1970-01-01T00:00:00.000Z" });
  });

  it("passes primitives through", () => {
    const r = make(SIMPLE);
    expect(r.redactDeep(null)).toBeNull();
    expect(r.redactDeep(undefined)).toBeUndefined();
    expect(r.redactDeep(7)).toBe(7);
    expect(r.redactDeep(SIMPLE)).toBe(REDACTED);
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the security review (R1-R5).

describe("Redactor review regressions", () => {
  const AWS = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  it("R1: catches PHP-escaped, hex and Python \\u-escaped re-encodings", () => {
    const r = make(AWS);
    expect(r.redact(`x ${AWS.replace(/\//g, "\\/")} y`)).toBe(`x ${REDACTED} y`);
    const hex = Buffer.from(AWS).toString("hex");
    expect(r.redact(hex)).toBe(REDACTED);
    expect(r.redact(hex.toUpperCase())).toBe(REDACTED);
    expect(r.redact(encodeURIComponent(AWS))).toBe(REDACTED);
    const r2 = make("pässwörd-geheim");
    expect(r2.redact('"p\\u00e4ssw\\u00f6rd-geheim"')).toBe(`"${REDACTED}"`);
  });

  it("R1: documented misses (not redacted): HTML entities, double URL-encoding, prefixes, line wraps, case changes", () => {
    const r = make(AWS);
    for (const form of [
      AWS.replace(/\//g, "&#x2F;"),
      encodeURIComponent(encodeURIComponent(AWS)),
      `Incorrect API key provided: ${AWS.slice(0, 30)}`,
      `${AWS.slice(0, 20)}\n${AWS.slice(20)}`,
      AWS.toUpperCase(),
    ]) {
      expect(r.redact(form)).toBe(form);
    }
  });

  it("R2: a short secret inside Basic auth base64 is caught at every alignment", () => {
    const r = make("s3cr3t");
    for (const prefix of ["usr:", "u:", "user:"]) {
      const encoded = Buffer.from(`${prefix}s3cr3t`).toString("base64");
      expect(r.redact(encoded), prefix).toContain(REDACTED);
    }
  });

  it("R3: redactDeep never copies binary data and walks Maps and Sets", () => {
    const r = make("topsecret-value-1");
    const out = JSON.stringify(
      r.redactDeep({
        buf: Buffer.from("topsecret-value-1"),
        u8: new TextEncoder().encode("topsecret-value-1"),
        ab: new ArrayBuffer(4),
        map: new Map([["k", "topsecret-value-1"]]),
        set: new Set(["topsecret-value-1"]),
      }),
    );
    expect(out).not.toContain("topsecret");
    expect(out).toContain("[binary 17 bytes]");
    expect(out).toContain("[binary 4 bytes]");
    expect(JSON.parse(out).map).toEqual([["k", REDACTED]]);
    expect(JSON.parse(out).set).toEqual([REDACTED]);
  });

  it("R4: a very large secret does not break redaction of the others", () => {
    const big = Array.from({ length: 30_000 }, (_, i) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charAt((i * 7919) % 64),
    ).join("");
    expect(big.length).toBeGreaterThan(LONG_SECRET_LENGTH);
    const r = make("sk-OTHER-SMALL-SECRET-0001", big);
    expect(r.redact(`log sk-OTHER-SMALL-SECRET-0001 ${big} line`)).toBe(
      `log ${REDACTED} ${REDACTED} line`,
    );
    expect(r.redactDeep({ a: "b" })).toEqual({ a: "b" });
  }, 60_000);

  it("R5: overlapping secrets leave no fragment", () => {
    const r = make("abcdef123456", "123456uvwxyz");
    expect(r.redact("abcdef123456uvwxyz")).toBe(REDACTED);
    expect(r.redact("x abcdef123456uvwxyz y")).toBe(`x ${REDACTED} y`);
  });

  it("REDACTION_FAILED is a fixed marker that names no secret", () => {
    expect(REDACTION_FAILED).toBe("[redaction failed]");
  });
});
