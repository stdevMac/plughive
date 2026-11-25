// Real ffmpeg/ffprobe, lavfi sources only. Skipped when ffmpeg is not installed.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pack from "../../../packs/local/index.js";
import { toolOf } from "../support.js";
import { type Env, ffmpegPresent, makeEnv, makeFixture, realSpawn } from "./harness.js";

const have = ffmpegPresent();
const d = describe.skipIf(!have);

async function hasFilter(name: string): Promise<boolean> {
  const r = await realSpawn("ffmpeg", ["-hide_banner", "-filters"]);
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(r.stdout);
}

d("local ffmpeg tools (real ffmpeg)", () => {
  let env: Env;
  let videoAv: string;
  let videoSilent: string;
  let voice: string;
  let music: string;
  let subtitles = false;

  const call = async (name: string, input: unknown) => {
    const tool = toolOf(pack, name);
    return (await tool.run(tool.input.parse(input), env.ctx)) as Record<string, any>;
  };
  const probe = async (artifactId: string) =>
    call("local_media_probe", { artifact_id: artifactId });

  beforeAll(async () => {
    env = makeEnv({ spawn: realSpawn });
    subtitles = await hasFilter("subtitles");
    videoAv = env.addFile(
      await makeFixture(env, "av.mp4", [
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x240:rate=25:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
      ]),
      "video/mp4",
      "video",
    );
    videoSilent = env.addFile(
      await makeFixture(env, "silent.mp4", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=30:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
      ]),
      "video/mp4",
      "video",
    );
    voice = env.addFile(
      await makeFixture(env, "voice.wav", ["-f", "lavfi", "-i", "sine=frequency=300:duration=2"]),
      "audio/wav",
    );
    music = env.addFile(
      await makeFixture(env, "music.wav", ["-f", "lavfi", "-i", "sine=frequency=600:duration=5"]),
      "audio/wav",
    );
  }, 60_000);

  afterAll(() => env?.cleanup());

  it("probes video and audio", async () => {
    const v = await probe(videoAv);
    expect(v.has_video).toBe(true);
    expect(v.has_audio).toBe(true);
    expect(v.width).toBe(320);
    expect(v.height).toBe(240);
    expect(v.duration_s).toBeGreaterThan(2.5);
    const a = await probe(voice);
    expect(a.has_video).toBe(false);
    expect(a.has_audio).toBe(true);
  });

  it("leaves no work files behind", async () => {
    await probe(videoAv);
    const work = join(env.dataDir, "work");
    let left: string[] = [];
    try {
      left = readdirSync(work);
    } catch {
      /* never created */
    }
    expect(left).toEqual([]);
  });

  it("rejects hostile or non-media inputs", async () => {
    const concatFile = env.add(
      "list.txt",
      "ffconcat version 1.0\nfile '/etc/passwd'\n",
      "text/plain",
    );
    await expect(probe(concatFile)).rejects.toThrow();
    const hls = env.add(
      "x.m3u8",
      "#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n",
      "application/x-mpegurl",
    );
    await expect(probe(hls)).rejects.toThrow();
    await expect(probe("../../etc/passwd")).rejects.toThrow();
    await expect(probe("-i")).rejects.toThrow();
    await expect(probe("does-not-exist")).rejects.toThrow(/not found/);
  });

  it("trims and scales", async () => {
    const r = await call("local_media_convert", {
      artifact_id: videoAv,
      operation: "trim",
      start_s: 0.5,
      duration_s: 1,
    });
    const p = await probe(r.artifact.id);
    expect(p.duration_s).toBeGreaterThan(0.7);
    expect(p.duration_s).toBeLessThan(1.4);
    const s = await call("local_media_convert", {
      artifact_id: videoAv,
      operation: "scale",
      width: 160,
    });
    const sp = await probe(s.artifact.id);
    expect(sp.width).toBe(160);
    expect(sp.height).toBe(120);
  }, 60_000);

  it("reframes to fixed aspect presets", async () => {
    const r = await call("local_media_convert", {
      artifact_id: videoSilent,
      operation: "reframe",
      aspect: "1:1",
      fit: "contain",
    });
    const p = await probe(r.artifact.id);
    expect([p.width, p.height]).toEqual([1080, 1080]);
  }, 90_000);

  it("extracts audio, takes a thumbnail and makes a gif", async () => {
    const a = await call("local_media_convert", {
      artifact_id: videoAv,
      operation: "extract_audio",
      audio_format: "mp3",
    });
    expect(a.artifact.mime).toBe("audio/mpeg");
    expect((await probe(a.artifact.id)).has_audio).toBe(true);
    const t = await call("local_media_convert", {
      artifact_id: videoAv,
      operation: "thumbnail",
      at_s: 1,
    });
    expect(t.artifact.mime).toBe("image/jpeg");
    const g = await call("local_media_convert", {
      artifact_id: videoAv,
      operation: "gif",
      duration_s: 1,
      width: 160,
    });
    expect(g.artifact.mime).toBe("image/gif");
    const gp = await probe(g.artifact.id);
    expect(gp.width).toBe(160);
  }, 90_000);

  it("mixes voice and music with ducking and loudnorm", async () => {
    const r = await call("local_audio_mix", {
      inputs: [{ artifact_id: voice }, { artifact_id: music }],
      preset: "ad",
    });
    // 1 s intro + 2 s voice + 1.5 s outro
    expect(r.total_duration_s).toBeCloseTo(4.5, 1);
    const p = await probe(r.artifact.id);
    expect(p.has_audio).toBe(true);
    expect(p.duration_s).toBeGreaterThan(4.0);
    expect(p.duration_s).toBeLessThan(5.1);
  }, 90_000);

  it("mixes without ducking and with several background tracks", async () => {
    const r = await call("local_audio_mix", {
      inputs: [
        { artifact_id: voice },
        { artifact_id: music, volume: 0.3 },
        { artifact_id: music, volume: 0.1 },
      ],
      preset: "custom",
      output_format: "wav",
    });
    expect(r.artifact.mime).toBe("audio/wav");
  }, 90_000);

  it("joins audio end to end with gaps and loudnorm, mixing mono, stereo and a video's audio", async () => {
    // voice: 2 s mono wav; music: 5 s; videoAv: 3 s with an AAC track.
    const r = await call("local_audio_concat", {
      artifact_ids: [voice, music, videoAv],
      gap_ms: 500,
      loudnorm: true,
    });
    expect(r.artifact.mime).toBe("audio/mpeg");
    expect(r.total_duration_s).toBeGreaterThan(10.5);
    const p = await probe(r.artifact.id);
    expect(p.has_audio).toBe(true);
    expect(p.has_video).toBe(false);
    expect(p.duration_s).toBeGreaterThan(10.5);
    expect(p.duration_s).toBeLessThan(11.6);
    const plain = await call("local_audio_concat", {
      artifact_ids: [voice, voice],
      output_format: "wav",
    });
    expect(plain.artifact.mime).toBe("audio/wav");
    const pp = await probe(plain.artifact.id);
    expect(pp.duration_s).toBeGreaterThan(3.8);
    expect(pp.duration_s).toBeLessThan(4.3);
    await expect(
      call("local_audio_concat", { artifact_ids: [voice, videoSilent] }),
    ).rejects.toThrow(/no audio/);
  }, 90_000);

  it("concatenates clips of different sizes, with and without audio", async () => {
    const r = await call("local_video_concat", {
      artifact_ids: [videoAv, videoSilent],
      aspect: "16:9",
      fps: 25,
    });
    const p = await probe(r.artifact.id);
    expect([p.width, p.height]).toEqual([1920, 1080]);
    expect(p.has_audio).toBe(true);
    expect(p.duration_s).toBeGreaterThan(4.5);
  }, 120_000);

  it("muxes audio onto a video (replace and mix)", async () => {
    const r = await call("local_video_mux_audio", {
      video_artifact_id: videoSilent,
      audio_artifact_id: music,
    });
    const p = await probe(r.artifact.id);
    expect(p.has_audio).toBe(true);
    expect(p.has_video).toBe(true);
    expect(p.duration_s).toBeLessThan(2.6);
    const m = await call("local_video_mux_audio", {
      video_artifact_id: videoAv,
      audio_artifact_id: voice,
      mode: "mix",
    });
    expect((await probe(m.artifact.id)).has_audio).toBe(true);
  }, 90_000);

  it("refuses non-video / non-audio inputs for the wrong tool", async () => {
    await expect(
      call("local_video_mux_audio", { video_artifact_id: voice, audio_artifact_id: music }),
    ).rejects.toThrow(/not a video/);
    await expect(
      call("local_media_convert", { artifact_id: voice, operation: "gif" }),
    ).rejects.toThrow(/video/);
  });

  it("burns captions when this ffmpeg has libass", async (ctx) => {
    if (!subtitles) ctx.skip();
    const srt = env.add(
      "c.srt",
      "1\n00:00:00,000 --> 00:00:02,000\nHello; [world] 'quoted' \\ : x\n",
      "application/x-subrip",
    );
    const r = await call("local_video_burn_captions", {
      video_artifact_id: videoAv,
      captions_artifact_id: srt,
      position: "middle",
    });
    expect((await probe(r.artifact.id)).has_video).toBe(true);
  }, 90_000);

  it("explains a missing libass instead of failing obscurely", async (ctx) => {
    if (subtitles) ctx.skip();
    const srt = env.add("c.srt", "1\n00:00:00,000 --> 00:00:02,000\nHi\n", "application/x-subrip");
    await expect(
      call("local_video_burn_captions", { video_artifact_id: videoAv, captions_artifact_id: srt }),
    ).rejects.toThrow(/libass/);
  });
});
