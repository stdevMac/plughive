// src/core/workflows/expr.ts
//
// The one expression language of workflow recipes, parsed by hand. There is no
// eval, no Function and no property access outside the fixed roots:
//
//   operand   := literal | path | helper "(" [operand ("," operand)*] ")"
//   literal   := 'text' | "text" | number | true | false | null
//   path      := root ("." segment | "[" digits "]")*
//   root      := input | steps | index | <the forEach item name>
//   condition := or ; or := and ("||" and)* ; and := not ("&&" not)*
//   not       := "!" not | cmp ; cmp := primary (("==" | "!=") primary)?
//   primary   := "(" condition ")" | operand
//
// Templates (`${...}`) hold one operand. Conditions (`when`) hold a condition
// and may also call available("tool_name"). Path segments are letters, digits,
// "_" and "-"; `__proto__`, `prototype` and `constructor` are refused, and a
// lookup only ever reads an object's own properties.

export type PathSeg = string | number;

export type Expr =
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "path"; root: string; segs: PathSeg[] }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "not"; e: Expr }
  | { k: "and" | "or"; a: Expr; b: Expr }
  | { k: "eq" | "ne"; a: Expr; b: Expr };

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

export const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/** Helpers a template may call, with their arity. Pure functions of their arguments. */
export const HELPER_ARITY: Readonly<Record<string, readonly [number, number]>> = {
  default: [2, 2],
  json: [1, 1],
  join: [1, 2],
  length: [1, 1],
  pluck: [2, 2],
  truncate: [2, 2],
  slice: [2, 3],
  at: [2, 2],
  compact: [1, 1],
  concat: [2, 6],
  number: [1, 1],
  string: [1, 1],
  pick: [2, 2],
};
/** Only in conditions: resolved from the pre-flight, never from a step output. */
export const CONDITION_ONLY = "available";

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_-]/;
const NUMBER = /^-?\d+(\.\d+)?/;
const INDEX = /^\d{1,6}/;
const MAX_EXPR_CHARS = 2000;
const MAX_DEPTH = 16;

interface ParseOptions {
  /** Allowed path roots. */
  roots: ReadonlySet<string>;
  /** Conditions: operators and available(). */
  condition: boolean;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(
    private readonly src: string,
    private readonly opts: ParseOptions,
  ) {}

