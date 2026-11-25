// packs/sandbox/index.ts
//
// Run untrusted code away from the user's machine: E2B and Daytona cloud
// sandboxes (create, run a command or code, write and read files, destroy),
// and one-shot local Docker containers when docker is installed.
// See e2b.ts, daytona.ts and docker.ts for the endpoints and isolation rules.
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import {
  daytonaCreate,
  daytonaDestroy,
  daytonaRead,
  daytonaRun,
  daytonaRunCode,
  daytonaWrite,
} from "./daytona.js";
import { dockerRun, workPath } from "./docker.js";
import { e2bCreate, e2bDestroy, e2bRead, e2bRun, e2bRunCode, e2bSession, e2bWrite } from "./e2b.js";
import { isPathSegment, noControl } from "./http.js";
import { MAX_FILE_BYTES, asText, kindOf, mimeOf } from "./shared.js";

// Tools take either provider, so none lists `secrets` (the loader would
// require both up front); each provider call asks for its own key and fails
// with MISSING_SECRET naming it.

const provider = z.enum(["e2b", "daytona"]);
const sandboxId = z
  .string()
  .min(1)
  .max(200)
  .refine(isPathSegment, "a sandbox id has no spaces, slashes or control characters");
const remotePath = z.string().min(1).max(1024).refine(noControl, "no control characters");
const timeoutS = z.number().int().min(1).max(600).default(60);

const remote = { provider, sandbox_id: sandboxId };

const create = defineTool({
  name: "sandbox_create",
  description:
    "Start a cloud sandbox on E2B or Daytona (billed while it runs). Returns its sandbox_id for the other sandbox tools. E2B sandboxes stop after timeout_s; Daytona ones auto-stop after auto_stop_minutes idle. Destroy it with sandbox_destroy when done.",
  annotations: {
    title: "Start sandbox",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    provider,
    template: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:/-]+$/, "a template or snapshot name")
      .optional(),
    timeout_s: z.number().int().min(60).max(86_400).default(900),
    auto_stop_minutes: z.number().int().min(1).max(1440).default(15),
  }),
  async run(input, ctx) {
    if (input.provider === "e2b") {
      return e2bCreate(ctx, input.template ?? "base", input.timeout_s);
    }
    return daytonaCreate(ctx, {
      ...(input.template ? { snapshot: input.template } : {}),
      autoStopMinutes: input.auto_stop_minutes,
    });
  },
});

const runCommand = defineTool({
  name: "sandbox_run_command",
  description:
    "Run a shell command in a cloud sandbox and return its exit code and output (each capped at 100k characters).",
  annotations: {
    title: "Run command in sandbox",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    ...remote,
    command: z.string().min(1).max(100_000),
    cwd: remotePath.optional(),
    timeout_s: timeoutS,
  }),
  async run(input, ctx) {
    const opts = { timeoutS: input.timeout_s, ...(input.cwd ? { cwd: input.cwd } : {}) };
    if (input.provider === "e2b") {
      return e2bRun(ctx, await e2bSession(ctx, input.sandbox_id), input.command, opts);
    }
    return daytonaRun(ctx, input.sandbox_id, input.command, opts);
  },
});

const runCode = defineTool({
  name: "sandbox_run_code",
  description:
    "Run a Python or JavaScript snippet in a cloud sandbox and return its exit code and output.",
  annotations: {
    title: "Run code in sandbox",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    ...remote,
    language: z.enum(["python", "javascript"]),
    code: z.string().min(1).max(500_000),
    timeout_s: timeoutS,
  }),
  async run(input, ctx) {
    if (input.provider === "e2b") {
      const s = await e2bSession(ctx, input.sandbox_id);
      return e2bRunCode(ctx, s, input.language, input.code, input.timeout_s);
    }
    return daytonaRunCode(ctx, input.sandbox_id, input.language, input.code, input.timeout_s);
  },
});

async function writeBytes(
  ctx: PackContext,
  p: "e2b" | "daytona",
  id: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  if (p === "e2b") await e2bWrite(ctx, await e2bSession(ctx, id), path, bytes);
  else await daytonaWrite(ctx, id, path, bytes);
}

