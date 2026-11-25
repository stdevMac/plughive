// The bundled workflows (packs/workflows) end to end through the real
// PackLoader: the recipes load from disk, every step goes through the
// workflow pack's ctx.tools.call (permissions, registry validation) to mock
// packs that use the real tool names. Checks step order, the arguments each
// tool receives, the output shape, and each recipe's dry run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type LoaderHarness,
  MOCK_PACKS,
  MockTools,
  bootLoader,
  chatReply,
  runOk,
  writeMockPack,
} from "./support.js";

type Obj = Record<string, unknown>;
type PlanStep = {
  id: string;
  runs: string;
  calls: number;
  paid: boolean;
  needs: unknown[];
  steps?: PlanStep[];
};
type DryRun = {
  dry_run: true;
  ok: boolean;
  steps: PlanStep[];
  paid_calls_max: number;
  blocking: unknown[];
};

const userText = (args: Obj) =>
  (args.messages as { role: string; content: string }[]).find((m) => m.role === "user")?.content ??
  "";
const stepRuns = (plan: DryRun) =>
  Object.fromEntries(
    plan.steps.flatMap((s) => [[s.id, s.runs], ...(s.steps ?? []).map((c) => [c.id, c.runs])]),
  );
const stepArtifacts = (r: Obj, id: string) =>
  (r.steps as { id: string; artifacts: string[] }[]).find((s) => s.id === id)?.artifacts ?? [];

let h: LoaderHarness;
let mock: MockTools;

async function dry(name: string, input: Obj, harness: LoaderHarness = h): Promise<DryRun> {
  return (await runOk(harness, name, { ...input, dry_run: true })) as unknown as DryRun;
}

beforeAll(async () => {
  h = await bootLoader();
});
afterAll(async () => h?.close());
beforeEach(() => {
  mock = new MockTools().install();
});

describe("the bundled pack", () => {
  it("loads all seven recipes as wf_* tools of the workflows pack", async () => {
    const pack = (await h.loader.listPacks()).find((p) => p.id === "workflows");
    expect(pack?.state).toBe("loaded");
    expect(pack?.workflowErrors).toEqual([]);
    expect([...(pack?.workflows ?? [])].sort()).toEqual([
      "brand_kit_from_url",
      "dub_localize",
      "issue_triage",
      "podcast_produce",
      "video_launch_film_16x9",
      "video_narrated_ad",
      "video_short_9x16",
    ]);
    const t = h.registry.get("wf_video_short_9x16");
    expect(t?.origin).toBe("workflow");
    expect(t?.longRunning).toBe(true);
    expect((t?.inputSchema.properties as Obj).dry_run).toBeDefined();
  });
});

