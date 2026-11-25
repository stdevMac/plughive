// ffmpeg tools with ffmpeg/ffprobe mocked: argv construction, filter escaping,
// option-injection attempts, cancellation and the missing-binary path.
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import pack from "../../../packs/local/index.js";
import {
  ASPECTS,
  escapeFilterText,
  formatProblem,
  quoteFilterValue,
} from "../../../packs/local/lib/ffmpeg.js";
import { HINTS, LocalBackendError } from "../../../packs/local/lib/util.js";
import {
  AudioConcatInput,
  ConvertInput,
  type MIX_PRESETS,
  buildAudioConcatGraph,
  buildCaptionsFilter,
  buildConcatGraph,
  buildMixGraph,
  captionFileFor,
  resolveMix,
} from "../../../packs/local/media.js";
import { failure } from "../provider-support.js";
import { toolOf } from "../support.js";
import { type Env, type SpawnCall, makeEnv, recordingSpawn } from "./harness.js";

const MP4 = "mov,mp4,m4a,3gp,3g2,mj2";
const probeAv = {
  format: { format_name: MP4, duration: "10.0", size: "1000", bit_rate: "800" },
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      width: 1280,
      height: 720,
      avg_frame_rate: "30/1",
    },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
  ],
};
const probeVoice = {
  format: { format_name: "wav", duration: "4.0", size: "10" },
  streams: [
    { index: 0, codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "44100", channels: 1 },
  ],
};

