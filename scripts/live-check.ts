/**
 * Live end-to-end check of the built daemon's platform features (run after
 * `pnpm build`, with `pnpm live-check`). It complements `pnpm smoke:ci`,
 * which covers start-up, local engines and secrets on every OS.
 *
 * Starts dist/src/server.js on port 7793 (LIVE_CHECK_PORT) with a throwaway
 * PLUGHIVE_HOME, admin token, keychain service and import folder, and checks
 * through MCP and the admin API, all free:
 *   - MCP resources (artifacts) and prompts (workflows);
 *   - code mode: run_tool_script calls tools, has no process/require/fetch,
 *     and is stopped by its time limit;
 *   - batch_run as one job; setup_plan;
 *   - triggers: a signed webhook starts its workflow, unsigned, replayed and
 *     stale requests are refused, cron triggers get a next run and reject a
 *     bad schedule;
 *   - the OAuth mounts are listed and signed out on a fresh home;
 *   - the action packs are present (opt-in ones off) and every tool that
 *     sends or posts is annotated destructive;
 *   - chat workflows, text.embed and memory, through the real local pack and
 *     router, against a small Ollama-compatible stub this script serves on
 *     port 7792 (LIVE_CHECK_OLLAMA_PORT): /api/version, /api/tags, /api/chat
 *     (a fixed triage reply) and /api/embed (hashed bag-of-words vectors).
 *     `--no-stub` skips it; the checks then expect a clean "set up a
 *     provider" failure.
 *
 * `--cli-bridge` also enables the CLI bridge and asks the user's own Claude
 * Code CLI for "PONG". That call is billed to the user's Claude account, so it
 * is opt-in. LIVE_CHECK_CLAUDE_CONFIG_DIR picks the Claude profile folder.
 *
 * Exits non-zero if any check fails. Never touches ~/.plughive.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.LIVE_CHECK_PORT ?? 7793);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `live-${randomBytes(24).toString("base64url")}`;
const SERVICE = `plughive-live-${randomBytes(4).toString("hex")}`;
const WITH_CLI_BRIDGE = process.argv.includes("--cli-bridge");
const WITH_STUB = !process.argv.includes("--no-stub");
const STUB_PORT = Number(process.env.LIVE_CHECK_OLLAMA_PORT ?? 7792);
const STUB_TRIAGE = {
  summary: "The app crashes when it starts.",
  type: "bug",
  severity: "high",
  labels: ["bug", "crash"],
  components: ["startup"],
  missing_info: ["OS and app version"],
  reproducible: null,
  next_steps: ["Ask for the crash log"],
  reply_draft: "Thanks for the report. Could you share the crash log?",
};
const SECRET_NAME = /(_API_KEY|_TOKEN|_KEY|_SECRET|PASSPHRASE)$/;
/** A 1x1 PNG. */
const DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Bundled tools that send, post or delete for the user. */
const DESTRUCTIVE = [
  "resend_send_email",
  "agentmail_reply",
  "twilio_send_sms",
  "vapi_create_call",
  "ayrshare_post",
  "ayrshare_delete_post",
  "send_telegram",
];
const ACTION_PACKS = ["email", "phone", "browser", "social", "stock", "maps", "finance-data"];
const OPT_IN_PACKS = ["sandbox", "x402", "cli-bridge"];

// JSON from the daemon, read field by field.
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON responses
type J = any;

const results: { name: string; pass: boolean }[] = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass });
  process.stdout.write(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (v: unknown, n = 160) =>
  (typeof v === "string" ? v : (JSON.stringify(v) ?? "")).slice(0, n);

function daemonEnv(home: string, importRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k) || k.startsWith("PLUGHIVE_")) continue;
    env[k] = v;
  }
  return {
    ...env,
    PLUGHIVE_PORT: String(PORT),
    PLUGHIVE_BIND_HOST: "127.0.0.1",
    PLUGHIVE_HOME: home,
    PLUGHIVE_NO_DOTENV: "1",
    PLUGHIVE_LOG_LEVEL: "warn",
    PLUGHIVE_CODE_MODE: "1",
    PLUGHIVE_IMPORT_ROOTS: importRoot,
    PLUGHIVE_ADMIN_TOKEN: ADMIN,
    PLUGHIVE_KEYCHAIN_SERVICE: SERVICE,
  };
}

