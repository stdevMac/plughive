// src/clients/toml-edit.ts
//
// Edits one table of a TOML file (`[<section>.<name>]` and its subtables) as
// a text splice: every other byte, comments included, stays as it was. The
// whole file is parsed first (a compact TOML 1.0 reader covering the value
// forms config files use), and a file that does not parse is refused.

import { ClientConfigError, ConfigParseError } from "./errors.js";

type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
type TomlTable = { [k: string]: TomlValue };

interface Header {
  path: string[];
  array: boolean;
  /** Offset of the start of the header line. */
  lineStart: number;
}

interface KeyLine {
  /** Full key path, table path included. */
  path: string[];
  /** The header the key sits under (-1 for the root table). */
  header: number;
}

export interface TomlDoc {
  data: TomlTable;
  headers: Header[];
  keys: KeyLine[];
}

const BARE = /^[A-Za-z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_TOKEN =
  /^(?:\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
const INT = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const PREFIXED = /^(?:0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/;
const FLOAT = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_FLOAT = /^[+-]?(?:inf|nan)$/;

class TomlReader {
  private i = 0;
  readonly headers: Header[] = [];
  readonly keys: KeyLine[] = [];
  // Null-prototype tables: a key named "__proto__" in the file becomes an
  // own property instead of reaching (and then polluting) Object.prototype.
  readonly data: TomlTable = Object.create(null) as TomlTable;
  /** Tables defined by a header or by dotted keys; a second header for one is an error. */
  private readonly defined = new Set<string>();
  private readonly inlineFrozen = new WeakSet<object>();

  constructor(private readonly s: string) {}

  private fail(msg: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new ConfigParseError(`not valid TOML (line ${line}): ${msg}`);
  }

  private peek(n = 0): string {
    return this.s[this.i + n] ?? "";
  }

  private skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.i++;
  }

  private skipComment(): void {
    if (this.peek() !== "#") return;
    while (this.i < this.s.length && this.peek() !== "\n") {
      const c = this.s.charCodeAt(this.i);
      if ((c < 0x20 && c !== 0x09 && c !== 0x0d) || c === 0x7f)
        this.fail("control character in a comment");
      this.i++;
    }
  }

  /** After a statement: spaces, an optional comment, then a newline or the end. */
  private endOfLine(): void {
    this.skipSpaces();
    this.skipComment();
    if (this.peek() === "\r" && this.peek(1) === "\n") this.i += 2;
    else if (this.peek() === "\n") this.i++;
    else if (this.i < this.s.length) this.fail("expected the end of the line");
  }

  /** Whitespace, newlines and comments (inside arrays). */
  private skipBlank(): void {
    for (;;) {
      this.skipSpaces();
      this.skipComment();
      if (this.peek() === "\n") this.i++;
      else if (this.peek() === "\r" && this.peek(1) === "\n") this.i += 2;
      else return;
    }
  }

  parse(): TomlDoc {
    if (this.s.startsWith("﻿")) this.i = 1;
    let current: TomlTable = this.data;
    let currentHeader = -1;
    let currentPath: string[] = [];
    while (this.i < this.s.length) {
      this.skipSpaces();
      const c = this.peek();
      if (c === "#" || c === "\n" || c === "\r") {
        this.endOfLine();
        continue;
      }
      if (c === "") break;
      if (c === "[") {
        const lineStart = this.s.lastIndexOf("\n", this.i - 1) + 1;
        const array = this.peek(1) === "[";
        this.i += array ? 2 : 1;
        this.skipSpaces();
        const path = this.key();
        this.skipSpaces();
        if (array) {
          if (this.peek() !== "]" || this.peek(1) !== "]") this.fail("expected ']]'");
          this.i += 2;
        } else {
          if (this.peek() !== "]") this.fail("expected ']'");
          this.i++;
        }
        this.endOfLine();
        current = array ? this.openArrayTable(path) : this.openTable(path);
        this.headers.push({ path, array, lineStart });
        currentHeader = this.headers.length - 1;
        currentPath = path;
        continue;
      }
      const path = this.key();
      this.skipSpaces();
      if (this.peek() !== "=") this.fail("expected '='");
      this.i++;
      this.skipSpaces();
      const value = this.value(0);
      this.assign(current, path, value, currentPath);
      this.keys.push({ path: [...currentPath, ...path], header: currentHeader });
      this.endOfLine();
    }
    return { data: this.data, headers: this.headers, keys: this.keys };
  }

  private descend(table: TomlTable, k: string, where: string): TomlTable {
    const existing = table[k];
    if (existing === undefined) {
      const t: TomlTable = Object.create(null) as TomlTable;
      table[k] = t;
      return t;
    }
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (
        last &&
        typeof last === "object" &&
        !Array.isArray(last) &&
        !this.inlineFrozen.has(existing)
      ) {
        return last as TomlTable;
      }
      this.fail(`"${where}" is not a table`);
    }
    if (typeof existing === "object" && !this.inlineFrozen.has(existing))
      return existing as TomlTable;
    this.fail(`"${where}" is already a value`);
  }

  private openTable(path: string[]): TomlTable {
    const id = JSON.stringify(path);
    if (this.defined.has(id)) this.fail(`table [${path.join(".")}] is defined twice`);
    this.defined.add(id);
    let t = this.data;
    for (const k of path) t = this.descend(t, k, path.join("."));
    return t;
  }

  private openArrayTable(path: string[]): TomlTable {
    let t = this.data;
    for (const k of path.slice(0, -1)) t = this.descend(t, k, path.join("."));
    const last = path[path.length - 1] as string;
    const existing = t[last];
    const entry: TomlTable = Object.create(null) as TomlTable;
    if (existing === undefined) t[last] = [entry];
    else if (Array.isArray(existing) && !this.inlineFrozen.has(existing)) existing.push(entry);
    else this.fail(`"${path.join(".")}" is not an array of tables`);
    return entry;
  }

  private assign(table: TomlTable, path: string[], value: TomlValue, prefix: string[]): void {
    let t = table;
    for (let n = 0; n < path.length - 1; n++) {
      const k = path[n] as string;
      t = this.descend(t, k, [...prefix, ...path.slice(0, n + 1)].join("."));
      this.defined.add(JSON.stringify([...prefix, ...path.slice(0, n + 1)]));
    }
    const last = path[path.length - 1] as string;
    if (Object.hasOwn(t, last))
      this.fail(`key "${[...prefix, ...path].join(".")}" is defined twice`);
    t[last] = value;
  }

  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === '"') parts.push(this.basicString());
      else if (c === "'") parts.push(this.literalString());
      else {
        const start = this.i;
        while (/[A-Za-z0-9_-]/.test(this.peek())) this.i++;
        if (this.i === start) this.fail("expected a key");
        parts.push(this.s.slice(start, this.i));
      }
      this.skipSpaces();
      if (this.peek() !== ".") return parts;
      this.i++;
    }
  }

  private value(depth: number): TomlValue {
    if (depth > 256) this.fail("nested too deeply");
    const c = this.peek();
    if (c === '"') {
      return this.s.startsWith('"""', this.i) ? this.multilineBasic() : this.basicString();
    }
    if (c === "'") {
      return this.s.startsWith("'''", this.i) ? this.multilineLiteral() : this.literalString();
    }
    if (c === "[") return this.array(depth);
    if (c === "{") return this.inlineTable(depth);
    const start = this.i;
    while (/[0-9A-Za-z_+\-.:]/.test(this.peek())) this.i++;
    let token = this.s.slice(start, this.i);
    // "1979-05-27 07:32:00": a space may separate the date and the time.
    if (
      DATE.test(token) &&
      this.peek() === " " &&
      /^\d{2}:/.test(this.s.slice(this.i + 1, this.i + 4))
    ) {
      this.i++;
      while (/[0-9A-Za-z_+\-.:]/.test(this.peek())) this.i++;
      token = this.s.slice(start, this.i);
    }
    if (token === "true") return true;
    if (token === "false") return false;
    if (INT.test(token)) return Number(token.replace(/_/g, ""));
    if (PREFIXED.test(token)) return Number(token.replace(/_/g, ""));
    if (FLOAT.test(token)) return Number(token.replace(/_/g, ""));
    if (SPECIAL_FLOAT.test(token))
      return token.includes("nan")
        ? Number.NaN
        : token.startsWith("-")
          ? Number.NEGATIVE_INFINITY
          : Number.POSITIVE_INFINITY;
    if (DATETIME_TOKEN.test(token)) return token;
    this.fail(token ? `unexpected value "${token.slice(0, 40)}"` : "expected a value");
  }

  private escape(): string {
    // At the backslash.
    const n = this.peek(1);
    const simple: Record<string, string> = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
      e: "\x1b",
    };
    if (n in simple) {
      this.i += 2;
      return simple[n] as string;
    }
    const len = n === "u" ? 4 : n === "U" ? 8 : n === "x" ? 2 : 0;
    if (!len) this.fail("bad escape in a string");
    const hex = this.s.slice(this.i + 2, this.i + 2 + len);
    if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) this.fail("bad escape in a string");
    this.i += 2 + len;
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) this.fail("bad code point in a string");
    return String.fromCodePoint(cp);
  }

  private checkChar(c: string): void {
    const code = c.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) this.fail("control character in a string");
  }

  private basicString(): string {
    this.i++;
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "" || c === "\n") this.fail("unterminated string");
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") {
        out += this.escape();
        continue;
      }
      this.checkChar(c);
      out += c;
      this.i++;
    }
  }

  private literalString(): string {
    this.i++;
    const start = this.i;
    for (;;) {
      const c = this.peek();
      if (c === "" || c === "\n") this.fail("unterminated string");
      if (c === "'") {
        const out = this.s.slice(start, this.i);
        this.i++;
        return out;
      }
      this.checkChar(c);
      this.i++;
    }
  }

  private multilineBasic(): string {
    this.i += 3;
    if (this.peek() === "\n") this.i++;
    else if (this.peek() === "\r" && this.peek(1) === "\n") this.i += 2;
    let out = "";
    for (;;) {
      const c = this.peek();
      if (c === "") this.fail("unterminated string");
      if (this.s.startsWith('"""', this.i)) {
        // Up to two quotes may sit right before the closing delimiter.
        let extra = 0;
        while (this.peek(3 + extra) === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        this.i += 3 + extra;
        return out;
      }
      if (c === "\\") {
        const rest = this.s.slice(this.i + 1).match(/^[ \t]*\r?\n/);
        if (rest) {
          // Line-ending backslash: trim the newline and following whitespace.
          this.i += 1 + rest[0].length;
          while (/[ \t\r\n]/.test(this.peek())) this.i++;
          continue;
        }
        out += this.escape();
        continue;
      }
      if (c !== "\n" && c !== "\r") this.checkChar(c);
      out += c;
      this.i++;
    }
  }

  private multilineLiteral(): string {
    this.i += 3;
    if (this.peek() === "\n") this.i++;
    else if (this.peek() === "\r" && this.peek(1) === "\n") this.i += 2;
    const start = this.i;
    for (;;) {
      const c = this.peek();
      if (c === "") this.fail("unterminated string");
      if (this.s.startsWith("'''", this.i)) {
        let extra = 0;
        while (this.peek(3 + extra) === "'" && extra < 2) extra++;
        const out = this.s.slice(start, this.i + extra);
        this.i += 3 + extra;
        return out;
      }
      if (c !== "\n" && c !== "\r") this.checkChar(c);
      this.i++;
    }
  }

  private array(depth: number): TomlValue[] {
    this.i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") {
        this.i++;
        break;
      }
      out.push(this.value(depth + 1));
      this.skipBlank();
      if (this.peek() === ",") {
        this.i++;
        continue;
      }
      if (this.peek() === "]") {
        this.i++;
        break;
      }
      this.fail("expected ',' or ']'");
    }
    this.inlineFrozen.add(out);
    return out;
  }

  private inlineTable(depth: number): TomlTable {
    this.i++;
    const t: TomlTable = Object.create(null) as TomlTable;
    this.skipSpaces();
    if (this.peek() === "}") {
      this.i++;
      this.inlineFrozen.add(t);
      return t;
    }
    for (;;) {
      this.skipSpaces();
      const path = this.key();
      this.skipSpaces();
      if (this.peek() !== "=") this.fail("expected '='");
      this.i++;
      this.skipSpaces();
      const v = this.value(depth + 1);
      let cur = t;
      for (const k of path.slice(0, -1)) {
        const e = cur[k];
        if (e === undefined) cur = cur[k] = Object.create(null) as TomlTable;
        else if (typeof e === "object" && !Array.isArray(e) && !this.inlineFrozen.has(e))
          cur = e as TomlTable;
        else this.fail(`key "${k}" is defined twice`);
      }
      const last = path[path.length - 1] as string;
      if (Object.hasOwn(cur, last)) this.fail(`key "${last}" is defined twice`);
      cur[last] = v;
      this.skipSpaces();
      if (this.peek() === ",") {
        this.i++;
        continue;
      }
      if (this.peek() === "}") {
        this.i++;
        break;
      }
      this.fail("expected ',' or '}'");
    }
    this.inlineFrozen.add(t);
    return t;
  }
}