describe("wf_issue_triage", () => {
  const verdict = {
    summary: "Crash on save",
    type: "bug",
    severity: "high",
    labels: ["bug", "editor"],
    components: ["editor"],
    missing_info: ["version"],
    reproducible: true,
    next_steps: ["reproduce", "bisect"],
    reply_draft: "Thanks, which version?",
  };

  it("reads the issue page, triages it and writes the report", async () => {
    mock.handlers.chat = chatReply(verdict);
    const r = await runOk(h, "wf_issue_triage", {
      issue_url: "https://example.com/org/repo/issues/1",
      labels: ["bug", "editor", "docs"],
      project_context: "An editor.",
    });
    expect(mock.order()).toEqual(["firecrawl_scrape", "chat"]);
    expect(mock.argsOf("firecrawl_scrape")[0]).toEqual({
      url: "https://example.com/org/repo/issues/1",
      formats: ["markdown"],
      only_main_content: true,
    });
    const chat = mock.argsOf("chat")[0] as Obj;
    expect(userText(chat)).toContain("Allowed labels: bug, editor, docs");
    expect(userText(chat)).toContain("Title: Fetched page");
    expect(userText(chat)).toContain("Page text.");
    const out = r.output as Obj;
    expect(out.triage).toEqual(verdict);
    expect(out.source).toBe("https://example.com/org/repo/issues/1");
    expect(out.markdown).toContain("## Fetched page");
    expect(out.markdown).toContain("- Severity: high");
    expect(out.markdown).toContain("### Next steps\nreproduce\nbisect");
  });

  it("falls back to the pasted text when the page cannot be read", async () => {
    mock.handlers.firecrawl_scrape = () => {
      throw new Error("firecrawl: 402 payment required");
    };
    mock.handlers.chat = chatReply(`Here you go:\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``);
    const r = await runOk(h, "wf_issue_triage", {
      title: "Save crashes",
      body: "It crashes when I save.",
      issue_url: "https://example.com/i/2",
    });
    expect(userText(mock.argsOf("chat")[0] as Obj)).toContain("It crashes when I save.");
    const out = r.output as Obj;
    expect(out.source).toBe("pasted text");
    expect(out.triage).toEqual(verdict);
    expect(out.markdown).toContain("## Save crashes");
    expect((r.steps as Obj[]).find((s) => s.id === "fetch")?.status).toBe("continued");
  });

  it("dry run: one paid call for pasted text, two with a URL; nothing runs", async () => {
    const pasted = await dry("wf_issue_triage", { body: "x" });
    expect(pasted.ok).toBe(true);
    expect(stepRuns(pasted)).toMatchObject({ fetch: "no", triage: "yes", report: "yes" });
    expect(pasted.paid_calls_max).toBe(1);
    const url = await dry("wf_issue_triage", { issue_url: "https://example.com/i/3" });
    expect(url.paid_calls_max).toBe(2);
    expect(mock.calls).toEqual([]);
  });
});

describe("wf_video_short_9x16", () => {
  const plan = {
    title: "Tide pools",
    music_prompt: "calm ocean synth",
    shots: [
      { prompt: "A crab in a pool", narration: "Meet the crab." },
      { prompt: "An anemone opens", narration: "Anemones bloom." },
      { prompt: "Waves return", narration: "Then the tide returns." },
      { prompt: "Extra shot", narration: "Never used." },
    ],
  };

  it("plans, renders each shot, voices, joins, muxes and burns captions", async () => {
    mock.handlers.chat = chatReply(plan);
    const r = await runOk(h, "wf_video_short_9x16", { topic: "tide pools", max_shots: 3 });
    expect(mock.order()).toEqual([
      "chat",
      "generate_video",
      "generate_video",
      "generate_video",
      "generate_speech",
      "local_video_concat",
      "local_video_mux_audio",
      "local_transcribe",
      "local_video_burn_captions",
    ]);
    const videos = mock.argsOf("generate_video");
    expect(videos.map((a) => a.prompt)).toEqual([
      "A crab in a pool. Style: cinematic, bright, high contrast",
      "An anemone opens. Style: cinematic, bright, high contrast",
      "Waves return. Style: cinematic, bright, high contrast",
    ]);
    for (const v of videos) {
      expect(v).toMatchObject({ aspect_ratio: "9:16", duration_seconds: 5 });
      expect(v).not.toHaveProperty("image_input");
    }
    expect(mock.argsOf("generate_speech")[0]).toMatchObject({
      text: "Meet the crab. Anemones bloom. Then the tide returns.",
      language: "en",
    });
    expect(mock.argsOf("generate_speech")[0]).not.toHaveProperty("voice");
    const out = r.output as Obj;
    const clipIds = (out.clips as Obj[]).map((c) => c.id);
    expect(clipIds).toHaveLength(3);
    expect(mock.argsOf("local_video_concat")[0]).toMatchObject({
      artifact_ids: clipIds,
      aspect: "9:16",
    });
    const voiceId = (out.voice as Obj).id;
    expect(mock.argsOf("local_video_mux_audio")[0]).toMatchObject({
      audio_artifact_id: voiceId,
      mode: "replace",
    });
    expect(mock.argsOf("local_transcribe")[0]).toMatchObject({ artifact_id: voiceId });
    expect(mock.argsOf("local_video_burn_captions")[0]).toMatchObject({ position: "middle" });
    expect(out.title).toBe("Tide pools");
    expect((out.video as Obj).id).toBe(stepArtifacts(r, "captioned")[0]);
    expect((out.video_without_captions as Obj).id).toBe(stepArtifacts(r, "muxed")[0]);
    expect(out.shots).toHaveLength(3);
  });

  it("with keyframes and music: first frames feed the clips and the voice is mixed over the bed", async () => {
    mock.handlers.chat = chatReply(plan);
    const r = await runOk(h, "wf_video_short_9x16", {
      topic: "tide pools",
      max_shots: 2,
      keyframes: true,
      music: true,
      captions: false,
      voice: "nova",
    });
    expect(mock.order()).toEqual([
      "chat",
      "generate_image",
      "generate_image",
      "generate_video",
      "generate_video",
      "generate_speech",
      "generate_music",
      "local_audio_mix",
      "local_video_concat",
      "local_video_mux_audio",
    ]);
    expect(mock.argsOf("generate_image").every((a) => a.aspect_ratio === "9:16")).toBe(true);
    expect(mock.argsOf("generate_video").map((a) => a.image_input)).toEqual(
      stepArtifacts(r, "frames"),
    );
    expect(mock.argsOf("generate_music")[0]).toMatchObject({
      prompt: "calm ocean synth",
      instrumental: true,
    });
    const mix = mock.argsOf("local_audio_mix")[0] as { inputs: Obj[]; preset: string };
    expect(mix.preset).toBe("ad");
    expect(mix.inputs[1]).toMatchObject({ volume: 0.35 });
    expect(mock.argsOf("local_video_mux_audio")[0]).toMatchObject({
      audio_artifact_id: stepArtifacts(r, "mix")[0],
    });
    expect(mock.argsOf("generate_speech")[0]).toMatchObject({ voice: "nova" });
    expect((r.output as Obj).video).toEqual((r.output as Obj).video_without_captions);
  });

  it("dry run: the worst case counts the shots at their cap", async () => {
    const base = await dry("wf_video_short_9x16", { topic: "tide pools" });
    expect(base.ok).toBe(true);
    expect(stepRuns(base)).toMatchObject({ frames: "no", clips: "yes", music: "no" });
    expect(base.paid_calls_max).toBe(10);
    const all = await dry("wf_video_short_9x16", {
      topic: "tide pools",
      keyframes: true,
      music: true,
    });
    expect(all.paid_calls_max).toBe(19);
    expect(mock.calls).toEqual([]);
  });
});

describe("wf_video_launch_film_16x9", () => {
  const beats = ["hook", "problem", "solution", "proof", "cta", "extra"].map((name) => ({
    name,
    prompt: `${name} shot`,
    narration: `${name} line.`,
  }));

  it("reads the page, writes five beats, renders them at 1080p and captions at the bottom", async () => {
    mock.handlers.chat = chatReply({ title: "Launch", beats, music_prompt: "big" });
    const r = await runOk(h, "wf_video_launch_film_16x9", {
      product: "Acme Router",
      url: "https://example.com/router",
      key_points: ["fast", "quiet"],
      captions: true,
    });
    expect(mock.order()).toEqual([
      "firecrawl_scrape",
      "chat",
      ...Array(5).fill("generate_video"),
      "generate_speech",
      "local_video_concat",
      "local_video_mux_audio",
      "local_transcribe",
      "local_video_burn_captions",
    ]);
    const prompt = userText(mock.argsOf("chat")[0] as Obj);
    expect(prompt).toContain("Must mention: fast; quiet");
    expect(prompt).toContain("Page text.");
    for (const v of mock.argsOf("generate_video")) {
      expect(v).toMatchObject({ aspect_ratio: "16:9", resolution: "1080p", duration_seconds: 6 });
    }
    expect(mock.argsOf("generate_speech")[0]?.text).toBe(
      "hook line. problem line. solution line. proof line. cta line.",
    );
    expect(mock.argsOf("local_video_concat")[0]).toMatchObject({ aspect: "16:9" });
    expect((mock.argsOf("local_video_concat")[0]?.artifact_ids as string[]).length).toBe(5);
    expect(mock.argsOf("local_video_burn_captions")[0]).toMatchObject({ position: "bottom" });
    const out = r.output as Obj;
    expect(out.title).toBe("Launch");
    expect(out.used_product_page).toBe("https://example.com/router");
    expect(out.beats).toHaveLength(5);
    expect(out.clips).toHaveLength(5);
  });

  it("without a URL: no page read, no captions by default", async () => {
    mock.handlers.chat = chatReply({ title: "Launch", beats: beats.slice(0, 2) });
    const r = await runOk(h, "wf_video_launch_film_16x9", { product: "Acme Router" });
    expect(mock.order()).toEqual([
      "chat",
      "generate_video",
      "generate_video",
      "generate_speech",
      "local_video_concat",
      "local_video_mux_audio",
    ]);
    expect(userText(mock.argsOf("chat")[0] as Obj)).toContain("(not available)");
    expect((r.output as Obj).used_product_page).toBe(false);
  });

  it("dry run: 7 paid calls by default, 8 with a URL", async () => {
    expect((await dry("wf_video_launch_film_16x9", { product: "Acme" })).paid_calls_max).toBe(7);
    expect(
      (await dry("wf_video_launch_film_16x9", { product: "Acme", url: "https://example.com" }))
        .paid_calls_max,
    ).toBe(8);
    expect(mock.calls).toEqual([]);
  });
});

describe("wf_video_narrated_ad", () => {
  const lines = [1, 2, 3, 4].map((i) => ({ text: `Line ${i}.`, visual: `Visual ${i}` }));

  it("writes the script, voices it, renders one clip per line in the asked aspect", async () => {
    mock.handlers.chat = chatReply({ title: "Ad", lines });
    const r = await runOk(h, "wf_video_narrated_ad", {
      brief: "A water bottle for hikers",
      aspect: "16:9",
      max_lines: 3,
    });
    const order = mock.order();
    expect(order[0]).toBe("chat");
    expect(order.filter((t) => t === "generate_video")).toHaveLength(3);
    expect(order.filter((t) => t === "generate_speech")).toHaveLength(1);
    // Captions are off by default for this recipe.
    expect(order.slice(-2)).toEqual(["local_video_concat", "local_video_mux_audio"]);
    expect(userText(mock.argsOf("chat")[0] as Obj)).toContain("Aspect: 16:9");
    expect(mock.argsOf("generate_speech")[0]?.text).toBe("Line 1. Line 2. Line 3.");
    expect(
      mock.argsOf("generate_video").map((a) => [a.prompt, a.aspect_ratio, a.duration_seconds]),
    ).toEqual([
      ["Visual 1. Style: polished commercial look, natural light", "16:9", 5],
      ["Visual 2. Style: polished commercial look, natural light", "16:9", 5],
      ["Visual 3. Style: polished commercial look, natural light", "16:9", 5],
    ]);
    expect(mock.argsOf("local_video_concat")[0]).toMatchObject({ aspect: "16:9" });
    const out = r.output as Obj;
    expect(out.title).toBe("Ad");
    expect(out.script).toEqual(lines.slice(0, 3));
    expect(out.clips).toHaveLength(3);
    expect((out.voice as Obj).id).toBe(stepArtifacts(r, "voice")[0]);
    expect(out.video).toBeDefined();
  });

  it("dry run: clips counted at their cap of 6", async () => {
    const plan = await dry("wf_video_narrated_ad", { brief: "A bottle" });
    expect(plan.ok).toBe(true);
    expect(plan.paid_calls_max).toBe(8);
    expect(
      (await dry("wf_video_narrated_ad", { brief: "A bottle", music: true })).paid_calls_max,
    ).toBe(9);
  });
});

describe("wf_brand_kit_from_url", () => {
  const kit = {
    name: "Acme",
    tagline: "Make it",
    voice: { adjectives: ["bold"], do: [], dont: [] },
    colors: [{ name: "Ink", hex: "#111111", use: "text" }],
    fonts: [],
    logo_prompt: "an anvil mark",
    mood_prompt: "workshop light",
    markdown: "# Acme brand sheet",
  };

  it("screenshots and reads the site side by side, drafts the kit and saves JSON and Markdown", async () => {
    mock.handlers.chat = chatReply(kit);
    const before = h.saves.length;
    const r = await runOk(h, "wf_brand_kit_from_url", {
      url: "https://acme.example",
      make_images: true,
    });
    expect(mock.order().slice(0, 2).sort()).toEqual(["firecrawl_scrape", "screenshot_url"]);
    expect(mock.order().slice(2)).toEqual(["chat", "generate_image", "generate_image"]);
    expect(mock.argsOf("screenshot_url")[0]).toMatchObject({ url: "https://acme.example" });
    expect(mock.argsOf("firecrawl_scrape")[0]).toMatchObject({
      url: "https://acme.example",
      only_main_content: false,
    });
    const out = r.output as Obj;
    const shotId = (out.screenshot as Obj).id;
    expect(userText(mock.argsOf("chat")[0] as Obj)).toContain(`Screenshot taken: ${shotId}`);
    expect(
      mock.argsOf("generate_image").map((a) => [a.prompt, a.aspect_ratio, a.image_inputs]),
    ).toEqual([
      ["an anvil mark", "1:1", [shotId]],
      ["workshop light", "1:1", [shotId]],
    ]);
    const saved = h.saves.slice(before);
    expect(saved.map((s) => [s.kind, s.mime])).toEqual([
      ["data", "application/json"],
      ["document", "text/markdown"],
    ]);
    expect(JSON.parse(saved[0]?.text ?? "null")).toEqual(kit);
    expect(saved[1]?.text).toBe("# Acme brand sheet");
    expect(out.kit).toEqual(kit);
    expect((out.kit_json as Obj).id).toBe(saved[0]?.id);
    expect((out.brand_sheet as Obj).id).toBe(saved[1]?.id);
    expect(out.images).toHaveLength(2);
    expect(out.read_page_text).toBe("https://acme.example");
  });

  it("still drafts the kit when both reads fail", async () => {
    mock.handlers.screenshot_url = () => {
      throw new Error("chromium is not installed");
    };
    mock.handlers.firecrawl_scrape = () => {
      throw new Error("no key");
    };
    const { markdown: _m, ...noSheet } = kit;
    mock.handlers.chat = chatReply(noSheet);
    const r = await runOk(h, "wf_brand_kit_from_url", { url: "https://acme.example" });
    const prompt = userText(mock.argsOf("chat")[0] as Obj);
    expect(prompt).toContain("Screenshot taken: no");
    expect(prompt).toContain("(not available)");
    expect(mock.calls.some((c) => c.tool === "generate_image")).toBe(false);
    const out = r.output as Obj;
    expect(out).not.toHaveProperty("screenshot");
    expect(out.read_page_text).toBe(false);
    // No markdown in the reply: the sheet is the kit's JSON.
    expect(JSON.parse(h.saves.at(-1)?.text ?? "null")).toMatchObject({ name: "Acme" });
  });

  it("dry run: 2 paid calls, 4 with images", async () => {
    const plan = await dry("wf_brand_kit_from_url", { url: "https://acme.example" });
    expect(stepRuns(plan)).toMatchObject({ read: "yes", shot: "yes", page: "yes", images: "no" });
    expect(plan.paid_calls_max).toBe(2);
    expect(
      (await dry("wf_brand_kit_from_url", { url: "https://acme.example", make_images: true }))
        .paid_calls_max,
    ).toBe(4);
  });
});

describe("wf_dub_localize with ElevenLabs", () => {
  it("dubs each language and swaps the video's audio track", async () => {
    const r = await runOk(h, "wf_dub_localize", {
      artifact_id: "vid_source01",
      languages: ["es", "fr"],
      source_language: "en",
    });
    expect(mock.order()).toEqual([
      "elevenlabs_dub",
      "elevenlabs_dub",
      "local_video_mux_audio",
      "local_video_mux_audio",
    ]);
    expect(mock.argsOf("elevenlabs_dub")).toEqual([
      {
        artifact_id: "vid_source01",
        target_language: "es",
        source_language: "en",
        max_wait_seconds: 1500,
      },
      {
        artifact_id: "vid_source01",
        target_language: "fr",
        source_language: "en",
        max_wait_seconds: 1500,
      },
    ]);
    const out = r.output as Obj;
    const audio = (out.audio as Obj[]).map((a) => a.id);
    expect(audio).toHaveLength(2);
    expect(
      mock
        .argsOf("local_video_mux_audio")
        .map((a) => [a.video_artifact_id, a.audio_artifact_id, a.mode]),
    ).toEqual(audio.map((id) => ["vid_source01", id, "replace"]));
    expect(out).toMatchObject({ elevenlabs_dubs: 2, tts_tracks: 0, languages: ["es", "fr"] });
    expect(out.videos).toHaveLength(2);
  });

  it("returns audio only for an audio source", async () => {
    const r = await runOk(h, "wf_dub_localize", {
      artifact_id: "aud_source01",
      media: "audio",
      languages: ["de"],
    });
    expect(mock.order()).toEqual(["elevenlabs_dub"]);
    expect(mock.argsOf("elevenlabs_dub")[0]).not.toHaveProperty("source_language");
    expect((r.output as Obj).audio).toHaveLength(1);
  });

  it("dry run: the ElevenLabs path runs, the fallback path does not", async () => {
    const plan = await dry("wf_dub_localize", {
      artifact_id: "vid_source01",
      languages: ["es", "fr"],
    });
    expect(stepRuns(plan)).toMatchObject({
      dubs: "yes",
      dub_videos: "yes",
      transcript: "no",
      translations: "no",
      speech: "no",
    });
    expect(plan.paid_calls_max).toBe(2);
  });
});

describe("wf_dub_localize without ElevenLabs", () => {
  let fb: LoaderHarness;
  beforeAll(async () => {
    // No ElevenLabs pack: available("elevenlabs_dub") is false.
    fb = await bootLoader({ packs: ["media", "local", "web"] });
  });
  afterAll(async () => fb?.close());

  it("transcribes, translates and reads each language, then lays it under the picture", async () => {
    mock.handlers.chat = (args) => ({
      text: `[${userText(args).match(/Translate into ([^:]+):/)?.[1]}] Hola`,
      model: "m",
      provider: "p",
    });
    const r = await runOk(fb, "wf_dub_localize", {
      artifact_id: "vid_source01",
      languages: ["es", "fr"],
      voice: "aria",
    });
    const order = mock.order();
    expect(order[0]).toBe("transcribe_audio");
    expect(order.filter((t) => t === "chat")).toHaveLength(2);
    expect(order.filter((t) => t === "generate_speech")).toHaveLength(2);
    expect(order.slice(-2)).toEqual(["local_video_mux_audio", "local_video_mux_audio"]);
    expect(mock.argsOf("transcribe_audio")[0]).toMatchObject({ artifact_id: "vid_source01" });
    expect(userText(mock.argsOf("chat")[0] as Obj)).toContain("Hello from the source.");
    expect(mock.argsOf("generate_speech").map((a) => [a.text, a.language, a.voice])).toEqual([
      ["[es] Hola", "es", "aria"],
      ["[fr] Hola", "fr", "aria"],
    ]);
    const out = r.output as Obj;
    expect(out).toMatchObject({
      elevenlabs_dubs: 0,
      tts_tracks: 2,
      transcript: "Hello from the source.",
    });
    expect(out.audio).toHaveLength(2);
    expect(out.videos).toHaveLength(2);
  });

  it("dry run: the fallback path, 1 + 2 per language", async () => {
    const plan = await dry(
      "wf_dub_localize",
      { artifact_id: "vid_source01", languages: ["es", "fr"] },
      fb,
    );
    expect(plan.ok).toBe(true);
    expect(stepRuns(plan)).toMatchObject({
      dubs: "no",
      transcript: "yes",
      translations: "yes",
      speech: "yes",
    });
    expect(plan.paid_calls_max).toBe(5);
  });
});

describe("wf_podcast_produce", () => {
  const script = (speakers: string[]) => ({
    title: "Episode 1",
    segments: speakers.map((speaker, i) => ({ speaker, text: `Turn ${i + 1}.` })),
    show_notes_markdown: "- point one",
    music_prompt: "lofi",
  });

  it("one host with music: one read, a bed, a podcast mix and show notes", async () => {
    mock.handlers.chat = chatReply(script(["a", "a", "a"]));
    const r = await runOk(h, "wf_podcast_produce", {
      topic: "Tides",
      music: true,
      voices: { a: "sam" },
    });
    expect(mock.order()).toEqual(["chat", "generate_speech", "generate_music", "local_audio_mix"]);
    expect(mock.argsOf("generate_speech")[0]).toMatchObject({
      text: "Turn 1.\n\nTurn 2.\n\nTurn 3.",
      voice: "sam",
    });
    expect(mock.argsOf("local_audio_mix")[0]).toMatchObject({ preset: "podcast", duck: true });
    const out = r.output as Obj;
    expect((out.episode as Obj).id).toBe(stepArtifacts(r, "mix")[0]);
    expect(h.saves.at(-1)).toMatchObject({
      kind: "document",
      mime: "text/markdown",
      text: "# Episode 1\n\n- point one\n",
    });
    expect((out.show_notes as Obj).id).toBe(h.saves.at(-1)?.id);
  });

  it("two hosts: one speech call per turn with each host's voice, joined into one episode", async () => {
    mock.handlers.chat = chatReply(script(["a", "b", "a"]));
    // The turns finish out of order; the join still follows the script.
    const texts = ["Turn 1.", "Turn 2.", "Turn 3."];
    mock.handlers.generate_speech = async (args) => {
      const i = texts.indexOf(String(args.text));
      await new Promise((r) => setTimeout(r, (texts.length - i) * 15));
      return {
        artifacts: [
          {
            id: `spk_turn${i + 1}`,
            url: `http://127.0.0.1:7777/artifacts/spk_turn${i + 1}`,
            mime: "audio/mpeg",
          },
        ],
      };
    };
    const r = await runOk(h, "wf_podcast_produce", {
      topic: "Tides",
      hosts: 2,
      voices: { a: "sam", b: "kim" },
      music: true,
    });
    expect(mock.order()).toEqual([
      "chat",
      "generate_speech",
      "generate_speech",
      "generate_speech",
      "local_audio_concat",
    ]);
    expect(mock.argsOf("generate_speech").map((a) => [a.text, a.voice])).toEqual([
      ["Turn 1.", "sam"],
      ["Turn 2.", "kim"],
      ["Turn 3.", "sam"],
    ]);
    expect(mock.argsOf("local_audio_concat")).toEqual([
      {
        artifact_ids: ["spk_turn1", "spk_turn2", "spk_turn3"],
        gap_ms: 400,
        loudnorm: true,
        output_format: "mp3",
      },
    ]);
    const out = r.output as Obj;
    expect((out.episode as Obj).id).toBe(stepArtifacts(r, "join")[0]);
    expect((out.episode as Obj).id).toMatch(/^cat_/);
    expect((out.turns as Obj[]).map((t) => t.id)).toEqual(["spk_turn1", "spk_turn2", "spk_turn3"]);
    expect(out.segments).toHaveLength(3);
  });

  it("two hosts: a failed join keeps the run and the separate turns", async () => {
    mock.handlers.chat = chatReply(script(["a", "b"]));
    mock.handlers.local_audio_concat = () => {
      throw new Error("ffmpeg is not installed");
    };
    const r = await runOk(h, "wf_podcast_produce", { topic: "Tides", hosts: 2 });
    expect((r.steps as Obj[]).find((s) => s.id === "join")?.status).toBe("continued");
    const out = r.output as Obj;
    expect(out.episode ?? null).toBeNull();
    expect(out.turns).toHaveLength(2);
    expect((out.show_notes as Obj).id).toBe(h.saves.at(-1)?.id);
  });

  it("one host never joins", async () => {
    mock.handlers.chat = chatReply(script(["a", "a"]));
    const r = await runOk(h, "wf_podcast_produce", { topic: "Tides" });
    expect(mock.order()).toEqual(["chat", "generate_speech"]);
    expect((r.steps as Obj[]).find((s) => s.id === "join")?.status).toBe("skipped");
    expect(((r.output as Obj).episode as Obj).id).toBe(stepArtifacts(r, "full_voice")[0]);
  });

  it("dry run: 2 paid calls for one host, the turns at their cap for two", async () => {
    const one = await dry("wf_podcast_produce", { topic: "Tides" });
    expect(stepRuns(one)).toMatchObject({ full_voice: "yes", turns: "no", music: "no" });
    expect(one.paid_calls_max).toBe(2);
    expect((await dry("wf_podcast_produce", { topic: "Tides", music: true })).paid_calls_max).toBe(
      3,
    );
    const two = await dry("wf_podcast_produce", { topic: "Tides", hosts: 2 });
    // The join is local: it adds no paid call.
    expect(two.paid_calls_max).toBe(13);
    expect(two.ok).toBe(true);
    expect(stepRuns(two)).toMatchObject({ full_voice: "no", turns: "yes", join: "yes" });
    expect(two.steps.find((s) => s.id === "join")).toMatchObject({ paid: false, calls: 1 });
    expect(stepRuns(one).join).toBe("no");
    expect(mock.calls).toEqual([]);
  });
});

