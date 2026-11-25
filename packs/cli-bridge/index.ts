// packs/cli-bridge/index.ts
//
// Use the agent CLIs the user already has installed and signed in to (Claude
// Code, Codex, Gemini CLI, Antigravity, opencode, Copilot) as tools: ask one
// a question and get its answer back as text, or have Antigravity draw an
// image into the artifact library.
//
// Rules this pack keeps:
//  - It never reads, copies or forwards a CLI's credential files. Each CLI
//    signs itself in from the user's real HOME (permissions.userHome); the
//    pack only says "signed in" where the CLI itself answers the question.
//  - The child environment is the daemon's bare allowlist plus at most
//    CLAUDE_CONFIG_DIR (a user setting). Model-provider keys
//    (ANTHROPIC_API_KEY, OPENAI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ...) are
//    never put there: they stay with the bundled provider packs.
//  - The working folder is a folder inside the pack's data folder, or one
//    inside a folder the user listed in `allowedFolders` (checked by the
//    daemon at every spawn).
//  - Every run is a background job with a timeout, an output cap, and a
//    process-tree kill on timeout, cap or cancel.
//  - As the `chat` provider the prompt can carry untrusted text (web pages,
//    emails), so the CLI runs with its hard no-tools / read-only flags, not
//    just the prompt's request (the `noTools` argv in clis.ts).
//  - On Windows, npm's .cmd shims are never run: see resolve.ts.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CapabilityError,
  type PackContext,
  SpawnError,
  definePack,
  defineProvider,
  defineTool,
  z,
} from "plughive/pack";
import {
  CLIS,
  CLI_IDS,
  type CliAnswer,
  type CliId,
  CliReportedError,
  MODEL_RE,
  checkModel,
  readVersion,
} from "./clis.js";
import { invocationFor } from "./resolve.js";

export const DEFAULT_TIMEOUT_S = 600;
export const MIN_TIMEOUT_S = 10;
export const MAX_TIMEOUT_S = 1800;
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MIN_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_PROMPT_CHARS = 100_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * Environment names the pack never hands a CLI, even if a setting tried to:
 * they are the model-provider keys only bundled provider packs may hold.
 */
export const FORBIDDEN_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "OPENAI_ADMIN_KEY",
] as const;

const modelSchema = z
  .string()
  .regex(
    MODEL_RE,
    "model ids start with a letter or digit and use only letters, digits and . _ : / -",
  );

const cliSchema = z.enum(CLI_IDS);

// --- settings ---------------------------------------------------------------------

const intSetting = (ctx: PackContext, key: string, dflt: number, min: number, max: number) => {
  const v = ctx.settings[key];
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt;
  return Math.min(max, Math.max(min, n));
};

/** CLAUDE_CONFIG_DIR from the setting: an absolute folder (or ~/...), never read by the pack. */
export function claudeConfigDir(value: unknown, home: string = homedir()): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const v = value.trim().replace(/^~(?=$|[\\/])/, home);
  if (v.includes("\0") || !isAbsolute(v)) {
    throw new Error('setting "claudeConfigDir" must be an absolute folder (or start with ~/)');
  }
  return v;
}

/** The login name, which the daemon's bare child environment leaves out. */
function loginName(): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The environment a CLI child gets from this pack (on top of the daemon's bare
 * allowlist). USER and LOGNAME carry the login name: on macOS the CLIs look up
 * their own sign-in in the user's keychain under it (claude reports "Not
 * logged in" without it). The pack never reads that sign-in itself.
 */
export function childEnv(
  cli: CliId,
  settings: Readonly<Record<string, unknown>>,
  user: string | undefined = loginName(),
) {
  const env: Record<string, string> = {};
  if (user && /^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    env.USER = user;
    env.LOGNAME = user;
  }
  if (cli === "claude") {
    const dir = claudeConfigDir(settings.claudeConfigDir);
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
  }
  for (const name of Object.keys(env)) {
    if ((FORBIDDEN_ENV as readonly string[]).includes(name.toUpperCase())) delete env[name];
  }
  return env;
}

