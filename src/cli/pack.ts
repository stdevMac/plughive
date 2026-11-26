// src/cli/pack.ts
//
//   plughive pack list | show | consent | enable | disable | reload | settings
//   plughive pack add <dir | git-url>
//   plughive pack remove <id>
//
// add copies a pack into $PLUGHIVE_HOME/packs/<id> and asks a running daemon
// to look again. A new user pack is discovered disabled. enable shows what the
// pack asks for (the same consent the dashboard shows), asks, and sends the
// reviewed hashes, so the daemon refuses if the pack changed in between.
// Secrets are granted only by name with --grant.
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
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE, cleanLine, jsonText, parse } from "./args.js";
import {
  COMMON_HELP,
  COMMON_OPTIONS,
  type Ctx,
  assertSafeKey,
  confirm,
  enc,
  homeEnv,
  parseAssignments,
  printFields,
  printTable,
  runGroup,
  sub,
} from "./common.js";

export const PACK_HELP = `Usage: plughive pack <command> [options]

Commands:
  list                    the packs of the running daemon: state, tools
  show <id>               everything about one pack: tools, providers,
                          workflows, mounts, secrets, errors
  consent <id>            what the pack asks for (network hosts, programs,
                          folders, library, secrets), high-risk items flagged
  enable <id>             show what it asks for, ask, then enable it
      --grant SECRET      grant the pack a stored secret (repeatable)
      -y, --yes           do not ask
  disable <id>            turn the pack off (its tools disappear)
  reload <id>             read the pack from disk again
  settings <id>           show the pack's settings
  settings <id> k=v ...   change them: k=v for text, k:=json for numbers,
                          booleans, lists; --unset k to clear one
  add <dir|git-url>       copy a pack into $PLUGHIVE_HOME/packs and register it
  remove <id>             disable a user pack and move it to packs/.removed

${COMMON_HELP}

A pack you add starts disabled. Read what it asks for ("plughive pack consent
<id>") before you enable it. Code in a pack runs with your user's rights.`;

/** The bundled packs: <repo>/packs from src/cli, dist/packs from dist/src/cli. */
export function builtinPacksDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "packs");
}

export function isGitUrl(spec: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/.test(spec);
}

/** The URL without a user name or token in it, for messages. */
export function redactUrl(spec: string): string {
  try {
    const url = new URL(spec);
    if (!url.username && !url.password) return spec;
    url.username = "***";
    url.password = "";
    return url.toString();
  } catch {
    return spec;
  }
}

function gitClone(url: string, into: string): Promise<void> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      // No submodules over file://, and links checked out as plain files: a
      // cloned pack cannot point into the rest of this computer.
      [
        "-c",
        "protocol.file.allow=never",
        "-c",
        "core.symlinks=false",
        "clone",
        "--depth",
        "1",
        "--quiet",
        "--",
        url,
        into,
      ],
      { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err) => {
        if (!err) return done();
        const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
        fail(
          new CliError(missing ? "git is not installed" : `git clone of ${redactUrl(url)} failed`),
        );
      },
    );
  });
}

