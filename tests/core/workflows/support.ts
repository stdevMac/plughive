// Shared helpers for workflow tests: mock tool packs that stand in for the
// media, local, web and ElevenLabs packs (same tool names, every call recorded
// and answered by the test), a fake library, and the real PackLoader over a
// temp builtin directory. Nothing here reaches a provider.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostLibrary, PackHost } from "../../../src/core/packs/context.js";
import { PackLoader } from "../../../src/core/packs/loader.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";

export const silent = { debug() {}, info() {}, warn() {}, error() {} };
export const WORKFLOWS_PACK_DIR = fileURLToPath(
  new URL("../../../packs/workflows", import.meta.url),
);

export interface MockToolSpec {
  name: string;
  capability?: string;
  secrets?: string[];
  tags?: string[];
}

export interface MockPackSpec {
  tools: MockToolSpec[];
  secrets?: string[];
}

/** The tools the bundled recipes call, grouped by the pack that really provides them. */
export const MOCK_PACKS: Record<string, MockPackSpec> = {
  media: {
    tools: [
      { name: "chat", capability: "chat" },
      { name: "generate_image", capability: "image.generate" },
      { name: "generate_video", capability: "video.generate" },
      { name: "generate_speech", capability: "speech.generate" },
      { name: "generate_music", capability: "music.generate" },
      { name: "transcribe_audio", capability: "audio.transcribe" },
    ],
  },
  local: {
    tools: [
      { name: "local_audio_mix" },
      { name: "local_audio_concat" },
      { name: "local_video_concat" },
      { name: "local_video_mux_audio" },
      { name: "local_video_burn_captions" },
      { name: "local_transcribe", capability: "audio.transcribe" },
    ],
  },
  web: {
    secrets: ["FIRECRAWL_API_KEY"],
    tools: [
      { name: "firecrawl_scrape", secrets: ["FIRECRAWL_API_KEY"] },
      { name: "screenshot_url" },
    ],
  },
  elevenlabs: {
    secrets: ["ELEVENLABS_API_KEY"],
    tools: [{ name: "elevenlabs_dub", secrets: ["ELEVENLABS_API_KEY"] }],
  },
};

export interface MockCall {
  tool: string;
  args: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>, call: MockCall) => unknown;

/** Answers every mock tool call. Install before loading; one per test. */
export class MockTools {
  calls: MockCall[] = [];
  handlers: Record<string, Handler> = {};
  /** Milliseconds each call waits (to observe concurrency and cancellation). */
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  private seq = 0;

  install(): this {
    (globalThis as Record<string, unknown>).__wfMock = (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => this.handle(name, input, signal);
    return this;
  }

  /** Tool names in call order. */
  order(): string[] {
    return this.calls.map((c) => c.tool);
  }

  argsOf(tool: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.tool === tool).map((c) => c.args);
  }

  id(prefix: string): string {
    this.seq++;
    return `${prefix}_${String(this.seq).padStart(6, "0")}`;
  }

  private ref(prefix: string, mime: string) {
    const id = this.id(prefix);
    return { id, url: `http://127.0.0.1:7777/artifacts/${id}`, mime };
  }

  private defaults(tool: string, args: Record<string, unknown>): unknown {
    switch (tool) {
      case "chat":
        throw new Error("the test gave no chat reply");
      case "generate_image":
        return { artifacts: [this.ref("img", "image/png")], model: "mock-image", provider: "mock" };
      case "generate_video":
        return { artifacts: [this.ref("vid", "video/mp4")], model: "mock-video", provider: "mock" };
      case "generate_speech":
        return {
          artifacts: [this.ref("spk", "audio/mpeg")],
          model: "mock-voice",
          provider: "mock",
        };
      case "generate_music":
        return {
          artifacts: [this.ref("mus", "audio/mpeg")],
          model: "mock-music",
          provider: "mock",
        };
      case "transcribe_audio":
        return { text: "Hello from the source.", model: "mock-stt", provider: "mock" };
      case "local_audio_mix":
        return { artifact: this.ref("mix", "audio/mpeg") };
      case "local_audio_concat":
        return {
          artifact: this.ref("cat", "audio/mpeg"),
          items: (args.artifact_ids as unknown[]).length,
        };
      case "local_video_concat":
      case "local_video_mux_audio":
      case "local_video_burn_captions":
        return { artifact: this.ref("loc", "video/mp4") };
      case "local_transcribe":
        return {
          text: "words",
          segments: [],
          srt_artifact: this.ref("srt", "application/x-subrip"),
        };
      case "firecrawl_scrape":
        return { url: args.url, title: "Fetched page", markdown: "# Fetched page\n\nPage text." };
      case "screenshot_url":
        return { artifact: this.ref("png", "image/png") };
      case "elevenlabs_dub":
        return {
          artifacts: [this.ref("dub", "audio/mpeg")],
          model: "dubbing",
          provider: "elevenlabs",
          project_id: "proj1",
        };
      default:
        throw new Error(`no mock for ${tool}`);
    }
  }

  async handle(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const call = { tool, args };
    this.calls.push(call);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, this.delayMs);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      }
      const h = this.handlers[tool];
      return h ? await h(args, call) : this.defaults(tool, args);
    } finally {
      this.inFlight--;
    }
  }
}

/** A chat reply handler: the JSON text the model "returns". */
export function chatReply(value: unknown): Handler {
  return () => ({
    text: typeof value === "string" ? value : JSON.stringify(value),
    model: "mock-chat",
    provider: "mock",
  });
}