// --- running a CLI ----------------------------------------------------------------

export interface AskInput {
  cli: CliId;
  prompt: string;
  cwd?: string | undefined;
  model?: string | undefined;
  timeout_s?: number | undefined;
  /**
   * Chat-provider runs only: pass the CLI's hard no-tools flags (the prompt
   * carries untrusted text). The ask_agent_cli tool never sets this.
   */
  noTools?: boolean | undefined;
}

export interface AskResult extends CliAnswer {
  cli: CliId;
  duration_ms: number;
}

/** Folder the CLI runs in: the user's (checked by the daemon), else a fresh one in the data folder. */
async function workingFolder(ctx: PackContext, cwd: string | undefined) {
  if (cwd !== undefined) {
    if (!isAbsolute(cwd)) {
      throw new Error(
        "cwd must be an absolute path inside a folder listed in the pack's allowedFolders setting",
      );
    }
    return { cwd, scratch: false, cleanup: async () => {} };
  }
  const rel = join("work", randomUUID());
  const abs = join(ctx.pack.dataDir, rel);
  await mkdir(abs, { recursive: true, mode: 0o700 });
  return {
    cwd: rel,
    scratch: true,
    cleanup: () => rm(abs, { recursive: true, force: true }),
  };
}

function notInstalled(cli: CliId, problem: string | undefined): Error {
  return new Error(
    `${CLIS[cli].label} (${cli}) was not found on the daemon's PATH. Install it and sign in ` +
      `with it once in a terminal, then reload this pack.${problem ? ` ${problem}` : ""}`,
  );
}

/** Start `cli` with `args` (Windows npm installs go through node + their JS entry). */
async function runCli(
  ctx: PackContext,
  cli: CliId,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; maxOutputBytes: number },
) {
  const inv = invocationFor(cli, {
    platform: process.platform,
    npmPrefix: typeof ctx.settings.npmPrefix === "string" ? ctx.settings.npmPrefix : undefined,
  });
  try {
    return await ctx.spawn(inv.binary, [...inv.prefixArgs, ...args], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
      env: childEnv(cli, ctx.settings),
      killTree: true,
      input: "",
    });
  } catch (e) {
    if (e instanceof SpawnError && e.code === "not_installed") throw notInstalled(cli, inv.problem);
    throw e;
  }
}

/**
 * Seconds a run may take: the call's timeout_s (the tool schemas keep it in
 * 10..1800) or the defaultTimeoutSeconds setting.
 */
export function timeoutFor(ctx: PackContext, requested: number | undefined): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.min(MAX_TIMEOUT_S, Math.max(1, Math.trunc(requested)));
  }
  return intSetting(ctx, "defaultTimeoutSeconds", DEFAULT_TIMEOUT_S, MIN_TIMEOUT_S, MAX_TIMEOUT_S);
}

const tail = (s: string, n = 600) => {
  const t = s.trim();
  return t.length > n ? `...${t.slice(-n)}` : t;
};

export async function askCli(ctx: PackContext, input: AskInput): Promise<AskResult> {
  const spec = CLIS[input.cli];
  const model = checkModel(input.model);
  const timeoutS = timeoutFor(ctx, input.timeout_s);
  const maxOutputBytes = intSetting(
    ctx,
    "maxOutputBytes",
    DEFAULT_MAX_OUTPUT_BYTES,
    MIN_OUTPUT_BYTES,
    MAX_OUTPUT_BYTES,
  );
  const folder = await workingFolder(ctx, input.cwd);
  const started = Date.now();
  try {
    ctx.progress(0.05, `asking ${spec.label}`);
    const r = await runCli(
      ctx,
      input.cli,
      spec.askArgs(input.prompt, model, {
        scratch: folder.scratch,
        noTools: input.noTools === true,
      }),
      {
        cwd: folder.cwd,
        timeoutMs: timeoutS * 1000,
        maxOutputBytes,
      },
    );
    if (r.timedOut) {
      throw new Error(`${spec.label} did not finish within ${timeoutS} s and was stopped`);
    }
    if (r.truncated) {
      throw new Error(
        `${spec.label} printed more than ${maxOutputBytes} bytes and was stopped (raise the maxOutputBytes setting)`,
      );
    }
    let answer: CliAnswer;
    try {
      answer = spec.parse(r.stdout);
    } catch (e) {
      if (!(e instanceof CliReportedError)) throw e;
      const detail = r.exitCode !== 0 && r.stderr.trim() ? ` stderr: ${tail(r.stderr)}` : "";
      throw new Error(`${e.message} (exit ${r.exitCode}).${detail}`);
    }
    if (r.exitCode !== 0) {
      throw new Error(`${spec.label} exited with ${r.exitCode}: ${tail(r.stderr || answer.text)}`);
    }
    ctx.progress(1);
    return { cli: input.cli, ...answer, duration_ms: Date.now() - started };
  } finally {
    await folder.cleanup();
  }
}

