// packs/cli-bridge/clis.ts
//
// One entry per agent CLI: how to ask it one question non-interactively, how
// to read its machine-readable answer, and how to ask it for its version and
// (where the CLI itself reports one) its login state. Pure: no spawning here.
//
// Each argv was checked against the installed CLI's `--help` and a live run
// (November 2026). The `noTools` argv (chat mode, where the prompt carries
// untrusted text) uses each CLI's hard read-only / no-tools flags, verified
// against the installed CLI's `--help` only, never a live session.
// The prompt is always handed over in a form the CLI cannot
// read as a flag: after `--`, or glued to its flag (`--prompt=...`), so a
// prompt that starts with "-" stays a prompt.

export const CLI_IDS = ["claude", "codex", "gemini", "agy", "opencode", "copilot"] as const;
export type CliId = (typeof CLI_IDS)[number];

export interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  /** Copilot bills premium requests, not tokens. */
  premium_requests?: number;
}

export interface CliAnswer {
  text: string;
  usage?: CliUsage;
  session_id?: string;
  model?: string;
  cost_usd?: number;
}

/** Thrown by a parser when the CLI reported a failure in its own output. */
export class CliReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliReportedError";
  }
}

export interface AskArgsOptions {
  /** True when the CLI runs in the pack's own empty scratch folder. */
  scratch?: boolean;
  /**
   * True for the chat provider, where the prompt carries untrusted text
   * (web pages, emails): add the CLI's hard no-tools / read-only flags.
   * Only flags verified against the installed CLI's `--help` are used.
   */
  noTools?: boolean;
}

/**
 * What a model name may look like: a letter or digit first, then letters,
 * digits and . _ : / - only. Anything else (a leading "-", spaces, "=") is
 * refused before it reaches a command line.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export function checkModel(model: string | undefined): string | undefined {
  if (model === undefined || model === "") return undefined;
  if (!MODEL_RE.test(model)) {
    throw new Error(
      "model must start with a letter or digit and use only letters, digits and . _ : / - (max 120)",
    );
  }
  return model;
}

export interface CliSpec {
  id: CliId;
  /** Shown to people (list_agent_clis, errors). */
  label: string;
  /** Vendor whose terms govern use of the CLI. */
  vendor: string;
  /**
   * argv (after the binary) for one non-interactive question with JSON
   * output. The prompt and the model are each one token (glued to their flag,
   * or after `--`), so neither can be read as another option. Flags that skip
   * a CLI's own folder-trust check are added only for `scratch` runs (the
   * pack's private, empty working folder), never in a folder the user listed.
   */
  askArgs(prompt: string, model?: string, opts?: AskArgsOptions): string[];
  /** Reads stdout of a run. Throws CliReportedError when the CLI reported a failure. */
  parse(stdout: string): CliAnswer;
  /** argv that prints the version. */
  versionArgs: string[];
  /**
   * argv of a command where the CLI itself says whether it is signed in, and
   * how to read its output. Absent when the CLI has no such command: the pack
   * never looks at the CLI's credential files to guess.
   */
  login?: {
    args: string[];
    read(stdout: string, stderr: string, exitCode: number): boolean | null;
  };
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

function compact<T extends object>(o: T): T | undefined {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? (out as T) : undefined;
}

function withOptional(answer: CliAnswer): CliAnswer {
  const out: CliAnswer = { text: answer.text };
  if (answer.usage) out.usage = answer.usage;
  if (answer.session_id) out.session_id = answer.session_id;
  if (answer.model) out.model = answer.model;
  if (answer.cost_usd !== undefined) out.cost_usd = answer.cost_usd;
  return out;
}

/** The one JSON value in stdout (some CLIs print a banner line before it). */
export function parseJsonDocument(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/^[{[]/m);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // fall through
      }
    }
    throw new CliReportedError(
      `expected JSON output, got: ${trimmed.slice(0, 200) || "(nothing)"}`,
    );
  }
}

/** Each JSON object of a JSON-lines stream. Lines that are not JSON objects are skipped. */
export function parseJsonLines(stdout: string): Json[] {
  const out: Json[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t);
      if (isObj(v)) out.push(v);
    } catch {
      // a partial line (output cap) or a log line: skip
    }
  }
  return out;
}

const errorText = (v: unknown): string | undefined => {
  if (typeof v === "string") return v;
  if (isObj(v)) return str(v.message) ?? str(v.type);
  return undefined;
};

// --- claude (Claude Code) ---------------------------------------------------------
// `claude -p --output-format json -- <prompt>` prints one object:
// {type:"result", subtype, is_error, result, session_id, total_cost_usd, usage{...}}.
// Older builds with --verbose print an array of events ending with that object.

