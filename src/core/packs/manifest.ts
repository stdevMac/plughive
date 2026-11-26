// src/core/packs/manifest.ts
//
// Strict schema for a pack's `pack.json`. Unknown keys are errors (a typo in a
// permission name must not silently grant or drop anything). Every message is
// written for the pack author: it names the field and says what is expected.
import { z } from "zod";
import { isLoopbackHost } from "../../lib/access-key.js";
import { SECRET_NAME_PATTERN } from "../secrets/index.js";
import { PACK_API_VERSION } from "./api-version.js";

export { PACK_API_VERSION };

/** Where a pack comes from. Decides how much it is trusted. */
export type PackSource = "builtin" | "user";

/**
 * Pack ids a USER pack may not take: they name daemon-internal packs, or are
 * property names of Object.prototype (ids are used as keys of plain objects).
 */
export const RESERVED_PACK_IDS: ReadonlySet<string> = new Set([
  "gateway",
  "user",
  "core",
  "plughive",
  "system",
  "internal",
  "builtin",
  "daemon",
  "constructor",
  "prototype",
  "tostring",
  "valueof",
  "hasownproperty",
]);

export function isReservedPackId(id: string): boolean {
  const lower = String(id).toLowerCase();
  return RESERVED_PACK_IDS.has(lower) || lower in Object.prototype || id in Object.prototype;
}

const DENIED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TERM",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "IFS",
  "ENV",
  "BASH_ENV",
  "HOSTNAME",
  "DISPLAY",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  // Credentials of other tools the daemon may have inherited from the user's
  // shell. No pack needs them under these names; a pack that talks to one of
  // these services declares a name of its own (GITHUB_MCP_PAT, ...).
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "HOMEBREW_GITHUB_API_TOKEN",
  "GITLAB_TOKEN",
  "CI_JOB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG",
  "DOCKER_AUTH_CONFIG",
  "VAULT_TOKEN",
  "PGPASSWORD",
  "MYSQL_PWD",
]);
const DENIED_SECRET_PREFIXES = [
  "PLUGHIVE_",
  "LD_",
  "DYLD_",
  "NODE_",
  "NPM_",
  "XDG_",
  "LC_",
  "AWS_",
  "SSH_",
  "AZURE_",
  "CLOUDSDK_",
  "GCLOUD_",
  // The daemon's own sign-ins to OAuth mounts (tokens, client registration).
  "OAUTH_",
];

/**
 * Keys of the model providers the user's other tools use. A bundled pack may
 * declare one; a user pack may not (it would ask for "the key you already
 * have" under its own label).
 */
const BUNDLED_ONLY_SECRET_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_ADMIN_KEY",
]);

/** True when only a pack shipped with plughive may declare `name`. */
export function isBundledOnlySecretName(name: unknown): boolean {
  return typeof name === "string" && BUNDLED_ONLY_SECRET_NAMES.has(name.toUpperCase());
}

/** May a pack of this source read a secret of this name at all? */
export function secretNameAllowed(name: unknown, source: PackSource): boolean {
  if (isDeniedSecretName(name)) return false;
  return source === "builtin" || !isBundledOnlySecretName(name);
}

/**
 * Names no pack (built-in or user) may declare as a secret: the daemon's own
 * configuration (PLUGHIVE_*, which includes its access key), process
 * environment that is not a credential (PATH, HOME, NODE_OPTIONS, LD_*, ...)
 * and well-known credentials of other tools (AWS_*, SSH_*, GITHUB_TOKEN,
 * GH_TOKEN, NPM_*, GOOGLE_APPLICATION_CREDENTIALS, ...).
 * Checked when the manifest is parsed and again when a secret is requested.
 */
export function isDeniedSecretName(name: unknown): boolean {
  if (typeof name !== "string") return true;
  const upper = name.toUpperCase();
  return DENIED_SECRET_NAMES.has(upper) || DENIED_SECRET_PREFIXES.some((p) => upper.startsWith(p));
}