function mediaSpawn(
  probe: object | ((call: SpawnCall) => unknown) = probeAv,
  opts: { subtitles?: boolean; exit?: number } = {},
) {
  return recordingSpawn(async (call) => {
    if (call.binary === "ffprobe") {
      const body = typeof probe === "function" ? (probe as (c: SpawnCall) => unknown)(call) : probe;
      return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
    }
    if (call.args.includes("-filters")) {
      return {
        stdout:
          opts.subtitles === false
            ? " ... drawtext V->V\n"
            : " T.. subtitles        V->V       Render text subtitles\n",
        stderr: "",
        exitCode: 0,
      };
    }
    if (opts.exit) return { stdout: "", stderr: "Error: boom\nlast line", exitCode: opts.exit };
    writeFileSync(call.args[call.args.length - 1] as string, "out");
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

const tool = (name: string) => toolOf(pack, name);
let env: Env | undefined;
afterEach(() => env?.cleanup());

function setup(
  probe?: object | ((c: SpawnCall) => unknown),
  opts?: Parameters<typeof mediaSpawn>[1],
) {
  const m = mediaSpawn(probe, opts);
  env = makeEnv({ spawn: m.spawn });
  return { m, env };
}
const ffmpegCalls = (calls: SpawnCall[]) =>
  calls.filter((c) => c.binary === "ffmpeg" && !c.args.includes("-filters"));

/** Every "-i" is directly preceded by the protocol whitelist, and its operand is an absolute work-dir path. */
function expectLockedInputs(args: readonly string[], dataDir: string) {
  const idx = args.flatMap((a, i) => (a === "-i" ? [i] : []));
  expect(idx.length).toBeGreaterThan(0);
  for (const i of idx) {
    expect(args.slice(i - 2, i)).toEqual(["-protocol_whitelist", "file,pipe"]);
    const p = args[i + 1] as string;
    expect(p.startsWith(`${dataDir}/work/`)).toBe(true);
    expect(p.startsWith("-")).toBe(false);
  }
}

describe("filter escaping", () => {
  it("escapes every filtergraph metacharacter", () => {
    const hostile = "a;b[c]d'e\\f:g,h=i%j k\nl";
    const escaped = escapeFilterText(hostile);
    // Nothing structural survives unescaped.
    expect(escaped.replace(/\\[\s\S]/g, "")).not.toMatch(/[;[\]',:=\n]/);
    const quoted = quoteFilterValue("Alignment=2,FontSize=18");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // A single quote inside a quoted value cannot end the quoting.
    const tricky = quoteFilterValue("x'; drawtext=text=pwned; '");
    expect(tricky).not.toMatch(/^'[^']*'[^']*$/);
  });

  it("builds the caption filter from enums and numbers only, with a fixed file name", () => {
    const f = buildCaptionsFilter("captions.srt", {
      video_artifact_id: "a",
      captions_artifact_id: "b",
      position: "top",
      font_size: 24,
      color: "yellow",
    } as never);
    expect(f.startsWith("subtitles=filename=captions.srt:force_style=")).toBe(true);
    expect(f).toContain("Alignment=8");
    expect(f).toContain("FontSize=24");
    expect(f).toContain("&H0000FFFF");
    expect(f).not.toMatch(/[;[\]]/);
  });

  it("picks the caption file type from content and refuses ASS styling", () => {
    expect(captionFileFor("WEBVTT\n\n00:00.000 --> 00:01.000\nhi")).toBe("captions.vtt");
    expect(captionFileFor("1\n00:00:00,000 --> 00:00:01,000\nhi")).toBe("captions.srt");
    expect(() => captionFileFor("[Script Info]\nTitle: x")).toThrow(/ASS/);
  });
});

describe("filter graphs", () => {
  const graphFor = (name: keyof typeof MIX_PRESETS, n = 2) => {
    const r = resolveMix(
      {
        inputs: Array.from({ length: n }, (_, i) => ({ artifact_id: `a${i}` })),
        preset: name,
      } as never,
      10,
    );
    return { g: buildMixGraph(r.graph), total: r.totalSec };
  };

  it("mix graph: sidechain ducking, loudnorm, no single-letter labels, voice split once", () => {
    for (const p of ["ad", "narration", "podcast", "trailer"] as const) {
      const { g } = graphFor(p);
      expect(g).toContain("sidechaincompress");
      expect(g).toContain("loudnorm=I=-14:TP=-1");
      expect(g).toContain("asplit=2[voice][voicekey]");
      const labels = [...g.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1] as string);
      expect(labels.filter((l) => /^[a-z]$/i.test(l))).toEqual([]);
      // each filter output label is produced exactly once
      const produced = [...g.matchAll(/\[([A-Za-z_][\w]*)\](?=;|$)/g)].map((m) => m[1]);
      expect(new Set(produced).size).toBe(produced.length);
    }
  });

  it("mix graph: preset timings feed the total duration", () => {
    expect(graphFor("ad").total).toBeCloseTo(1 + 10 + 1.5, 6);
    expect(graphFor("narration").total).toBeCloseTo(2 + 10 + 2.5, 6);
  });

  it("mix graph: several background tracks are summed before ducking; custom skips ducking", () => {
    const { g } = graphFor("ad", 4);
    expect(g).toContain("amix=inputs=3:duration=longest:normalize=0[bg_pre]");
    const custom = graphFor("custom").g;
    expect(custom).not.toContain("sidechaincompress");
    expect(custom).not.toContain("loudnorm");
  });

  it("concat graph: normalises every clip and synthesises silence when audio is missing", () => {
    const { graph, audio } = buildConcatGraph(
      [
        { hasAudio: true, duration: 3 },
        { hasAudio: false, duration: 2.5 },
      ],
      ASPECTS["9:16"],
      30,
    );
    expect(audio).toBe(true);
    expect(graph).toContain("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920");
    expect(graph).toContain("anullsrc=r=44100:cl=stereo,atrim=duration=2.5[aud1]");
    expect(graph).toContain("concat=n=2:v=1:a=1[outv][outa]");
    const silent = buildConcatGraph(
      [
        { hasAudio: false, duration: 1 },
        { hasAudio: false, duration: 1 },
      ],
      ASPECTS["1:1"],
      30,
    );
    expect(silent.audio).toBe(false);
    expect(silent.graph).toContain("concat=n=2:v=1:a=0[outv]");
  });

  it("recognises dangerous containers", () => {
    for (const f of ["hls", "concat", "ffconcat", "sdp", "applehttp", "mov,mp4,concat"])
      expect(formatProblem(f)).not.toBeNull();
    expect(formatProblem(MP4)).toBeNull();
    expect(formatProblem("wav")).toBeNull();
    expect(formatProblem("totally_made_up")).not.toBeNull();
  });

  it("accepts only the listed image pipes, not every *_pipe demuxer (L9)", () => {
    for (const f of ["png_pipe", "jpeg_pipe", "webp_pipe", "bmp_pipe", "tiff_pipe"])
      expect(formatProblem(f)).toBeNull();
    // svg_pipe renders through librsvg and can reference other resources; the
    // rest are rarely needed parsers that widen the attack surface.
    for (const f of ["svg_pipe", "exr_pipe", "psd_pipe", "dpx_pipe", "anything_pipe"])
      expect(formatProblem(f)).not.toBeNull();
  });
});

describe("input validation (option injection)", () => {
  const hostileIds = [
    "-i",
    "--help",
    "a;b",
    "a[b]",
    "a'b",
    "a b",
    "../x",
    "/etc/passwd",
    "a/b",
    "file:///etc/passwd",
    "a\nb",
    "",
    "x".repeat(65),
    "-protocol_whitelist",
  ];

  it("every ffmpeg tool rejects artifact ids that are not plain ids", () => {
    const shapes: Array<[string, (id: string) => unknown]> = [
      ["local_media_probe", (id) => ({ artifact_id: id })],
      ["local_media_convert", (id) => ({ artifact_id: id, operation: "transcode" })],
      ["local_audio_mix", (id) => ({ inputs: [{ artifact_id: id }, { artifact_id: "ok1" }] })],
      ["local_video_concat", (id) => ({ artifact_ids: [id, "ok1"] })],
      ["local_audio_concat", (id) => ({ artifact_ids: ["ok1", id] })],
      ["local_video_mux_audio", (id) => ({ video_artifact_id: id, audio_artifact_id: "ok1" })],
      [
        "local_video_burn_captions",
        (id) => ({ video_artifact_id: "ok1", captions_artifact_id: id }),
      ],
      ["local_transcribe", (id) => ({ artifact_id: id })],
    ];
    for (const [name, make] of shapes) {
      for (const id of hostileIds) {
        expect(
          tool(name).input.safeParse(make(id)).success,
          `${name} accepted ${JSON.stringify(id)}`,
        ).toBe(false);
      }
      expect(tool(name).input.safeParse(make("art_1-x")).success, name).toBe(true);
    }
  });

  it("rejects unknown fields that could carry paths or ffmpeg flags", () => {
    const parsed = ConvertInput.safeParse({
      artifact_id: "a1",
      operation: "transcode",
      output_path: "/tmp/x",
      extra_args: ["-i", "/etc/passwd"],
    });
    // zod strips unknown keys: they never reach the argv builder
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data)).toEqual(["artifact_id", "operation"]);
  });

  it("only accepts enum formats and bounded numbers", () => {
    const bad = [
      { artifact_id: "a1", operation: "transcode", format: "mp4;rm" },
      { artifact_id: "a1", operation: "transcode", format: "avi" },
      { artifact_id: "a1", operation: "scale", width: 100000 },
      { artifact_id: "a1", operation: "scale", width: 8 },
      { artifact_id: "a1", operation: "trim", duration_s: 99999 },
      { artifact_id: "a1", operation: "trim" },
      { artifact_id: "a1", operation: "reframe" },
      { artifact_id: "a1", operation: "reframe", aspect: "4:5" },
      { artifact_id: "a1", operation: "transcode", crf: 0 },
    ];
    for (const b of bad) expect(ConvertInput.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("an id that passes the schema but names nothing is refused before anything runs", async () => {
    const { m, env } = setup();
    await expect(
      tool("local_media_convert").run({ artifact_id: "ghost", operation: "transcode" }, env.ctx),
    ).rejects.toThrow(/not found/);
    expect(m.calls).toHaveLength(0);
  });

  it("run() re-checks ids even when the schema was skipped", async () => {
    const { m, env } = setup();
    for (const id of ["-i", "a;b", "/etc/passwd"]) {
      await expect(tool("local_media_probe").run({ artifact_id: id }, env.ctx)).rejects.toThrow(
        /artifact id/,
      );
    }
    expect(m.calls).toHaveLength(0);
  });

  it("rejects playlist-like containers reported by ffprobe", async () => {
    const { env } = setup({
      format: { format_name: "hls", duration: "1" },
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 10, height: 10 }],
    });
    const id = env.add("list.m3u8", "#EXTM3U");
    await expect(tool("local_media_probe").run({ artifact_id: id }, env.ctx)).rejects.toThrow(
      /not accepted/,
    );
  });

  it("rejects oversized inputs", async () => {
    const { env } = setup({
      format: { format_name: MP4, duration: "1" },
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 20000, height: 100 }],
    });
    const id = env.add("v.mp4", "x");
    await expect(tool("local_media_probe").run({ artifact_id: id }, env.ctx)).rejects.toThrow(
      /larger than/,
    );
  });
});