export function parseClaude(stdout: string): CliAnswer {
  const doc = parseJsonDocument(stdout);
  const result = Array.isArray(doc)
    ? [...doc].reverse().find((e) => isObj(e) && e.type === "result")
    : doc;
  if (!isObj(result)) throw new CliReportedError("claude printed no result object");
  const text = typeof result.result === "string" ? result.result : "";
  if (result.is_error === true || (str(result.subtype) && result.subtype !== "success")) {
    // A failed turn can still carry subtype "success" (e.g. "Not logged in"); name the
    // subtype only when it says something, like error_max_turns.
    const sub = str(result.subtype);
    const why = sub && sub !== "success" ? ` (${sub})` : "";
    throw new CliReportedError(
      `claude reported an error${why}: ${text.slice(0, 400) || "no message"}`,
    );
  }
  const u = isObj(result.usage) ? result.usage : {};
  return withOptional({
    text,
    session_id: str(result.session_id),
    cost_usd: num(result.total_cost_usd),
    usage: compact({
      input_tokens: num(u.input_tokens),
      output_tokens: num(u.output_tokens),
      cached_input_tokens: num(u.cache_read_input_tokens),
    }),
  });
}

// --- codex (OpenAI Codex CLI) -----------------------------------------------------
// `codex exec --json [--skip-git-repo-check] -- <prompt>` prints JSON lines:
// thread.started{thread_id}, item.completed{item{type:"agent_message",text}},
// turn.completed{usage}, and turn.failed{error} / error{message} on failure.

export function parseCodex(stdout: string): CliAnswer {
  const events = parseJsonLines(stdout);
  let session: string | undefined;
  const texts: string[] = [];
  let usage: CliUsage | undefined;
  for (const e of events) {
    if (e.type === "thread.started") session = str(e.thread_id) ?? session;
    else if (e.type === "item.completed" && isObj(e.item) && e.item.type === "agent_message") {
      if (typeof e.item.text === "string") texts.push(e.item.text);
    } else if (e.type === "turn.completed" && isObj(e.usage)) {
      usage = compact({
        input_tokens: num(e.usage.input_tokens),
        output_tokens: num(e.usage.output_tokens),
        cached_input_tokens: num(e.usage.cached_input_tokens),
        reasoning_tokens: num(e.usage.reasoning_output_tokens),
      });
    } else if (e.type === "turn.failed" || e.type === "error") {
      throw new CliReportedError(
        `codex reported an error: ${errorText(e.error) ?? errorText(e.message) ?? "turn failed"}`,
      );
    }
  }
  if (!texts.length && !events.some((e) => e.type === "turn.completed")) {
    throw new CliReportedError("codex printed no answer");
  }
  return withOptional({ text: texts[texts.length - 1] ?? "", session_id: session, usage });
}

// --- gemini (Gemini CLI) ----------------------------------------------------------
// `gemini --prompt=<prompt> --output-format json [--skip-trust]` prints one object:
// {session_id, response, stats{models{<model>{tokens{input,candidates,total,cached,thoughts}}}}}
// and {error{message}} on failure.

export function parseGemini(stdout: string): CliAnswer {
  const doc = parseJsonDocument(stdout);
  if (!isObj(doc)) throw new CliReportedError("gemini printed no JSON object");
  if (doc.error !== undefined && doc.error !== null) {
    throw new CliReportedError(`gemini reported an error: ${errorText(doc.error) ?? "unknown"}`);
  }
  if (typeof doc.response !== "string") throw new CliReportedError("gemini printed no response");
  let usage: CliUsage | undefined;
  let model: string | undefined;
  const models = isObj(doc.stats) && isObj(doc.stats.models) ? doc.stats.models : {};
  let inTok = 0;
  let outTok = 0;
  let cached = 0;
  let thoughts = 0;
  let total = 0;
  let mainTokens = -1;
  for (const [name, m] of Object.entries(models)) {
    if (!isObj(m) || !isObj(m.tokens)) continue;
    const t = m.tokens;
    inTok += num(t.input) ?? num(t.prompt) ?? 0;
    outTok += num(t.candidates) ?? 0;
    cached += num(t.cached) ?? 0;
    thoughts += num(t.thoughts) ?? 0;
    total += num(t.total) ?? 0;
    // The model that did the main work: the one under the "main" role, else the biggest.
    const isMain = isObj(m.roles) && "main" in m.roles;
    const size = (num(t.total) ?? 0) + (isMain ? Number.MAX_SAFE_INTEGER / 2 : 0);
    if (size > mainTokens) {
      mainTokens = size;
      model = name;
    }
  }
  if (Object.keys(models).length) {
    usage = compact({
      input_tokens: inTok,
      output_tokens: outTok,
      cached_input_tokens: cached,
      reasoning_tokens: thoughts,
      total_tokens: total,
    });
  }
  return withOptional({ text: doc.response, session_id: str(doc.session_id), model, usage });
}

