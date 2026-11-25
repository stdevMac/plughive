// src/core/secrets/redactor.ts
//
// Replaces registered secret values in text with "[redacted]".
//
// Matching is purely literal (indexOf over a list of precomputed variants); no
// regular expression is ever built from secret material, so a large or odd
// secret can neither break compilation nor end up in an error message.
// Overlapping matches are merged before replacement, so two secrets that
// overlap in the text leave no fragment behind.
//
// Forms that are caught for every registered value:
//   - the raw value
//   - JSON string escaping (JSON.stringify), also with "\/" escaped slashes
//     (PHP json_encode) and with non-ASCII as "\uXXXX" (Python json.dumps,
//     lower and upper case hex)
// Additionally, for values up to LONG_SECRET_LENGTH characters:
//   - URL encodings: encodeURIComponent, strict RFC 3986, WHATWG form
//     serialisation, encodeURI; each with "+" for space and lower-case hex
//   - hex of the UTF-8 bytes (lower and upper case)
//   - base64 / base64url, padded and unpadded, and the base64 text the value
//     produces at each of the three byte alignments inside a longer encoded
//     buffer (e.g. "user:secret" in a Basic Authorization header)
// Values longer than LONG_SECRET_LENGTH only get the raw and JSON-escaped
// forms: deriving and scanning dozens of encodings of a huge value would make
// every redact() call expensive.
//
// Known misses (not caught, by design or cost):
//   - HTML entity encoding (&#x2F;, &amp; ...)
//   - double (or deeper) URL encoding, and other nested encodings
//   - prefixes, suffixes or truncated fragments of a value ("sk-abc...")
//   - values split by line wrapping or other inserted characters
//   - case changes of the value (upper-casing, lower-casing)
//   - base64 fragments at alignments where fewer than 6 characters remain
//   - encodings of values longer than LONG_SECRET_LENGTH (see above)

export const REDACTED = "[redacted]";

/** Returned by redact()/redactDeep() when redaction itself fails (fail closed). */
export const REDACTION_FAILED = "[redaction failed]";

/** Values shorter than this are not registered: they would shred normal text. */
export const MIN_REDACT_LENGTH = 6;

/** Above this length only the raw and JSON-escaped forms are matched. */
export const LONG_SECRET_LENGTH = 4096;

/** Minimum length for a derived base64 fragment to be used as a pattern. */
const MIN_BASE64_FRAGMENT = MIN_REDACT_LENGTH;

/** Binary values (Buffer, typed arrays) are never copied into the output. */
function binaryPlaceholder(byteLength: number): string {
  return `[binary ${byteLength} bytes]`;
}

/**
 * Base64 text that a value produces at each of the three possible byte
 * alignments inside a longer encoded buffer. Characters that also depend on
 * neighbouring bytes are trimmed, so each fragment is a guaranteed substring
 * of the encoding of any buffer that contains the value at that alignment.
 */
function base64Fragments(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    let encoded = padded.toString("base64").replace(/=+$/, "");
    // Leading characters that mix in the (unknown) preceding bytes.
    const dropStart = offset === 0 ? 0 : offset + 1;
    // The final character mixes in the following byte unless we end on a boundary.
    const dropEnd = padded.length % 3 === 0 ? 0 : 1;
    encoded = encoded.slice(dropStart, encoded.length - dropEnd);
    if (encoded.length >= MIN_BASE64_FRAGMENT) out.push(encoded);
  }
  return out;
}

function hex4(code: number): string {
  return code.toString(16).padStart(4, "0");
}