async function waitForHealth(child: ChildProcess, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`daemon exited early with code ${child.exitCode}`);
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("daemon did not become healthy in time");
}

async function stopDaemon(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  const timer = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; j: J }> {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
      "x-plughive-csrf": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, j: await r.json().catch(() => null) };
}

let sessionId: string | undefined;
let nextId = 1;
async function rpc(method: string, params: unknown, notify = false): Promise<J> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ADMIN}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const msg = notify
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: nextId++, method, params };
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify(msg) });
  sessionId = r.headers.get("mcp-session-id") ?? sessionId;
  if (notify) return null;
  const raw = await r.text();
  const data = (r.headers.get("content-type") ?? "").includes("event-stream")
    ? raw
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .pop()
        ?.slice(6)
    : raw;
  return JSON.parse(data ?? "null");
}

/** Calls a tool; `data` is the unwrapped result (or `{error}`). */
async function call(
  name: string,
  args: unknown,
): Promise<{ text: string; data: J; isError: boolean }> {
  const r = await rpc("tools/call", { name, arguments: args });
  const text: string =
    r.result?.content?.find((c: J) => c.type === "text")?.text ??
    JSON.stringify(r.error ?? r.result);
  let data: J = r.result?.structuredContent;
  if (!data) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (data && typeof data === "object" && "ok" in data)
    data = data.ok ? data.result : { error: data.error };
  return { text, data, isError: !!r.result?.isError || !!r.error || !!data?.error };
}

async function waitJob(id: string, ms = 60_000): Promise<J> {
  const end = Date.now() + ms;
  let last: J;
  while (Date.now() < end) {
    last = (await call("get_job_status", { job_id: id })).data;
    if (["succeeded", "failed", "cancelled", "expired"].includes(last?.status)) return last;
    await sleep(400);
  }
  return last;
}

async function script(args: unknown) {
  const r = await call("run_tool_script", args);
  if (!r.data?.job_id) return r;
  const job = await waitJob(r.data.job_id);
  return { isError: job?.status !== "succeeded", text: JSON.stringify(job?.result ?? job?.error) };
}

const describeTool = async (name: string): Promise<J> =>
  (await call("describe_tool", { name })).data?.tools?.[0];

async function checkMcpSurface(dotPath: string) {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plughive-live-check", version: "1" },
  });
  await rpc("notifications/initialized", {}, true);
  const caps = init.result?.capabilities ?? {};
  check(
    "server declares tools, resources and prompts",
    !!caps.tools && !!caps.resources && !!caps.prompts,
  );
  for (const t of [
    "run_tool_script",
    "batch_run",
    "setup_plan",
    "install_software",
    "import_artifact",
  ])
    check(`describe_tool finds ${t}`, !!(await describeTool(t)));

  const imp = await call("import_artifact", { source_path: dotPath, kind: "image" });
  const artId: string | undefined = imp.data?.id ?? imp.data?.artifact?.id;
  check("import_artifact stores a PNG", !imp.isError && !!artId, artId ?? short(imp.text));
  const listed = (await rpc("resources/list", {})).result?.resources ?? [];
  check(
    "resources/list shows the artifact",
    listed.some((x: J) => x.uri === `artifact://${artId}`),
  );
  const templates = (await rpc("resources/templates/list", {})).result?.resourceTemplates ?? [];
  check(
    "resource template artifact://{id}",
    templates.some((t: J) => t.uriTemplate === "artifact://{id}"),
  );
  const content = (await rpc("resources/read", { uri: `artifact://${artId}` })).result
    ?.contents?.[0];
  check("resources/read returns the PNG", !!content?.blob && content.mimeType === "image/png");
  const prompts = (await rpc("prompts/list", {})).result?.prompts ?? [];
  check(
    "prompts/list has the workflows",
    prompts.some((p: J) => p.name === "wf_issue_triage"),
    `${prompts.length}`,
  );
  const pg = await rpc("prompts/get", {
    name: "wf_issue_triage",
    arguments: { title: "Crash", body: "It crashes on start" },
  });
  check(
    "prompts/get renders a workflow",
    (pg.result?.messages ?? []).length > 0,
    short(pg.error?.message ?? ""),
  );
}

