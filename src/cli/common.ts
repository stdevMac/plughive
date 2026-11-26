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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ApiClient, connect } from "./api.js";
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE, type Options, parse } from "./args.js";

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
    printJson: (value) => io.out(JSON.stringify(value, null, 2)),
  };
  return { values: parsed.values, positionals: parsed.positionals, ctx };
}

// ---- output ----------------------------------------------------------------

/**
 * Text from the daemon (pack manifests, tool descriptions, error messages)
 * without control characters, so an escape sequence in it cannot move the
 * cursor, recolour or rewrite what the terminal shows. Newlines and tabs stay.
 */
export function clean(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\t" || (c >= 0x20 && c !== 0x7f && (c < 0x80 || c > 0x9f)))
      out += ch;
  }
  return out;
}

/** A left-aligned table with a header row; empty cells for null/undefined. */
export function printTable(io: CliIo, head: string[], rows: unknown[][]): void {
  const cells = rows.map((r) =>
    r.map((c) => (c === null || c === undefined ? "" : clean(String(c)).replace(/[\n\t]/g, " "))),
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

/** `key: value` lines, aligned; null/undefined values are skipped. */
export function printFields(io: CliIo, fields: [string, unknown][]): void {
  const shown = fields.filter(([, v]) => v !== null && v !== undefined && v !== "");
  const width = Math.max(0, ...shown.map(([k]) => k.length));
  for (const [k, v] of shown) {
    const text = clean(typeof v === "object" ? JSON.stringify(v) : String(v));
    io.out(`${`${k}:`.padEnd(width + 2)}${text}`);
  }
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "";
  const one = text.replace(/\s+/g, " ").trim();
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

/**
 * JSON from a flag value: inline JSON, `@path` for a file, or `-` for stdin.
 */
export function readJsonInput(spec: string, what = "input"): unknown {
  let text: string;
  if (spec === "-") {
    try {
      text = readFileSync(0, "utf8");
    } catch {
      throw new CliError(`could not read ${what} from stdin`);
    }
  } else if (spec.startsWith("@")) {
    const path = resolve(spec.slice(1));
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new CliError(`could not read ${path}`);
    }
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
    const path = key.split(".");
    let node = out;
    for (const part of path.slice(0, -1)) {
      const next = node[part];
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
  try {
    return readFileSync(0, "utf8");
  } catch {
    throw new CliError("could not read stdin");
  }
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