const HIGH_RISK_BINARIES =
  /^(sh|bash|zsh|fish|dash|ksh|csh|tcsh|pwsh|powershell|cmd|node|nodejs|deno|bun|tsx|python[0-9.]*|pypy[0-9.]*|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|lua[0-9.]*|osascript|env|sudo|su|doas|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|curl|wget|xargs|find|awk|gawk|sed|make|git|docker|podman|kubectl|launchctl|systemctl|open|xdg-open|npm|npx|pnpm|yarn|pip[0-9.]*|uv|uvx|brew|winget|apt|apt-get|dpkg|choco|scoop|pipx|conda|mamba|nohup|timeout|script|expect|tmux|screen)$/i;

/**
 * Shells, interpreters and remote-access tools. A pack that may spawn one of
 * these can run arbitrary code, so the consent screen flags it as high risk.
 */
export function isHighRiskBinary(name: string): boolean {
  return HIGH_RISK_BINARIES.test(name);
}

/** Pack ids: lowercase, start with a letter, 2-32 chars. Also the folder name. */
export const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Valid MCP tool names (letters, digits, `_`, `-`, `.`; 1-128 chars). Pack
 * tools may not contain `__`: that separator is reserved for mounted tools
 * (`<prefix>__<tool>`), so a pack can never shadow a mount's namespace.
 */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export function toolNameProblem(name: string): string | null {
  if (!TOOL_NAME_PATTERN.test(name)) {
    return `tool name "${name}" is not a valid MCP tool name (use letters, digits, "_", "-" or ".", at most 128 chars)`;
  }
  if (name.includes("__")) {
    return `tool name "${name}" contains "__", which is reserved for mounted tools`;
  }
  return null;
}

// "*", "api.example.com", "*.example.com", optionally ":port".
const HOST_PATTERN =
  /^(\*|(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?)$/i;
// "127.0.0.1:11434", "localhost:8188", "[::1]:3000". A port is mandatory.
const LOCAL_PATTERN = /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\]):\d{1,5}$/i;
// A bare executable name, looked up on the daemon's PATH. No slashes, no shell
// syntax, and it cannot start with "." or "-" (so "." and ".." are rejected).
const BINARY_PATTERN = /^[A-Za-z0-9_+][A-Za-z0-9._+-]{0,63}$/;
// Tool permission entries: a tool name, "pack:<id>" or "cap:<name>".
const TOOL_REF_PATTERN =
  /^((pack:[a-z][a-z0-9-]{1,31})|(cap:[a-z0-9][a-z0-9_.-]{0,63})|[A-Za-z0-9_.-]{1,128})$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
export const SECRET_REF_PATTERN = /\$\{secret:([^}]*)\}/g;

/** A path inside the pack folder: relative, no "..", no NUL, no backslashes. */
const relativePath = (what: string) =>
  z
    .string({ error: `${what} must be a string` })
    .min(1, `${what} must not be empty`)
    .refine(
      (p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p),
      `${what} must be a relative path inside the pack folder`,
    )
    .refine((p) => !p.split(/[\\/]/).includes(".."), `${what} must not contain ".." segments`)
    .refine((p) => !p.includes("\0") && !p.includes("\\"), `${what} contains invalid characters`);

const httpUrl = (what: string) =>
  z.url({ protocol: /^https?$/, error: `${what} must be an http(s) URL` });

// Header names that carry a credential even when the value is written out
// literally instead of as a ${secret:NAME} reference (same rule as user
// mounts, src/core/mounts/user-mounts.ts).
const CREDENTIAL_HEADER =
  /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key)$|token|secret|api[-_]?key|auth/i;