async function checkCodeModeAndBatch() {
  const sc = await script({
    code: 'const a = await tools.call("list_artifacts", { limit: 5 }); return Object.keys(a).length > 0;',
  });
  check("run_tool_script calls a tool", !sc.isError && /true/.test(sc.text), short(sc.text));
  const loop = await script({ code: "while (true) {}", timeout_ms: 500 });
  check(
    "run_tool_script stops a runaway loop",
    loop.isError && /ran over|time/i.test(loop.text),
    short(loop.text),
  );
  const globals = await script({
    code: 'return [typeof process, typeof require, typeof fetch].join("/");',
  });
  check(
    "run_tool_script has no process, require or fetch",
    /undefined\/undefined\/undefined/.test(globals.text),
  );

  const b = await call("batch_run", {
    tool: "list_artifacts",
    inputs: [{ limit: 1 }, { limit: 2 }, { limit: 3 }],
    max_items: 3,
  });
  const job = b.data?.job_id ? await waitJob(b.data.job_id) : undefined;
  check(
    "batch_run runs every item as one job",
    job?.status === "succeeded" && job?.result?.succeeded === 3,
    short(job?.result ?? b.text),
  );
  const over = await call("batch_run", { tool: "list_artifacts", inputs: [{}, {}], max_items: 1 });
  check("batch_run refuses more inputs than max_items", over.isError);

  const plan = await call("setup_plan", { goal: "transcribe meetings" });
  check(
    "setup_plan answers with steps",
    !plan.isError && Array.isArray(plan.data?.steps),
    short(plan.data?.goal),
  );
}