/** Reads and validates <dir>/pack.json with the rules for user packs. */
export function readUserManifest(dir: string, folderName?: string) {
  const path = join(dir, "pack.json");
  if (!existsSync(path)) throw new CliError(`${dir} has no pack.json`);
  // A linked pack.json would make the pack's words come from another file.
  if (!lstatSync(path).isFile()) throw new CliError(`${path} is not a regular file`);
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

/** How much a pack may hold: the limits the daemon checks when it hashes a pack. */
interface PackLimits {
  files: number;
  fileBytes: number;
  totalBytes: number;
}

/**
 * Copies a pack folder without .git, node_modules or symbolic links. A pipe,
 * a device or a pack larger than the daemon accepts is refused before it
 * fills the disk.
 */
function copyPack(from: string, to: string, skipped: string[], limits: PackLimits): void {
  let files = 0;
  let total = 0;
  cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (src) => {
      const name = basename(src);
      const rel = src.slice(from.length + 1);
      if (src !== from && (name === ".git" || name === "node_modules")) return false;
      const st = lstatSync(src);
      if (st.isSymbolicLink()) {
        skipped.push(rel);
        return false;
      }
      if (st.isDirectory()) return true;
      if (!st.isFile()) throw new CliError(`${rel} is not a regular file; remove it from the pack`);
      files += 1;
      total += st.size;
      if (files > limits.files) {
        throw new CliError(`the pack has more than ${limits.files} files`);
      }
      if (st.size > limits.fileBytes) {
        throw new CliError(`${rel} is larger than ${limits.fileBytes} bytes`);
      }
      if (total > limits.totalBytes) {
        throw new CliError(`the pack is larger than ${limits.totalBytes} bytes`);
      }
      return true;
    },
  });
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
    io.out(jsonText(body.packs, 2));
    return EXIT_OK;
  }
  const rows = body.packs.map((p) => [
    p.id,
    p.version ?? "",
    p.source,
    p.state,
    String(p.tools.length),
  ]);
  printTable(io, ["ID", "VERSION", "SOURCE", "STATE", "TOOLS"], rows);
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
      io.out(`Cloning ${redactUrl(spec)}`);
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
    const { PACK_HASH_MAX_FILES, PACK_HASH_MAX_FILE_BYTES, PACK_HASH_MAX_TOTAL_BYTES } =
      await import("../core/packs/loader.js");
    try {
      copyPack(source, dest, skipped, {
        files: PACK_HASH_MAX_FILES,
        fileBytes: PACK_HASH_MAX_FILE_BYTES,
        totalBytes: PACK_HASH_MAX_TOTAL_BYTES,
      });
      // Validate again where the loader will read it (folder name = id).
      readUserManifest(dest, manifest.id);
    } catch (e) {
      // Leave no half-copied pack for the daemon to find.
      rmSync(dest, { recursive: true, force: true });
      throw e;
    }
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

// ---- review, enable, disable, settings ---------------------------------------

interface PackView {
  id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  notice: string | null;
  source: string;
  enabled: boolean;
  state: string;
  error: string | null;
  tools: string[];
  providers: string[];
  secrets: { name: string; present?: boolean; granted?: boolean; required?: boolean }[];
  skills: string[];
  workflows: string[];
  workflowErrors: { name: string; error: string }[];
  mounts: string[];
  review: unknown;
}

interface ConsentView {
  id: string;
  name: string;
  version: string;
  source: string;
  items: { kind: string; text: string; risk: string }[];
  highRisk: boolean;
  runsCode: boolean;
  secrets: {
    name: string;
    label?: string;
    required: boolean;
    granted: boolean;
    grantable: boolean;
    stored: boolean;
  }[];
  manifestHash: string;
  entryHash: string;
  review: unknown;
}

async function findPack(ctx: Ctx, id: string): Promise<PackView> {
  const { packs } = await ctx.api().get<{ packs: PackView[] }>("/api/packs");
  const pack = packs.find((p) => p.id === id);
  if (!pack) throw new CliError(`no pack "${id}"; "plughive pack list" shows them`);
  return pack;
}

/**
 * What a pack asks for. The words come from the pack's manifest: each one is
 * kept on its own line, so a name or label cannot forge another item.
 */
