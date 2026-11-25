// packs/sandbox/daytona.ts
//
// Daytona cloud sandboxes (Bearer API key), from the published OpenAPI specs
// https://www.daytona.io/docs/openapi.json and /docs/toolbox-openapi.json:
//   POST   https://app.daytona.io/api/sandbox            CreateSandbox {snapshot, autoStopInterval, labels}
//   GET    https://app.daytona.io/api/sandbox/{id}       Sandbox {state, toolboxProxyUrl}
//   DELETE https://app.daytona.io/api/sandbox/{id}
//   Toolbox at {toolboxProxyUrl}/{id}:
//     POST /process/execute   {command, cwd, envs, timeout (s)} -> {exitCode, result}
//     POST /process/code-run  {code, language, timeout}         -> {exitCode, result}
//     POST /files/upload-v2?path=   multipart "file"
//     GET  /files/download?path=
import type { PackContext } from "plughive/pack";
import { isPathSegment, num, obj, requestBytes, requestJson, str } from "./http.js";
import { type CommandResult, MAX_FILE_BYTES, capText } from "./shared.js";

const API = "https://app.daytona.io/api";
const DEFAULT_TOOLBOX = "https://proxy.app.daytona.io/toolbox";
const START_WAIT_MS = 90_000;

async function key(ctx: PackContext): Promise<string> {
  return ctx.secrets.get("DAYTONA_API_KEY");
}

async function api(
  ctx: PackContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const k = await key(ctx);
  return obj(
    await requestJson(
      ctx.fetch,
      "Daytona",
      `${API}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${k}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: 120_000,
      },
      [k],
    ),
  );
}

function checkId(id: string): string {
  if (!isPathSegment(id)) throw new Error("invalid sandbox id");
  return encodeURIComponent(id);
}

const FAILED = new Set(["error", "build_failed", "destroyed", "destroying"]);

export async function daytonaCreate(
  ctx: PackContext,
  opts: { snapshot?: string; autoStopMinutes: number },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Record<string, unknown>> {
  let sb = await api(ctx, "POST", "/sandbox", {
    ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
    autoStopInterval: opts.autoStopMinutes,
    labels: { "created-by": "plughive" },
  });
  const id = str(sb.id);
  if (!id) throw new Error("Daytona created a sandbox but returned no id.");
  const deadline = Date.now() + START_WAIT_MS;
  while (str(sb.state) !== "started") {
    const state = str(sb.state) ?? "unknown";
    if (FAILED.has(state)) {
      throw new Error(`Daytona sandbox ${id} is ${state}: ${str(sb.errorReason) ?? "no reason"}`);
    }
    if (Date.now() > deadline) {
      return { provider: "daytona", sandbox_id: id, state, ready: false };
    }
    await sleep(1000);
    sb = await api(ctx, "GET", `/sandbox/${checkId(id)}`);
  }
  return {
    provider: "daytona",
    sandbox_id: id,
    state: "started",
    ready: true,
    auto_stop_minutes: num(sb.autoStopInterval) ?? opts.autoStopMinutes,
  };
}

/** The sandbox's toolbox base URL, kept on Daytona's proxy host. */
async function toolbox(ctx: PackContext, id: string): Promise<{ base: string; secret: string }> {
  const sb = await api(ctx, "GET", `/sandbox/${checkId(id)}`);
  const state = str(sb.state);
  if (state !== "started") {
    throw new Error(`Daytona sandbox ${id} is ${state ?? "unknown"}, not started.`);
  }
  let proxy = str(sb.toolboxProxyUrl) ?? DEFAULT_TOOLBOX;
  try {
    const u = new URL(proxy);
    if (u.protocol !== "https:" || u.hostname !== "proxy.app.daytona.io") proxy = DEFAULT_TOOLBOX;
  } catch {
    proxy = DEFAULT_TOOLBOX;
  }
  return { base: `${proxy.replace(/\/+$/, "")}/${checkId(id)}`, secret: await key(ctx) };
}

async function tb(
  ctx: PackContext,
  id: string,
  path: string,
  body: unknown,
  timeoutS: number,
): Promise<Record<string, unknown>> {
  const t = await toolbox(ctx, id);
  return obj(
    await requestJson(
      ctx.fetch,
      "Daytona",
      `${t.base}${path}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${t.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: timeoutS * 1000 + 15_000,
      },
      [t.secret],
    ),
  );
}

function result(out: Record<string, unknown>): CommandResult {
  const r = out.result;
  return {
    exit_code: num(out.exitCode) ?? 0,
    stdout: capText(typeof r === "string" ? r : ""),
  };
}

export async function daytonaRun(
  ctx: PackContext,
  id: string,
  command: string,
  opts: { cwd?: string; timeoutS: number; env?: Record<string, string> },
): Promise<CommandResult> {
  // execute runs argv without a shell: hand the script to sh through base64,
  // so quotes and pipes in `command` reach the shell unchanged.
  const b64 = Buffer.from(command, "utf8").toString("base64");
  return result(
    await tb(
      ctx,
      id,
      "/process/execute",
      {
        command: `sh -c "echo ${b64} | base64 -d | sh"`,
        timeout: opts.timeoutS,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { envs: opts.env } : {}),
      },
      opts.timeoutS,
    ),
  );
}

export async function daytonaRunCode(
  ctx: PackContext,
  id: string,
  language: "python" | "javascript",
  code: string,
  timeoutS: number,
): Promise<CommandResult> {
  return result(
    await tb(ctx, id, "/process/code-run", { code, language, timeout: timeoutS }, timeoutS),
  );
}

export async function daytonaWrite(
  ctx: PackContext,
  id: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const t = await toolbox(ctx, id);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.split("/").pop() || "file");
  await requestJson(
    ctx.fetch,
    "Daytona",
    `${t.base}/files/upload-v2?${new URLSearchParams({ path }).toString()}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${t.secret}` },
      body: form,
      timeoutMs: 300_000,
    },
    [t.secret],
  );
}

export async function daytonaRead(
  ctx: PackContext,
  id: string,
  path: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const t = await toolbox(ctx, id);
  return requestBytes(
    ctx.fetch,
    "Daytona",
    `${t.base}/files/download?${new URLSearchParams({ path }).toString()}`,
    { headers: { Authorization: `Bearer ${t.secret}` }, timeoutMs: 300_000 },
    [t.secret],
    MAX_FILE_BYTES,
  );
}

export async function daytonaDestroy(ctx: PackContext, id: string): Promise<boolean> {
  await api(ctx, "DELETE", `/sandbox/${checkId(id)}`);
  return true;
}