async function checkTriggers() {
  const workflows = (await api("GET", "/api/triggers/workflows")).j?.workflows ?? [];
  check("triggers list the workflows", workflows.length > 0, `${workflows.length}`);
  const hook = await api("POST", "/api/triggers", {
    name: "live check hook",
    kind: "webhook",
    workflow: "wf_issue_triage",
    args: { title: "Crash on start", body: "The app crashes." },
    use_body: true,
  });
  const id: string | undefined = hook.j?.trigger?.id;
  const secret: string | undefined = hook.j?.secret;
  check("create a webhook trigger (secret shown once)", hook.status === 201 && !!id && !!secret);
  if (id && secret) {
    const url = `${BASE}/hooks/${id}`;
    const body = JSON.stringify({ title: "From the hook", body: "Signed request" });
    const sign = (ts: string) =>
      `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
    const post = (headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", ...headers },
      });
    check("unsigned webhook refused", (await post({})).status === 401);
    const ts = String(Math.floor(Date.now() / 1000));
    const signedHeaders = { "x-plughive-timestamp": ts, "x-plughive-signature": sign(ts) };
    const signed = await post(signedHeaders);
    const started: J = await signed.json().catch(() => null);
    check("signed webhook starts its workflow", signed.status === 202 && !!started?.job_id);
    check("replayed webhook refused", (await post(signedHeaders)).status === 409);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    check(
      "stale timestamp refused",
      (await post({ "x-plughive-timestamp": old, "x-plughive-signature": sign(old) })).status ===
        401,
    );
    if (started?.job_id) {
      // A fresh home has no chat provider: the run must end, failing with a
      // setup hint rather than hanging.
      const job = await waitJob(started.job_id, 30_000);
      if (WITH_STUB)
        check(
          "the hook's workflow runs to a triage report",
          job?.status === "succeeded" && /Severity: high/.test(short(job?.result, 4000)),
          `${job?.status} ${short(job?.result ?? job?.error)}`,
        );
      else
        check(
          "the hook's run ends (fails cleanly without a chat provider)",
          job?.status === "failed" && /provider|set up/i.test(short(job?.error, 400)),
          `${job?.status}`,
        );
    }
    const detail = await api("GET", `/api/triggers/${id}`);
    check("the trigger records its run", (detail.j?.runs ?? []).length === 1);
    await api("DELETE", `/api/triggers/${id}`);
  }

  const cron = await api("POST", "/api/triggers", {
    name: "live check cron",
    kind: "cron",
    workflow: "wf_issue_triage",
    args: { title: "Nightly", body: "check" },
    schedule: "*/5 * * * *",
  });
  const cronId: string | undefined = cron.j?.trigger?.id;
  check(
    "create a cron trigger with its next run",
    cron.status === 201 && !!cron.j?.trigger?.next_run_at,
  );
  const bad = await api("POST", "/api/triggers", {
    name: "bad",
    kind: "cron",
    workflow: "wf_issue_triage",
    args: { title: "x", body: "y" },
    schedule: "61 * * * *",
  });
  check("an invalid cron schedule is refused", bad.status === 400);
  if (cronId) {
    const run = await api("POST", `/api/triggers/${cronId}/run`, {});
    check("run a cron trigger now", run.status === 202 && !!run.j?.job_id);
    await api("DELETE", `/api/triggers/${cronId}`);
  }
}

async function checkMountsAndPacks() {
  const mounts: J[] = (await api("GET", "/api/mounts")).j?.mounts ?? [];
  const oauth = mounts.filter((m) => m.auth === "oauth");
  check("OAuth mounts are listed", oauth.length >= 5, oauth.map((m) => m.id).join(" "));
  check(
    "no OAuth mount is signed in on a fresh home",
    oauth.every((m) => !m.signedIn),
  );

  const packs: J[] = (await api("GET", "/api/packs")).j?.packs ?? [];
  const byId = new Map(packs.map((p) => [p.id, p]));
  for (const id of ACTION_PACKS)
    check(`action pack loaded: ${id}`, byId.get(id)?.state === "loaded");
  for (const id of OPT_IN_PACKS)
    check(`opt-in pack is off by default: ${id}`, byId.get(id)?.enabled === false);
  for (const name of DESTRUCTIVE) {
    const ann = (await describeTool(name))?.annotations;
    check(`${name} is annotated destructive`, ann?.destructiveHint === true);
  }

  if (!WITH_STUB) {
    const rem = await call("remember", { text: "The launch is on 3 December.", collection: "x" });
    check(
      "memory names the embedding provider to set up",
      rem.isError && /text\.embed/.test(rem.text),
    );
  }
}

/** Hashed bag-of-words vector, so texts that share words point the same way. */
function stubEmbed(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const i = (h >>> 0) % 64;
    v[i] = (v[i] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function startOllamaStub(): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body: J = raw ? JSON.parse(raw) : {};
      const send = (status: number, j: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(j));
      };
      switch (req.url) {
        case "/api/version":
          return send(200, { version: "0.0.0-stub" });
        case "/api/tags":
          return send(200, {
            models: [
              { name: "stub-chat:latest", size: 1, details: { family: "llama" } },
              { name: "nomic-embed-text:latest", size: 1, details: { family: "nomic-bert" } },
            ],
          });
        case "/api/chat":
          return send(200, {
            model: body.model,
            message: { role: "assistant", content: JSON.stringify(STUB_TRIAGE) },
            prompt_eval_count: 40,
            eval_count: 60,
            done_reason: "stop",
          });
        case "/api/embed": {
          const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
          return send(200, { model: body.model, embeddings: input.map(stubEmbed) });
        }
        default:
          return send(404, { error: "not found" });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function checkLocalEngines() {
  const set = await api("PUT", "/api/packs/local/settings", {
    values: { ollamaUrl: `http://127.0.0.1:${STUB_PORT}`, ollamaModel: "stub-chat:latest" },
  });
  check("point the local pack at the Ollama stub", set.status === 200, `${set.status}`);
  const models = await call("local_ollama_models", {});
  check("local_ollama_models reads the stub", models.data?.count === 2, short(models.text));

  const chat = await call("chat", { messages: [{ role: "user", content: "Say hi" }] });
  const chatOut = chat.data?.job_id ? (await waitJob(chat.data.job_id))?.result : chat.data;
  check("chat routes to the local pack", /crashes/.test(short(chatOut, 2000)), short(chatOut));

  for (const [text, id] of [
    ["The launch is on 3 December.", "launch"],
    ["The office plants need water on Fridays.", "plants"],
  ]) {
    const r = await call("remember", { text, collection: "live-check", id });
    check(`remember stores "${id}"`, !r.isError, short(r.text));
  }
  const rec = await call("recall", { query: "when is the launch", collection: "live-check", k: 2 });
  const first = JSON.stringify(rec.data?.results?.[0] ?? "");
  check("recall ranks the matching memory first", /3 December/.test(first), short(rec.text, 240));
  const forget = await call("forget", { collection: "live-check", id: "plants" });
  const after = await call("recall", { query: "plants water", collection: "live-check", k: 5 });
  check(
    "forget removes a memory",
    !forget.isError && !/plants/.test(JSON.stringify(after.data?.results ?? [])),
    short(forget.text),
  );
}

