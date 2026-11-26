// packs/local/comfy.ts
//
// ComfyUI: status, running an API-format workflow and a built-in txt2img graph.
import { randomInt, randomUUID } from "node:crypto";
import { defineTool, z } from "plughive/pack";
import type { ArtifactRef, PackContext, PackFetch } from "plughive/pack";
import {
  HINTS,
  LocalBackendError,
  artifactOut,
  backendFetch,
  baseUrl,
  cancelled,
  errorExcerpt,
  readBytes,
  readJson,
  round,
  throwIfCancelled,
} from "./lib/util.js";

const BACKEND = "ComfyUI";
const MAX_NODES = 500;
const MAX_WORKFLOW_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUTS = 16;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;

const MIME: Record<string, { mime: string; kind: "image" | "video" | "audio" | "other" }> = {
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  mp4: { mime: "video/mp4", kind: "video" },
  webm: { mime: "video/webm", kind: "video" },
  mov: { mime: "video/quicktime", kind: "video" },
  wav: { mime: "audio/wav", kind: "audio" },
  mp3: { mime: "audio/mpeg", kind: "audio" },
  flac: { mime: "audio/flac", kind: "audio" },
  ogg: { mime: "audio/ogg", kind: "audio" },
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function get<T>(ctx: PackContext, path: string, timeoutMs = 15_000): Promise<T> {
  const res = await backendFetch(ctx, BACKEND, HINTS.comfy, baseUrl(ctx, "comfyUrl"), path, {
    timeoutMs,
  });
  if (!res.ok) throw new Error(`ComfyUI ${path.split("?")[0]} returned HTTP ${res.status}`);
  return readJson<T>(res);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

interface ObjectInfo {
  CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } };
}

export async function listCheckpoints(ctx: PackContext): Promise<string[]> {
  const info = await get<ObjectInfo>(ctx, "/object_info/CheckpointLoaderSimple");
  const names = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

export async function comfyStatus(ctx: PackContext) {
  const stats = await get<{
    system?: { comfyui_version?: string; python_version?: string };
    devices?: Array<{ name?: string; type?: string; vram_total?: number; vram_free?: number }>;
  }>(ctx, "/system_stats");
  const queue = await get<{ queue_running?: unknown[]; queue_pending?: unknown[] }>(
    ctx,
    "/queue",
  ).catch(() => null);
  const checkpoints = await listCheckpoints(ctx).catch(() => [] as string[]);
  return {
    reachable: true,
    version: stats.system?.comfyui_version ?? null,
    devices: (stats.devices ?? []).map((d) => ({
      name: d.name ?? null,
      type: d.type ?? null,
      vram_total: d.vram_total ?? null,
      vram_free: d.vram_free ?? null,
    })),
    queue: queue
      ? { running: queue.queue_running?.length ?? 0, pending: queue.queue_pending?.length ?? 0 }
      : null,
    checkpoints,
  };
}

// ---------------------------------------------------------------------------
// workflow validation
// ---------------------------------------------------------------------------

export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** Accepts API-format workflow JSON only (node id -> {class_type, inputs}). */
export function validateWorkflow(raw: unknown): Workflow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "workflow must be an object in ComfyUI API format (node id -> {class_type, inputs})",
    );
  }
  if (Array.isArray((raw as { nodes?: unknown }).nodes)) {
    throw new Error(
      'this looks like a UI-format workflow (it has "nodes"). Export it with "Save (API Format)" in ComfyUI and pass that JSON.',
    );
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) throw new Error("workflow has no nodes");
  if (entries.length > MAX_NODES)
    throw new Error(`workflow has ${entries.length} nodes, over the ${MAX_NODES} limit`);
  if (JSON.stringify(raw).length > MAX_WORKFLOW_BYTES)
    throw new Error("workflow JSON is too large");
  for (const [id, node] of entries) {
    const n = node as { class_type?: unknown; inputs?: unknown };
    if (
      !node ||
      typeof node !== "object" ||
      typeof n.class_type !== "string" ||
      !n.inputs ||
      typeof n.inputs !== "object" ||
      Array.isArray(n.inputs)
    ) {
      throw new Error(
        `workflow node ${JSON.stringify(id.slice(0, 40))} must have a class_type string and an inputs object`,
      );
    }
  }
  return raw as Workflow;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
}
interface HistoryEntry {
  outputs?: Record<string, Record<string, unknown>>;
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const OUTPUT_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The output names come from ComfyUI's history (the workflow's nodes decide
 * them) and are sent to `/view`, whose server side joins them onto the output
 * folder — so a name with path segments or a leading "-" is refused here
 * before the request is made. Returns null when both are plain names.
 */