describe("argv construction", () => {
  it("convert: locked inputs, cwd in work dir, bounded output, fixed encoder args", async () => {
    const { m, env } = setup();
    const id = env.add("v.mp4", "x", "video/mp4", "video");
    const r = (await tool("local_media_convert").run(
      { artifact_id: id, operation: "reframe", aspect: "9:16", fit: "cover", crf: 25 },
      env.ctx,
    )) as { artifact: { id: string; mime: string } };
    expect(r.artifact.mime).toBe("video/mp4");
    const [call] = ffmpegCalls(m.calls);
    expect(call).toBeDefined();
    const args = (call as SpawnCall).args;
    expectLockedInputs(args, env.dataDir);
    expect(args.slice(0, 5)).toEqual(["-hide_banner", "-nostdin", "-loglevel", "error", "-y"]);
    expect(args).toContain("-t");
    expect(args).toContain("-fs");
    const vf = args[args.indexOf("-vf") + 1] as string;
    expect(vf).toContain("1080:1920");
    expect(args[args.indexOf("-crf") + 1]).toBe("25");
    expect((call as SpawnCall).opts?.cwd?.startsWith(`${env.dataDir}/work/`)).toBe(true);
    // every argument is a string with no NUL/newline, nothing is a shell string
    for (const a of args) expect(a).not.toMatch(/[\0\n]/);
  });

  it("cleans the work dir after success and after failure", async () => {
    const ok = setup();
    const id = ok.env.add("v.mp4", "x", "video/mp4", "video");
    await tool("local_media_convert").run({ artifact_id: id, operation: "transcode" }, ok.env.ctx);
    expect(
      existsSync(`${ok.env.dataDir}/work`) ? require_ls(`${ok.env.dataDir}/work`) : [],
    ).toEqual([]);
    ok.env.cleanup();
    const bad = setup(probeAv, { exit: 1 });
    const id2 = bad.env.add("v.mp4", "x", "video/mp4", "video");
    await expect(
      tool("local_media_convert").run({ artifact_id: id2, operation: "transcode" }, bad.env.ctx),
    ).rejects.toThrow(/ffmpeg failed.*boom/s);
    expect(
      existsSync(`${bad.env.dataDir}/work`) ? require_ls(`${bad.env.dataDir}/work`) : [],
    ).toEqual([]);
  });

  it("mix: one -i per input, the filter graph is a single argument, labels come from the mapping", async () => {
    const { m, env } = setup((c) =>
      c.args.join(" ").includes("in0")
        ? probeVoice
        : { ...probeVoice, format: { ...probeVoice.format, duration: "30" } },
    );
    const a = env.add("v.wav", "x");
    const b = env.add("m.wav", "x");
    const r = (await tool("local_audio_mix").run(
      {
        inputs: [{ artifact_id: a }, { artifact_id: b, volume: 0.3 }],
        preset: "ad",
        output_format: "mp3",
      },
      env.ctx,
    )) as { total_duration_s: number };
    expect(r.total_duration_s).toBeCloseTo(6.5, 1);
    const args = (ffmpegCalls(m.calls)[0] as SpawnCall).args;
    expectLockedInputs(args, env.dataDir);
    expect(args.filter((x) => x === "-i")).toHaveLength(2);
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("volume=0.3");
    expect(args[args.indexOf("-map") + 1]).toBe("[mixout]");
  });

  it("concat: video-only normalisation graph and bounded duration", async () => {
    const { m, env } = setup();
    const a = env.add("a.mp4", "x");
    const b = env.add("b.mp4", "x");
    await tool("local_video_concat").run({ artifact_ids: [a, b], aspect: "1:1" }, env.ctx);
    const args = (ffmpegCalls(m.calls)[0] as SpawnCall).args;
    expectLockedInputs(args, env.dataDir);
    expect(args.filter((x) => x === "-i")).toHaveLength(2);
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("concat=n=2:v=1:a=1[outv][outa]");
  });

  it("concat refuses to build something longer than the cap", async () => {
    const { env } = setup({ ...probeAv, format: { ...probeAv.format, duration: "1500" } });
    const a = env.add("a.mp4", "x");
    const b = env.add("b.mp4", "x");
    await expect(tool("local_video_concat").run({ artifact_ids: [a, b] }, env.ctx)).rejects.toThrow(
      /limit/,
    );
  });

  it("audio concat: one -i per item, gaps and loudnorm inside a single filter argument", async () => {
    const { m, env } = setup(probeVoice);
    const ids = [env.add("t1.wav", "x"), env.add("t2.wav", "x"), env.add("t3.wav", "x")];
    const r = (await tool("local_audio_concat").run(
      { artifact_ids: ids, gap_ms: 500, loudnorm: true, output_format: "wav" },
      env.ctx,
    )) as { artifact: { mime: string }; items: number; total_duration_s: number };
    // 3 x 4 s plus two 0.5 s gaps
    expect(r.total_duration_s).toBeCloseTo(13, 3);
    expect(r.items).toBe(3);
    expect(r.artifact.mime).toBe("audio/wav");
    const args = (ffmpegCalls(m.calls)[0] as SpawnCall).args;
    expectLockedInputs(args, env.dataDir);
    expect(args.filter((x) => x === "-i")).toHaveLength(3);
    const graph = args[args.indexOf("-filter_complex") + 1] as string;
    expect(graph).toContain("[aud0][gap0][aud1][gap1][aud2]concat=n=5:v=0:a=1[joined]");
    expect(graph).toContain("atrim=duration=0.5[gap0]");
    expect(graph).toContain("loudnorm=I=-16");
    expect(args[args.indexOf("-map") + 1]).toBe("[catout]");
    expect(args[args.indexOf("-c:a") + 1]).toBe("pcm_s16le");
    expect(args).toContain("-t");
    for (const a of args) expect(a).not.toMatch(/[\0\n]/);
  });

  it("audio concat graph: no gap segments and no loudnorm unless asked", () => {
    const g = buildAudioConcatGraph({ n: 2, gap_ms: 0, loudnorm: false });
    expect(g).not.toContain("anullsrc");
    expect(g).not.toContain("loudnorm");
    expect(g).toContain("[aud0][aud1]concat=n=2:v=0:a=1[joined]");
    // A gap goes only between items, never after the last one.
    const withGap = buildAudioConcatGraph({ n: 2, gap_ms: 250, loudnorm: false });
    expect(withGap.match(/anullsrc/g)).toHaveLength(1);
  });

  it("audio concat refuses inputs with no audio, too many items, bad gaps and over-long results", async () => {
    const bad = [
      { artifact_ids: ["a1"] },
      { artifact_ids: Array.from({ length: 201 }, (_, i) => `a${i}`) },
      { artifact_ids: ["a1", "a2"], gap_ms: -1 },
      { artifact_ids: ["a1", "a2"], gap_ms: 10_001 },
      { artifact_ids: ["a1", "a2"], gap_ms: 1.5 },
      { artifact_ids: ["a1", "a2"], output_format: "ogg;rm" },
    ];
    for (const b of bad)
      expect(AudioConcatInput.safeParse(b).success, JSON.stringify(b)).toBe(false);

    const silent = setup({
      format: { format_name: MP4, duration: "3" },
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", width: 10, height: 10 }],
    });
    const v1 = silent.env.add("a.mp4", "x");
    const v2 = silent.env.add("b.mp4", "x");
    await expect(
      tool("local_audio_concat").run({ artifact_ids: [v1, v2] }, silent.env.ctx),
    ).rejects.toThrow(/no audio/);
    expect(ffmpegCalls(silent.m.calls)).toHaveLength(0);
    silent.env.cleanup();

    const long = setup({ ...probeVoice, format: { ...probeVoice.format, duration: "1000" } });
    const l1 = long.env.add("a.wav", "x");
    const l2 = long.env.add("b.wav", "x");
    await expect(
      tool("local_audio_concat").run({ artifact_ids: [l1, l2] }, long.env.ctx),
    ).rejects.toThrow(/limit/);
    expect(ffmpegCalls(long.m.calls)).toHaveLength(0);
  });

  it("mux: copies H.264 and maps the new audio", async () => {
    const { m, env } = setup((c) => (c.args.join(" ").includes("in1") ? probeVoice : probeAv));
    const v = env.add("v.mp4", "x");
    const a = env.add("a.wav", "x");
    await tool("local_video_mux_audio").run(
      { video_artifact_id: v, audio_artifact_id: a },
      env.ctx,
    );
    const args = (ffmpegCalls(m.calls)[0] as SpawnCall).args;
    expectLockedInputs(args, env.dataDir);
    expect(args[args.indexOf("-c:v") + 1]).toBe("copy");
    expect(args).toContain("[muxa]");
  });

  it("burn captions: the caption text goes into a file, never onto argv", async () => {
    const { m, env } = setup();
    const v = env.add("v.mp4", "x");
    const hostile = "1\n00:00:00,000 --> 00:00:01,000\nHello;[x]'quote'\\:, drawtext=text=pwned\n";
    const c = env.add("c.srt", hostile);
    await tool("local_video_burn_captions").run(
      { video_artifact_id: v, captions_artifact_id: c },
      env.ctx,
    );
    const call = ffmpegCalls(m.calls)[0] as SpawnCall;
    const joined = call.args.join("\n");
    expect(joined).not.toContain("pwned");
    expect(joined).not.toContain("Hello");
    expect(call.args[call.args.indexOf("-vf") + 1]).toMatch(
      /^subtitles=filename=captions\.srt:force_style=/,
    );
  });

  it("burn captions: ASS content is refused and a missing libass gets an install hint", async () => {
    const a = setup();
    const v = a.env.add("v.mp4", "x");
    const ass = a.env.add(
      "c.ass",
      "[Script Info]\nTitle: x\n[Events]\nDialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,\\h",
    );
    await expect(
      tool("local_video_burn_captions").run(
        { video_artifact_id: v, captions_artifact_id: ass },
        a.env.ctx,
      ),
    ).rejects.toThrow(/ASS/);
    a.env.cleanup();
    const b = setup(probeAv, { subtitles: false });
    const v2 = b.env.add("v.mp4", "x");
    const s = b.env.add("c.srt", "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
    await expect(
      tool("local_video_burn_captions").run(
        { video_artifact_id: v2, captions_artifact_id: s },
        b.env.ctx,
      ),
    ).rejects.toThrow(/libass/);
  });
});

describe("failure modes", () => {
  it("a missing ffmpeg reports how to install it", async () => {
    const spawn = async () => {
      throw Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" });
    };
    env = makeEnv({ spawn: spawn as never });
    const id = env.add("v.mp4", "x");
    const err = await failure(tool("local_media_probe").run({ artifact_id: id }, env.ctx));
    expect(err).toBeInstanceOf(LocalBackendError);
    expect(err.message).toContain(HINTS.ffmpeg);
  });

  it("a timeout reported by the kernel becomes an error", async () => {
    const { env } = setup();
    env.ctx.spawn = (async (bin: string) =>
      bin === "ffprobe"
        ? { stdout: JSON.stringify(probeAv), stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: -1, timedOut: true }) as never;
    const id = env.add("v.mp4", "x");
    await expect(
      tool("local_media_convert").run({ artifact_id: id, operation: "transcode" }, env.ctx),
    ).rejects.toThrow(/timed out/);
  });

  it("cancellation surfaces as 'cancelled' and still cleans up", async () => {
    const ac = new AbortController();
    const m = recordingSpawn(async (call) => {
      if (call.binary === "ffprobe")
        return { stdout: JSON.stringify(probeAv), stderr: "", exitCode: 0 };
      ac.abort();
      return { stdout: "", stderr: "", exitCode: 255 };
    });
    env = makeEnv({ spawn: m.spawn, signal: ac.signal });
    const id = env.add("v.mp4", "x");
    await expect(
      tool("local_media_convert").run({ artifact_id: id, operation: "transcode" }, env.ctx),
    ).rejects.toThrow(/cancelled/);
    expect(existsSync(`${env.dataDir}/work`) ? require_ls(`${env.dataDir}/work`) : []).toEqual([]);
  });

  it("reports progress through ctx.progress", async () => {
    const { env } = setup();
    const seen: number[] = [];
    (env.ctx as { progress?: (f: number) => void }).progress = (f) => seen.push(f);
    const id = env.add("v.mp4", "x", "video/mp4", "video");
    await tool("local_media_convert").run({ artifact_id: id, operation: "transcode" }, env.ctx);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

import { readdirSync } from "node:fs";
function require_ls(dir: string): string[] {
  return readdirSync(dir);
}
