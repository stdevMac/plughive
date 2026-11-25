// src/cli/pack.ts
//
//   plughive pack list
//   plughive pack add <dir | git-url>
//   plughive pack remove <id>
//
// add copies a pack into $PLUGHIVE_HOME/packs/<id> and asks a running daemon
// to look again. A new user pack is discovered disabled: the user reviews
// what it asks for and enables it in the dashboard. This command never
// enables a pack and never grants anything.
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ManifestError, parseManifestText } from "../core/packs/manifest.js";
import { apiClient, connect, daemonTarget, daemonUp, readAdminToken } from "./api.js";
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE, parse } from "./args.js";

export const PACK_HELP = `Usage: plughive pack <command> [options]

Commands:
  list               list the packs of the running daemon
  add <dir|git-url>  copy a pack into $PLUGHIVE_HOME/packs and register it
  remove <id>        disable a user pack and move it to packs/.removed

Options:
  --home DIR    data directory of the daemon (PLUGHIVE_HOME)
  --json        (list) print JSON
  -h, --help    show this help

A pack you add starts disabled. Open the dashboard (plughive dashboard),
read what the pack asks for (network hosts, programs, secrets, library
access) and enable it there. Code in a pack runs with your user's rights.`;

/** The bundled packs: <repo>/packs from src/cli, dist/packs from dist/src/cli. */
export function builtinPacksDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "packs");
}

export function isGitUrl(spec: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(spec);
}

function gitClone(url: string, into: string): Promise<void> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      ["clone", "--depth", "1", "--quiet", "--", url, into],
      { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err) => {
        if (!err) return done();
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        fail(new CliError(missing ? "git is not installed" : `git clone of ${url} failed`));
      },
    );
  });
}

/** Reads and validates <dir>/pack.json with the rules for user packs. */
export function readUserManifest(dir: string, folderName?: string) {
  const path = join(dir, "pack.json");
  if (!existsSync(path)) throw new CliError(`${dir} has no pack.json`);
  try {
    return parseManifestText(readFileSync(path, "utf8"), {
      source: "pack.json",
      packSource: "user",
      ...(folderName !== undefined ? { folderName } : {}),
    });
  } catch (e) {
    if (e instanceof ManifestError) throw new CliError(e.message);
    throw new CliError(`could not read ${path}`);
  }
}

/** Copies a pack folder without .git, node_modules or symbolic links. */
function copyPack(from: string, to: string, skipped: string[]): void {
  cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (src) => {
      const name = basename(src);
      if (src !== from && (name === ".git" || name === "node_modules")) return false;
      if (lstatSync(src).isSymbolicLink()) {
        skipped.push(src.slice(from.length + 1));
        return false;
      }
      return true;
    },
  });
}

function homeEnv(io: CliIo, home: string | undefined): NodeJS.ProcessEnv {
  const env = { ...io.env };
  if (home !== undefined) {
    env.PLUGHIVE_HOME = resolve(home);
    env.PLUGHIVE_ROOT = env.PLUGHIVE_HOME;
  }
  return env;
}

/** A client when a daemon runs, else null (add and remove work without one). */
async function optionalClient(env: NodeJS.ProcessEnv) {
  const target = daemonTarget(env);
  if (!(await daemonUp(target.localUrl))) return null;
  const token = readAdminToken(target.config.root, env);
  return token ? apiClient(target.localUrl, token) : null;
}