  fail(msg: string): never {
    throw new ExprError(`${msg} at position ${this.i} in "${this.src.slice(0, 120)}"`);
  }

  ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src.charAt(this.i))) this.i++;
  }

  peek(s: string): boolean {
    this.ws();
    return this.src.startsWith(s, this.i);
  }

  eat(s: string): boolean {
    if (this.peek(s)) {
      this.i += s.length;
      return true;
    }
    return false;
  }

  done(): void {
    this.ws();
    if (this.i < this.src.length) this.fail(`unexpected "${this.src.charAt(this.i)}"`);
  }

  enter(): void {
    if (++this.depth > MAX_DEPTH) this.fail("expression nested too deeply");
  }

  condition(): Expr {
    this.enter();
    let a = this.and();
    while (this.eat("||")) a = { k: "or", a, b: this.and() };
    this.depth--;
    return a;
  }

  and(): Expr {
    let a = this.not();
    while (this.eat("&&")) a = { k: "and", a, b: this.not() };
    return a;
  }

  not(): Expr {
    if (this.peek("!") && !this.peek("!=")) {
      this.i++;
      this.enter();
      const e = this.not();
      this.depth--;
      return { k: "not", e };
    }
    return this.cmp();
  }

  cmp(): Expr {
    const a = this.primary();
    if (this.eat("==")) return { k: "eq", a, b: this.primary() };
    if (this.eat("!=")) return { k: "ne", a, b: this.primary() };
    return a;
  }

  primary(): Expr {
    if (this.opts.condition && this.eat("(")) {
      const e = this.condition();
      if (!this.eat(")")) this.fail('expected ")"');
      return e;
    }
    return this.operand();
  }

  operand(): Expr {
    this.ws();
    const c = this.src.charAt(this.i);
    if (c === "'" || c === '"') return { k: "lit", v: this.str(c) };
    if (/[0-9-]/.test(c)) return { k: "lit", v: this.num() };
    if (!IDENT_START.test(c)) this.fail("expected a value, a path or a helper call");
    const word = this.ident();
    if (word === "true" || word === "false") return { k: "lit", v: word === "true" };
    if (word === "null") return { k: "lit", v: null };
    if (this.peek("(")) return this.call(word);
    return this.path(word);
  }

  str(q: string): string {
    this.i++;
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src.charAt(this.i++);
      if (c === q) return out;
      if (c === "\\") {
        const n = this.src.charAt(this.i++);
        out += n === "n" ? "\n" : n === "t" ? "\t" : n;
        continue;
      }
      out += c;
    }
    return this.fail("unterminated string");
  }

  num(): number {
    const m = this.src.slice(this.i).match(NUMBER);
    if (!m) return this.fail("expected a number");
    this.i += m[0].length;
    return Number(m[0]);
  }

  ident(): string {
    const start = this.i;
    while (this.i < this.src.length && IDENT_CHAR.test(this.src.charAt(this.i))) this.i++;
    return this.src.slice(start, this.i);
  }

  call(fn: string): Expr {
    const isAvail = fn === CONDITION_ONLY;
    if (isAvail && !this.opts.condition) {
      this.fail("available() is only allowed in a when condition");
    }
    if (!isAvail && !Object.hasOwn(HELPER_ARITY, fn))
      this.fail(`unknown helper "${fn.slice(0, 40)}"`);
    const arity = isAvail ? ([1, 1] as const) : (HELPER_ARITY[fn] as readonly [number, number]);
    this.eat("(");
    this.enter();
    const args: Expr[] = [];
    if (!this.peek(")")) {
      do args.push(this.operand());
      while (this.eat(","));
    }
    if (!this.eat(")")) this.fail('expected ")" or ","');
    this.depth--;
    if (args.length < arity[0] || args.length > arity[1]) {
      const n = arity[0] === arity[1] ? `${arity[0]}` : `${arity[0]}-${arity[1]}`;
      this.fail(`${fn}() takes ${n} arguments`);
    }
    if (isAvail && (args[0]?.k !== "lit" || typeof args[0].v !== "string")) {
      this.fail('available() takes a tool name in quotes, such as available("elevenlabs_dub")');
    }
    if (fn === "pluck") {
      const p = args[1];
      if (p?.k !== "lit" || typeof p.v !== "string") {
        this.fail("pluck() takes a quoted path as its second argument");
      }
      parseSubPath(p.v);
    }
    return { k: "call", fn, args };
  }

  path(root: string): Expr {
    if (!this.opts.roots.has(root)) {
      this.fail(`unknown name "${root.slice(0, 40)}" (use ${[...this.opts.roots].join(", ")})`);
    }
    const segs: PathSeg[] = [];
    for (;;) {
      if (this.src.charAt(this.i) === ".") {
        this.i++;
        const seg = this.ident();
        if (seg === "") this.fail('expected a name after "."');
        segs.push(segment(seg, this));
      } else if (this.src.charAt(this.i) === "[") {
        this.i++;
        const m = this.src.slice(this.i).match(INDEX);
        if (!m) return this.fail("only numeric indexes are allowed in [ ]");
        this.i += m[0].length;
        if (this.src.charAt(this.i) !== "]") this.fail('expected "]"');
        this.i++;
        segs.push(Number(m[0]));
      } else break;
      if (segs.length > 32) this.fail("path too long");
    }
    return { k: "path", root, segs };
  }
}

function segment(seg: string, p: { fail(m: string): never }): PathSeg {
  if (FORBIDDEN_SEGMENTS.has(seg)) p.fail(`the name "${seg}" is not allowed in a path`);
  if (!SEGMENT.test(seg)) p.fail(`bad path segment "${seg.slice(0, 40)}"`);
  return /^\d+$/.test(seg) ? Number(seg) : seg;
}

/** A relative path such as "a.b.0" (pluck's second argument). */
export function parseSubPath(src: string): PathSeg[] {
  const fail = (m: string): never => {
    throw new ExprError(`${m} in the path "${src.slice(0, 80)}"`);
  };
  if (src === "") return [];
  if (src.length > 200) fail("path too long");
  return src.split(".").map((s) => segment(s, { fail }));
}

export function parseOperand(src: string, roots: ReadonlySet<string>): Expr {
  if (src.length > MAX_EXPR_CHARS) throw new ExprError("expression too long");
  const p = new Parser(src, { roots, condition: false });
  const e = p.operand();
  p.done();
  return e;
}

