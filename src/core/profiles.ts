// src/core/profiles.ts
//
// Exposure profiles: which tools an MCP endpoint shows and how.
//
//   /mcp          serves the "default" profile
//   /p/<id>/mcp   serves the profile <id>
//
// A profile selects tools (include minus exclude) and picks a mode:
//   list    every selected tool is in tools/list
//   search  tools/list holds only search_tools / describe_tool / execute_tool
//           (plus pinned tools); the rest is reached through execute_tool
//   auto    list while the selection is small, search once it passes a threshold
//
// `resolveExposure` is pure and is the single source of the tools/list payload:
// the MCP endpoint and GET /api/profiles/:id/preview both call it.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicReplaceSync } from "../lib/platform.js";
import { JOB_TOOLS, META_TOOLS } from "./mcp/meta.js";
import type { ToolAnnotations } from "./pack-api.js";
import type { RegisteredTool } from "./tools/registry.js";

export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const DEFAULT_PROFILE_ID = "default";
export const MAX_PROFILES = 64;
export const DEFAULT_AUTO_THRESHOLD_TOKENS = 8000;
export const DEFAULT_AUTO_THRESHOLD_TOOLS = 40;

/** "*", or "<kind>:<value>" where value may be "*". */
const SELECTOR_PATTERN =
  /^(\*|(pack|tool|mount|capability|workflow|tag):(\*|[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}))$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const Selector = z
  .string()
  .regex(
    SELECTOR_PATTERN,
    'must be "*" or "<kind>:<value>" with kind pack, tool, mount, capability, workflow or tag',
  );