/**
 * Why this pack mount would send a credential in clear text, or null. An
 * http mount whose url is plain `http://` to a host other than this machine
 * may not carry a secret (a `${secret:NAME}` in the url or a header value, or
 * a credential header such as Authorization) and may not be an OAuth mount
 * (the sign-in token would cross the wire unencrypted). Plain http to
 * loopback stays allowed. Same rule as user mounts (plainHttpSecretProblem).
 */
export function packMountPlainHttpProblem(
  m: Pick<MountDecl, "transport" | "url" | "headers" | "auth">,
): string | null {
  if (m.transport !== "http" || !m.url) return null;
  let u: URL;
  try {
    u = new URL(m.url.replace(SECRET_REF_PATTERN, "x"));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" || isLoopbackHost(u.hostname)) return null;
  const where = `plain http:// to ${u.hostname.slice(0, 253)}`;
  const fix = "use an https:// url (plain http is allowed only to this machine)";
  for (const [name, value] of Object.entries(m.headers ?? {})) {
    const refs = [...value.matchAll(SECRET_REF_PATTERN)].length > 0;
    if (refs || CREDENTIAL_HEADER.test(name)) {
      return `the header ${name} carries a secret and would be sent over ${where}; ${fix}`;
    }
  }
  if ([...m.url.matchAll(SECRET_REF_PATTERN)].length > 0) {
    return `the url carries a secret and would be sent over ${where}; ${fix}`;
  }
  if (m.auth === "oauth") {
    return `an OAuth mount signs in over ${where} and its token would be sent in clear text; ${fix}`;
  }
  return null;
}

export const SecretDeclSchema = z
  .object({
    name: z
      .string()
      .regex(
        SECRET_NAME_PATTERN,
        "secret name must match ^[A-Z][A-Z0-9_]{1,63}$ (for example EXA_API_KEY)",
      )
      .refine(
        (name) => !isDeniedSecretName(name),
        "this name is reserved (daemon configuration such as PLUGHIVE_*, process environment such as PATH, HOME, NODE_OPTIONS, LD_*, DYLD_*, or another tool's credential such as AWS_*, SSH_*, GITHUB_TOKEN, NPM_TOKEN) and can never be a pack secret",
      ),
    label: z.string().min(1, "secret label must not be empty").max(120).optional(),
    helpUrl: httpUrl("secret helpUrl").optional(),
    required: z.boolean().default(true),
  })
  .strict();

export const PermissionsSchema = z
  .object({
    network: z
      .array(
        z
          .string()
          .regex(
            HOST_PATTERN,
            'network entries are host patterns: "api.example.com", "*.example.com", "host:port" or "*"',
          ),
      )
      .default([]),
    localNetwork: z
      .array(
        z
          .string()
          .regex(
            LOCAL_PATTERN,
            'localNetwork entries are "host:port" (for example "127.0.0.1:11434")',
          ),
      )
      .default([]),
    spawn: z
      .array(
        z
          .string()
          .regex(
            BINARY_PATTERN,
            'spawn entries are bare binary names looked up on PATH (for example "ffmpeg"), no paths or arguments',
          ),
      )
      .default([]),
    library: z
      .enum(["none", "read", "read-all", "write", "full"], {
        error: 'library must be "none", "read", "read-all", "write" or "full"',
      })
      .default("none"),
    llm: z.boolean({ error: "llm must be true or false" }).default(false),
    /**
     * Programs the pack spawns normally get a HOME of their own inside the
     * pack's data folder, so they cannot read or write the user's dotfiles
     * (~/.ssh, ~/.aws, ~/.netrc, ...) through "~". `userHome: true` gives
     * them the user's real HOME instead: for a program whose whole job needs
     * it, such as ssh with the user's keys and known_hosts.
     */
    userHome: z.boolean({ error: "userHome must be true or false" }).default(false),
    tools: z
      .array(
        z
          .string()
          .regex(TOOL_REF_PATTERN, 'tools entries are tool names, "pack:<id>" or "cap:<name>"')
          // "gateway" owns every tool of every mounted server and "core" the
          // daemon's own tools: neither is a pack a manifest can ask for whole.
          .refine((ref) => !ref.startsWith("pack:") || !isReservedPackId(ref.slice(5)), {
            message:
              'tools entries cannot name a reserved pack id (such as "pack:gateway" or "pack:core"); list the tool names instead',
          }),
      )
      .default([]),
  })
  .strict();

/** A list setting holds at most this many strings. */
export const SETTING_LIST_MAX_ITEMS = 256;
/** Each string of a list setting is at most this long. */
export const SETTING_LIST_ITEM_MAX_CHARS = 1024;

const SettingPropertySchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean", "array"], {
      error: 'setting type must be "string", "number", "integer", "boolean" or "array"',
    }),
    /** With type "array" only: the list holds strings, nothing else. */
    items: z
      .object({
        type: z.literal("string", {
          error: 'a list setting holds strings: items.type must be "string"',
        }),
      })
      .strict()
      .optional(),
    description: z.string().optional(),
    title: z.string().optional(),
    default: z
      .union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.string().min(1).max(SETTING_LIST_ITEM_MAX_CHARS)).max(SETTING_LIST_MAX_ITEMS),
      ])
      .optional(),
    enum: z.array(z.union([z.string(), z.number()])).optional(),
    /**
     * "local-endpoint": the value is an http(s) URL of a service on this
     * machine or the LAN (loopback or RFC 1918). Its host:port is added to
     * the pack's localNetwork when the pack loads; the daemon's own port,
     * link-local and metadata addresses are always refused.
     *
     * "folder-list" (type "array"): absolute folders the user lets the pack's
     * child processes work in (ctx.spawn cwd). Checked when the pack loads:
     * each must exist and be a folder; the filesystem root, the home folder
     * itself and anything inside the plughive home are refused.
     */
    format: z
      .enum(["local-endpoint", "folder-list"], {
        error: 'setting format must be "local-endpoint" or "folder-list"',
      })
      .optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.format === "local-endpoint" && p.type !== "string") {
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: 'a setting with format "local-endpoint" must have type "string"',
      });
    }
    if (p.format === "folder-list" && p.type !== "array") {
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: 'a setting with format "folder-list" must have type "array"',
      });
    }
    if (p.type === "array") {
      if (!p.items) {
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: 'a setting with type "array" needs items: {"type": "string"}',
        });
      }
      if (p.enum !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["enum"],
          message: "a list setting cannot have an enum",
        });
      }
      if (p.format === "folder-list" && Array.isArray(p.default) && p.default.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["default"],
          message:
            'a "folder-list" setting cannot have a non-empty default: only the user lists folders',
        });
      }
      if (p.default !== undefined && !Array.isArray(p.default)) {
        ctx.addIssue({
          code: "custom",
          path: ["default"],
          message: "the default of a list setting must be a list of strings",
        });
      }
    } else {
      if (p.items !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: 'items is only for type "array"',
        });
      }
      if (Array.isArray(p.default)) {
        ctx.addIssue({
          code: "custom",
          path: ["default"],
          message: 'a list default is only for type "array"',
        });
      }
    }
  });

