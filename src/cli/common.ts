// src/cli/common.ts
//
// Pieces shared by the management commands (jobs, tools, secrets, ...): a
// sub-command dispatcher with the common --home/--json/--help flags, table
// and JSON output, key=value argument parsing, JSON input from a flag, a file
// or stdin, and confirmation and secret prompts.
//
// Every management command talks to the running daemon through /api with the
// admin token, exactly as the dashboard does, so the CLI and the dashboard
// always see and change the same state.
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { type ApiClient, connect } from "./api.js";
import {
  CliError,
  type CliIo,
  EXIT_OK,
  EXIT_USAGE,
  type Options,
  cleanLine,
  jsonText,
  parse,
} from "./args.js";

export { clean } from "./args.js";

/** The flags every management sub-command accepts. */
export const COMMON_OPTIONS = {
  home: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies Options;

export const COMMON_HELP = `Common options:
  --home DIR    data directory of the daemon (PLUGHIVE_HOME)
  --json        print JSON (the daemon's own answer) instead of text
  -h, --help    show this help`;

export function homeEnv(io: CliIo, home: string | undefined): NodeJS.ProcessEnv {
  const env = { ...io.env };
  if (home !== undefined) {
    env.PLUGHIVE_HOME = resolve(home);
    env.PLUGHIVE_ROOT = env.PLUGHIVE_HOME;
  }
  return env;
}

export interface Ctx {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  json: boolean;
  /** The client of the running daemon (created on first use). */
  api(): ApiClient;
  /** Prints a value as indented JSON. */
  printJson(value: unknown): void;
}

export type SubHandler = (argv: string[], io: CliIo) => Promise<number>;

/**
 * Runs `plughive <group> <sub> ...`: the first positional picks the handler.
 * No sub-command, or --help before it, prints the group's help.
 */
export async function runGroup(
  group: string,
  help: string,
  argv: string[],
  io: CliIo,
  handlers: Record<string, SubHandler>,
  defaultSub?: string,
): Promise<number> {
  const first = argv[0];
  if (first === "-h" || first === "--help" || first === "help") {
    io.out(help);
    return EXIT_OK;
  }
  let sub = first;
  let rest = argv.slice(1);
  if (sub === undefined || sub.startsWith("-")) {
    if (defaultSub === undefined) {
      io.out(help);
      return sub === undefined ? EXIT_USAGE : EXIT_USAGE;
    }
    sub = defaultSub;
    rest = argv;
  }
  const handler = handlers[sub];
  if (!handler) {
    throw new CliError(
      `unknown ${group} command "${sub}"\nRun "plughive ${group} --help" for usage.`,
      EXIT_USAGE,
    );
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(help);
    return EXIT_OK;
  }
  return handler(rest, io);
}

/**
 * Parses the arguments of one sub-command (its own options plus the common
 * ones) and checks the number of positionals.
 */
export function sub<O extends Options>(
  name: string,
  argv: string[],
  io: CliIo,
  options: O,
  positionals: { min?: number; max?: number; usage?: string } = {},
) {
  const parsed = parse(name, argv, { ...COMMON_OPTIONS, ...options }, true);
  const min = positionals.min ?? 0;
  const max = positionals.max ?? 0;
  const count = parsed.positionals.length;
  if (count < min || count > max) {
    const usage = positionals.usage ? `\nUsage: plughive ${name} ${positionals.usage}` : "";
    throw new CliError(
      `${count < min ? "missing arguments" : "too many arguments"} for "${name}"${usage}`,
      EXIT_USAGE,
    );
  }
  const values = parsed.values as Record<string, unknown>;
  const env = homeEnv(io, values.home as string | undefined);
  let client: ApiClient | null = null;
  const ctx: Ctx = {
    io,
    env,
    json: values.json === true,
    api: () => {
      client ??= connect(env).api;
      return client;
    },
    printJson: (value) => io.out(jsonText(value, 2)),
  };
  return { values: parsed.values, positionals: parsed.positionals, ctx };
}

// ---- output ----------------------------------------------------------------

/**
 * A left-aligned table with a header row; empty cells for null/undefined.
 * Cells are cleaned to one line first, so a value cannot break the layout or
 * add rows of its own.
 */
export function printTable(io: CliIo, head: string[], rows: unknown[][]): void {
  const cells = rows.map((r) =>
    r.map((c) => (c === null || c === undefined ? "" : cleanLine(String(c)))),
  );
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  io.out(line(head));
  for (const r of cells) io.out(line(r));
}

/** `key: value` lines, aligned; null/undefined values are skipped. Each value stays on its line. */
export function printFields(io: CliIo, fields: [string, unknown][]): void {
  const shown = fields.filter(([, v]) => v !== null && v !== undefined && v !== "");
  const width = Math.max(0, ...shown.map(([k]) => cleanLine(k).length));
  for (const [k, v] of shown) {
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    io.out(`${`${cleanLine(k)}:`.padEnd(width + 2)}${cleanLine(text)}`);
  }
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  // Clean before cutting, so the length counts what is shown.
  const one = cleanLine(text).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** "3m ago", "in 2h": a short relative time from an ISO date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.round((now - t) / 1000);
  const abs = Math.abs(s);
  const span =
    abs < 60
      ? `${abs}s`
      : abs < 3600
        ? `${Math.round(abs / 60)}m`
        : abs < 86_400
          ? `${Math.round(abs / 3600)}h`
          : `${Math.round(abs / 86_400)}d`;
  return s >= 0 ? `${span} ago` : `in ${span}`;
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return `$${value < 1 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
}

// ---- input -----------------------------------------------------------------

/** The most the CLI reads from a file or stdin for one input (JSON, a secret, a body). */
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;

/**
 * Reads a file descriptor as UTF-8, up to MAX_INPUT_BYTES. Anything longer is
 * refused rather than cut.
 */
function readCapped(fd: number, what: string): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  for (;;) {
    const n = readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    total += n;
    if (total > MAX_INPUT_BYTES) {
      throw new CliError(`${what} is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MiB`, EXIT_USAGE);
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A regular file, up to MAX_INPUT_BYTES. */
function readInputFile(path: string): string {
  let fd: number;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new CliError(`could not read ${path}`);
  }
  try {
    // A FIFO or a device (/dev/zero) would never end; only files are read.
    if (!fstatSync(fd).isFile()) throw new CliError(`${path} is not a regular file`, EXIT_USAGE);
    try {
      return readCapped(fd, path);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError(`could not read ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

/** All of stdin, up to MAX_INPUT_BYTES. */
function readStdinCapped(what: string): string {
  try {
    return readCapped(0, what);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`could not read ${what}`);
  }
}

/**
 * JSON from a flag value: inline JSON, `@path` for a file, or `-` for stdin.
 */
export function readJsonInput(spec: string, what = "input"): unknown {
  let text: string;
  if (spec === "-") {
    text = readStdinCapped(`${what} from stdin`);
  } else if (spec.startsWith("@")) {
    text = readInputFile(resolve(spec.slice(1)));
  } else {
    text = spec;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`the ${what} is not valid JSON`, EXIT_USAGE);
  }
}