function printConsent(io: CliIo, c: ConsentView): void {
  const one = (v: unknown) => cleanLine(String(v ?? ""));
  io.out(`${one(c.name)} ${one(c.version)} (${one(c.id)}, ${one(c.source)} pack) asks for:`);
  for (const item of c.items) {
    io.out(`  ${item.risk === "high" ? "[high-risk] " : ""}${one(item.text)}`);
  }
  if (!c.items.length) io.out("  nothing");
  if (c.runsCode) {
    io.out("\nThis pack ships code. It runs inside the daemon with your user's rights;");
    io.out("the items above are what the daemon mediates, not a sandbox.");
  }
  if (c.secrets.length) {
    io.out("\nSecrets it can be granted (--grant NAME):");
    for (const s of c.secrets) {
      const notes = [
        s.required ? "required" : "optional",
        s.granted ? "granted" : null,
        s.stored ? "a value is stored" : null,
        s.grantable ? null : "cannot be granted to this pack",
      ].filter(Boolean);
      io.out(`  ${one(s.name)}${s.label ? ` (${one(s.label)})` : ""}: ${notes.join(", ")}`);
    }
  }
  if (c.review) io.out("\nThe pack changed since you last enabled it; review it again.");
}

async function packSub(
  name: "show" | "consent" | "enable" | "disable" | "reload" | "settings",
  argv: string[],
  io: CliIo,
): Promise<number> {
  switch (name) {
    case "show": {
      const { positionals, ctx } = sub(
        "pack show",
        argv,
        io,
        {},
        { min: 1, max: 1, usage: "<id>" },
      );
      const p = await findPack(ctx, positionals[0] ?? "");
      if (ctx.json) {
        ctx.printJson(p);
        return EXIT_OK;
      }
      printFields(io, [
        ["id", p.id],
        ["name", p.name],
        ["version", p.version],
        ["source", p.source],
        ["state", `${p.state}${p.enabled ? " (enabled)" : ""}`],
        ["error", p.error],
        ["description", p.description],
        ["notice", p.notice],
        ["tools", p.tools.join(", ") || "none"],
        ["providers", p.providers.join(", ") || null],
        ["workflows", p.workflows.join(", ") || null],
        ["skills", p.skills.join(", ") || null],
        ["mounts", p.mounts.join(", ") || null],
        [
          "secrets",
          p.secrets.map((s) => `${s.name}${s.present ? " (set)" : " (not set)"}`).join(", ") ||
            null,
        ],
      ]);
      for (const w of p.workflowErrors)
        io.out(`workflow ${cleanLine(w.name)} did not load: ${cleanLine(w.error)}`);
      return EXIT_OK;
    }
    case "consent": {
      const { positionals, ctx } = sub(
        "pack consent",
        argv,
        io,
        {},
        { min: 1, max: 1, usage: "<id>" },
      );
      const c = await ctx
        .api()
        .get<{ consent: ConsentView }>(`/api/packs/${enc(positionals[0] ?? "")}/consent`);
      if (ctx.json) ctx.printJson(c.consent);
      else printConsent(io, c.consent);
      return EXIT_OK;
    }
    case "enable": {
      const { values, positionals, ctx } = sub(
        "pack enable",
        argv,
        io,
        { grant: { type: "string", multiple: true }, yes: { type: "boolean", short: "y" } },
        { min: 1, max: 1, usage: "<id> [--grant SECRET ...] [--yes]" },
      );
      const id = positionals[0] ?? "";
      const { consent } = await ctx
        .api()
        .get<{ consent: ConsentView }>(`/api/packs/${enc(id)}/consent`);
      const grants = values.grant ?? [];
      for (const g of grants) {
        const s = consent.secrets.find((x) => x.name === g);
        if (!s) throw new CliError(`${id} does not ask for a secret named ${g}`, EXIT_USAGE);
        if (!s.grantable) throw new CliError(`${g} cannot be granted to ${id}`, EXIT_USAGE);
      }
      if (!ctx.json || !values.yes) printConsent(ctx.json ? { ...io, out: io.err } : io, consent);
      if (grants.length) io.err(`\nGranting: ${grants.join(", ")}`);
      await confirm(io, `\nEnable ${id}?`, values.yes === true);
      const { pack } = await ctx
        .api()
        .post<{ pack: PackView | null }>(`/api/packs/${enc(id)}/enable`, {
          grants,
          manifestHash: consent.manifestHash,
          entryHash: consent.entryHash,
        });
      if (ctx.json) ctx.printJson(pack);
      else
        io.out(
          `Enabled ${id}: ${pack?.state ?? "unknown"}${pack?.error ? ` (${pack.error})` : ""}, ${
            pack?.tools.length ?? 0
          } tools.`,
        );
      return EXIT_OK;
    }
    case "disable":
    case "reload": {
      const { positionals, ctx } = sub(
        `pack ${name}`,
        argv,
        io,
        {},
        { min: 1, max: 1, usage: "<id>" },
      );
      const id = positionals[0] ?? "";
      const { pack } = await ctx
        .api()
        .post<{ pack: PackView | null }>(`/api/packs/${enc(id)}/${name}`);
      if (ctx.json) ctx.printJson(pack);
      else
        io.out(
          `${name === "disable" ? "Disabled" : "Reloaded"} ${id}: ${pack?.state ?? "unknown"}${
            pack?.error ? ` (${pack.error})` : ""
          }.`,
        );
      return EXIT_OK;
    }
    case "settings": {
      const { values, positionals, ctx } = sub(
        "pack settings",
        argv,
        io,
        { unset: { type: "string", multiple: true } },
        { min: 1, max: 1000, usage: "<id> [key=value | key:=json ...] [--unset key]" },
      );
      const [id = "", ...pairs] = positionals;
      const path = `/api/packs/${enc(id)}/settings`;
      let body: Record<string, unknown>;
      if (pairs.length || values.unset?.length) {
        const patch: Record<string, unknown> = parseAssignments(pairs);
        for (const k of values.unset ?? []) {
          assertSafeKey(k);
          patch[k] = null;
        }
        body = await ctx.api().put(path, { values: patch });
      } else {
        body = await ctx.api().get(path);
      }
      if (ctx.json) {
        ctx.printJson(body);
        return EXIT_OK;
      }
      printSettings(io, body);
      return EXIT_OK;
    }
  }
}