export function outputPathProblem(filename: string, subfolder: string): string | null {
  if (filename.length === 0 || filename.length > 1024)
    return "the output filename is empty or over 1024 characters";
  if (
    /[/\\]/.test(filename) ||
    filename.startsWith("-") ||
    OUTPUT_CONTROL.test(filename) ||
    filename === "." ||
    filename === ".."
  ) {
    return 'the output filename must be a plain name: no slashes, no leading "-", not "." or ".."';
  }
  if (subfolder.length > 1024) return "the output subfolder is over 1024 characters";
  if (/\\/.test(subfolder) || OUTPUT_CONTROL.test(subfolder))
    return "the output subfolder must not contain backslashes or control characters";
  if (subfolder !== "") {
    for (const seg of subfolder.split("/")) {
      if (seg === "" || seg === "." || seg === ".." || seg.startsWith("-"))
        return "the output subfolder must be slash-separated plain names (no empty, dot or dot-dot segments, no leading dash)";
    }
  }
  return null;
}

export function collectOutputs(entry: HistoryEntry): OutputFile[] {
  const files: OutputFile[] = [];
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const list of Object.values(out)) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        const o = f as Partial<OutputFile>;
        if (typeof o?.filename === "string" && o.type === "output") {
          const subfolder = typeof o.subfolder === "string" ? o.subfolder : "";
          // Fail closed: a name that could traverse out of ComfyUI's output
          // folder on /view refuses the run instead of being fetched.
          const problem = outputPathProblem(o.filename, subfolder);
          if (problem) {
            throw new Error(
              `refusing a ComfyUI output: ${problem} (filename ${JSON.stringify(o.filename.slice(0, 80))}, subfolder ${JSON.stringify(subfolder.slice(0, 80))})`,
            );
          }
          files.push({
            filename: o.filename,
            subfolder,
            type: "output",
          });
        }
      }
    }
  }
  return files;
}

/** The service key setup() stores the pack-lifetime fetch under. */
export const LIFETIME_FETCH = "localLifetimeFetch";

/**
 * The fetch captured in setup(). It is bound to the pack's lifetime, so the
 * stop request still goes out after the call was aborted (the per-call
 * ctx.fetch refuses to run once the call signal fired).
 */
function lifetimeFetch(ctx: PackContext): PackFetch {
  const f = (ctx as PackContext & { [LIFETIME_FETCH]?: PackFetch })[LIFETIME_FETCH];
  return typeof f === "function" ? f : ctx.fetch;
}

type QueueItem = unknown[];
const inQueue = (list: unknown, id: string) =>
  Array.isArray(list) && list.some((it) => Array.isArray(it) && (it as QueueItem)[1] === id);

/**
 * Stop one prompt, never touching other users' jobs: delete it from the queue
 * when it is still pending, interrupt it (by prompt_id) when it is running.
 * When the queue cannot be read, sends both. Never throws; returns a sentence
 * that says truthfully what was sent.
 */
export async function stopPrompt(
  ctx: PackContext,
  base: string,
  promptId: string,
): Promise<string> {
  const f = lifetimeFetch(ctx);
  const post = async (path: string, body: unknown): Promise<boolean> => {
    try {
      const res = await f(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 6_000,
      });
      await res.arrayBuffer().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  };
  let where: "running" | "pending" | "gone" | "unknown" = "unknown";
  try {
    const res = await f(`${base}/queue`, { method: "GET", timeoutMs: 6_000 });
    if (res.ok) {
      const q = await readJson<{ queue_running?: unknown; queue_pending?: unknown }>(res);
      where = inQueue(q.queue_running, promptId)
        ? "running"
        : inQueue(q.queue_pending, promptId)
          ? "pending"
          : "gone";
    } else {
      await res.arrayBuffer().catch(() => undefined);
    }
  } catch {
    where = "unknown";
  }
  const unsent = `The stop request for ComfyUI prompt ${promptId} did not reach ComfyUI, so it may keep running on your GPU (local, nothing is billed). Stop it from the ComfyUI queue.`;
  switch (where) {
    case "pending":
      return (await post("/queue", { delete: [promptId] }))
        ? `ComfyUI prompt ${promptId} was removed from the queue before it started.`
        : unsent;
    case "running":
      return (await post("/interrupt", { prompt_id: promptId }))
        ? `An interrupt for ComfyUI prompt ${promptId} was sent; it stops at the current node.`
        : unsent;
    case "gone":
      return `ComfyUI prompt ${promptId} was no longer queued or running, so nothing was stopped (it may have just finished; its outputs stay in ComfyUI's output folder).`;
    default: {
      const deleted = await post("/queue", { delete: [promptId] });
      const interrupted = await post("/interrupt", { prompt_id: promptId });
      return deleted || interrupted
        ? `The ComfyUI queue could not be read, so a queue delete and an interrupt for prompt ${promptId} were sent.`
        : unsent;
    }
  }
}

