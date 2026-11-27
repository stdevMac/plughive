// src/clients/yaml-edit.ts
//
// Edits one entry of a top-level block mapping in a YAML file
// (`<section>:` then `  <name>:`) as a line splice: every other line,
// comments included, stays as it was.
//
// This is a structural editor, not a full YAML parser. It checks what it
// relies on (no tabs in indentation, a block mapping at the top level, the
// section a block mapping or an empty value, no duplicate keys at the levels
// it edits) and refuses anything else rather than guess. Entries are written
// with double-quoted JSON strings, which are valid YAML.

import { ClientConfigError, ConfigParseError } from "./errors.js";

const BOM = "\uFEFF";

/**
 * A UTF-8 byte order mark (Windows editors write one) is not part of the
 * first key: it is set aside while reading and put back on an edited text.
 */
function splitBom(text: string): { bom: string; body: string } {
  return text.startsWith(BOM) ? { bom: BOM, body: text.slice(1) } : { bom: "", body: text };
}

interface Line {
  text: string;
  start: number;
  /** Indentation width, -1 for blank and comment-only lines. */
  indent: number;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    const raw = text.slice(pos, end);
    const body = raw.replace(/\r?\n$/, "");
    const lead = body.match(/^[ \t]*/)?.[0] ?? "";
    const rest = body.slice(lead.length);
    const blank = rest === "" || rest.startsWith("#");
    if (!blank && lead.includes("\t")) {
      throw new ConfigParseError(`not valid YAML (line ${out.length + 1}): tab in indentation`);
    }
    out.push({ text: raw, start: pos, indent: blank ? -1 : lead.length });
    pos = end;
  }
  return out;
}

