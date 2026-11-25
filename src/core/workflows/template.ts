// src/core/workflows/template.ts
//
// Templates inside recipe values. Every string of a step's `args` (and of
// `set`, `save`, `forEach` and `output`) is parsed once, when the recipe loads:
//
//   "${input.topic}"            the whole string: the value keeps its type
//   "A film about ${input.x}"   embedded: the value is turned into text
//   "$${literal}"               an escaped "${"
//
// A whole-string template whose path is missing resolves to undefined: in an
// object its key is dropped, in a list the element is dropped. An embedded one
// is an error (use default(...)). Resolution is a single pass over the parsed
// form, so text that comes back from a tool is never parsed again: template
// values are data only.
import {
  type EvalScope,
  type Expr,
  ExprError,
  FORBIDDEN_SEGMENTS,
  type References,
  describeExpr,
  evaluate,
  parseOperand,
  references,
  stringify,
} from "./expr.js";

export type CompiledValue =
  | { t: "const"; v: unknown }
  | { t: "whole"; e: Expr; src: string }
  | { t: "parts"; parts: (string | Expr)[]; src: string }
  | { t: "arr"; items: CompiledValue[] }
  | { t: "obj"; entries: [string, CompiledValue][] };

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface TemplateLimits {
  /** Longest string one template may produce. */
  maxStringChars: number;
}

const MAX_VALUE_DEPTH = 24;
const MAX_TEMPLATES_PER_STRING = 64;

/** Split "a ${x} b" into literal text and expression sources. */
function splitTemplate(s: string): (string | { src: string })[] {
  const out: (string | { src: string })[] = [];
  let text = "";
  let i = 0;
  let count = 0;
  while (i < s.length) {
    if (s.startsWith("$${", i)) {
      text += "${";
      i += 3;
      continue;
    }
    if (!s.startsWith("${", i)) {
      text += s.charAt(i++);
      continue;
    }
    // Find the closing brace, skipping quoted strings inside the expression.
    let j = i + 2;
    let quote = "";
    for (; j < s.length; j++) {
      const c = s.charAt(j);
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = "";
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "}") break;
    }
    if (j >= s.length) throw new TemplateError(`unclosed "\${" in "${s.slice(0, 80)}"`);
    if (text) out.push(text);
    text = "";
    out.push({ src: s.slice(i + 2, j) });
    if (++count > MAX_TEMPLATES_PER_STRING)
      throw new TemplateError("too many templates in one string");
    i = j + 1;
  }
  if (text) out.push(text);
  return out;
}

/** Parse every template in a JSON value. Throws TemplateError with the location. */
export function compileValue(
  value: unknown,
  roots: ReadonlySet<string>,
  where: string,
  depth = 0,
): CompiledValue {
  if (depth > MAX_VALUE_DEPTH) throw new TemplateError(`${where}: value nested too deeply`);
  if (typeof value === "string") {
    if (!value.includes("${")) return { t: "const", v: value };
    const pieces = splitTemplate(value);
    const parse = (src: string): Expr => {
      try {
        return parseOperand(src.trim(), roots);
      } catch (e) {
        throw new TemplateError(`${where}: ${(e as Error).message}`);
      }
    };
    const only = pieces[0];
    if (pieces.length === 1 && typeof only === "object") {
      return { t: "whole", e: parse(only.src), src: value };
    }
    if (pieces.every((p) => typeof p === "string")) return { t: "const", v: pieces.join("") };
    return {
      t: "parts",
      parts: pieces.map((p) => (typeof p === "string" ? p : parse(p.src))),
      src: value,
    };
  }
  if (Array.isArray(value)) {
    const items = value.map((v, i) => compileValue(v, roots, `${where}[${i}]`, depth + 1));
    return items.every((c) => c.t === "const")
      ? { t: "const", v: items.map((c) => (c as { v: unknown }).v) }
      : { t: "arr", items };
  }
  if (value !== null && typeof value === "object") {
    const entries: [string, CompiledValue][] = [];
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_SEGMENTS.has(k))
        throw new TemplateError(`${where}: the key "${k}" is not allowed`);
      entries.push([k, compileValue(v, roots, `${where}.${k}`, depth + 1)]);
    }
    return entries.every(([, c]) => c.t === "const")
      ? { t: "const", v: Object.fromEntries(entries.map(([k, c]) => [k, (c as { v: unknown }).v])) }
      : { t: "obj", entries };
  }
  return { t: "const", v: value };
}

/** Every reference in a compiled value. */
export function valueReferences(c: CompiledValue, out: References): References {
  switch (c.t) {
    case "const":
      break;
    case "whole":
      references(c.e, out);
      break;
    case "parts":
      for (const p of c.parts) if (typeof p !== "string") references(p, out);
      break;
    case "arr":
      for (const i of c.items) valueReferences(i, out);
      break;
    case "obj":
      for (const [, v] of c.entries) valueReferences(v, out);
      break;
  }
  return out;
}

function capString(s: string, limits: TemplateLimits, src: string): string {
  if (s.length > limits.maxStringChars) {
    throw new TemplateError(
      `the template "${src.slice(0, 80)}" produced ${s.length} characters, over the ${limits.maxStringChars} limit`,
    );
  }
  return s;
}

function run(e: Expr, scope: EvalScope, src: string): unknown {
  try {
    return evaluate(e, scope);
  } catch (err) {
    if (err instanceof ExprError) throw new TemplateError(`"${src.slice(0, 80)}": ${err.message}`);
    throw err;
  }
}

/** Resolve a compiled value. Constants are returned as they are (never mutated by callers). */
export function resolveValue(c: CompiledValue, scope: EvalScope, limits: TemplateLimits): unknown {
  switch (c.t) {
    case "const":
      return c.v;
    case "whole": {
      const v = run(c.e, scope, c.src);
      if (typeof v === "string") capString(v, limits, c.src);
      return v;
    }
    case "parts": {
      let out = "";
      for (const p of c.parts) {
        if (typeof p === "string") {
          out += p;
          continue;
        }
        const v = run(p, scope, c.src);
        if (v === undefined) {
          throw new TemplateError(
            `"${c.src.slice(0, 80)}": ${describeExpr(p)} has no value (wrap it in default(..., '') if it is optional)`,
          );
        }
        out += stringify(v);
        if (out.length > limits.maxStringChars) capString(out, limits, c.src);
      }
      return out;
    }
    case "arr": {
      const out: unknown[] = [];
      for (const i of c.items) {
        const v = resolveValue(i, scope, limits);
        if (v !== undefined) out.push(v);
      }
      return out;
    }
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of c.entries) {
        const r = resolveValue(v, scope, limits);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
  }
}

/** True when the value only reads `input` (it can be resolved before any step runs). */
export function inputOnly(refs: References): boolean {
  for (const r of refs.roots) if (r !== "input") return false;
  return true;
}