/**
 * JSON Schema (object of scalar properties, or lists of strings) for the
 * pack's non-secret settings.
 */
export const SettingsSchema = z
  .object({
    type: z.literal("object", { error: 'settings must be a JSON Schema with type "object"' }),
    properties: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "setting names must be identifiers"),
        SettingPropertySchema,
      )
      .default({}),
    required: z.array(z.string()).optional(),
  })
  .strict();

export const MountDeclSchema = z
  .object({
    id: z.string().regex(PACK_ID_PATTERN, "mount id must match ^[a-z][a-z0-9-]{1,31}$"),
    name: z.string().min(1),
    transport: z.enum(["http", "stdio"], { error: 'mount transport must be "http" or "stdio"' }),
    url: httpUrl("mount url").optional(),
    command: z
      .string()
      .regex(BINARY_PATTERN, "mount command must be a bare binary name")
      .optional(),
    args: z.array(z.string()).optional(),
    // No CR, LF or NUL: a header must stay one header.
    headers: z
      .record(
        z.string().regex(/^[^\r\n\0]+$/, "mount header names must not contain CR, LF or NUL"),
        z.string().regex(/^[^\r\n\0]*$/, "mount header values must not contain CR, LF or NUL"),
      )
      .optional(),
    env: z.record(z.string(), z.string()).optional(),
    prefix: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/, "mount prefix must match ^[a-z][a-z0-9_-]{0,31}$"),
    enabledByDefault: z.boolean().default(false),
    docsUrl: httpUrl("mount docsUrl").optional(),
    /** One line on what the server offers (shown in listMounts). */
    description: z.string().min(1).max(500).optional(),
    /**
     * How the server authenticates. An "oauth" server is switched on once the
     * user signs in to it from the dashboard (MCP OAuth with dynamic client
     * registration; the daemon keeps the tokens in its secret store).
     */
    auth: z
      .enum(["none", "header", "query", "oauth"], {
        error: 'mount auth must be "none", "header", "query" or "oauth"',
      })
      .optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.auth === "oauth" && m.enabledByDefault) {
      ctx.addIssue({
        code: "custom",
        path: ["enabledByDefault"],
        message:
          "an oauth mount cannot be enabled by default (the user has to sign in to it first)",
      });
    }
    if (m.transport === "http" && !m.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "an http mount needs a url" });
    }
    if (m.transport === "stdio" && !m.command) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "a stdio mount needs a command" });
    }
    const insecure = packMountPlainHttpProblem(m);
    if (insecure) {
      ctx.addIssue({ code: "custom", path: ["url"], message: insecure });
    }
  });