export function parseCondition(src: string, roots: ReadonlySet<string>): Expr {
  let s = src.trim();
  // A condition may be written as a template: "${input.captions}".
  if (s.startsWith("${") && s.endsWith("}") && s.indexOf("${", 2) === -1) s = s.slice(2, -1);
  if (s.length > MAX_EXPR_CHARS) throw new ExprError("condition too long");
  const p = new Parser(s, { roots, condition: true });
  const e = p.condition();
  p.done();
  return e;
}

export interface References {
  steps: Set<string>;
  roots: Set<string>;
  tools: Set<string>;
}

export function emptyReferences(): References {
  return { steps: new Set(), roots: new Set(), tools: new Set() };
}

/** Every path root and step id an expression reads, and the tools available() asks about. */
export function references(e: Expr, out: References): References {
  switch (e.k) {
    case "lit":
      break;
    case "path":
      out.roots.add(e.root);
      if (e.root === "steps" && typeof e.segs[0] === "string") out.steps.add(e.segs[0]);
      break;
    case "call":
      if (e.fn === CONDITION_ONLY) out.tools.add(String((e.args[0] as { v: string }).v));
      for (const a of e.args) references(a, out);
      break;
    case "not":
      references(e.e, out);
      break;
    default:
      references(e.a, out);
      references(e.b, out);
  }
  return out;
}

// --- evaluation -----------------------------------------------------------------

export interface EvalScope {
  /** Root values: input, steps, index, the item variable. */
  roots: Readonly<Record<string, unknown>>;
  /** Pre-flight answer for available("tool"). */
  available?: (tool: string) => boolean;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own-property lookup. Anything else (prototypes, class instances, functions) reads as undefined. */
export function lookup(value: unknown, segs: readonly PathSeg[]): unknown {
  let v = value;
  for (const s of segs) {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) {
      if (typeof s !== "number") return undefined;
      v = s < v.length ? v[s] : undefined;
    } else if (isPlainObject(v)) {
      const key = String(s);
      if (!Object.hasOwn(v, key)) return undefined;
      v = v[key];
    } else return undefined;
  }
  return typeof v === "function" ? undefined : v;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return !!v;
}

function same(a: unknown, b: unknown): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return a === b;
}

const MAX_HELPER_CHARS = 256 * 1024;
/** Longest list concat() builds. */
const MAX_HELPER_ITEMS = 10_000;

/**
 * At least how long `v` is as JSON, counting no further than just past
 * `limit`. A value that shares one object in many places (a list holding the
 * same step output a thousand times) is counted at its full written size, but
 * the count stops early instead of building the text first. A cycle counts as
 * endless.
 */
export function jsonLength(v: unknown, limit: number): number {
  let n = 0;
  const stack: unknown[] = [v];
  const open = new Set<object>();
  while (stack.length > 0 && n <= limit) {
    const x = stack.pop();
    if (x instanceof Close) {
      open.delete(x.of);
    } else if (typeof x === "string") {
      n += x.length + 2;
    } else if (typeof x === "number" || typeof x === "boolean" || x === null) {
      n += String(x).length;
    } else if (typeof x === "object") {
      if (open.has(x)) return Number.POSITIVE_INFINITY;
      open.add(x);
      stack.push(new Close(x));
      if (Array.isArray(x)) {
        n += 1 + Math.max(1, x.length);
        for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
      } else {
        n += 1;
        for (const [k, val] of Object.entries(x)) {
          if (val === undefined || typeof val === "function" || typeof val === "symbol") continue;
          n += k.length + 4;
          stack.push(val);
        }
      }
    }
  }
  return n;
}

class Close {
  constructor(readonly of: object) {}
}

export function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (jsonLength(v, MAX_HELPER_CHARS) > MAX_HELPER_CHARS) {
    throw new ExprError("value too large to turn into text");
  }
  const s = JSON.stringify(v);
  if (s === undefined) return "";
  if (s.length > MAX_HELPER_CHARS) throw new ExprError("value too large to turn into text");
  return s;
}

function asInt(v: unknown, what: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ExprError(`${what} must be a number`);
  return Math.trunc(n);
}

