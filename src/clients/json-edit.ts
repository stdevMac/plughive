// src/clients/json-edit.ts
//
// Edits one member of a JSON object (`root[section][name]`) as a text splice,
// so every other byte of the file stays as it was: other keys, their order,
// the file's indentation and line endings. The input must be strict JSON
// (RFC 8259, an optional UTF-8 BOM allowed); anything else is refused rather
// than rewritten.

import { ConfigParseError } from "./errors.js";

interface JsonNode {
  kind: "object" | "array" | "scalar";
  start: number;
  end: number;
  members?: JsonMember[];
}

interface JsonMember {
  key: string;
  keyStart: number;
  value: JsonNode;
}

const SCALAR = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;

class JsonScanner {
  private i = 0;
  constructor(private readonly s: string) {}

  parseDocument(start: number): JsonNode {
    this.i = start;
    this.ws();
    const node = this.value(0);
    this.ws();
    if (this.i !== this.s.length) this.fail("unexpected content after the top-level value");
    return node;
  }

  private fail(msg: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new ConfigParseError(`not valid JSON (line ${line}): ${msg}`);
  }

  private ws(): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else break;
    }
  }

  private value(depth: number): JsonNode {
    if (depth > 512) this.fail("nested too deeply");
    const c = this.s[this.i];
    const start = this.i;
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"') {
      this.string();
      return { kind: "scalar", start, end: this.i };
    }
    const m = this.s.slice(this.i, this.i + 400).match(SCALAR);
    if (!m) this.fail("expected a value");
    this.i += m[0].length;
    return { kind: "scalar", start, end: this.i };
  }

  private string(): string {
    const start = this.i;
    this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      if (c === '"') {
        this.i++;
        return JSON.parse(this.s.slice(start, this.i)) as string;
      }
      if (c === "\\") {
        const n = this.s[this.i + 1];
        if (n === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(this.s.slice(this.i + 2, this.i + 6)))
            this.fail("bad \\u escape");
          this.i += 6;
          continue;
        }
        if (n === undefined || !'"\\/bfnrt'.includes(n)) this.fail("bad escape");
        this.i += 2;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) this.fail("control character in a string");
      this.i++;
    }
    this.fail("unterminated string");
  }

  private object(depth: number): JsonNode {
    const start = this.i;
    this.i++;
    const members: JsonMember[] = [];
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return { kind: "object", start, end: this.i, members };
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail("expected a key");
      const keyStart = this.i;
      const key = this.string();
      this.ws();
      if (this.s[this.i] !== ":") this.fail("expected ':'");
      this.i++;
      this.ws();
      const value = this.value(depth + 1);
      members.push({ key, keyStart, value });
      this.ws();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "}") {
        this.i++;
        return { kind: "object", start, end: this.i, members };
      }
      this.fail("expected ',' or '}'");
    }
  }

  private array(depth: number): JsonNode {
    const start = this.i;
    this.i++;
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return { kind: "array", start, end: this.i };
    }
    for (;;) {
      this.ws();
      this.value(depth + 1);
      this.ws();
      const c = this.s[this.i];
      if (c === ",") {
        this.i++;
        continue;
      }
      if (c === "]") {
        this.i++;
        return { kind: "array", start, end: this.i };
      }
      this.fail("expected ',' or ']'");
    }
  }
}

const BOM = "﻿";

function parseObject(text: string): JsonNode {
  const offset = text.startsWith(BOM) ? 1 : 0;
  const root = new JsonScanner(text).parseDocument(offset);
  if (root.kind !== "object")
    throw new ConfigParseError("the top-level JSON value is not an object");
  return root;
}

function isBlank(text: string): boolean {
  return text.replace(BOM, "").trim() === "";
}

/** Throws ConfigParseError unless `text` is empty or strict JSON with an object at the top. */
export function assertJsonObject(text: string): void {
  if (!isBlank(text)) parseObject(text);
}

/** Whitespace at the start of the line holding `pos`. */
function lineIndent(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return text.slice(lineStart).match(/^[ \t]*/)?.[0] ?? "";
}