function jsonVariants(value: string): string[] {
  const json = JSON.stringify(value).slice(1, -1);
  // JSON.stringify leaves non-ASCII as-is; ensure_ascii style encoders do not.
  const asciiLower = json.replace(/[\u0080-￿]/g, (c) => `\\u${hex4(c.charCodeAt(0))}`);
  const asciiUpper = json.replace(
    /[\u0080-￿]/g,
    (c) => `\\u${hex4(c.charCodeAt(0)).toUpperCase()}`,
  );
  const out = new Set<string>();
  for (const form of [json, asciiLower, asciiUpper]) {
    out.add(form);
    out.add(form.replace(/\//g, "\\/"));
  }
  return [...out];
}

function variantsOf(value: string): string[] {
  const variants = new Set<string>([value]);
  const add = (candidate: string): void => {
    if (candidate.length >= MIN_REDACT_LENGTH) variants.add(candidate);
  };
  for (const form of jsonVariants(value)) add(form);
  if (value.length > LONG_SECRET_LENGTH) return [...variants];

  try {
    const uri = encodeURIComponent(value);
    const pct = (c: string): string => `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
    const bases = [
      uri,
      // encodeURIComponent leaves !'()* alone; strict (RFC 3986) encoders escape them.
      uri.replace(/[!'()*]/g, pct),
      // WHATWG form serialisation (URLSearchParams) escapes !'()~ but not *.
      uri.replace(/[!'()~]/g, pct),
      encodeURI(value),
    ];
    for (const base of bases) {
      // "+" for a space is application/x-www-form-urlencoded.
      for (const form of [base, base.replace(/%20/g, "+")]) {
        add(form);
        add(form.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
      }
    }
  } catch {
    // lone surrogates cannot be URI-encoded; the raw pattern still applies
  }
  const bytes = Buffer.from(value, "utf8");
  const hex = bytes.toString("hex");
  add(hex);
  add(hex.toUpperCase());
  const b64 = bytes.toString("base64");
  add(b64);
  add(b64.replace(/=+$/, ""));
  add(bytes.toString("base64url"));
  for (const fragment of base64Fragments(bytes)) {
    add(fragment);
    add(fragment.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...variants];
}

export class Redactor {
  private readonly values = new Set<string>();
  private readonly patterns = new Set<string>();

  /**
   * Register a secret value. Values shorter than 6 characters are ignored.
   * Registration is incremental: only the new value's variants are computed.
   * Never throws.
   */
  register(value: string): void {
    if (typeof value !== "string" || value.length < MIN_REDACT_LENGTH) return;
    if (this.values.has(value)) return;
    let variants: string[];
    try {
      variants = variantsOf(value);
    } catch {
      variants = [value];
    }
    this.values.add(value);
    for (const variant of variants) this.patterns.add(variant);
  }

  /** Number of registered values. */
  get size(): number {
    return this.values.size;
  }

  /**
   * Replace every registered value (and its encoded forms) in `text`.
   * Never throws: if redaction fails internally the fixed string
   * REDACTION_FAILED is returned instead of the input.
   */
  redact(text: string): string {
    if (typeof text !== "string" || text === "") return text;
    if (this.patterns.size === 0) return text;
    try {
      return this.replaceAll(text);
    } catch {
      return REDACTION_FAILED;
    }
  }

  private replaceAll(text: string): string {
    // Collect every occurrence (overlapping ones included) of every pattern.
    const spans: Array<[number, number]> = [];
    for (const pattern of this.patterns) {
      if (pattern.length > text.length) continue;
      let from = text.indexOf(pattern);
      while (from !== -1) {
        spans.push([from, from + pattern.length]);
        from = text.indexOf(pattern, from + 1);
      }
    }
    if (spans.length === 0) return text;
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    // Merge overlapping spans; spans that merely touch stay separate.
    let out = "";
    let cursor = 0;
    let start = spans[0]![0];
    let end = spans[0]![1];
    const flush = (): void => {
      out += text.slice(cursor, start) + REDACTED;
      cursor = end;
    };
    for (let i = 1; i < spans.length; i++) {
      const [s, e] = spans[i]!;
      if (s < end) {
        if (e > end) end = e;
      } else {
        flush();
        start = s;
        end = e;
      }
    }
    flush();
    return out + text.slice(cursor);
  }

  /**
   * Deep-copy a JSON-serialisable value with every string (keys included)
   * redacted. Errors become `{ name, message, stack? }`, objects with `toJSON`
   * are converted first, cycles become "[circular]", Maps become arrays of
   * [key, value] pairs and Sets arrays. Binary data (Buffer, typed arrays,
   * DataView, ArrayBuffer) is never copied: it becomes "[binary N bytes]".
   * Never throws: a node that cannot be processed becomes REDACTION_FAILED.
   */
  redactDeep<T>(value: T): T {
    try {
      return this.walk(value, new WeakSet<object>()) as T;
    } catch {
      return REDACTION_FAILED as unknown as T;
    }
  }

  private walk(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redact(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    try {
      if (ArrayBuffer.isView(value)) return binaryPlaceholder(value.byteLength);
      if (value instanceof ArrayBuffer) return binaryPlaceholder(value.byteLength);
      if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
        return binaryPlaceholder(value.byteLength);
      }
      if (Array.isArray(value)) return value.map((item) => this.walk(item, seen));
      if (value instanceof Map) {
        return [...value].map(([k, v]) => [this.walk(k, seen), this.walk(v, seen)]);
      }
      if (value instanceof Set) return [...value].map((item) => this.walk(item, seen));
      if (value instanceof Error) {
        const out: Record<string, unknown> = {
          name: this.redact(value.name),
          message: this.redact(value.message),
        };
        if (typeof value.stack === "string") out.stack = this.redact(value.stack);
        for (const [key, item] of Object.entries(value)) {
          out[this.redact(key)] = this.walk(item, seen);
        }
        return out;
      }
      const toJSON = (value as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") {
        return this.walk((toJSON as () => unknown).call(value), seen);
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[this.redact(key)] = this.walk(item, seen);
      }
      return out;
    } catch {
      return REDACTION_FAILED;
    } finally {
      seen.delete(value);
    }
  }
}