describe("wf_podcast_produce without local_audio_concat", () => {
  let bare: LoaderHarness;
  beforeAll(async () => {
    // A local pack from before the tool existed: available("local_audio_concat") is false.
    const local = {
      tools: (MOCK_PACKS.local?.tools ?? []).filter((t) => t.name !== "local_audio_concat"),
    };
    bare = await bootLoader({
      packs: ["media", "web", "elevenlabs"],
      seed: (dir) => writeMockPack(dir, "local", local),
    });
  });
  afterAll(async () => bare?.close());

  it("two hosts: the turns stay separate files, in order, and nothing is joined", async () => {
    expect(bare.registry.get("local_audio_concat")).toBeUndefined();
    expect(bare.registry.get("local_audio_mix")).toBeDefined();
    mock.handlers.chat = chatReply({
      title: "Episode 1",
      segments: [
        { speaker: "a", text: "One." },
        { speaker: "b", text: "Two." },
      ],
      show_notes_markdown: "",
    });
    const r = await runOk(bare, "wf_podcast_produce", { topic: "Tides", hosts: 2 });
    expect(mock.order()).toEqual(["chat", "generate_speech", "generate_speech"]);
    expect((r.steps as Obj[]).find((s) => s.id === "join")?.status).toBe("skipped");
    const out = r.output as Obj;
    expect(out.turns).toHaveLength(2);
    expect(out.episode ?? null).toBeNull();
  });

  it("dry run: the join does not run and does not block", async () => {
    const plan = await dry("wf_podcast_produce", { topic: "Tides", hosts: 2 }, bare);
    expect(plan.ok).toBe(true);
    expect(plan.blocking).toEqual([]);
    expect(stepRuns(plan)).toMatchObject({ turns: "yes", join: "no" });
    expect(plan.paid_calls_max).toBe(13);
  });
});