// --- list_agent_clis --------------------------------------------------------------

export interface CliStatus {
  cli: CliId;
  name: string;
  vendor: string;
  installed: boolean;
  version: string | null;
  /** What the CLI itself says; null when it has no such command or did not answer. */
  logged_in: boolean | null;
  note?: string;
}

export async function probeCli(ctx: PackContext, cli: CliId): Promise<CliStatus> {
  const spec = CLIS[cli];
  const base = { cli, name: spec.label, vendor: spec.vendor };
  let version: string | null = null;
  try {
    const r = await runCli(ctx, cli, spec.versionArgs, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    version = readVersion(r.stdout, r.stderr);
    if (r.exitCode !== 0 && version === null) {
      return { ...base, installed: true, version, logged_in: null, note: tail(r.stderr, 200) };
    }
  } catch (e) {
    return {
      ...base,
      installed: false,
      version: null,
      logged_in: null,
      note: (e as Error).message,
    };
  }
  let loggedIn: boolean | null = null;
  if (spec.login) {
    try {
      const r = await runCli(ctx, cli, spec.login.args, {
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: 64 * 1024,
      });
      if (!r.timedOut) loggedIn = spec.login.read(r.stdout, r.stderr, r.exitCode);
    } catch {
      loggedIn = null;
    }
  }
  return { ...base, installed: true, version, logged_in: loggedIn };
}

const listAgentClis = defineTool({
  name: "list_agent_clis",
  description:
    "List the agent CLIs this pack can drive (claude, codex, gemini, agy, opencode, copilot): " +
    "whether each is installed on the daemon's PATH, its version, and whether it is signed in " +
    "where the CLI itself reports that (claude, codex; null otherwise).",
  annotations: { readOnlyHint: true, openWorldHint: false },
  tags: ["agents", "cli"],
  input: z.object({}),
  async run(_input, ctx) {
    const clis = await Promise.all(CLI_IDS.map((cli) => probeCli(ctx, cli)));
    return { clis };
  },
});

// --- ask_agent_cli ------------------------------------------------------------------

const askAgentCli = defineTool({
  name: "ask_agent_cli",
  description:
    "Ask an installed agent CLI (claude, codex, gemini, agy, opencode, copilot) one question " +
    "in non-interactive mode, using the account it is signed in with, and return its answer " +
    "{text, usage?, session_id?}. Runs as a background job. Without cwd it runs in an empty " +
    "scratch folder; with cwd (absolute) it runs in a folder the user allowed in the pack's " +
    "allowedFolders setting. The CLI may act in that folder with its own tools and its own " +
    "permission settings, and its own folder-trust checks apply there (gemini needs the " +
    "folder trusted, codex needs a git repository); the pack skips them only in its scratch " +
    "folder.",
  longRunning: true,
  annotations: { openWorldHint: true },
  tags: ["agents", "cli", "chat"],
  input: z.object({
    cli: cliSchema,
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
    cwd: z.string().min(1).max(1024).optional(),
    model: modelSchema.optional().describe("The CLI's own model name. Omit for its default."),
    timeout_s: z.number().int().min(MIN_TIMEOUT_S).max(MAX_TIMEOUT_S).optional(),
  }),
  async run(input, ctx) {
    return askCli(ctx, input);
  },
});

// --- generate_image_via_agy ---------------------------------------------------------

const IMAGE_TYPES: { ext: RegExp; mime: string; magic: (b: Buffer) => boolean }[] = [
  {
    ext: /\.png$/i,
    mime: "image/png",
    magic: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: /\.jpe?g$/i,
    mime: "image/jpeg",
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: /\.webp$/i,
    mime: "image/webp",
    magic: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/**
 * The newest image agy wrote into `dir` (top level or one folder down): a
 * regular file (no symlink) with an image extension whose first bytes match it.
 */
export async function findNewestImage(dir: string) {
  const candidates: { path: string; mtime: number; size: number; mime: string }[] = [];
  const visit = async (d: string, depth: number) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 1 && !e.name.startsWith(".")) await visit(p, depth + 1);
      if (!e.isFile()) continue;
      const type = IMAGE_TYPES.find((t) => t.ext.test(e.name));
      if (!type) continue;
      const st = await lstat(p);
      if (!st.isFile() || st.nlink > 1 || st.size === 0 || st.size > MAX_IMAGE_BYTES) continue;
      const fh = await open(p, "r");
      try {
        const head = Buffer.alloc(16);
        await fh.read(head, 0, 16, 0);
        if (!type.magic(head)) continue;
      } finally {
        await fh.close();
      }
      candidates.push({ path: p, mtime: st.mtimeMs, size: st.size, mime: type.mime });
    }
  };
  await visit(dir, 0);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ?? null;
}

