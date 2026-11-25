// packs/sandbox/e2b.ts
//
// E2B cloud sandboxes.
//   Control plane (X-API-Key), as the official JS SDK calls it
//   (packages/js-sdk/src/sandbox/sandboxApi.ts):
//     POST   https://api.e2b.app/v2/sandboxes                {templateID, timeout (s)}
//     POST   https://api.e2b.app/v2/sandboxes/{id}/connect   -> envdAccessToken, domain
//     DELETE https://api.e2b.app/sandboxes/{id}
//   In-sandbox daemon (envd) at https://49983-{id}.{domain} (connectionConfig.ts):
//     POST /process.Process/Start  Connect server-stream, JSON codec
//                                  (spec/envd/process/process.proto)
//     GET|POST /files?path&username&signature&signature_expiration
//                                  signature = "v1_" + base64(sha256(
//                                  "path:op:user:token:exp")) without padding
// The envd access token is a credential: it is scrubbed and never returned.
import { createHash, randomUUID } from "node:crypto";
import type { PackContext } from "plughive/pack";
import {
  apiError,
  isPathSegment,
  obj,
  readCapped,
  requestBytes,
  requestJson,
  scrub,
  send,
  str,
} from "./http.js";
import { type CommandResult, MAX_FILE_BYTES, capText } from "./shared.js";

const API = "https://api.e2b.app";
const ENVD_PORT = 49983;
const USER = "user";
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

export interface E2bSession {
  id: string;
  base: string;
  token: string | null;
  secrets: string[];
}

async function apiKey(ctx: PackContext): Promise<string> {
  return ctx.secrets.get("E2B_API_KEY");
}

export async function e2bCreate(
  ctx: PackContext,
  template: string,
  timeoutS: number,
): Promise<Record<string, unknown>> {
  const key = await apiKey(ctx);
  const out = obj(
    await requestJson(
      ctx.fetch,
      "E2B",
      `${API}/v2/sandboxes`,
      {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: template, timeout: timeoutS }),
        timeoutMs: 120_000,
      },
      [key],
    ),
  );
  const id = str(out.sandboxID);
  if (!id) throw new Error("E2B created a sandbox but returned no id.");
  return {
    provider: "e2b",
    sandbox_id: id,
    template: str(out.templateID) ?? template,
    timeout_s: timeoutS,
  };
}

/** The domain E2B reports, checked so envd calls stay on E2B hosts. */
function envdBase(id: string, domain: string | null): string {
  const d = domain ?? "e2b.app";
  if (d !== "e2b.app" && !d.endsWith(".e2b.app")) {
    throw new Error("E2B returned an unexpected sandbox domain.");
  }
  return `https://${ENVD_PORT}-${id}.${d}`;
}

/** Looks the sandbox up (connect) for its envd token and domain. */
export async function e2bSession(ctx: PackContext, id: string): Promise<E2bSession> {
  if (!isPathSegment(id)) throw new Error("invalid sandbox id");
  const key = await apiKey(ctx);
  const out = obj(
    await requestJson(
      ctx.fetch,
      "E2B",
      `${API}/v2/sandboxes/${encodeURIComponent(id)}/connect`,
      {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: "{}",
      },
      [key],
    ),
  );
  const token = str(out.envdAccessToken);
  return {
    id,
    base: envdBase(id, str(out.domain)),
    token,
    secrets: token ? [key, token] : [key],
  };
}

function envdHeaders(s: E2bSession): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${USER}:`).toString("base64")}`,
    ...(s.token ? { "X-Access-Token": s.token } : {}),
  };
}

/** One Connect envelope: flags byte, 4-byte big-endian length, JSON. */
export function connectFrame(message: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const out = Buffer.alloc(5 + json.length);
  out.writeUInt8(0, 0);
  out.writeUInt32BE(json.length, 1);
  json.copy(out, 5);
  return new Uint8Array(out);
}

/** Splits a Connect stream body into its envelopes. */
export function parseFrames(bytes: Uint8Array): { flags: number; message: unknown }[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: { flags: number; message: unknown }[] = [];
  let at = 0;
  while (at + 5 <= buf.length) {
    const flags = buf.readUInt8(at);
    const len = buf.readUInt32BE(at + 1);
    const end = at + 5 + len;
    if (end > buf.length) throw new Error("E2B: the command output stream was cut off");
    const text = buf.subarray(at + 5, end).toString("utf8");
    let message: unknown = {};
    try {
      message = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("E2B: the command output stream is not valid JSON");
    }
    frames.push({ flags, message });
    at = end;
  }
  return frames;
}