export function parseToml(text: string): TomlDoc {
  return new TomlReader(text).parse();
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.every((p, n) => path[n] === p);
}

function quoteKey(k: string): string {
  return BARE.test(k) ? k : JSON.stringify(k);
}

/** A TOML string literal (JSON's escapes are a subset of TOML's basic string escapes). */
function str(v: string): string {
  return JSON.stringify(v);
}

function renderValue(v: TomlValue): string {
  if (typeof v === "string") return str(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(renderValue).join(", ")}]`;
  const parts = Object.entries(v).map(([k, x]) => `${quoteKey(k)} = ${renderValue(x)}`);
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

/** `[section.name]` followed by one `key = value` line per entry. */
export function renderTomlTable(
  section: string,
  name: string,
  entry: Record<string, TomlValue>,
  nl = "\n",
): string {
  const lines = [`[${quoteKey(section)}.${quoteKey(name)}]`];
  for (const [k, v] of Object.entries(entry)) lines.push(`${quoteKey(k)} = ${renderValue(v)}`);
  return lines.join(nl) + nl;
}

/** The parsed value of `[section.name]`, or undefined. */
export function getTomlEntry(text: string, section: string, name: string): unknown {
  const doc = parseToml(text);
  const sec = doc.data[section];
  if (!sec || typeof sec !== "object" || Array.isArray(sec)) return undefined;
  return (sec as TomlTable)[name];
}

/** All of `[section.*]` as parsed values. */
export function getTomlSection(text: string, section: string): Record<string, unknown> {
  const doc = parseToml(text);
  const sec = doc.data[section];
  if (!sec || typeof sec !== "object" || Array.isArray(sec)) return {};
  return { ...(sec as TomlTable) };
}

/**
 * Text ranges of the tables that make up `[section.name]` (the table and its
 * subtables). Each range runs from its header to the next header, less the
 * blank and comment lines right before that next header (they belong to it).
 */
function entryRanges(
  text: string,
  doc: TomlDoc,
  section: string,
  name: string,
): Array<[number, number]> {
  const own = [section, name];
  if (doc.headers.some((h) => h.array && startsWith(own, h.path))) {
    throw new ClientConfigError(
      `[[${section}]] is an array of tables here; edit this file by hand`,
    );
  }
  const mine = new Set<number>();
  doc.headers.forEach((h, n) => {
    if (startsWith(h.path, own)) mine.add(n);
  });
  for (const k of doc.keys) {
    const touches = startsWith(k.path, own) || (k.path.length === 1 && k.path[0] === section);
    if (touches && !mine.has(k.header)) {
      throw new ClientConfigError(
        `"${section}.${name}" is defined with inline or dotted keys here; edit this file by hand`,
      );
    }
  }
  const ranges: Array<[number, number]> = [];
  for (const n of mine) {
    const h = doc.headers[n] as Header;
    const next = doc.headers[n + 1];
    let end = next ? next.lineStart : text.length;
    // Between two of our own tables nothing is handed back.
    if (next && !mine.has(n + 1)) {
      // Give the blank and comment lines just above the next header back to it.
      for (;;) {
        const prevLineStart = text.lastIndexOf("\n", end - 2) + 1;
        if (prevLineStart <= h.lineStart) break;
        const line = text.slice(prevLineStart, end).trim();
        if (line !== "" && !line.startsWith("#")) break;
        end = prevLineStart;
      }
    }
    ranges.push([h.lineStart, end]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** `text` with `[section.name]` replaced by `entry`; everything else unchanged. */
export function setTomlEntry(
  text: string,
  section: string,
  name: string,
  entry: Record<string, TomlValue>,
): string {
  const doc = parseToml(text);
  const sec = doc.data[section];
  if (sec !== undefined && (typeof sec !== "object" || Array.isArray(sec))) {
    throw new ClientConfigError(`"${section}" is not a table here; edit this file by hand`);
  }
  const nl = eol(text);
  const block = renderTomlTable(section, name, entry, nl);
  const ranges = entryRanges(text, doc, section, name);
  if (ranges.length === 0) {
    if (text.trim() === "") return block;
    const sep =
      text.endsWith("\n\n") || text.endsWith("\r\n\r\n") ? "" : text.endsWith("\n") ? nl : nl + nl;
    return text + sep + block;
  }
  let out = text;
  for (let n = ranges.length - 1; n >= 0; n--) {
    const [a, b] = ranges[n] as [number, number];
    out = out.slice(0, a) + (n === 0 ? block : "") + out.slice(b);
  }
  // A table that ran to the end of the file without a trailing newline.
  return out;
}

/** `text` without `[section.name]` and its subtables; unchanged when absent. */
export function removeTomlEntry(text: string, section: string, name: string): string {
  const doc = parseToml(text);
  const ranges = entryRanges(text, doc, section, name);
  let out = text;
  for (let n = ranges.length - 1; n >= 0; n--) {
    const [a, b] = ranges[n] as [number, number];
    let start = a;
    // Drop one blank line that separated the table from what came before.
    const before = out.slice(0, start);
    const after = out.slice(b);
    if (/\n\r?\n$/.test(before) && (after === "" || /^\r?\n/.test(after) || /^\[/.test(after))) {
      start = before.replace(/\r?\n$/, "").length;
    }
    out = out.slice(0, start) + out.slice(b);
  }
  return out;
}