export const PackManifestSchema = z
  .object({
    id: z
      .string({ error: "id is required" })
      .regex(
        PACK_ID_PATTERN,
        "id must match ^[a-z][a-z0-9-]{1,31}$ (lowercase letters, digits and dashes, starting with a letter)",
      ),
    name: z.string({ error: "name is required" }).min(1, "name must not be empty").max(80),
    version: z
      .string({ error: "version is required" })
      .regex(SEMVER_PATTERN, 'version must be semver, for example "0.1.0"'),
    apiVersion: z
      .number({ error: "apiVersion is required (a whole number)" })
      .int("apiVersion must be a whole number")
      .min(1, "apiVersion must be at least 1")
      .max(
        PACK_API_VERSION,
        `apiVersion must be at most ${PACK_API_VERSION} (this daemon implements pack API v${PACK_API_VERSION})`,
      ),
    entry: relativePath("entry").optional(),
    description: z.string().max(500).optional(),
    /**
     * Terms or caveats the user should read before turning the pack on (a
     * third party's terms of use, a cheaper or safer alternative). Shown on
     * the pack's card in the dashboard. Plain text.
     */
    notice: z.string().min(1).max(2000).optional(),
    /**
     * Bundled packs only: `false` ships the pack switched off until the user
     * turns it on. A user pack is always off until it is reviewed.
     */
    enabledByDefault: z.boolean().optional(),
    secrets: z.array(SecretDeclSchema).default([]),
    permissions: PermissionsSchema.default({
      network: [],
      localNetwork: [],
      spawn: [],
      library: "none",
      llm: false,
      userHome: false,
      tools: [],
    }),
    settings: SettingsSchema.optional(),
    mounts: z.array(MountDeclSchema).default([]),
    skills: relativePath("skills").optional(),
    workflows: relativePath("workflows").optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.secrets.forEach((s, i) => {
      if (seen.has(s.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["secrets", i, "name"],
          message: `secret ${s.name} is declared twice`,
        });
      }
      seen.add(s.name);
    });
    // `${secret:NAME}` in a mount may only reference this pack's own secrets.
    m.mounts.forEach((mount, i) => {
      const values = [
        mount.url ?? "",
        ...Object.keys(mount.headers ?? {}),
        ...Object.keys(mount.env ?? {}),
        ...Object.values(mount.headers ?? {}),
        ...Object.values(mount.env ?? {}),
        ...(mount.args ?? []),
      ];
      for (const value of values) {
        for (const match of value.matchAll(SECRET_REF_PATTERN)) {
          const ref = match[1] ?? "";
          if (!seen.has(ref)) {
            ctx.addIssue({
              code: "custom",
              path: ["mounts", i],
              message: `mount "${mount.id}" references \${secret:${ref}}, which is not declared in secrets`,
            });
          }
        }
      }
    });
    const mountIds = new Set<string>();
    m.mounts.forEach((mount, i) => {
      if (mountIds.has(mount.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["mounts", i, "id"],
          message: `mount id "${mount.id}" is declared twice`,
        });
      }
      mountIds.add(mount.id);
    });
    for (const name of m.settings?.required ?? []) {
      if (!m.settings?.properties[name]) {
        ctx.addIssue({
          code: "custom",
          path: ["settings", "required"],
          message: `required setting "${name}" has no property`,
        });
      }
    }
  });