export const ProfileSchema = z
  .object({
    id: z.string().regex(PROFILE_ID_PATTERN, "must match ^[a-z][a-z0-9-]{1,31}$"),
    name: z.string().trim().min(1).max(64),
    mode: z.enum(["list", "search", "auto"]).default("auto"),
    include: z.array(Selector).max(256).default(["*"]),
    exclude: z.array(Selector).max(256).default([]),
    /** Tools that stay in tools/list next to the search tools. */
    pinned: z.array(z.string().regex(TOOL_NAME_PATTERN)).max(64).default([]),
    /** auto: switch to search above this estimated tools/list size. */
    autoThresholdTokens: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(DEFAULT_AUTO_THRESHOLD_TOKENS),
    /** auto: switch to search above this many tools. */
    autoThresholdTools: z.number().int().min(1).max(10_000).default(DEFAULT_AUTO_THRESHOLD_TOOLS),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileInput = z.input<typeof ProfileSchema>;

/** The file envelope. Entries are validated one by one, so one bad entry does not cost the rest. */
const FileSchema = z.object({ version: z.literal(1), profiles: z.array(z.unknown()) });

/**
 * The small core set the default profile keeps in tools/list next to the
 * search tools once the catalog is large enough for search mode. A name that
 * no loaded pack provides is skipped silently.
 */
export const DEFAULT_PINNED_TOOLS: readonly string[] = [
  "generate_image",
  "generate_video",
  "generate_speech",
  "generate_music",
  "list_artifacts",
  "get_job_status",
];

export function defaultProfile(): Profile {
  return ProfileSchema.parse({
    id: DEFAULT_PROFILE_ID,
    name: "Default",
    pinned: [...DEFAULT_PINNED_TOOLS],
  });
}

/** Everything, always listed. Used when an app is built without a profile store. */
export const LIST_ALL_PROFILE: Profile = Object.freeze({
  ...defaultProfile(),
  mode: "list" as const,
});

// ---------------------------------------------------------------------------
// Exposure
// ---------------------------------------------------------------------------

/** One entry of a tools/list result. */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface ContextCost {
  /** Estimated tokens of the whole tools/list payload (characters / 4). */
  totalTokens: number;
  perTool: Array<{ name: string; tokens: number }>;
}

export interface Exposure {
  profileId: string;
  /** The mode in effect after resolving `auto`. */
  mode: "list" | "search";
  /** Exactly what tools/list returns. */
  tools: ToolDescriptor[];
  /** Every registry tool this profile can reach, listed or through execute_tool. */
  exposed: RegisteredTool[];
  /** Cost of `tools`. */
  cost: ContextCost;
  /** What listing every exposed tool directly would cost. */
  directTokens: number;
}

export interface ExposureOptions {
  /** A job queue is available, so wait_for_job and cancel_job can be offered. */
  jobs?: boolean;
}

export function toDescriptor(t: RegisteredTool): ToolDescriptor {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  };
}

export function estimateTokens(descriptor: ToolDescriptor): number {
  return Math.ceil(JSON.stringify(descriptor).length / 4);
}

function matches(
  selector: string,
  t: Pick<RegisteredTool, "name" | "packId" | "origin" | "tags" | "capability">,
): boolean {
  if (selector === "*") return true;
  const cut = selector.indexOf(":");
  const kind = selector.slice(0, cut);
  const value = selector.slice(cut + 1);
  const any = value === "*";
  switch (kind) {
    case "pack":
      return any || t.packId === value;
    case "tool":
      return any || t.name === value;
    case "mount":
      return t.origin === "mounted" && (any || t.tags.includes(`mount:${value}`));
    case "capability":
      return t.capability !== undefined && (any || t.capability === value);
    case "workflow":
      return any
        ? t.tags.some((tag) => tag.startsWith("workflow:"))
        : t.tags.includes(`workflow:${value}`);
    case "tag":
      return any ? t.tags.length > 0 : t.tags.includes(value);
    default:
      return false;
  }
}

/** Whether a profile's include and exclude selectors let it see a tool. */
export function profileAllows(
  profile: Pick<Profile, "include" | "exclude">,
  t: Pick<RegisteredTool, "name" | "packId" | "origin" | "tags" | "capability">,
): boolean {
  return profile.include.some((s) => matches(s, t)) && !profile.exclude.some((s) => matches(s, t));
}

/** Whether one selector matches a tool. */
export function selectorMatches(
  selector: string,
  t: Pick<RegisteredTool, "name" | "packId" | "origin" | "tags" | "capability">,
): boolean {
  return matches(selector, t);
}

function costOf(tools: readonly ToolDescriptor[]): ContextCost {
  const perTool = tools.map((t) => ({ name: t.name, tokens: estimateTokens(t) }));
  return { perTool, totalTokens: perTool.reduce((sum, t) => sum + t.tokens, 0) };
}

/** Pure: the tools/list payload and its context cost for one profile. */
export function resolveExposure(
  profile: Profile,
  registry: { list(): RegisteredTool[] },
  opts: ExposureOptions = {},
): Exposure {
  const exposed = registry
    .list()
    .filter(
      (t) =>
        profile.include.some((s) => matches(s, t)) && !profile.exclude.some((s) => matches(s, t)),
    );
  const direct = exposed.map(toDescriptor);
  const directTokens = costOf(direct).totalTokens;

  const mode =
    profile.mode === "auto"
      ? exposed.length > profile.autoThresholdTools || directTokens > profile.autoThresholdTokens
        ? "search"
        : "list"
      : profile.mode;

  // The job tools are only worth their tokens when something exposed produces
  // jobs. They stay callable either way (the protocol layer serves them);
  // excluding "tool:wait_for_job" or "tool:cancel_job" only unlists them.
  const producesJobs = exposed.some((t) => t.longRunning || t.name === "get_job_status");
  const core =
    opts.jobs && producesJobs
      ? JOB_TOOLS.filter((t) => !profile.exclude.some((s) => s === `tool:${t.name}`))
      : [];

  let tools: ToolDescriptor[];
  if (mode === "list") {
    tools = [...direct, ...core];
  } else {
    const byName = new Map(exposed.map((t) => [t.name, t]));
    const pinned = [...new Set(profile.pinned)]
      .map((name) => byName.get(name))
      .filter((t): t is RegisteredTool => t !== undefined)
      .map(toDescriptor);
    tools = [...META_TOOLS, ...pinned, ...core];
  }
  return { profileId: profile.id, mode, tools, exposed, cost: costOf(tools), directTokens };
}

/**
 * Pure: whether a profile exposes the pack `packId`, the test for reaching its
 * capability providers. True when at least one of the pack's tools is exposed.
 * A pack without tools is matched by the selectors that name a pack ("*" and
 * "pack:<id>"), minus the excludes of the same kinds.
 */
export function profileExposesPack(
  profile: Profile,
  registry: { list(): RegisteredTool[] },
  packId: string,
): boolean {
  const own = registry.list().filter((t) => t.packId === packId);
  if (own.length > 0) {
    return own.some(
      (t) =>
        profile.include.some((s) => matches(s, t)) && !profile.exclude.some((s) => matches(s, t)),
    );
  }
  const names = (s: string) => s === "*" || s === "pack:*" || s === `pack:${packId}`;
  return profile.include.some(names) && !profile.exclude.some(names);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ProfileError extends Error {
  constructor(
    readonly code: "INVALID_PROFILE" | "PROFILE_LIMIT" | "PROFILE_PROTECTED",
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
    this.name = "ProfileError";
  }
}

interface ProfileLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ProfileStoreOptions {
  /** $PLUGHIVE_HOME. Without it profiles live in memory only. */
  home?: string;
  logger?: ProfileLogger;
}

/**
 * Profiles in `$PLUGHIVE_HOME/profiles.json` (0600, written atomically).
 * The "default" profile always exists. An unreadable file is kept aside as
 * profiles.json.corrupt and the store starts from the default profile.
 */
export class ProfileStore {
  private readonly path: string | null;
  private readonly home: string | null;
  private profiles = new Map<string, Profile>();

  constructor(private readonly opts: ProfileStoreOptions = {}) {
    this.home = opts.home ?? null;
    this.path = opts.home ? join(opts.home, "profiles.json") : null;
    this.load();
  }

  list(): Profile[] {
    return [...this.profiles.values()];
  }

  get(id: string): Profile | undefined {
    return this.profiles.get(id);
  }

  /** Create or replace. Throws ProfileError when the profile is invalid. */
  put(input: unknown): Profile {
    const parsed = ProfileSchema.safeParse(input);
    if (!parsed.success) {
      throw new ProfileError(
        "INVALID_PROFILE",
        `invalid profile: ${z.prettifyError(parsed.error)}`,
        parsed.error.issues,
      );
    }
    const profile = parsed.data;
    if (!this.profiles.has(profile.id) && this.profiles.size >= MAX_PROFILES) {
      throw new ProfileError("PROFILE_LIMIT", `at most ${MAX_PROFILES} profiles are supported`);
    }
    const next = new Map(this.profiles);
    next.set(profile.id, profile);
    this.persist(next);
    this.profiles = next;
    return profile;
  }

  /** Returns false when the profile does not exist. The default profile cannot be deleted. */
  delete(id: string): boolean {
    if (id === DEFAULT_PROFILE_ID) {
      throw new ProfileError(
        "PROFILE_PROTECTED",
        "the default profile cannot be deleted; edit it instead",
      );
    }
    if (!this.profiles.has(id)) return false;
    const next = new Map(this.profiles);
    next.delete(id);
    this.persist(next);
    this.profiles = next;
    return true;
  }

  private load(): void {
    const fresh = () => new Map([[DEFAULT_PROFILE_ID, defaultProfile()]]);
    this.profiles = fresh();
    if (!this.path || !existsSync(this.path)) return;
    const path = this.path;
    // The file as found is kept next to it before anything is dropped, so a
    // later save (which only writes what loaded) never destroys the original.
    const backUp = (): string | null => {
      const backup = `${path}.corrupt`;
      try {
        copyFileSync(path, backup);
        chmodSync(backup, 0o600);
        return backup;
      } catch {
        return null;
      }
    };
    let file: z.infer<typeof FileSchema>;
    try {
      file = FileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (e) {
      const reason =
        e instanceof z.ZodError ? "it does not match the profile schema" : "it is not valid JSON";
      this.opts.logger?.warn(
        { path, backup: backUp(), reason },
        "profiles.json could not be read; using the default profile",
      );
      return;
    }
    const loaded = new Map<string, Profile>();
    const skipped: Array<{ index: number; id: string | null }> = [];
    file.profiles.forEach((entry, index) => {
      const parsed = ProfileSchema.safeParse(entry);
      if (parsed.success && loaded.size < MAX_PROFILES) {
        loaded.set(parsed.data.id, parsed.data);
        return;
      }
      const rawId = (entry as { id?: unknown } | null)?.id;
      skipped.push({
        index,
        id: typeof rawId === "string" && PROFILE_ID_PATTERN.test(rawId) ? rawId : null,
      });
    });
    if (skipped.length > 0) {
      this.opts.logger?.warn(
        { path, backup: backUp(), skipped },
        "profiles.json has entries that are not valid profiles; they were skipped",
      );
    }
    if (!loaded.has(DEFAULT_PROFILE_ID)) loaded.set(DEFAULT_PROFILE_ID, defaultProfile());
    this.profiles = loaded;
  }

  private persist(profiles: Map<string, Profile>): void {
    if (!this.path || !this.home) return;
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const body = `${JSON.stringify({ version: 1, profiles: [...profiles.values()] }, null, 2)}\n`;
    try {
      // Durable and atomic: the bytes reach the disk before the rename makes
      // them the file, and the rename itself is flushed with the directory.
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeFileSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      atomicReplaceSync(tmp, this.path);
      try {
        const dir = openSync(this.home, "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      } catch {
        // not every platform can fsync a directory; the rename already happened
      }
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
}