// --- agy (Google Antigravity CLI) ------------------------------------------------
// `agy -p=<prompt> --output-format json` prints one object:
// {conversation_id, status:"SUCCESS", response, usage{input_tokens,output_tokens,
// thinking_tokens,cache_read_tokens,total_tokens}}. `-p` takes the prompt as
// its value, so it is glued to the flag.

export function parseAgy(stdout: string): CliAnswer {
  const doc = parseJsonDocument(stdout);
  if (!isObj(doc)) throw new CliReportedError("agy printed no JSON object");
  const status = str(doc.status);
  if (status && status !== "SUCCESS") {
    throw new CliReportedError(
      `agy reported ${status}: ${(errorText(doc.error) ?? str(doc.response) ?? "").slice(0, 400)}`,
    );
  }
  if (typeof doc.response !== "string") throw new CliReportedError("agy printed no response");
  const u = isObj(doc.usage) ? doc.usage : {};
  return withOptional({
    text: doc.response.replace(/\n+$/, ""),
    session_id: str(doc.conversation_id),
    usage: compact({
      input_tokens: num(u.input_tokens),
      output_tokens: num(u.output_tokens),
      cached_input_tokens: num(u.cache_read_tokens),
      reasoning_tokens: num(u.thinking_tokens),
      total_tokens: num(u.total_tokens),
    }),
  });
}

// --- opencode ---------------------------------------------------------------------
// `opencode run --format json -- <prompt>` prints JSON lines: step_start,
// text{part{text}}, step_finish{part{tokens{input,output,reasoning,cache{read}},cost}},
// error{error{type,message}}. Every event carries sessionID.

export function parseOpencode(stdout: string): CliAnswer {
  const events = parseJsonLines(stdout);
  let session: string | undefined;
  const texts: string[] = [];
  let inTok: number | undefined;
  let outTok: number | undefined;
  let reasoning: number | undefined;
  let cached: number | undefined;
  let cost: number | undefined;
  const add = (a: number | undefined, b: number | undefined) =>
    b === undefined ? a : (a ?? 0) + b;
  for (const e of events) {
    session = str(e.sessionID) ?? (isObj(e.part) ? str(e.part.sessionID) : undefined) ?? session;
    if (e.type === "error") {
      throw new CliReportedError(`opencode reported an error: ${errorText(e.error) ?? "unknown"}`);
    }
    if (!isObj(e.part)) continue;
    if (e.type === "text" && typeof e.part.text === "string") texts.push(e.part.text);
    if (e.type === "step_finish") {
      const t = isObj(e.part.tokens) ? e.part.tokens : {};
      inTok = add(inTok, num(t.input));
      outTok = add(outTok, num(t.output));
      reasoning = add(reasoning, num(t.reasoning));
      cached = add(cached, isObj(t.cache) ? num(t.cache.read) : undefined);
      cost = add(cost, num(e.part.cost));
    }
  }
  if (!events.length) throw new CliReportedError("opencode printed no events");
  return withOptional({
    text: texts.join(""),
    session_id: session,
    cost_usd: cost,
    usage: compact({
      input_tokens: inTok,
      output_tokens: outTok,
      reasoning_tokens: reasoning,
      cached_input_tokens: cached,
    }),
  });
}

// --- copilot (GitHub Copilot CLI) ------------------------------------------------
// `copilot --prompt=<prompt> --output-format json` prints JSON lines, most of
// them ephemeral status events; the answer is in assistant.message{data{content,
// model}} and the run ends with result{sessionId, exitCode, usage{premiumRequests}}.

export function parseCopilot(stdout: string): CliAnswer {
  const events = parseJsonLines(stdout);
  const texts: string[] = [];
  let model: string | undefined;
  let session: string | undefined;
  let premium: number | undefined;
  let sawResult = false;
  for (const e of events) {
    const data = isObj(e.data) ? e.data : {};
    if (e.type === "assistant.message") {
      const content = str(data.content);
      if (content) texts.push(content);
      model = str(data.model) ?? model;
    } else if (e.type === "session.error" || e.type === "error") {
      throw new CliReportedError(
        `copilot reported an error: ${errorText(data.message) ?? errorText(e.error) ?? "unknown"}`,
      );
    } else if (e.type === "result") {
      sawResult = true;
      session = str(e.sessionId) ?? session;
      if (isObj(e.usage)) premium = num(e.usage.premiumRequests);
      const code = num(e.exitCode);
      if (code !== undefined && code !== 0) {
        throw new CliReportedError(`copilot finished with exit code ${code}`);
      }
    }
  }
  if (!texts.length && !sawResult) throw new CliReportedError("copilot printed no answer");
  return withOptional({
    text: texts[texts.length - 1] ?? "",
    session_id: session,
    model,
    usage: compact({ premium_requests: premium }),
  });
}

// --- login readers ---------------------------------------------------------------