export type PackManifest = z.output<typeof PackManifestSchema>;
export type PackManifestInput = z.input<typeof PackManifestSchema>;
export type SecretDecl = z.output<typeof SecretDeclSchema>;
export type PackPermissions = z.output<typeof PermissionsSchema>;
export type MountDecl = z.output<typeof MountDeclSchema>;

export class ManifestError extends Error {
  readonly code = "INVALID_MANIFEST" as const;
  readonly issues: string[];
  constructor(source: string, issues: string[]) {
    super(`Invalid pack manifest ${source}:\n  - ${issues.join("\n  - ")}`);
    this.name = "ManifestError";
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    if (issue.code === "unrecognized_keys") {
      return `${path}: unknown field(s) ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
    }
    return `${path}: ${issue.message}`;
  });
}

export interface ParseManifestOptions {
  /** Shown in errors, usually the pack.json path. */
  source?: string;
  /** When given, the manifest id must equal the pack folder name. */
  folderName?: string;
  /**
   * "user" applies the rules for packs from $PLUGHIVE_HOME/packs: reserved
   * ids are rejected and no mount may be enabled by default.
   */
  packSource?: PackSource;
}

/** Validate a parsed pack.json value. Throws ManifestError with readable issues. */
export function parseManifest(raw: unknown, options: ParseManifestOptions = {}): PackManifest {
  const source = options.source ?? "pack.json";
  const parsed = PackManifestSchema.safeParse(raw);
  if (!parsed.success) throw new ManifestError(source, formatIssues(parsed.error));
  if (options.folderName !== undefined && parsed.data.id !== options.folderName) {
    throw new ManifestError(source, [
      `id: "${parsed.data.id}" must equal the pack folder name "${options.folderName}"`,
    ]);
  }
  if (parsed.data.id in Object.prototype) {
    throw new ManifestError(source, [`id: "${parsed.data.id}" is reserved`]);
  }
  if (options.packSource === "user") {
    if (isReservedPackId(parsed.data.id)) {
      throw new ManifestError(source, [
        `id: "${parsed.data.id}" is reserved for the daemon; choose another pack id`,
      ]);
    }
    // A user pack can never switch a mount on by itself.
    for (const mount of parsed.data.mounts) mount.enabledByDefault = false;
  }
  return parsed.data;
}

/** Parse pack.json text (JSON syntax errors become ManifestError too). */
export function parseManifestText(text: string, options: ParseManifestOptions = {}): PackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ManifestError(options.source ?? "pack.json", [
      `(root): not valid JSON (${(e as Error).message})`,
    ]);
  }
  return parseManifest(raw, options);
}