export function readJsonObject(spec: string, what = "input"): Record<string, unknown> {
  const value = readJsonInput(spec, what);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`the ${what} must be a JSON object`, EXIT_USAGE);
  }
  return value as Record<string, unknown>;
}

/** Keys that would reach Object.prototype instead of setting a value. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Refuses a key (or a dotted part of one) that is __proto__, constructor or prototype. */
export function assertSafeKey(key: string): void {
  for (const part of key.split(".")) {
    if (UNSAFE_KEYS.has(part)) {
      throw new CliError(`"${key}": ${part} cannot be used as a key`, EXIT_USAGE);
    }
  }
}

/**
 * `key=value` pairs into an object. `key=value` is a string, `key:=json` a
 * JSON value (number, boolean, array, object, null). Dotted keys nest:
 * `a.b=1` gives {a: {b: "1"}}.
 */
export function parseAssignments(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const m = /^([^=:]+?)(:?)=(.*)$/s.exec(pair);
    if (!m) {
      throw new CliError(`"${pair}" is not key=value or key:=json`, EXIT_USAGE);
    }
    const [, key = "", raw, text = ""] = m;
    let value: unknown = text;
    if (raw === ":") {
      try {
        value = JSON.parse(text);
      } catch {
        throw new CliError(`the value of ${key} is not valid JSON`, EXIT_USAGE);
      }
    }
    assertSafeKey(key);
    const path = key.split(".");
    let node = out;
    for (const part of path.slice(0, -1)) {
      const next = Object.hasOwn(node, part) ? node[part] : undefined;
      if (next === undefined || next === null || typeof next !== "object" || Array.isArray(next)) {
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }
    node[path[path.length - 1] ?? key] = value;
  }
  return out;
}

/** Reads all of stdin as text (for piped secrets and bodies). */
export function readStdin(): string {
  return readStdinCapped("stdin");
}

/**
 * Asks a yes/no question on the terminal. --yes answers it; without a
 * terminal and without --yes the command stops rather than guess.
 */
export async function confirm(io: CliIo, question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!io.prompt || !process.stdin.isTTY) {
    throw new CliError(`${question} Pass --yes to confirm.`, EXIT_USAGE);
  }
  const answer = (await io.prompt(`${question} [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new CliError("cancelled");
}

/** Sleeps, for polling. */
export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export const enc = encodeURIComponent;