export const AGY_IMAGE_FILE = "image.png";

export function agyImagePrompt(prompt: string): string {
  return [
    "Use your image generation tool to create this image, then save the image file in the",
    `current working directory as ${AGY_IMAGE_FILE}. Do not do anything else.`,
    `Reply with only the file name.\n\nImage description:\n${prompt}`,
  ].join(" ");
}

const generateImageViaAgy = defineTool({
  name: "generate_image_via_agy",
  description:
    "Generate an image with the Antigravity CLI's (agy) built-in image tool, using the Google " +
    "account agy is signed in with, and save it to the artifact library. Runs as a background " +
    "job; agy works in an empty scratch folder of this pack and may refuse or fail upstream " +
    "(then the error says what agy answered).",
  longRunning: true,
  annotations: { openWorldHint: true },
  capability: "image.generate",
  tags: ["image", "agents", "cli"],
  input: z.object({
    prompt: z.string().min(1).max(8000),
    model: modelSchema.optional().describe("agy model name. Omit for its default."),
    timeout_s: z.number().int().min(MIN_TIMEOUT_S).max(MAX_TIMEOUT_S).optional(),
  }),
  async run(input, ctx) {
    const rel = join("agy-images", randomUUID());
    const abs = join(ctx.pack.dataDir, rel);
    await mkdir(abs, { recursive: true, mode: 0o700 });
    try {
      const spec = CLIS.agy;
      const timeoutS = timeoutFor(ctx, input.timeout_s);
      ctx.progress(0.05, "asking agy for the image");
      const r = await runCli(
        ctx,
        "agy",
        // agy's default mode (never --mode accept-edits or auto) plus its terminal
        // sandbox: the image tool still saves into this private, empty folder.
        [
          ...spec.askArgs(agyImagePrompt(input.prompt), input.model, { scratch: true }),
          "--sandbox",
          // The prompt is interpolated into the agy prompt text: never let it
          // expand as a /slash-command in print mode.
          "--disable-slash-commands",
        ],
        {
          cwd: rel,
          timeoutMs: timeoutS * 1000,
          maxOutputBytes: intSetting(
            ctx,
            "maxOutputBytes",
            DEFAULT_MAX_OUTPUT_BYTES,
            MIN_OUTPUT_BYTES,
            MAX_OUTPUT_BYTES,
          ),
        },
      );
      if (r.timedOut) throw new Error(`agy did not finish within ${timeoutS} s and was stopped`);
      if (r.truncated) throw new Error("agy printed more output than allowed and was stopped");
      let answer: CliAnswer | null = null;
      try {
        answer = spec.parse(r.stdout);
      } catch (e) {
        if (!(e instanceof CliReportedError)) throw e;
        throw new Error(`${e.message} (exit ${r.exitCode}). ${tail(r.stderr, 300)}`.trim());
      }
      const image = await findNewestImage(abs);
      if (!image) {
        throw new Error(
          `agy saved no image. agy answered: ${tail(answer.text, 500) || "(nothing)"}`,
        );
      }
      ctx.progress(0.9, "saving the image");
      const ref = await ctx.library.importFile({
        kind: "image",
        mime: image.mime,
        sourcePath: image.path,
        prompt: input.prompt,
        model: input.model ? `agy:${input.model}` : "agy",
        meta: { via: "agy", conversation_id: answer.session_id ?? null },
      });
      ctx.progress(1);
      return {
        artifacts: [ref],
        model: input.model ?? "agy",
        provider: "cli-bridge",
        session_id: answer.session_id ?? null,
      };
    } finally {
      await rm(abs, { recursive: true, force: true });
    }
  },
});