function helper(fn: string, args: unknown[], raw: Expr[]): unknown {
  const [a, b, c] = args;
  switch (fn) {
    case "default":
      return a === undefined || a === null || a === "" ? b : a;
    case "json":
      return a === undefined ? "null" : typeof a === "string" ? JSON.stringify(a) : stringify(a);
    case "join": {
      if (a === undefined || a === null) return "";
      if (!Array.isArray(a)) throw new ExprError("join() needs a list");
      const sep = b === undefined ? ", " : stringify(b);
      let out = "";
      for (const [i, x] of a.entries()) {
        out += i === 0 ? stringify(x) : sep + stringify(x);
        if (out.length > MAX_HELPER_CHARS) throw new ExprError("join() result too large");
      }
      return out;
    }
    case "length":
      if (Array.isArray(a) || typeof a === "string") return a.length;
      if (isPlainObject(a)) return Object.keys(a).length;
      return 0;
    case "pluck": {
      if (a === undefined || a === null) return [];
      if (!Array.isArray(a)) throw new ExprError("pluck() needs a list");
      const segs = parseSubPath(String((raw[1] as { v: string }).v));
      return a.map((x) => lookup(x, segs));
    }
    case "truncate": {
      const s = stringify(a);
      const n = Math.max(0, asInt(b, "truncate() length"));
      return s.length > n ? s.slice(0, n) : s;
    }
    case "slice": {
      if (a === undefined || a === null) return a;
      if (!Array.isArray(a) && typeof a !== "string") {
        throw new ExprError("slice() needs a list or text");
      }
      if (c === undefined) return a.slice(0, Math.max(0, asInt(b, "slice() count")));
      return a.slice(asInt(b, "slice() start"), asInt(c, "slice() end"));
    }
    case "at": {
      if (!Array.isArray(a)) return undefined;
      const i = asInt(b, "at() index");
      return a[i < 0 ? a.length + i : i];
    }
    case "compact":
      if (!Array.isArray(a)) return [];
      return a.filter((x) => x !== undefined && x !== null && x !== "" && truthyObject(x));
    case "concat": {
      const out: unknown[] = [];
      for (const x of args) {
        if (x === undefined || x === null) continue;
        if (Array.isArray(x)) {
          if (out.length + x.length > MAX_HELPER_ITEMS) {
            throw new ExprError(`concat() result longer than ${MAX_HELPER_ITEMS} items`);
          }
          out.push(...x);
        } else out.push(x);
      }
      return out;
    }
    case "number": {
      if (a === undefined || a === null || a === "") return undefined;
      const n = Number(a);
      return Number.isFinite(n) ? n : undefined;
    }
    case "string":
      return a === undefined ? undefined : stringify(a);
    case "pick": {
      // A key chosen at run time (pick(input.voices, item.speaker)): own
      // properties of a plain object only, never a prototype name.
      if (!isPlainObject(a) || (typeof b !== "string" && typeof b !== "number")) return undefined;
      const key = String(b);
      if (FORBIDDEN_SEGMENTS.has(key) || !Object.hasOwn(a, key)) return undefined;
      const v = a[key];
      return typeof v === "function" ? undefined : v;
    }
    default:
      throw new ExprError(`unknown helper "${fn}"`);
  }
}

/** compact() also drops objects left empty by missing whole-string templates. */
function truthyObject(x: unknown): boolean {
  return !isPlainObject(x) || Object.keys(x).length > 0;
}

export function evaluate(e: Expr, scope: EvalScope): unknown {
  switch (e.k) {
    case "lit":
      return e.v;
    case "path":
      return lookup(Object.hasOwn(scope.roots, e.root) ? scope.roots[e.root] : undefined, e.segs);
    case "call": {
      if (e.fn === CONDITION_ONLY) {
        const name = String((e.args[0] as { v: string }).v);
        return scope.available ? scope.available(name) : false;
      }
      return helper(
        e.fn,
        e.args.map((a) => evaluate(a, scope)),
        e.args,
      );
    }
    case "not":
      return !truthy(evaluate(e.e, scope));
    case "and":
      return truthy(evaluate(e.a, scope)) && truthy(evaluate(e.b, scope));
    case "or":
      return truthy(evaluate(e.a, scope)) || truthy(evaluate(e.b, scope));
    case "eq":
      return same(evaluate(e.a, scope), evaluate(e.b, scope));
    case "ne":
      return !same(evaluate(e.a, scope), evaluate(e.b, scope));
  }
}

/** A printable form of an expression, for error messages. */
export function describeExpr(e: Expr): string {
  if (e.k === "path") return [e.root, ...e.segs.map(String)].join(".");
  if (e.k === "call") return `${e.fn}(...)`;
  return "value";
}