/** `claude auth status` prints JSON with a `loggedIn` boolean. Nothing else is kept. */
export function readClaudeLogin(stdout: string): boolean | null {
  try {
    const doc = parseJsonDocument(stdout);
    return isObj(doc) && typeof doc.loggedIn === "boolean" ? doc.loggedIn : null;
  } catch {
    return null;
  }
}

/** `codex login status` prints "Logged in using ..." or "Not logged in". */
export function readCodexLogin(stdout: string, stderr: string, exitCode: number): boolean | null {
  const out = `${stdout}\n${stderr}`;
  if (/not logged in/i.test(out)) return false;
  if (exitCode === 0 && /logged in/i.test(out)) return true;
  return null;
}

/** First version-looking token of `--version` output. */
export function readVersion(stdout: string, stderr = ""): string | null {
  const m = `${stdout}\n${stderr}`.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return m?.[1] ?? null;
}

/** `--model=<name>` as one token, or nothing. */
const modelArgs = (flag: string, model?: string): string[] => {
  const m = checkModel(model);
  return m ? [`${flag}=${m}`] : [];
};

export const CLIS: Record<CliId, CliSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    vendor: "Anthropic",
    askArgs: (prompt, model, opts) => [
      "-p",
      "--output-format",
      "json",
      // Chat mode: no built-in tools at all ("--tools """), no MCP servers
      // from config files (--strict-mcp-config), and user/project settings
      // that could re-add tools are ignored (--restricted).
      ...(opts?.noTools ? ["--restricted", "--tools", "", "--strict-mcp-config"] : []),
      ...modelArgs("--model", model),
      "--",
      prompt,
    ],
    parse: parseClaude,
    versionArgs: ["--version"],
    login: {
      args: ["auth", "status"],
      read: (stdout) => readClaudeLogin(stdout),
    },
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex CLI",
    vendor: "OpenAI",
    askArgs: (prompt, model, opts) => [
      "exec",
      "--json",
      // codex refuses to run outside a git repository; only the pack's own
      // scratch folder skips that check.
      ...(opts?.scratch ? ["--skip-git-repo-check"] : []),
      // Chat mode: the most restrictive sandbox codex offers. codex exec has
      // no hard no-tools flag, so model-run commands can still execute
      // read-only inside the sandbox — residual risk, documented in the pack.
      ...(opts?.noTools ? ["--sandbox", "read-only"] : []),
      ...modelArgs("--model", model),
      "--",
      prompt,
    ],
    parse: parseCodex,
    versionArgs: ["--version"],
    login: { args: ["login", "status"], read: readCodexLogin },
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    vendor: "Google",
    askArgs: (prompt, model, opts) => [
      `--prompt=${prompt}`,
      "--output-format",
      "json",
      // Chat mode: plan approval mode is read-only (no edit/exec tools run).
      ...(opts?.noTools ? ["--approval-mode", "plan"] : []),
      // Trusts the folder for this session: only the pack's own scratch folder.
      ...(opts?.scratch ? ["--skip-trust"] : []),
      ...modelArgs("--model", model),
    ],
    parse: parseGemini,
    versionArgs: ["--version"],
  },
  agy: {
    id: "agy",
    label: "Antigravity CLI",
    vendor: "Google",
    askArgs: (prompt, model, opts) => [
      `-p=${prompt}`,
      "--output-format",
      "json",
      // Chat mode: plan mode (read-only) and no slash-command expansion, so
      // text inside the prompt cannot invoke a /command.
      ...(opts?.noTools ? ["--mode", "plan", "--disable-slash-commands"] : []),
      ...modelArgs("--model", model),
    ],
    parse: parseAgy,
    versionArgs: ["--version"],
  },
  opencode: {
    id: "opencode",
    label: "opencode",
    vendor: "the model provider you configured in opencode",
    askArgs: (prompt, model, opts) => [
      "run",
      "--format",
      "json",
      // Chat mode: the built-in read-only "plan" agent (no write/bash tools).
      ...(opts?.noTools ? ["--agent", "plan"] : []),
      ...modelArgs("--model", model),
      "--",
      prompt,
    ],
    parse: parseOpencode,
    versionArgs: ["--version"],
  },
  copilot: {
    id: "copilot",
    label: "GitHub Copilot CLI",
    vendor: "GitHub",
    askArgs: (prompt, model, opts) => [
      `--prompt=${prompt}`,
      "--output-format",
      "json",
      // Chat mode: no built-in MCP servers. Tools are never auto-allowed
      // (--allow-all-tools is not passed), and in non-interactive mode an
      // unapproved tool is denied, so the model cannot act.
      ...(opts?.noTools ? ["--disable-builtin-mcps"] : []),
      ...modelArgs("--model", model),
    ],
    parse: parseCopilot,
    versionArgs: ["--version"],
  },
};
