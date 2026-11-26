// packs/machines/state.ts
//
// Registered machines and repos, persisted as JSON in the pack's dataDir
// (`machines.json`, mode 0600, written atomically). Every read is validated
// against the schema; a corrupt file is an error, never silently reset, so a
// bad edit cannot wipe the user's registrations.
import { randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "plughive/pack";
import {
  BRANCH_PATTERN,
  NAME_PATTERN,
  USER_PATTERN,
  hostKeyLineProblem,
  identityFileProblem,
  isValidHost,
  remotePathProblem,
} from "./shell.js";

const name = z.string().regex(NAME_PATTERN);

export const SshTargetSchema = z
  .object({
    host: z.string().refine(isValidHost, "invalid host"),
    user: z.string().regex(USER_PATTERN),
    port: z.number().int().min(1).max(65535),
    /** Path to a private key file, or null for ssh-agent / ssh's default keys. Never the key itself. */
    identityFile: z
      .string()
      .refine((p) => identityFileProblem(p) === null, "invalid identity file path")
      .nullable(),
    /**
     * Opt-in pinned host key: one known_hosts line for this host. Null (the
     * default, also for state written before this field existed) keeps the
     * first-contact accept-new behaviour against the pack's own known_hosts.
     */
    hostKey: z
      .string()
      .refine((l) => hostKeyLineProblem(l) === null, "invalid host_key known_hosts line")
      .nullable()
      .default(null),
    /**
     * Explicit opt-ins for the auth methods that would otherwise be silent
     * fallbacks. Both false (the default) with no identityFile means the
     * machine has NO auth method and every connection is refused: the pack
     * never tries the user's default ~/.ssh keys or an agent on its own.
     */
    useAgent: z.boolean().default(false),
    useDefaultKeys: z.boolean().default(false),
  })
  .strict();

export const MachineRecordSchema = z
  .object({
    name,
    provider: z.literal("ssh"),
    ssh: SshTargetSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const RepoRecordSchema = z
  .object({
    name,
    machine: name,
    path: z.string().refine((p) => remotePathProblem(p, "path", true) === null, "invalid path"),
    repoUrl: z.string().max(2048).nullable(),
    aliases: z.array(z.string().min(1).max(200)).max(32),
    branch: z.string().regex(BRANCH_PATTERN).nullable(),
    /** Shell command run on the machine after the pull, in the repo folder. Raw by design. */
    postUpdate: z.string().max(8192).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const StateSchema = z
  .object({
    version: z.literal(1),
    machines: z.array(MachineRecordSchema),
    repos: z.array(RepoRecordSchema),
  })
  .strict();

export type SshTarget = z.output<typeof SshTargetSchema>;
export type MachineRecord = z.output<typeof MachineRecordSchema>;
export type RepoRecord = z.output<typeof RepoRecordSchema>;
export type MachinesState = z.output<typeof StateSchema>;

export const STATE_FILE = "machines.json";

/** The state file is small; anything bigger is refused instead of parsed. */
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export class MachineStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, STATE_FILE);
  }

  read(): MachinesState {
    // Opened with O_NOFOLLOW and checked on the descriptor, so a symlinked
    // state file is refused, never read (or chmodded) through.
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { version: 1, machines: [], repos: [] };
      if (code === "ELOOP") {
        throw new Error(
          `${STATE_FILE} is a symlink; remove it (a symlinked state file is never read)`,
        );
      }
      throw e;
    }
    let raw: unknown;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error(`${STATE_FILE} is not a regular file; remove it`);
      if (st.size > MAX_STATE_BYTES) {
        throw new Error(`${STATE_FILE} is over ${MAX_STATE_BYTES} bytes; fix or remove it`);
      }
      // Tighten permissions left loose by hand edits — on the opened file,
      // so a path swapped for a symlink in the meantime is not chmodded.
      if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      raw = JSON.parse(readFileSync(fd, "utf8"));
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`${STATE_FILE} is not valid JSON (${e.message}); fix or remove it`);
      }
      throw e;
    } finally {
      closeSync(fd);
    }
    const parsed = StateSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${STATE_FILE} does not match the expected schema (${issue?.path.join(".") || "(root)"}: ${issue?.message}); fix or remove it`,
      );
    }
    return parsed.data;
  }

  write(state: MachinesState): void {
    const valid = StateSchema.parse(state);
    // O_EXCL ("wx") with a random name: a pre-planted or colliding temp file
    // is refused instead of being written through.
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  update<T>(fn: (state: MachinesState) => T): T {
    const state = this.read();
    const out = fn(state);
    this.write(state);
    return out;
  }

  getMachine(machine: string): MachineRecord {
    const found = this.read().machines.find((m) => m.name === machine);
    if (!found) {
      throw new Error(
        `no machine named "${machine}" is registered (machine_add registers one; machines_list shows them)`,
      );
    }
    return found;
  }
}

// --- repo lookup (ported from the old update_repo matcher) --------------------

function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^ssh:\/\//, "")
    .replace(/^git@/, "")
    .replace(/^github\.com[:/]/, "");
}

function shortName(url: string): string {
  return (url.split(/[/:]/).pop() ?? "").replace(/\.git$/, "");
}

function ownerRepo(url: string): string {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : "";
}

/** Match by name, alias, repo URL, URL short name or owner/repo. Returns every match. */
export function findRepos(repos: readonly RepoRecord[], query: string): RepoRecord[] {
  const q = normalize(query);
  if (!q) return [];
  return repos.filter((r) => {
    const url = r.repoUrl ?? "";
    return [r.name, ...r.aliases, url, url && shortName(url), url && ownerRepo(url)]
      .map((c) => normalize(c ?? ""))
      .filter(Boolean)
      .includes(q);
  });
}