describe("recipes keep scraped page text inside untrusted markers", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // Recipes that interpolate a scraped page (steps.*.markdown) into an LLM
  // prompt must wrap it in BEGIN/END UNTRUSTED markers and say the text is data,
  // not instructions. (The workflow engine has no random helper, so the marker
  // is fixed here; the growth pack's own tools use a per-call random token.)
  const RECIPES: Record<string, { marker: string; pageExpr: string }> = {
    "brand_kit_from_url.json": {
      marker: "UNTRUSTED PAGE TEXT",
      pageExpr: "steps.page.markdown",
    },
    "issue_triage.json": { marker: "UNTRUSTED ISSUE TEXT", pageExpr: "steps.fetch.markdown" },
    "video_launch_film_16x9.json": {
      marker: "UNTRUSTED PAGE TEXT",
      pageExpr: "steps.page.markdown",
    },
  };

  for (const [file, { marker, pageExpr }] of Object.entries(RECIPES)) {
    it(`${file} wraps ${pageExpr} in ${marker} markers and calls it untrusted`, () => {
      const recipe = readFileSync(`${root}packs/workflows/workflows/${file}`, "utf8");
      const doc = JSON.parse(recipe) as {
        steps: { args?: { messages?: { role: string; content: string }[] } }[];
      };
      const contents = doc.steps.flatMap((s) => s.args?.messages ?? []);
      const withPage = contents.filter((m) => m.content.includes(pageExpr));
      expect(withPage.length).toBeGreaterThan(0);
      for (const m of withPage) {
        expect(m.content).toContain(`-----BEGIN ${marker}-----`);
        expect(m.content).toContain(`-----END ${marker}-----`);
        expect(m.content).toMatch(/never instructions/);
      }
      // The system prompt must say the marked text is data, not instructions.
      const systems = contents.filter((m) => m.role === "system").map((m) => m.content);
      expect(systems.some((c) => c.includes(marker) && /never as instructions/.test(c))).toBe(true);
    });
  }
});