export interface RunWorkflowOptions {
  timeoutS?: number;
  tool?: string;
  prompt?: string | null;
  model?: string | null;
  meta?: Record<string, unknown>;
}

export async function runWorkflow(
  ctx: PackContext,
  workflow: Workflow,
  opts: RunWorkflowOptions = {},
) {
  const base = baseUrl(ctx, "comfyUrl");
  const timeoutS = Math.min(opts.timeoutS ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
  const tool = opts.tool ?? "local_comfy_run_workflow";
  ctx.progress?.(0.02, "queueing workflow");
  const queued = await backendFetch(ctx, BACKEND, HINTS.comfy, base, "/prompt", {
    json: { prompt: workflow, client_id: randomUUID() },
    timeoutMs: 30_000,
  });
  if (!queued.ok) {
    let detail = "";
    try {
      const j = await readJson<{
        error?: { message?: string };
        node_errors?: Record<string, unknown>;
      }>(queued, 1024 * 1024);
      const nodes = Object.keys(j.node_errors ?? {});
      detail =
        `${j.error?.message ?? ""}${nodes.length ? ` (nodes with errors: ${nodes.slice(0, 8).join(", ")})` : ""}`.trim();
    } catch {
      detail = await errorExcerpt(queued);
    }
    throw new Error(
      `ComfyUI rejected the workflow (HTTP ${queued.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const { prompt_id: promptId } = await readJson<{ prompt_id?: string }>(queued);
  if (typeof promptId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(promptId)) {
    throw new Error("ComfyUI did not return a prompt id");
  }

  const started = Date.now();
  let entry: HistoryEntry | undefined;
  let delay = 500;
  for (;;) {
    if (cancelled(ctx)) {
      throw new Error(`cancelled. ${await stopPrompt(ctx, base, promptId)}`);
    }
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed > timeoutS) {
      const note = await stopPrompt(ctx, base, promptId);
      throw new Error(
        `ComfyUI did not finish within ${timeoutS} s. ${note} Raise timeout_s (max ${MAX_TIMEOUT_S}) for slow workflows.`,
      );
    }
    const history = await get<Record<string, HistoryEntry>>(ctx, `/history/${promptId}`).catch(
      (e) => {
        if (cancelled(ctx)) throw e;
        if (e instanceof LocalBackendError) throw e;
        return {} as Record<string, HistoryEntry>;
      },
    );
    const found = history[promptId];
    if (
      found &&
      (found.status?.completed ||
        found.status?.status_str === "success" ||
        found.status?.status_str === "error" ||
        found.outputs)
    ) {
      entry = found;
      break;
    }
    ctx.progress?.(
      Math.min(0.9, 0.05 + 0.85 * (1 - Math.exp(-elapsed / 60))),
      `running (${Math.round(elapsed)} s)`,
    );
    await sleep(delay, ctx.signal);
    delay = Math.min(delay * 1.5, 3000);
  }
  throwIfCancelled(ctx);
  if (entry.status?.status_str === "error") {
    throw new Error(
      "ComfyUI reported an error while running the workflow; check the ComfyUI console for the failing node",
    );
  }

  const files = collectOutputs(entry);
  if (files.length === 0) {
    throw new Error(
      "the workflow finished but produced no saved outputs; add a SaveImage (or equivalent save) node",
    );
  }
  const artifacts: ArtifactRef[] = [];
  for (const [i, f] of files.slice(0, MAX_OUTPUTS).entries()) {
    throwIfCancelled(ctx);
    ctx.progress?.(
      0.9 + (0.09 * i) / files.length,
      `downloading ${i + 1}/${Math.min(files.length, MAX_OUTPUTS)}`,
    );
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder, type: f.type });
    const res = await backendFetch(ctx, BACKEND, HINTS.comfy, base, `/view?${q.toString()}`, {
      timeoutMs: 120_000,
    });
    if (!res.ok)
      throw new Error(`ComfyUI /view returned HTTP ${res.status} for ${f.filename.slice(0, 80)}`);
    const bytes = await readBytes(res, MAX_OUTPUT_BYTES);
    const ext = (f.filename.split(".").pop() ?? "").toLowerCase();
    const type = MIME[ext] ?? { mime: "application/octet-stream", kind: "other" as const };
    artifacts.push(
      await ctx.library.save({
        kind: type.kind,
        mime: type.mime,
        bytes,
        tool,
        model: opts.model ?? null,
        prompt: opts.prompt ?? null,
        meta: { prompt_id: promptId, filename: f.filename, ...(opts.meta ?? {}) },
      }),
    );
  }
  return {
    prompt_id: promptId,
    artifacts: artifacts.map(artifactOut),
    outputs_skipped: Math.max(0, files.length - MAX_OUTPUTS),
    seconds: round((Date.now() - started) / 1000, 1),
  };
}

// ---------------------------------------------------------------------------
// built-in txt2img
// ---------------------------------------------------------------------------

const SD15_SIZES: Record<string, [number, number]> = {
  "1:1": [512, 512],
  "16:9": [768, 432],
  "9:16": [432, 768],
  "4:3": [640, 480],
  "3:4": [480, 640],
  "3:2": [768, 512],
  "2:3": [512, 768],
};
const SDXL_SIZES: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 896],
  "3:4": [896, 1152],
  "3:2": [1216, 832],
  "2:3": [832, 1216],
};

export function sizeFor(checkpoint: string, aspect: string): [number, number] {
  const table = /xl|sdxl|pony|illustrious|flux/i.test(checkpoint) ? SDXL_SIZES : SD15_SIZES;
  return table[aspect] ?? table["1:1"] ?? [512, 512];
}

export function pickCheckpoint(available: readonly string[], requested?: string): string {
  if (available.length === 0) {
    throw new LocalBackendError(
      `ComfyUI has no checkpoints installed. Put a .safetensors model in ComfyUI/models/checkpoints and restart or refresh ComfyUI. ${HINTS.comfy}`,
    );
  }
  if (!requested) return available[0] as string;
  const exact = available.find((c) => c === requested);
  if (exact) return exact;
  const loose = available.filter((c) => c.toLowerCase().includes(requested.toLowerCase()));
  if (loose.length === 1) return loose[0] as string;
  throw new Error(
    `checkpoint ${JSON.stringify(requested.slice(0, 100))} ${loose.length > 1 ? "matches several installed checkpoints" : "is not installed"}. Installed: ${available.slice(0, 20).join(", ")}`,
  );
}

export interface Txt2ImgParams {
  checkpoint: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  n: number;
  seed: number;
  steps: number;
  cfg: number;
}

export function buildTxt2ImgWorkflow(p: Txt2ImgParams): Workflow {
  return {
    ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
    pos: { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: ["ckpt", 1] } },
    neg: { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: ["ckpt", 1] } },
    latent: {
      class_type: "EmptyLatentImage",
      inputs: { width: p.width, height: p.height, batch_size: p.n },
    },
    sampler: {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["ckpt", 0],
        positive: ["pos", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
      },
    },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0], vae: ["ckpt", 2] } },
    save: {
      class_type: "SaveImage",
      inputs: { filename_prefix: "plughive", images: ["decode", 0] },
    },
  };
}

export const GenerateInput = z.object({
  prompt: z.string().min(1).max(4000),
  negative_prompt: z.string().max(2000).optional(),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Checkpoint file name (or a unique part of it). Default: the first checkpoint ComfyUI reports.",
    ),
  aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).optional(),
  n: z.number().int().min(1).max(4).optional(),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1)
    .optional(),
  steps: z.number().int().min(1).max(60).optional(),
  cfg: z.number().min(1).max(20).optional(),
  timeout_s: z.number().int().min(10).max(MAX_TIMEOUT_S).optional(),
});
export type GenerateArgs = z.output<typeof GenerateInput>;

export async function generateImage(
  ctx: PackContext,
  input: GenerateArgs,
  tool = "local_generate_image",
) {
  const checkpoint = pickCheckpoint(await listCheckpoints(ctx), input.model);
  const [width, height] = sizeFor(checkpoint, input.aspect_ratio ?? "1:1");
  const seed = input.seed ?? randomInt(0, 2 ** 32);
  const wf = buildTxt2ImgWorkflow({
    checkpoint,
    prompt: input.prompt,
    negative: input.negative_prompt ?? "",
    width,
    height,
    n: input.n ?? 1,
    seed,
    steps: input.steps ?? 20,
    cfg: input.cfg ?? 7,
  });
  const r = await runWorkflow(ctx, wf, {
    timeoutS: input.timeout_s ?? 900,
    tool,
    prompt: input.prompt,
    model: checkpoint,
    meta: { seed, width, height },
  });
  return { artifacts: r.artifacts, model: checkpoint, seed, width, height, seconds: r.seconds };
}

// ---------------------------------------------------------------------------
// img2img (image.edit)
// ---------------------------------------------------------------------------

const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
const EDIT_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Upload an image to ComfyUI's input folder; returns the name LoadImage takes. */
export async function uploadImage(
  ctx: PackContext,
  bytes: Uint8Array,
  mime: string,
  name: string,
): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), name);
  form.append("type", "input");
  form.append("overwrite", "true");
  const res = await backendFetch(
    ctx,
    BACKEND,
    HINTS.comfy,
    baseUrl(ctx, "comfyUrl"),
    "/upload/image",
    { form, timeoutMs: 60_000 },
  );
  if (!res.ok) {
    throw new Error(
      `ComfyUI /upload/image returned HTTP ${res.status}: ${await errorExcerpt(res)}`,
    );
  }
  const j = await readJson<{ name?: string; subfolder?: string }>(res);
  if (typeof j.name !== "string" || j.name === "") {
    throw new Error("ComfyUI did not name the uploaded image");
  }
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

export interface Img2ImgParams {
  checkpoint: string;
  image: string;
  prompt: string;
  negative: string;
  n: number;
  seed: number;
  steps: number;
  cfg: number;
  denoise: number;
}

/** LoadImage -> VAEEncode -> KSampler (partial denoise) -> VAEDecode -> SaveImage. */
export function buildImg2ImgWorkflow(p: Img2ImgParams): Workflow {
  return {
    ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: p.checkpoint } },
    load: { class_type: "LoadImage", inputs: { image: p.image } },
    encode: { class_type: "VAEEncode", inputs: { pixels: ["load", 0], vae: ["ckpt", 2] } },
    batch: { class_type: "RepeatLatentBatch", inputs: { samples: ["encode", 0], amount: p.n } },
    pos: { class_type: "CLIPTextEncode", inputs: { text: p.prompt, clip: ["ckpt", 1] } },
    neg: { class_type: "CLIPTextEncode", inputs: { text: p.negative, clip: ["ckpt", 1] } },
    sampler: {
      class_type: "KSampler",
      inputs: {
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: p.denoise,
        model: ["ckpt", 0],
        positive: ["pos", 0],
        negative: ["neg", 0],
        latent_image: ["batch", 0],
      },
    },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sampler", 0], vae: ["ckpt", 2] } },
    save: {
      class_type: "SaveImage",
      inputs: { filename_prefix: "plughive-edit", images: ["decode", 0] },
    },
  };
}

export interface EditImageArgs {
  artifact_id: string;
  prompt: string;
  model?: string;
  n?: number;
  seed?: number;
  denoise?: number;
}

export const EDIT_DENOISE = 0.6;

/**
 * Prompt-guided edit as img2img: the whole picture is redrawn at partial
 * strength, so it suits restyling better than small local changes.
 */
export async function editImage(ctx: PackContext, input: EditImageArgs, tool = "image_edit") {
  const record = await ctx.library.get(input.artifact_id);
  if (!record) throw new Error(`artifact not found: ${input.artifact_id}`);
  const ext = EDIT_MIMES[record.mime];
  if (!ext) {
    throw new Error(
      `artifact ${input.artifact_id} is ${record.mime}, not a PNG, JPEG or WebP image`,
    );
  }
  if ((record.bytes ?? 0) > UPLOAD_MAX_BYTES) throw new Error("the image is over 64 MB");
  const checkpoint = pickCheckpoint(await listCheckpoints(ctx), input.model);
  ctx.progress?.(0.02, "uploading image");
  const bytes = await ctx.library.read(input.artifact_id);
  const name = await uploadImage(ctx, bytes, record.mime, `plughive-${randomUUID()}.${ext}`);
  const seed = input.seed ?? randomInt(0, 2 ** 32);
  const denoise = input.denoise ?? EDIT_DENOISE;
  const wf = buildImg2ImgWorkflow({
    checkpoint,
    image: name,
    prompt: input.prompt,
    negative: "",
    n: input.n ?? 1,
    seed,
    steps: 25,
    cfg: 7,
    denoise,
  });
  const r = await runWorkflow(ctx, wf, {
    timeoutS: 900,
    tool,
    prompt: input.prompt,
    model: checkpoint,
    meta: { seed, source: input.artifact_id, denoise },
  });
  return { artifacts: r.artifacts, model: checkpoint, seed };
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/**
 * Raw workflows can run any node installed in ComfyUI (custom nodes that read
 * files, download models or reach the network), so the tool is off until the
 * user turns it on; only the dashboard / admin API can change pack settings.
 */
export function assertRawWorkflowsAllowed(ctx: PackContext): void {
  if (ctx.settings.allowRawComfyWorkflows === true) return;
  throw new Error(
    "local_comfy_run_workflow is turned off: arbitrary ComfyUI node graphs can run any installed custom node, including ones that read files or reach the network. " +
      'To allow it, turn on "Allow raw ComfyUI workflows" (allowRawComfyWorkflows) in the dashboard (Packs > Local > Settings); agents cannot change that setting. ' +
      "local_generate_image works without it.",
  );
}

export const comfyTools = [
  defineTool({
    name: "local_comfy_status",
    description:
      "Check the local ComfyUI server: version, GPU devices, queue length and installed checkpoints.",
    input: z.object({}),
    annotations: { title: "ComfyUI status", readOnlyHint: true, openWorldHint: false },
    tags: ["local", "comfyui"],
    run: (_input, ctx) => comfyStatus(ctx),
  }),
  defineTool({
    name: "local_comfy_run_workflow",
    description:
      "Run an arbitrary API-format ComfyUI node graph (Save (API Format) JSON) on your ComfyUI server, wait for it and save every output image, video or audio file to the library. " +
      "Any node installed there can run, including custom nodes that read files, download models or reach the network, so only pass workflows you trust. " +
      "Cancelling removes or interrupts only this job. " +
      "Off by default: refused unless the user has turned on the pack setting allowRawComfyWorkflows.",
    input: z.object({
      workflow: z
        .record(z.string(), z.unknown())
        .describe("API-format workflow: node id -> {class_type, inputs}."),
      timeout_s: z
        .number()
        .int()
        .min(10)
        .max(MAX_TIMEOUT_S)
        .optional()
        .describe(`Give up and interrupt after this many seconds. Default ${DEFAULT_TIMEOUT_S}.`),
    }),
    annotations: {
      title: "Run ComfyUI workflow",
      readOnlyHint: false,
      destructiveHint: false,
      // Custom nodes can do anything the ComfyUI process can, network included.
      openWorldHint: true,
    },
    longRunning: true,
    tags: ["local", "comfyui", "image", "video"],
    run: (input, ctx) => {
      assertRawWorkflowsAllowed(ctx);
      return runWorkflow(ctx, validateWorkflow(input.workflow), {
        timeoutS: input.timeout_s ?? DEFAULT_TIMEOUT_S,
      });
    },
  }),
  defineTool({
    name: "local_generate_image",
    capability: "image.generate",
    description:
      "Generate images from a text prompt with local ComfyUI using a built-in txt2img workflow and an installed checkpoint (no API key). Fails with a clear message when ComfyUI is not running or has no checkpoint.",
    input: GenerateInput,
    annotations: {
      title: "Generate image (ComfyUI)",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    longRunning: true,
    tags: ["local", "comfyui", "image"],
    run: (input, ctx) => generateImage(ctx, input),
  }),
];