/** `key` of a `key: ...` line (plain or quoted), with the rest after the colon. */
function mappingKey(line: string): { key: string; rest: string } | undefined {
  const body = line.replace(/\r?\n$/, "").trimStart();
  let key: string;
  let after: string;
  if (body.startsWith('"')) {
    const m = body.match(/^"((?:[^"\\]|\\.)*)"/);
    if (!m) return undefined;
    try {
      key = JSON.parse(m[0]) as string;
    } catch {
      return undefined;
    }
    after = body.slice(m[0].length);
  } else if (body.startsWith("'")) {
    const m = body.match(/^'((?:[^']|'')*)'/);
    if (!m) return undefined;
    key = (m[1] as string).replace(/''/g, "'");
    after = body.slice(m[0].length);
  } else {
    const m = body.match(/^([^\s#:'"[\]{},&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*(?=:(?:\s|$))/);
    if (!m) return undefined;
    key = m[1] as string;
    after = body.slice(m[0].length);
  }
  const colon = after.match(/^\s*:(?=\s|$)/);
  if (!colon) return undefined;
  return { key, rest: after.slice(colon[0].length) };
}

/** The value part after `key:`, without a trailing comment. A `#` inside quotes is kept. */
function inlineValue(rest: string): string {
  const trimmed = rest.trim();
  if (trimmed.startsWith("#")) return "";
  const quoted = trimmed.match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/)?.[0];
  if (quoted) return quoted + trimmed.slice(quoted.length).replace(/\s+#.*$/, "");
  return trimmed.replace(/\s+#.*$/, "");
}

/**
 * Refuse to splice a section that uses anchors (`&a`), aliases (`*a`) or
 * merge keys (`<<:`): moving or removing lines could leave an alias pointing
 * at nothing. Quoted strings and comments are ignored.
 */
function assertNoAnchors(lines: Line[], sec: Section, section: string): void {
  if (sec.keyLine < 0) return;
  for (let n = sec.keyLine; n < sec.to; n++) {
    const l = lines[n] as Line;
    if (l.indent < 0) continue;
    const bare = l.text
      .replace(/\r?\n$/, "")
      .replace(/(^|[\s:[{,])(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')/g, '$1""')
      .replace(/(^|\s)#.*$/, "");
    if (/(^|[\s[{,])[&*][^\s,[\]{}]/.test(bare) || /(^|[\s{,])<<\s*:/.test(bare)) {
      throw new ClientConfigError(
        `"${section}" uses YAML anchors, aliases or merge keys (line ${n + 1}); edit this file by hand`,
      );
    }
  }
}

function isEmptyValue(v: string): boolean {
  return v === "" || v === "{}" || v === "null" || v === "~" || v === "Null" || v === "NULL";
}

interface Section {
  /** Index of the `section:` line, or -1 when absent. */
  keyLine: number;
  /** Lines after the key line that belong to it: [from, to). */
  from: number;
  to: number;
  /** The value on the key line itself (empty for a block value). */
  inline: string;
}

function checkDocument(lines: Line[]): void {
  let sawContent = false;
  for (const [n, l] of lines.entries()) {
    const t = l.text.trim();
    if (l.indent === -1) continue;
    if (t === "---" && !sawContent) continue;
    if (t === "---" || t === "..." || t.startsWith("--- ")) {
      throw new ConfigParseError(
        `not valid here (line ${n + 1}): only a single YAML document is supported`,
      );
    }
    if (l.indent === 0) {
      if (t.startsWith("- ") || t === "-" || t.startsWith("[") || t.startsWith("{")) {
        throw new ConfigParseError(
          `not valid here (line ${n + 1}): the top level is not a block mapping`,
        );
      }
      if (!mappingKey(l.text) && !t.startsWith("%")) {
        throw new ConfigParseError(
          `not valid YAML (line ${n + 1}): expected "key: value" at the top level`,
        );
      }
    }
    sawContent = true;
  }
}

/** Find `section:` at the top level and the lines of its block value. */
function findSection(lines: Line[], section: string): Section {
  let found: Section | undefined;
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n] as Line;
    if (l.indent !== 0) continue;
    const k = mappingKey(l.text);
    if (!k || k.key !== section) continue;
    if (found)
      throw new ConfigParseError(`not valid YAML: "${section}" appears twice at the top level`);
    let to = n + 1;
    while (to < lines.length && (lines[to] as Line).indent !== 0) to++;
    found = { keyLine: n, from: n + 1, to, inline: inlineValue(k.rest) };
  }
  return found ?? { keyLine: -1, from: lines.length, to: lines.length, inline: "" };
}

/** Last index in [from, to) holding content, or from - 1. */
function lastContent(lines: Line[], from: number, to: number): number {
  for (let n = to - 1; n >= from; n--) if ((lines[n] as Line).indent >= 0) return n;
  return from - 1;
}

interface Child {
  from: number;
  to: number;
}

function sectionChildren(
  lines: Line[],
  sec: Section,
  sectionName: string,
): { indent: number; children: Map<string, Child> } {
  const children = new Map<string, Child>();
  let indent = -1;
  for (let n = sec.from; n < sec.to; n++) {
    const l = lines[n] as Line;
    if (l.indent < 0) continue;
    if (indent < 0) indent = l.indent;
    if (l.indent < indent) {
      throw new ConfigParseError(
        `not valid YAML (line ${n + 1}): inconsistent indentation under "${sectionName}"`,
      );
    }
    if (l.indent > indent) continue;
    const k = mappingKey(l.text);
    if (!k) {
      throw new ClientConfigError(
        `"${sectionName}" is not a block mapping here; edit this file by hand`,
      );
    }
    if (children.has(k.key))
      throw new ConfigParseError(`not valid YAML: "${sectionName}.${k.key}" appears twice`);
    let to = n + 1;
    while (to < sec.to && ((lines[to] as Line).indent < 0 || (lines[to] as Line).indent > indent))
      to++;
    // Blank and comment lines at the end belong to whatever follows.
    to = lastContent(lines, n, to) + 1;
    children.set(k.key, { from: n, to });
  }
  return { indent, children };
}

function eol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function scalar(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  throw new ClientConfigError("unsupported value for YAML output");
}

/** Block YAML for a mapping of scalars and nested mappings, at `indent`. */
export function renderYamlMapping(
  value: Record<string, unknown>,
  indent: string,
  unit: string,
  nl: string,
): string {
  let out = "";
  for (const [k, v] of Object.entries(value)) {
    const key = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) out += `${indent}${key}: {}${nl}`;
      else
        out += `${indent}${key}:${nl}${renderYamlMapping(v as Record<string, unknown>, indent + unit, unit, nl)}`;
    } else if (Array.isArray(v)) {
      out += `${indent}${key}: [${v.map(scalar).join(", ")}]${nl}`;
    } else {
      out += `${indent}${key}: ${scalar(v)}${nl}`;
    }
  }
  return out;
}

/**
 * Parse a block mapping made of scalars and nested mappings (the shape this
 * module writes). Returns undefined for anything richer; callers treat that
 * as "differs from what we would write", never as an error.
 */
function readBlock(lines: Line[], from: number, to: number): Record<string, unknown> | undefined {
  // Null-prototype: a key named "__proto__" is kept as an own property.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let indent = -1;
  for (let n = from; n < to; n++) {
    const l = lines[n] as Line;
    if (l.indent < 0) continue;
    if (indent < 0) indent = l.indent;
    if (l.indent !== indent) return undefined;
    const k = mappingKey(l.text);
    if (!k) return undefined;
    const v = inlineValue(k.rest);
    if (v === "") {
      let end = n + 1;
      while (end < to && ((lines[end] as Line).indent < 0 || (lines[end] as Line).indent > indent))
        end++;
      const child = end > n + 1 ? readBlock(lines, n + 1, end) : {};
      if (child === undefined) return undefined;
      out[k.key] = end > n + 1 ? child : null;
      n = end - 1;
      continue;
    }
    const s = readScalar(v);
    if (s === undefined) return undefined;
    out[k.key] = s.value;
  }
  return out;
}

function readScalar(v: string): { value: unknown } | undefined {
  if (v.startsWith('"')) {
    try {
      return { value: JSON.parse(v) };
    } catch {
      return undefined;
    }
  }
  if (v.startsWith("'")) {
    const m = v.match(/^'((?:[^']|'')*)'$/);
    return m ? { value: (m[1] as string).replace(/''/g, "'") } : undefined;
  }
  if (v === "{}") return { value: {} };
  if (/^[[{&*!|>@`]/.test(v)) return undefined;
  if (v === "true" || v === "True" || v === "TRUE") return { value: true };
  if (v === "false" || v === "False" || v === "FALSE") return { value: false };
  if (isEmptyValue(v)) return { value: null };
  if (/^[-+]?\d+(?:\.\d+)?$/.test(v)) return { value: Number(v) };
  return { value: v };
}

function prepare(text: string, section: string) {
  const lines = splitLines(text);
  checkDocument(lines);
  const sec = findSection(lines, section);
  if (sec.keyLine >= 0 && !isEmptyValue(sec.inline)) {
    throw new ClientConfigError(
      `"${section}" is written in flow style here; edit this file by hand`,
    );
  }
  const kids = sectionChildren(lines, sec, section);
  return { lines, sec, ...kids };
}

/** All entries of the top-level `section` mapping (unparseable ones as undefined). */
export function getYamlSection(text: string, section: string): Record<string, unknown> {
  const { lines, children } = prepare(splitBom(text).body, section);
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, c] of children) out[k] = readBlock(lines, c.from, c.to)?.[k];
  return out;
}

/** The parsed value of `section.name` (undefined when absent or richer than this reader handles). */
export function getYamlEntry(text: string, section: string, name: string): unknown {
  return getYamlSection(text, section)[name];
}

/** Whether `section.name` exists at all. */
export function hasYamlEntry(text: string, section: string, name: string): boolean {
  return prepare(splitBom(text).body, section).children.has(name);
}

/** `text` with `section.name` set to `entry`; every other line unchanged. */
export function setYamlEntry(
  text: string,
  section: string,
  name: string,
  entry: Record<string, unknown>,
): string {
  const { bom, body } = splitBom(text);
  return bom + setEntry(body, section, name, entry);
}

function setEntry(
  text: string,
  section: string,
  name: string,
  entry: Record<string, unknown>,
): string {
  const { lines, sec, indent, children } = prepare(text, section);
  assertNoAnchors(lines, sec, section);
  const nl = eol(text);
  const unit = indent > 0 ? " ".repeat(indent) : "  ";
  const childIndent = indent > 0 ? " ".repeat(indent) : unit;
  const block = renderYamlMapping({ [name]: entry }, childIndent, unit, nl);
  const at = (n: number) => (n < lines.length ? (lines[n] as Line).start : text.length);
  const existing = children.get(name);
  if (existing) {
    return text.slice(0, at(existing.from)) + block + text.slice(at(existing.to));
  }
  if (sec.keyLine < 0) {
    if (text.trim() === "") return `${section}:${nl}${block}`;
    const sep = text.endsWith("\n") ? "" : nl;
    return `${text}${sep}${section}:${nl}${block}`;
  }
  const keyLine = lines[sec.keyLine] as Line;
  if (sec.inline !== "") {
    // `section: {}` or `section: null` becomes a block mapping; a comment on the line stays.
    const comment = keyLine.text.replace(/\r?\n$/, "").match(/\s+#.*$/)?.[0] ?? "";
    const head = `${section}:${comment}${nl}`;
    return text.slice(0, keyLine.start) + head + block + text.slice(at(sec.keyLine + 1));
  }
  // Insert after the section's last content line.
  const last = lastContent(lines, sec.from, sec.to);
  const insertLine = last >= sec.from ? last + 1 : sec.keyLine + 1;
  let before = text.slice(0, at(insertLine));
  if (insertLine >= lines.length && !before.endsWith("\n")) before += nl;
  return before + block + text.slice(at(insertLine));
}

/** `text` without `section.name`; unchanged when absent. */
export function removeYamlEntry(text: string, section: string, name: string): string {
  const { bom, body } = splitBom(text);
  return bom + removeEntry(body, section, name);
}

function removeEntry(text: string, section: string, name: string): string {
  const { lines, sec, children } = prepare(text, section);
  const existing = children.get(name);
  if (!existing) return text;
  assertNoAnchors(lines, sec, section);
  const at = (n: number) => (n < lines.length ? (lines[n] as Line).start : text.length);
  const out = text.slice(0, at(existing.from)) + text.slice(at(existing.to));
  if (children.size > 1) return out;
  // The section is now empty: make it an explicit empty mapping.
  const keyLine = lines[sec.keyLine] as Line;
  const nl = eol(text);
  const comment = keyLine.text.replace(/\r?\n$/, "").match(/\s+#.*$/)?.[0] ?? "";
  const head = `${section}: {}${comment}${nl}`;
  return out.slice(0, keyLine.start) + head + out.slice(at(sec.keyLine + 1));
}