export async function e2bRun(
  ctx: PackContext,
  s: E2bSession,
  command: string,
  opts: { cwd?: string; timeoutS: number; env?: Record<string, string> },
): Promise<CommandResult> {
  const body = connectFrame({
    process: {
      cmd: "/bin/bash",
      args: ["-l", "-c", command],
      envs: opts.env ?? {},
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    },
  });
  const res = await send(
    ctx.fetch,
    "E2B",
    `${s.base}/process.Process/Start`,
    {
      method: "POST",
      headers: {
        ...envdHeaders(s),
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        "Connect-Timeout-Ms": String(opts.timeoutS * 1000),
      },
      body,
      timeoutMs: opts.timeoutS * 1000 + 15_000,
    },
    s.secrets,
  );
  if (!res.ok) {
    throw await apiError("E2B", res, s.secrets);
  }
  const { bytes, truncated } = await readCapped(res, MAX_STREAM_BYTES);
  const frames = parseFrames(bytes);
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let error: string | null = null;
  for (const f of frames) {
    const m = obj(f.message);
    if (f.flags & 0x02) {
      const e = obj(m.error);
      if (Object.keys(e).length > 0) {
        const msg = str(e.message) ?? str(e.code) ?? "stream error";
        throw new Error(`E2B: ${scrub(msg, s.secrets)}`);
      }
      continue;
    }
    const ev = obj(obj(m.event));
    const data = obj(ev.data);
    if (typeof data.stdout === "string") stdout += Buffer.from(data.stdout, "base64").toString();
    if (typeof data.stderr === "string") stderr += Buffer.from(data.stderr, "base64").toString();
    if (ev.end !== undefined) {
      const end = obj(ev.end);
      // proto3 JSON omits zero values: no exitCode means 0.
      exitCode = typeof end.exitCode === "number" ? end.exitCode : 0;
      error = str(end.error);
    }
  }
  if (exitCode === null && !truncated) {
    throw new Error("E2B: the command ended without an exit status");
  }
  return {
    exit_code: exitCode ?? -1,
    stdout: capText(stdout),
    stderr: capText(stderr),
    ...(error ? { error: scrub(error, s.secrets) } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function filesUrl(s: E2bSession, path: string, op: "read" | "write"): string {
  const q = new URLSearchParams({ path, username: USER });
  if (s.token) {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const hash = createHash("sha256")
      .update(`${path}:${op}:${USER}:${s.token}:${exp}`)
      .digest("base64")
      .replace(/=+$/, "");
    q.set("signature", `v1_${hash}`);
    q.set("signature_expiration", String(exp));
  }
  return `${s.base}/files?${q.toString()}`;
}

export async function e2bWrite(
  ctx: PackContext,
  s: E2bSession,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.split("/").pop() || "file");
  await requestJson(
    ctx.fetch,
    "E2B",
    filesUrl(s, path, "write"),
    { method: "POST", headers: envdHeaders(s), body: form, timeoutMs: 300_000 },
    s.secrets,
  );
}

export async function e2bRead(
  ctx: PackContext,
  s: E2bSession,
  path: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  return requestBytes(
    ctx.fetch,
    "E2B",
    filesUrl(s, path, "read"),
    { headers: envdHeaders(s), timeoutMs: 300_000 },
    s.secrets,
    MAX_FILE_BYTES,
  );
}

export async function e2bRunCode(
  ctx: PackContext,
  s: E2bSession,
  language: "python" | "javascript",
  code: string,
  timeoutS: number,
): Promise<CommandResult> {
  const ext = language === "python" ? "py" : "js";
  const file = `/tmp/mcp-run-${randomUUID()}.${ext}`;
  await e2bWrite(ctx, s, file, new TextEncoder().encode(code));
  const bin = language === "python" ? "python3" : "node";
  return e2bRun(ctx, s, `${bin} ${file}; rc=$?; rm -f ${file}; exit $rc`, { timeoutS });
}

export async function e2bDestroy(ctx: PackContext, id: string): Promise<boolean> {
  if (!isPathSegment(id)) throw new Error("invalid sandbox id");
  const key = await apiKey(ctx);
  const res = await send(
    ctx.fetch,
    "E2B",
    `${API}/sandboxes/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { "X-API-Key": key } },
    [key],
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    throw await apiError("E2B", res, [key]);
  }
  await res.body?.cancel().catch(() => {});
  return true;
}