const writeFile = defineTool({
  name: "sandbox_write_file",
  description:
    "Write a file into a cloud sandbox, from text `content` or from a library artifact (`artifact_id`).",
  annotations: { title: "Write file to sandbox", readOnlyHint: false, openWorldHint: true },
  input: z
    .object({
      ...remote,
      path: remotePath,
      content: z.string().max(10_000_000).optional(),
      artifact_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,100}$/)
        .optional(),
    })
    .refine((v) => (v.content === undefined) !== (v.artifact_id === undefined), {
      message: "give exactly one of content or artifact_id",
    }),
  async run(input, ctx) {
    let bytes: Uint8Array;
    if (input.artifact_id) {
      const art = await ctx.library.get(input.artifact_id);
      if (!art) throw new Error(`artifact ${input.artifact_id} not found`);
      if (art.bytes > MAX_FILE_BYTES) throw new Error("the artifact is over the 100 MB limit");
      bytes = await ctx.library.read(art.id);
    } else {
      bytes = new TextEncoder().encode(input.content ?? "");
    }
    await writeBytes(ctx, input.provider, input.sandbox_id, input.path, bytes);
    return { path: input.path, bytes: bytes.byteLength };
  },
});

const readFile = defineTool({
  name: "sandbox_read_file",
  description:
    "Read a file from a cloud sandbox. Text files up to 1 MB come back as `text`; with save_to_library the file is also stored in the artifact library (any type, up to 100 MB).",
  annotations: { title: "Read file from sandbox", readOnlyHint: false, openWorldHint: true },
  input: z.object({ ...remote, path: remotePath, save_to_library: z.boolean().default(false) }),
  async run(input, ctx) {
    const { bytes, mime: served } =
      input.provider === "e2b"
        ? await e2bRead(ctx, await e2bSession(ctx, input.sandbox_id), input.path)
        : await daytonaRead(ctx, input.sandbox_id, input.path);
    const text = asText(bytes);
    let artifact: { artifact_id: string; url: string } | null = null;
    if (input.save_to_library) {
      const byName = mimeOf(input.path);
      const mime = byName !== "application/octet-stream" ? byName : served;
      const ref = await ctx.library.save({
        kind: kindOf(mime),
        mime,
        bytes,
        meta: { provider: input.provider, sandboxId: input.sandbox_id, path: input.path },
      });
      artifact = { artifact_id: ref.id, url: ref.url };
    }
    return {
      path: input.path,
      bytes: bytes.byteLength,
      text,
      ...(text === null ? { note: "binary or over 1 MB: use save_to_library" } : {}),
      ...(artifact ?? {}),
    };
  },
});

const destroy = defineTool({
  name: "sandbox_destroy",
  description: "Destroy a cloud sandbox and everything in it, ending its billing.",
  annotations: {
    title: "Destroy sandbox",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object(remote),
  async run(input, ctx) {
    const found =
      input.provider === "e2b"
        ? await e2bDestroy(ctx, input.sandbox_id)
        : await daytonaDestroy(ctx, input.sandbox_id);
    return { provider: input.provider, sandbox_id: input.sandbox_id, destroyed: found };
  },
});

const docker = defineTool({
  name: "docker_run",
  description:
    "Run a shell command in a throwaway local Docker container (needs docker installed). The container sees only a fresh /work folder holding `files`; network is off unless the user allowed it; 1 GB memory, 1 CPU. Files listed in `collect` are saved from /work to the artifact library. The image must be in the allowedImages setting.",
  annotations: {
    title: "Run in local container",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  input: z.object({
    image: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-z0-9][a-z0-9._/:@-]*$/, "an image reference"),
    command: z.string().min(1).max(100_000),
    files: z
      .record(
        z.string().refine(workPath, "a relative path inside /work"),
        z.string().max(5_000_000),
      )
      .optional(),
    collect: z
      .array(z.string().refine(workPath, "a relative path inside /work"))
      .max(20)
      .optional(),
    network: z.boolean().default(false),
    timeout_s: z.number().int().min(1).max(1800).default(120),
  }),
  async run(input, ctx) {
    const out = await dockerRun(ctx, {
      image: input.image,
      command: input.command,
      network: input.network,
      timeoutS: input.timeout_s,
      ...(input.files ? { files: input.files } : {}),
      ...(input.collect ? { collect: input.collect } : {}),
    });
    const saved = [];
    for (const f of out.files) {
      const mime = mimeOf(f.path);
      const ref = await ctx.library.save({
        kind: kindOf(mime),
        mime,
        bytes: f.bytes,
        meta: { provider: "docker", image: input.image, path: f.path },
      });
      saved.push({ path: f.path, artifact_id: ref.id, url: ref.url, bytes: f.bytes.byteLength });
    }
    const { files: _files, ...result } = out;
    return { ...result, artifacts: saved };
  },
});

export default definePack({
  tools: [create, runCommand, runCode, writeFile, readFile, destroy, docker],
});