/** The file's indentation unit: from the first indented key, else two spaces. */
function indentUnit(text: string): string {
  return text.match(/\n([ \t]+)"/)?.[1] ?? "  ";
}

function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** JSON for `value`, its continuation lines indented under `indent`. */
function render(value: unknown, indent: string, unit: string, nl: string): string {
  return JSON.stringify(value, null, unit)
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join(nl);
}

function findMember(node: JsonNode, key: string): JsonMember | undefined {
  const found = (node.members ?? []).filter((m) => m.key === key);
  if (found.length > 1) throw new ConfigParseError(`the key "${key}" appears more than once`);
  return found[0];
}

/** Insert `"key": value` as the last member of `obj`. */
function insertMember(
  text: string,
  obj: JsonNode,
  key: string,
  value: unknown,
  unit: string,
  nl: string,
): string {
  const members = obj.members ?? [];
  const last = members[members.length - 1];
  if (!last) {
    const parentIndent = lineIndent(text, obj.start);
    const childIndent = parentIndent + unit;
    const body = `{${nl}${childIndent}${JSON.stringify(key)}: ${render(value, childIndent, unit, nl)}${nl}${parentIndent}}`;
    return text.slice(0, obj.start) + body + text.slice(obj.end);
  }
  const sameLine = !text.slice(obj.start, last.keyStart).includes("\n");
  if (sameLine) {
    // A one-line object stays one line.
    const piece = `, ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    return text.slice(0, last.value.end) + piece + text.slice(last.value.end);
  }
  const indent = lineIndent(text, last.keyStart);
  const piece = `,${nl}${indent}${JSON.stringify(key)}: ${render(value, indent, unit, nl)}`;
  return text.slice(0, last.value.end) + piece + text.slice(last.value.end);
}

/** All members of `root[section]` as parsed values (empty when absent). */
export function getJsonSection(text: string, section: string): Record<string, unknown> {
  if (isBlank(text)) return {};
  const root = parseObject(text);
  const sec = findMember(root, section);
  if (!sec || sec.value.kind !== "object") return {};
  // Null-prototype: a member named "__proto__" is kept as an own property.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const m of sec.value.members ?? [])
    out[m.key] = JSON.parse(text.slice(m.value.start, m.value.end));
  return out;
}

/** The current value of `root[section][name]`, or undefined. */
export function getJsonEntry(text: string, section: string, name: string): unknown {
  if (isBlank(text)) return undefined;
  const root = parseObject(text);
  const sec = findMember(root, section);
  if (!sec || sec.value.kind !== "object") return undefined;
  const entry = findMember(sec.value, name);
  if (!entry) return undefined;
  return JSON.parse(text.slice(entry.value.start, entry.value.end));
}

/** `text` with `root[section][name] = value`; everything else unchanged. */
export function setJsonEntry(text: string, section: string, name: string, value: unknown): string {
  if (isBlank(text)) {
    return `${JSON.stringify({ [section]: { [name]: value } }, null, 2)}\n`;
  }
  const root = parseObject(text);
  const unit = indentUnit(text);
  const nl = eol(text);
  const sec = findMember(root, section);
  if (!sec) return insertMember(text, root, section, { [name]: value }, unit, nl);
  if (sec.value.kind !== "object") {
    if (text.slice(sec.value.start, sec.value.end) !== "null") {
      throw new ConfigParseError(`"${section}" is not an object`);
    }
    const indent = lineIndent(text, sec.keyStart);
    return (
      text.slice(0, sec.value.start) +
      render({ [name]: value }, indent, unit, nl) +
      text.slice(sec.value.end)
    );
  }
  const entry = findMember(sec.value, name);
  if (!entry) return insertMember(text, sec.value, name, value, unit, nl);
  const indent = lineIndent(text, entry.keyStart);
  return (
    text.slice(0, entry.value.start) + render(value, indent, unit, nl) + text.slice(entry.value.end)
  );
}

/** `text` without `root[section][name]`; unchanged when it is not there. */
export function removeJsonEntry(text: string, section: string, name: string): string {
  if (isBlank(text)) return text;
  const root = parseObject(text);
  const sec = findMember(root, section);
  if (!sec || sec.value.kind !== "object") return text;
  findMember(sec.value, name); // refuses duplicates
  const members = sec.value.members ?? [];
  const idx = members.findIndex((m) => m.key === name);
  const entry = members[idx];
  if (!entry) return text;
  const prev = members[idx - 1];
  const next = members[idx + 1];
  if (prev) return text.slice(0, prev.value.end) + text.slice(entry.value.end);
  if (next) return text.slice(0, entry.keyStart) + text.slice(next.keyStart);
  // The only member: leave an empty object.
  return `${text.slice(0, sec.value.start)}{}${text.slice(sec.value.end)}`;
}