// --- opt-in chat provider -----------------------------------------------------------

/** One prompt from a chat transcript (the CLIs take a single prompt, not messages). */
export function transcriptPrompt(
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[],
  json?: boolean,
): string {
  const parts: string[] = [];
  const system = messages.filter((m) => m.role === "system").map((m) => m.content);
  if (system.length) parts.push(`Instructions:\n${system.join("\n\n")}`);
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 1 && turns[0]?.role === "user") parts.push(turns[0].content);
  else {
    parts.push(
      "Conversation so far:",
      ...turns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`),
      "Reply as the assistant to the last user message.",
    );
  }
  parts.push("Answer directly; do not use tools or change files.");
  if (json) parts.push("Reply with JSON only.");
  return parts.join("\n\n");
}

const chatCli = (ctx: PackContext): CliId | null => {
  const v = ctx.settings.chatCli;
  return typeof v === "string" && (CLI_IDS as readonly string[]).includes(v) ? (v as CliId) : null;
};

const chatProvider = defineProvider({
  capability: "chat",
  id: "cli-bridge",
  priority: -100,
  optIn: true,
  cost: "account",
  setupHint:
    "Set the cli-bridge pack's chatCli setting and put cli-bridge in the chat preference order.",
  isConfigured: (ctx) => chatCli(ctx) !== null,
  async run(input, ctx) {
    const cli = chatCli(ctx);
    if (!cli)
      throw new CapabilityError("cli-bridge: no chatCli is set", { code: "NOT_CONFIGURED" });
    let model: string | undefined;
    try {
      model = checkModel(input.model);
    } catch (e) {
      throw new CapabilityError(`cli-bridge: ${(e as Error).message}`, { code: "BAD_INPUT" });
    }
    const prompt = transcriptPrompt(input.messages, input.json);
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new CapabilityError(
        `cli-bridge: the conversation is over ${MAX_PROMPT_CHARS} characters`,
      );
    }
    let r: AskResult;
    try {
      // Chat text can be untrusted (web pages, emails): the CLI runs with its
      // hard no-tools / read-only flags, not just the prompt's request.
      r = await askCli(ctx, { cli, prompt, model, noTools: true });
    } catch (e) {
      // The CLI may have run (and used the account's quota): never retried elsewhere.
      throw new CapabilityError((e as Error).message, { mayHaveCharged: true });
    }
    return {
      text: r.text,
      model: r.model ?? input.model ?? cli,
      provider: "cli-bridge",
      usage: {
        ...(r.usage?.input_tokens !== undefined ? { input_tokens: r.usage.input_tokens } : {}),
        ...(r.usage?.output_tokens !== undefined ? { output_tokens: r.usage.output_tokens } : {}),
      },
      ...(r.cost_usd !== undefined ? { cost_usd: r.cost_usd } : {}),
    };
  },
});

export default definePack({
  tools: [listAgentClis, askAgentCli, generateImageViaAgy],
  providers: [chatProvider],
});