async function checkCliBridge() {
  const enable = await api("POST", "/api/packs/cli-bridge/enable", { grants: [] });
  check("enable the CLI bridge", enable.status === 200);
  const dir = process.env.LIVE_CHECK_CLAUDE_CONFIG_DIR;
  if (dir) {
    const set = await api("PUT", "/api/packs/cli-bridge/settings", {
      values: { claudeConfigDir: dir },
    });
    check("set claudeConfigDir", set.status === 200);
  }
  const clis = await call("list_agent_clis", {});
  const claude = (clis.data?.clis ?? []).find((c: J) => c.cli === "claude");
  check("list_agent_clis finds Claude Code", !!claude?.installed, short(claude));
  const ask = await call("ask_agent_cli", {
    cli: "claude",
    prompt: "Reply with exactly the word PONG and nothing else.",
  });
  let answer = ask.text;
  if (ask.data?.job_id)
    answer = JSON.stringify((await waitJob(ask.data.job_id, 180_000))?.result ?? "");
  check("ask_agent_cli claude answers PONG", /PONG/.test(answer), short(answer));
}

async function main() {
  const entry = join(ROOT, "dist", "src", "server.js");
  if (!existsSync(entry)) throw new Error("dist/src/server.js is missing: run `pnpm build` first");
  const work = mkdtempSync(join(tmpdir(), "plughive-live-"));
  const home = join(work, "home");
  const imports = join(work, "imports");
  mkdirSync(imports, { recursive: true });
  const dotPath = join(imports, "dot.png");
  writeFileSync(dotPath, Buffer.from(DOT_PNG, "base64"));

  const stub = WITH_STUB ? await startOllamaStub() : undefined;
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: daemonEnv(home, imports),
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Say so when the daemon goes away mid-run, so "fetch failed" has a cause.
  let stopping = false;
  child.on("exit", (code, signal) => {
    if (!stopping) process.stderr.write(`[live-check] daemon exited (code ${code}, signal ${signal})\n`);
  });
  try {
    await waitForHealth(child);
    await checkMcpSurface(dotPath);
    await checkCodeModeAndBatch();
    if (WITH_STUB) await checkLocalEngines();
    await checkTriggers();
    await checkMountsAndPacks();
    if (WITH_CLI_BRIDGE) await checkCliBridge();
    else
      process.stdout.write(
        "skip  CLI bridge (pass --cli-bridge; it is billed to your Claude account)\n",
      );
  } finally {
    stopping = true;
    await stopDaemon(child);
    stub?.close();
    rmSync(work, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
  process.stderr.write(`[live-check] ${err instanceof Error ? err.message : String(err)}${cause}\n`);
  process.exitCode = 1;
});
