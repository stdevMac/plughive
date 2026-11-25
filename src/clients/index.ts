// src/clients/index.ts
//
// "Connect a client": writes the MCP server entry for plughive into the
// config file of a local MCP client (Claude Desktop, Claude Code, Cursor,
// Codex CLI, Hermes Agent), and removes it again.
//
// - Only the one entry is touched; the rest of the file stays byte for byte
//   (JSON other keys and their order, TOML/YAML other tables and comments).
// - A file that does not parse is refused, never overwritten.
// - Writes are atomic (temp file + rename, same mode; new files 0600), and
//   one timestamped backup is made before the first change to a file.
// - Connecting twice with the same options changes nothing.
// - Symlinks are followed only while they stay inside the home directory.
// - The access key goes in a header field (or an env var the client turns
//   into a header), never in the URL.
// - Every path derives from the injected home and env, so tests never touch
//   the real home.
//
// Not exposed over HTTP: the menu-bar app and the CLI call it in-process.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClientConfigError, ConfigParseError } from "./errors.js";
import { backupOnce, readIfExists, resolveTarget, restrictMode, writeAtomic } from "./fs-safe.js";

/**
 * The exact mcp-remote release the Claude Desktop entry runs. Pinned so npx
 * never silently fetches a newer (or hijacked) release into a process that is
 * handed the access key; bump it deliberately after reviewing the release.
 * Shipping a bundled bridge instead of npx is future work.
 */
export const MCP_REMOTE_VERSION = "0.16.7";
export const MCP_REMOTE_PACKAGE = `mcp-remote@${MCP_REMOTE_VERSION}`;
import {
  assertJsonObject,
  getJsonEntry,
  getJsonSection,
  removeJsonEntry,
  setJsonEntry,
} from "./json-edit.js";
import {
  getTomlEntry,
  getTomlSection,
  parseToml,
  removeTomlEntry,
  setTomlEntry,
} from "./toml-edit.js";
import { getYamlSection, hasYamlEntry, removeYamlEntry, setYamlEntry } from "./yaml-edit.js";

export { ClientConfigError, ConfigParseError } from "./errors.js";

export type ClientId = "claude-desktop" | "claude-code" | "cursor" | "codex" | "hermes";

export const CLIENT_IDS: readonly ClientId[] = [
  "claude-desktop",
  "claude-code",
  "cursor",
  "codex",
  "hermes",
];

/** Where to look. Everything defaults to the real environment; tests pass a temp home. */
export interface ClientEnv {
  home?: string;
  /** Environment variables consulted (CLAUDE_CONFIG_DIR, CODEX_HOME, HERMES_HOME, APPDATA). */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Folders searched for installed .app bundles (macOS). Defaults to /Applications and ~/Applications. */
  applicationsDirs?: string[];
}

export interface ClientInfo {
  id: ClientId;
  name: string;
  configPath: string;
  installed: boolean;
  connected: boolean;
  /** The URL the existing entry points at, when connected and readable. */
  url?: string;
  /** What the user does after a change so the client picks it up. */
  restartHint: string;
  /** Set when the config file exists but could not be read or parsed. */
  error?: string;
}

export interface ConnectOptions extends ClientEnv {
  /** The daemon's MCP endpoint, e.g. http://127.0.0.1:7777/mcp. */
  url: string;
  /** Server name in the client config. Default "plughive". */
  name?: string;
  /** Sent as `Authorization: Bearer <key>` when the daemon requires one. */
  accessKey?: string;
}

export interface DisconnectOptions extends ClientEnv {
  name?: string;
}

export interface ConnectPlan {
  path: string;
  before: string | null;
  after: string;
  note?: string;
}

export interface ConnectResult {
  path: string;
  backupPath?: string;
  changed: boolean;
}

type Format = "json" | "toml" | "yaml";

interface ClientDef {
  id: ClientId;
  name: string;
  format: Format;
  /** Top-level key (JSON/YAML) or table (TOML) holding the servers. */
  section: string;
  configPath(c: Ctx): string;
  installed(c: Ctx): boolean;
  entry(
    url: string,
    accessKey: string | undefined,
    platform?: NodeJS.Platform,
  ): Record<string, unknown>;
  /** The URL an existing entry points at. */
  entryUrl(entry: unknown): string | undefined;
  restartHint: string;
  note?(url: string, accessKey: string | undefined): string | undefined;
}

