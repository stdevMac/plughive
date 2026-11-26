// src/cli/args.ts
//
// Shared pieces of the plughive CLI: the output sink every command writes
// to (so tests can capture it), the error type that carries an exit code,
// and a strict parseArgs wrapper that turns parse failures into usage errors.
import { type ParseArgsConfig, parseArgs } from "node:util";

/** Exit codes: 0 success, 1 the command failed, 2 the command line was wrong. */
export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** True when stdout is a terminal. Secrets (the dashboard link) only go there. */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  /**
   * Asks a question on the terminal and resolves the answer. With `hidden`,
   * what is typed is not echoed (secrets). Absent when there is no terminal.
   */
  prompt?(question: string, opts?: { hidden?: boolean }): Promise<string>;
}

export function processIo(): CliIo {
  return safeIo({
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isTTY: process.stdout.isTTY === true,
    env: process.env,
    prompt: terminalPrompt,
  });
}

// ---- terminal safety ---------------------------------------------------------
//
// Much of what the CLI prints comes from the daemon, and through it from packs,
// mounted MCP servers and tool results: names, descriptions, errors, progress
// messages. A terminal acts on control characters, so such text could move the
// cursor, rewrite lines, set the clipboard (OSC 52) or reverse what is shown
// (bidi overrides). Every line therefore goes through clean() on its way out.

/** True for a character a terminal may act on: C0 (but newline and tab), DEL, C1, bidi controls. */
function isControl(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x0a && code !== 0x09) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** The text without terminal control characters; newlines and tabs stay. */
export function clean(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!isControl(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/** clean() for one line (a table cell, a field value): newlines and tabs become spaces. */
export function cleanLine(text: string): string {
  return clean(text).replace(/[\n\t]/g, " ");
}

/**
 * JSON text in which the characters clean() would drop are \u escapes, so
 * --json output is the daemon's answer exactly, and safe to print. They can
 * only occur inside strings, so the result is valid JSON with the same value.
 */
export function jsonText(value: unknown, indent?: number): string {
  const text = JSON.stringify(value, null, indent) ?? "null";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += isControl(code) ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
  }
  return out;
}

/** The same sinks with every line and prompt cleaned. */
export function safeIo(io: CliIo): CliIo {
  const prompt = io.prompt;
  return {
    ...io,
    out: (line) => io.out(clean(String(line))),
    err: (line) => io.err(clean(String(line))),
    ...(prompt ? { prompt: (question, opts) => prompt.call(io, clean(question), opts) } : {}),
  };
}

/** One line from the terminal, on stderr so stdout stays clean for pipes. */
function terminalPrompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new CliError("no terminal to ask on"));
  return new Promise((done, fail) => {
    process.stderr.write(question);
    let answer = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (err: Error | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onEnd);
      process.stderr.write("\n");
      if (err) fail(err);
      else done(answer);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(null);
        if (ch === "\u0003") return finish(new CliError("cancelled"));
        if (ch === "\u007f" || ch === "\b") {
          if (answer.length) {
            answer = answer.slice(0, -1);
            if (!opts.hidden) process.stderr.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        answer += ch;
        if (!opts.hidden) process.stderr.write(ch);
      }
    };
    // The terminal went away: stop asking rather than wait forever in raw mode.
    const onEnd = () => finish(new CliError("no answer: the terminal closed"));
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onEnd);
  });
}

/** A failure written for the user. The message is printed as is, without a stack. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_FAIL,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type Options = NonNullable<ParseArgsConfig["options"]>;

/**
 * parseArgs in strict mode. Unknown flags, missing values and extra
 * positionals become a CliError with exit code 2 that names the command.
 */
export function parse<O extends Options>(
  command: string,
  argv: string[],
  options: O,
  allowPositionals = false,
) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CliError(`${msg}\nRun "plughive ${command} --help" for usage.`, EXIT_USAGE);
  }
}

/** A TCP port from a flag value, or a usage error. */
export function parsePort(value: string, flag = "--port"): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`${flag} must be a port number between 1 and 65535`, EXIT_USAGE);
  }
  return port;
}
