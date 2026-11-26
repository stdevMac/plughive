// Test harness for the local pack: an in-memory library on a temp dir, a real
// (child_process) spawn for the integration tests and recording mocks for the
// unit tests.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRecord, PackContext } from "plughive/pack";

/** A library record plus where the fake library keeps its bytes. */
export type StoredRecord = ArtifactRecord & { path: string };
import { fakeCtx } from "../support.js";

export interface Env {
  dir: string;
  dataDir: string;
  libDir: string;
  records: Map<string, StoredRecord>;
  ctx: PackContext;
  /** Add bytes to the library; returns the artifact id. */
  add(
    name: string,
    bytes: Uint8Array | string,
    mime?: string,
    kind?: ArtifactRecord["kind"],
  ): string;
  /** Add an existing file by copying it. */
  addFile(src: string, mime?: string, kind?: ArtifactRecord["kind"]): string;
  cleanup(): void;
}

export interface SpawnCall {
  binary: string;
  args: readonly string[];
  opts?: { cwd?: string; timeoutMs?: number; input?: string | Uint8Array };
}
export type SpawnResultLike = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
};
export type Spawner = (
  binary: string,
  args: readonly string[],
  opts?: SpawnCall["opts"],
) => Promise<SpawnResultLike>;

/** A real spawn that mimics the kernel: no shell, bounded output, timeout. */
export const realSpawn: Spawner = (binary, args, opts) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(binary, [...args], { cwd: opts?.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts?.timeoutMs ?? 60_000);
    child.stdout.on("data", (d) => {
      if (stdout.length < 2_000_000) stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 2_000_000) stderr += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    if (opts?.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });

export function makeEnv(
  opts: {
    spawn?: Spawner;
    fetch?: PackContext["fetch"];
    settings?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
): Env {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "local-pack-test-")));
  const dataDir = join(dir, "data");
  const libDir = join(dir, "lib");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  const records = new Map<string, StoredRecord>();
  let n = 0;
  const store = (
    name: string,
    bytes: Uint8Array | string,
    mime: string,
    kind: ArtifactRecord["kind"],
    tool = "test",
  ) => {
    const id = `art${++n}`;
    const path = join(libDir, `${id}-${name}`);
    writeFileSync(path, bytes);
    records.set(id, {
      id,
      kind,
      mime,
      path,
      url: `http://127.0.0.1:7777/a/${id}`,
      bytes: statSync(path).size,
      tool,
      model: null,
      prompt: null,
      meta: null,
      costUsd: null,
      createdAt: new Date().toISOString(),
    });
    return id;
  };
  const ref = (id: string) => {
    const r = records.get(id) as StoredRecord;
    return { id, path: r.path, url: `http://127.0.0.1:7777/a/${id}`, mime: r.mime, bytes: r.bytes };
  };
  const base = fakeCtx({
    packId: "local",
    dataDir,
    ...(opts.settings ? { settings: opts.settings } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.spawn ? { spawn: opts.spawn as PackContext["spawn"] } : {}),
    library: {
      get: async (id: string) => records.get(id) ?? null,
      read: async (id: string) => {
        const r = records.get(id);
        if (!r) throw new Error("not found");
        return readFileSync(r.path);
      },
      // Mimics the kernel: a fresh read-only copy in a dataDir subfolder.
      materialize: async (id: string, mopts?: { dir?: string }) => {
        const r = records.get(id);
        if (!r) throw new Error("not found");
        const dir = join(dataDir, mopts?.dir ?? ".materialized");
        mkdirSync(dir, { recursive: true });
        const ext = r.path.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? ".bin";
        const path = join(dir, `${id}-${++n}${ext}`);
        copyFileSync(r.path, path);
        chmodSync(path, 0o400);
        return {
          path,
          bytes: r.bytes,
          mime: r.mime,
          cleanup: async () => rmSync(path, { force: true }),
        };
      },
      save: async (input) => ref(store("saved", input.bytes, input.mime, input.kind, input.tool)),
      importFile: async (input) => {
        const id = store("imported", "", input.mime, input.kind, input.tool);
        const r = records.get(id) as StoredRecord;
        copyFileSync(input.sourcePath, r.path);
        r.bytes = statSync(r.path).size;
        r.meta = input.meta ?? null;
        return ref(id);
      },
    },
  });
  const ctx = (opts.signal ? { ...base, signal: opts.signal } : base) as PackContext;
  return {
    dir,
    dataDir,
    libDir,
    records,
    ctx,
    add: (name, bytes, mime = "application/octet-stream", kind = "other") =>
      store(name, bytes, mime, kind),
    addFile(src, mime = "application/octet-stream", kind = "other") {
      return store(src.split("/").pop() ?? "file", readFileSync(src), mime, kind);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function ffmpegPresent(): boolean {
  try {
    return (
      spawnSync("ffmpeg", ["-version"]).status === 0 &&
      spawnSync("ffprobe", ["-version"]).status === 0
    );
  } catch {
    return false;
  }
}

/** Run a real ffmpeg to create a fixture file. */
export async function makeFixture(env: Env, name: string, args: string[]): Promise<string> {
  const out = join(env.dir, name);
  const r = await realSpawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  if (r.exitCode !== 0) throw new Error(`fixture failed: ${r.stderr}`);
  return out;
}

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route fetch calls by "METHOD path" (query string included) to canned responses. */
export function routedFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
  log: string[] = [],
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.pathname}${u.search}`;
    log.push(`${key} ${u.host}`);
    const handler = routes[key] ?? routes[`${init?.method ?? "GET"} ${u.pathname}`];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(init);
  }) as PackContext["fetch"];
}

/** A spawn that records calls and answers from a script. */
export function recordingSpawn(
  answer: (call: SpawnCall) => SpawnResultLike | Promise<SpawnResultLike>,
) {
  const calls: SpawnCall[] = [];
  const spawn: Spawner = async (binary, args, opts) => {
    const call = { binary, args, ...(opts ? { opts } : {}) };
    calls.push(call);
    return answer(call);
  };
  return { calls, spawn };
}