function mockPackSource(spec: MockPackSpec): string {
  const tools = spec.tools.map(
    (t) => `api.defineTool({
      name: ${JSON.stringify(t.name)},
      description: "mock ${t.name}",
      input: api.z.looseObject({}),
      ${t.capability ? `capability: ${JSON.stringify(t.capability)},` : ""}
      ${t.secrets ? `secrets: ${JSON.stringify(t.secrets)},` : ""}
      ${t.tags ? `tags: ${JSON.stringify(t.tags)},` : ""}
      async run(input, ctx) { return await globalThis.__wfMock(${JSON.stringify(t.name)}, input, ctx.signal); },
    })`,
  );
  return `export default (api) => api.definePack({ tools: [${tools.join(",\n")}] });\n`;
}

export function writeMockPack(builtinDir: string, id: string, spec: MockPackSpec): void {
  const dir = join(builtinDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pack.json"),
    JSON.stringify({
      id,
      name: `Mock ${id}`,
      version: "0.1.0",
      apiVersion: 1,
      entry: "./index.mjs",
      ...(spec.secrets
        ? { secrets: spec.secrets.map((name) => ({ name, label: name, required: false })) }
        : {}),
      permissions: {},
    }),
  );
  writeFileSync(join(dir, "index.mjs"), mockPackSource(spec));
}

/** A declarative pack with the given recipes. */
export function writeWorkflowPack(
  builtinDir: string,
  recipes: Record<string, unknown>[],
  opts: { id?: string; tools?: string[]; library?: string } = {},
): string {
  const id = opts.id ?? "flows";
  const dir = join(builtinDir, id);
  mkdirSync(join(dir, "workflows"), { recursive: true });
  writeFileSync(
    join(dir, "pack.json"),
    JSON.stringify({
      id,
      name: `Flows ${id}`,
      version: "0.1.0",
      apiVersion: 1,
      permissions: { tools: opts.tools ?? [], library: opts.library ?? "write" },
      workflows: "workflows",
    }),
  );
  for (const r of recipes) {
    writeFileSync(join(dir, "workflows", `${String(r.name)}.json`), JSON.stringify(r, null, 2));
  }
  return dir;
}

/** A minimal valid recipe; override any field. */
export function recipe(
  name: string,
  steps: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    title: `Recipe ${name}`,
    description: `Test recipe ${name}.`,
    input: { type: "object", properties: {}, required: [] },
    steps,
    output: null,
    ...extra,
  };
}

export interface SavedArtifact {
  kind: string;
  mime: string;
  text: string;
  meta: Record<string, unknown> | null | undefined;
  id: string;
}

export interface LoaderHarness {
  dir: string;
  builtinDir: string;
  registry: ToolRegistry;
  loader: PackLoader;
  saves: SavedArtifact[];
  /** registry.call: the same path an MCP call takes after the transport. */
  call(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
  close(): Promise<void>;
}

export interface LoaderOptions {
  /** Mock packs to write (default: all of MOCK_PACKS). */
  packs?: string[];
  /** Copy the bundled packs/workflows pack (default true). */
  bundled?: boolean;
  /** Extra packs: write them into the builtin directory. */
  seed?: (builtinDir: string) => void;
  /** Secrets the store sees (default: the Firecrawl and ElevenLabs keys). */
  secrets?: Record<string, string>;
  /** Spend gate handed to the packs (workflow runs). */
  policy?: PackHost["policy"];
}

export const FIXTURE_SECRETS = {
  FIRECRAWL_API_KEY: "fixture-firecrawl-key-000000",
  ELEVENLABS_API_KEY: "fixture-elevenlabs-key-000000",
};

/** The real PackLoader over a temp builtin dir with the mock packs and the bundled workflows. */
export async function bootLoader(opts: LoaderOptions = {}): Promise<LoaderHarness> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plughive-wf-")));
  const builtinDir = join(dir, "builtin");
  mkdirSync(builtinDir, { recursive: true });
  for (const id of opts.packs ?? Object.keys(MOCK_PACKS)) {
    const spec = MOCK_PACKS[id];
    if (spec) writeMockPack(builtinDir, id, spec);
  }
  if (opts.bundled !== false)
    cpSync(WORKFLOWS_PACK_DIR, join(builtinDir, "workflows"), { recursive: true });
  opts.seed?.(builtinDir);

  const saves: SavedArtifact[] = [];
  let n = 0;
  const library: HostLibrary = {
    get: () => null,
    list: () => [],
    save(input) {
      n++;
      const id = `sav_${String(n).padStart(6, "0")}`;
      saves.push({
        kind: input.kind,
        mime: input.mime,
        text: Buffer.from(input.bytes).toString("utf8"),
        meta: input.meta,
        id,
      });
      return { id, url: `http://127.0.0.1:7777/artifacts/${id}`, mime: input.mime };
    },
  };
  const registry = new ToolRegistry();
  const store = createSecretStore({
    home: dir,
    env: opts.secrets ?? FIXTURE_SECRETS,
    backend: "memory",
  });
  const loader = new PackLoader({
    home: dir,
    registry,
    host: {
      store,
      logger: silent,
      library,
      ...(opts.policy ? { policy: opts.policy } : {}),
      tools: {
        call: (name, args, callCtx) => registry.call(name, args, callCtx),
        get: (name) => registry.get(name),
      },
    },
    builtinDir,
    userDir: join(dir, "packs"),
  });
  await loader.loadAll();
  return {
    dir,
    builtinDir,
    registry,
    loader,
    saves,
    call: (name, input, signal) =>
      registry.call(name, input, signal ? { signal } : {}) as ReturnType<LoaderHarness["call"]>,
    async close() {
      await loader.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The result of a successful workflow call, or a thrown error with the envelope's message. */
export async function runOk(
  h: LoaderHarness,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const env = await h.call(name, input);
  if (!env.ok) throw new Error(`${name} failed: ${env.error?.code} ${env.error?.message}`);
  return env.result as Record<string, unknown>;
}