async function list(env: NodeJS.ProcessEnv, io: CliIo, json: boolean): Promise<number> {
  const { api } = connect(env);
  const body = await api.get<{
    packs: {
      id: string;
      version: string | null;
      source: string;
      enabled: boolean;
      state: string;
      tools: string[];
    }[];
  }>("/api/packs");
  if (json) {
    io.out(JSON.stringify(body.packs, null, 2));
    return EXIT_OK;
  }
  const rows = body.packs.map((p) => [
    p.id,
    p.version ?? "",
    p.source,
    p.state,
    String(p.tools.length),
  ]);
  const head = ["ID", "VERSION", "SOURCE", "STATE", "TOOLS"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  io.out(line(head));
  for (const r of rows) io.out(line(r));
  return EXIT_OK;
}

async function add(spec: string, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const { config } = daemonTarget(env);
  let source = resolve(spec);
  let cleanup: string | null = null;
  try {
    if (isGitUrl(spec)) {
      cleanup = mkdtempSync(join(tmpdir(), "plughive-pack-"));
      source = join(cleanup, "pack");
      io.out(`Cloning ${spec}`);
      await gitClone(spec, source);
    } else if (spec.startsWith("-") || !existsSync(source) || !lstatSync(source).isDirectory()) {
      throw new CliError(`${spec} is not a folder or an https/ssh git URL`, EXIT_USAGE);
    }
    const manifest = readUserManifest(source);
    if (existsSync(join(builtinPacksDir(), manifest.id))) {
      throw new CliError(`"${manifest.id}" is the id of a bundled pack; give your pack another id`);
    }
    const packsDir = join(config.root, "packs");
    const dest = join(packsDir, manifest.id);
    if (existsSync(dest)) {
      throw new CliError(
        `a pack "${manifest.id}" is already installed in ${dest}; remove it first`,
      );
    }
    mkdirSync(packsDir, { recursive: true, mode: 0o700 });
    const skipped: string[] = [];
    copyPack(source, dest, skipped);
    // Validate again where the loader will read it (folder name = id).
    readUserManifest(dest, manifest.id);
    io.out(`Added pack "${manifest.id}" ${manifest.version} in ${dest}`);
    if (skipped.length) io.out(`Skipped symbolic links: ${skipped.join(", ")}`);

    const api = await optionalClient(env);
    if (api) {
      await api.post(`/api/packs/${encodeURIComponent(manifest.id)}/reload`);
      io.out("The daemon found it. It is disabled until you review and enable it.");
    } else {
      io.out("No daemon is running; it will find the pack on its next start, disabled.");
    }
    io.out('Review it before you enable it: run "plughive dashboard", open Packs, read what');
    io.out("the pack asks for (network, programs, secrets, library) and enable it there.");
    return EXIT_OK;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

async function remove(id: string, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id))
    throw new CliError(`"${id}" is not a pack id`, EXIT_USAGE);
  const { config } = daemonTarget(env);
  const dir = join(config.root, "packs", id);
  if (!existsSync(join(dir, "pack.json"))) {
    if (existsSync(join(builtinPacksDir(), id))) {
      throw new CliError(`"${id}" is a bundled pack; disable it in the dashboard instead`);
    }
    throw new CliError(`no user pack "${id}" in ${join(config.root, "packs")}`);
  }
  const api = await optionalClient(env);
  if (api) await api.post(`/api/packs/${encodeURIComponent(id)}/disable`);
  const trash = join(config.root, "packs", ".removed");
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  const target = join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  renameSync(dir, target);
  if (api) await api.post(`/api/packs/${encodeURIComponent(id)}/reload`);
  io.out(
    `Removed pack "${id}". Its files are in ${target}; delete that folder when you no longer need it.`,
  );
  return EXIT_OK;
}

export async function runPack(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(
    "pack",
    argv,
    {
      home: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    true,
  );
  const [sub, arg, ...rest] = positionals;
  if (values.help || sub === undefined) {
    io.out(PACK_HELP);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }
  const env = homeEnv(io, values.home);
  const tooMany = () => new CliError(`too many arguments for "pack ${sub}"`, EXIT_USAGE);
  switch (sub) {
    case "list":
      if (arg !== undefined) throw tooMany();
      return list(env, io, values.json === true);
    case "add":
      if (arg === undefined) throw new CliError("pack add needs a folder or a git URL", EXIT_USAGE);
      if (rest.length) throw tooMany();
      return add(arg, env, io);
    case "remove":
      if (arg === undefined) throw new CliError("pack remove needs a pack id", EXIT_USAGE);
      if (rest.length) throw tooMany();
      return remove(arg, env, io);
    default:
      throw new CliError(
        `unknown pack command "${sub}"\nRun "plughive pack --help" for usage.`,
        EXIT_USAGE,
      );
  }
}