function printSettings(io: CliIo, body: Record<string, unknown>): void {
  const schema = body.schema as {
    properties?: Record<string, { type?: string; title?: string; description?: string }>;
  } | null;
  const vals = (body.values ?? {}) as Record<string, unknown>;
  const props = Object.entries(schema?.properties ?? {});
  if (!props.length) {
    io.out("This pack has no settings.");
    return;
  }
  printTable(
    io,
    ["KEY", "VALUE", "TYPE", "ABOUT"],
    props.map(([key, p]) => [
      key,
      vals[key] === undefined ? "" : JSON.stringify(vals[key]),
      p.type,
      p.title ?? p.description,
    ]),
  );
}

export async function runPack(argv: string[], io: CliIo): Promise<number> {
  const legacy = async (name: "list" | "add" | "remove", args: string[]) => {
    const { values, positionals } = parse(`pack ${name}`, args, { ...COMMON_OPTIONS }, true);
    const env = homeEnv(io, values.home);
    const want = name === "list" ? 0 : 1;
    if (positionals.length < want) {
      throw new CliError(
        name === "add" ? "pack add needs a folder or a git URL" : "pack remove needs a pack id",
        EXIT_USAGE,
      );
    }
    if (positionals.length > want)
      throw new CliError(`too many arguments for "pack ${name}"`, EXIT_USAGE);
    if (name === "list") return list(env, io, values.json === true);
    if (name === "add") return add(positionals[0] ?? "", env, io);
    return remove(positionals[0] ?? "", env, io);
  };
  return runGroup("pack", PACK_HELP, argv, io, {
    list: (a) => legacy("list", a),
    add: (a) => legacy("add", a),
    remove: (a) => legacy("remove", a),
    show: (a) => packSub("show", a, io),
    consent: (a) => packSub("consent", a, io),
    enable: (a) => packSub("enable", a, io),
    disable: (a) => packSub("disable", a, io),
    reload: (a) => packSub("reload", a, io),
    settings: (a) => packSub("settings", a, io),
  });
}