interface Ctx {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  applicationsDirs: string[];
}

const DEFAULT_NAME = "plughive";
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Names that are property names of Object.prototype: a server under one of
 * them would not be stored as a plain key of the client's config object.
 */
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function ctx(e: ClientEnv = {}): Ctx {
  const home = e.home ?? homedir();
  return {
    home,
    env: e.env ?? process.env,
    platform: e.platform ?? process.platform,
    applicationsDirs: e.applicationsDirs ?? ["/Applications", join(home, "Applications")],
  };
}

function hasApp(c: Ctx, bundle: string): boolean {
  return c.platform === "darwin" && c.applicationsDirs.some((d) => existsSync(join(d, bundle)));
}

function bearer(key: string | undefined): Record<string, string> | undefined {
  return key ? { Authorization: `Bearer ${key}` } : undefined;
}

function field(entry: unknown, key: string): unknown {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)[key]
    : undefined;
}

function urlField(entry: unknown): string | undefined {
  const u = field(entry, "url");
  return typeof u === "string" ? u : undefined;
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

const CLIENTS: Record<ClientId, ClientDef> = {
  "claude-desktop": {
    id: "claude-desktop",
    name: "Claude Desktop",
    format: "json",
    section: "mcpServers",
    configPath(c) {
      if (c.platform === "win32") {
        return join(
          c.env.APPDATA ?? join(c.home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        );
      }
      if (c.platform === "darwin") {
        return join(
          c.home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        );
      }
      return join(c.home, ".config", "Claude", "claude_desktop_config.json");
    },
    installed(c) {
      return existsSync(join(this.configPath(c), "..")) || hasApp(c, "Claude.app");
    },
    // Claude Desktop's config file takes local (stdio) servers only, so the
    // entry runs the mcp-remote bridge, which forwards stdio to the URL. The
    // header value sits in an env var because Claude Desktop mangles spaces
    // inside args on some platforms (mcp-remote's documented workaround).
    entry(url, key, platform = process.platform) {
      const args = ["-y", MCP_REMOTE_PACKAGE, url, "--transport", "http-only"];
      if (url.startsWith("http:") && !isLoopback(url)) args.push("--allow-http");
      if (key) args.push("--header", "Authorization:${AUTH_HEADER}");
      // On Windows npx is npx.cmd, which Claude Desktop can only start through
      // cmd, and cmd re-parses its arguments: refuse a URL it would interpret.
      // (The key travels in the env var, never on the command line.)
      if (platform === "win32" && /[&|<>^%"!();,\s]/.test(url))
        throw new ClientConfigError(
          'on Windows the MCP URL for Claude Desktop must not contain & | < > ^ % " ! ( ) ; , or spaces',
        );
      const launch =
        platform === "win32"
          ? { command: "cmd", args: ["/c", "npx", ...args] }
          : { command: "npx", args };
      return key ? { ...launch, env: { AUTH_HEADER: `Bearer ${key}` } } : launch;
    },
    entryUrl(entry) {
      const args = field(entry, "args");
      if (!Array.isArray(args)) return urlField(entry);
      // The pinned form, any other pin, or the unpinned entry older versions wrote.
      const i = args.findIndex(
        (a) => typeof a === "string" && (a === "mcp-remote" || a.startsWith("mcp-remote@")),
      );
      const u = i >= 0 ? args[i + 1] : undefined;
      return typeof u === "string" ? u : undefined;
    },
    restartHint: "Quit Claude Desktop completely and open it again.",
    note() {
      return `Claude Desktop only starts local servers from this file, so the entry runs the mcp-remote bridge (npx ${MCP_REMOTE_PACKAGE}, pinned), which forwards to the URL. It needs Node.js with npx on the PATH Claude Desktop sees, and npx downloads that exact version the first time.`;
    },
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    format: "json",
    section: "mcpServers",
    configPath(c) {
      const dir = c.env.CLAUDE_CONFIG_DIR;
      return dir ? join(dir, ".claude.json") : join(c.home, ".claude.json");
    },
    installed(c) {
      return existsSync(this.configPath(c)) || existsSync(join(c.home, ".claude"));
    },
    entry(url, key) {
      const headers = bearer(key);
      return headers ? { type: "http", url, headers } : { type: "http", url };
    },
    entryUrl: urlField,
    restartHint: "Start a new Claude Code session (or run /mcp in an open one).",
    note() {
      return "Added at user scope, so every project sees it. A running Claude Code session may rewrite this file; reconnect with /mcp.";
    },
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    format: "json",
    section: "mcpServers",
    configPath(c) {
      return join(c.home, ".cursor", "mcp.json");
    },
    installed(c) {
      return existsSync(join(c.home, ".cursor")) || hasApp(c, "Cursor.app");
    },
    entry(url, key) {
      const headers = bearer(key);
      return headers ? { url, headers } : { url };
    },
    entryUrl: urlField,
    restartHint: "Restart Cursor, or turn the server off and on in Cursor Settings > MCP.",
  },
  codex: {
    id: "codex",
    name: "Codex CLI",
    format: "toml",
    section: "mcp_servers",
    configPath(c) {
      return join(c.env.CODEX_HOME ?? join(c.home, ".codex"), "config.toml");
    },
    installed(c) {
      return existsSync(c.env.CODEX_HOME ?? join(c.home, ".codex"));
    },
    entry(url, key) {
      const headers = bearer(key);
      return headers ? { url, http_headers: headers } : { url };
    },
    entryUrl: urlField,
    restartHint: "Start a new Codex session.",
  },
  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    format: "yaml",
    section: "mcp_servers",
    configPath(c) {
      return join(c.env.HERMES_HOME ?? join(c.home, ".hermes"), "config.yaml");
    },
    installed(c) {
      return existsSync(c.env.HERMES_HOME ?? join(c.home, ".hermes"));
    },
    entry(url, key) {
      const headers = bearer(key);
      return headers ? { url, headers } : { url };
    },
    entryUrl: urlField,
    restartHint: "Run /reload-mcp in Hermes, or restart it.",
  },
};

function def(id: string): ClientDef {
  const d = (CLIENTS as Record<string, ClientDef | undefined>)[id];
  if (!d)
    throw new ClientConfigError(
      `unknown client "${id}" (expected one of ${CLIENT_IDS.join(", ")})`,
    );
  return d;
}

function checkName(name: string): string {
  if (RESERVED_NAMES.has(name.toLowerCase()))
    throw new ClientConfigError(
      `invalid server name "${name}" (that name is reserved; choose another one)`,
    );
  if (!NAME_RE.test(name))
    throw new ClientConfigError(`invalid server name "${name}" (letters, digits, _ and - only)`);
  return name;
}

function checkUrl(url: string): string {
  // new URL() trims and drops tabs and newlines; the raw string is what is
  // written into the client's file and argv, so it must not carry any.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rejects
  if (/[\s\x00-\x1f\x7f]/.test(url))
    throw new ClientConfigError("the MCP URL must not contain spaces or control characters");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ClientConfigError("the MCP URL is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new ClientConfigError("the MCP URL must be http or https");
  if (u.username || u.password)
    throw new ClientConfigError("the MCP URL must not carry credentials");
  return url;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every(
      (k) =>
        Object.hasOwn(b as object, k) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}

/** Parse-check the whole file; throws ConfigParseError when it is not valid. */
function validate(format: Format, text: string): void {
  if (format === "json") assertJsonObject(text);
  else if (format === "toml") parseToml(text);
  else getYamlSection(text, "\u0000"); // structural check of the whole document
}

function readEntry(d: ClientDef, text: string, name: string): { present: boolean; value: unknown } {
  if (d.format === "json") {
    const v = getJsonEntry(text, d.section, name);
    return { present: v !== undefined, value: v };
  }
  if (d.format === "toml") {
    const v = getTomlEntry(text, d.section, name);
    return { present: v !== undefined, value: v };
  }
  return {
    present: hasYamlEntry(text, d.section, name),
    value: getYamlSection(text, d.section)[name],
  };
}

function writeEntry(
  d: ClientDef,
  text: string,
  name: string,
  entry: Record<string, unknown>,
): string {
  if (d.format === "json") return setJsonEntry(text, d.section, name, entry);
  if (d.format === "toml")
    return setTomlEntry(text, d.section, name, entry as Parameters<typeof setTomlEntry>[3]);
  return setYamlEntry(text, d.section, name, entry);
}

function dropEntry(d: ClientDef, text: string, name: string): string {
  if (d.format === "json") return removeJsonEntry(text, d.section, name);
  if (d.format === "toml") return removeTomlEntry(text, d.section, name);
  return removeYamlEntry(text, d.section, name);
}

/** Every supported client, with whether it looks installed and already has the entry. */
export function listClients(e: ClientEnv & { name?: string } = {}): ClientInfo[] {
  const c = ctx(e);
  const name = checkName(e.name ?? DEFAULT_NAME);
  return CLIENT_IDS.map((id) => {
    const d = CLIENTS[id];
    const configPath = d.configPath(c);
    const info: ClientInfo = {
      id,
      name: d.name,
      configPath,
      installed: d.installed(c),
      connected: false,
      restartHint: d.restartHint,
    };
    try {
      const target = resolveTarget(configPath, c.home);
      const text = readIfExists(target);
      if (text !== null) {
        validate(d.format, text);
        const { present, value } = readEntry(d, text, name);
        info.connected = present;
        const url = present ? d.entryUrl(value) : undefined;
        if (url) info.url = url;
      }
    } catch (err) {
      info.error = (err as Error).message;
    }
    return info;
  });
}

/** What connecting would write. Pure: reads the file, writes nothing. */
export function planConnect(
  id: ClientId,
  opts: ConnectOptions,
): ConnectPlan & { changed: boolean; target: string } {
  const d = def(id);
  const c = ctx(opts);
  const name = checkName(opts.name ?? DEFAULT_NAME);
  const url = checkUrl(opts.url);
  const path = d.configPath(c);
  const target = resolveTarget(path, c.home);
  const before = readIfExists(target);
  const text = before ?? "";
  validate(d.format, text);
  const entry = d.entry(url, opts.accessKey || undefined, c.platform);
  const current = readEntry(d, text, name);
  const same = current.present && deepEqual(current.value, entry);
  const after = same ? text : writeEntry(d, text, name, entry);
  // The result must still parse; a bug here must never reach the user's file.
  validate(d.format, after);
  const note = d.note?.(url, opts.accessKey);
  return {
    path,
    before,
    after,
    ...(note ? { note } : {}),
    changed: before === null || after !== before,
    target,
  };
}

/** Write the entry. Idempotent: an identical entry leaves the file alone. */
export function connectClient(id: ClientId, opts: ConnectOptions): ConnectResult {
  const plan = planConnect(id, opts);
  // The entry carries the access key: the file must be owner-only (M4), even
  // when the entry is already there and nothing else changes.
  const secret = Boolean(opts.accessKey);
  if (plan.before !== null && plan.after === plan.before) {
    if (secret) restrictMode(plan.target);
    return { path: plan.path, changed: false };
  }
  const backupPath = backupOnce(plan.target);
  writeAtomic(plan.target, plan.after, { secret });
  return { path: plan.path, ...(backupPath ? { backupPath } : {}), changed: true };
}

/** Remove the entry. A missing file or entry is not an error. */
export function disconnectClient(id: ClientId, opts: DisconnectOptions = {}): ConnectResult {
  const d = def(id);
  const c = ctx(opts);
  const name = checkName(opts.name ?? DEFAULT_NAME);
  const path = d.configPath(c);
  const target = resolveTarget(path, c.home);
  const before = readIfExists(target);
  if (before === null) return { path, changed: false };
  validate(d.format, before);
  if (!readEntry(d, before, name).present) return { path, changed: false };
  const after = dropEntry(d, before, name);
  validate(d.format, after);
  if (after === before) return { path, changed: false };
  const backupPath = backupOnce(target);
  writeAtomic(target, after);
  return { path, ...(backupPath ? { backupPath } : {}), changed: true };
}

/** The restart hint for one client. */
export function restartHint(id: ClientId): string {
  return def(id).restartHint;
}

// Kept for callers that want the raw section (e.g. to list every server).
export function readServers(id: ClientId, e: ClientEnv = {}): Record<string, unknown> {
  const d = def(id);
  const c = ctx(e);
  const text = readIfExists(resolveTarget(d.configPath(c), c.home));
  if (text === null) return {};
  if (d.format === "json") return getJsonSection(text, d.section);
  if (d.format === "toml") return getTomlSection(text, d.section);
  return getYamlSection(text, d.section);
}
