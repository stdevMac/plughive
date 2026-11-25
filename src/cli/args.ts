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
}

export function processIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isTTY: process.stdout.isTTY === true,
    env: process.env,
  };
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
