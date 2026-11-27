// Cover art stored ahead of the real video. ffmpeg's `0:v:0` matches every
// picture stream, attached pictures included, so a file whose stream 0 is
// cover art used to have its still treated as "the video". The tools map
// `0:V:0` and the probe describes the same stream. Real ffmpeg, lavfi sources
// only; skipped when ffmpeg is not installed.
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upscaleVideo } from "../../../packs/local/imaging.js";
import pack from "../../../packs/local/index.js";
import { probeFile } from "../../../packs/local/lib/ffmpeg.js";
import { toolOf } from "../support.js";
import { type Env, ffmpegPresent, makeEnv, makeFixture, realSpawn } from "./harness.js";

const have = ffmpegPresent();
const d = describe.skipIf(!have);

// ffmpeg's MP4 muxer writes the cover (moov/udta/meta/ilst/covr) after the
// tracks, and the demuxer numbers streams in the order it meets them. Moving
// udta ahead of the trak boxes inside moov makes the cover stream 0, as some
// taggers do. moov keeps its size and place, so the chunk offsets stay valid.
function coverFirst(src: string, dest: string): void {
  const b = readFileSync(src);
  const boxes = (start: number, end: number) => {
    const out: { p: number; size: number; type: string }[] = [];
    for (let p = start; p + 8 <= end; ) {
      const size = b.readUInt32BE(p);
      if (size < 8) throw new Error("unexpected MP4 box layout");
      out.push({ p, size, type: b.toString("latin1", p + 4, p + 8) });
      p += size;
    }
    return out;
  };
  const moov = boxes(0, b.length).find((x) => x.type === "moov");
  if (!moov) throw new Error("no moov box");
  const kids = boxes(moov.p + 8, moov.p + moov.size);
  const order = [
    ...kids.filter((k) => k.type !== "trak" && k.type !== "udta"),
    ...kids.filter((k) => k.type === "udta"),
    ...kids.filter((k) => k.type === "trak"),
  ];
  Buffer.concat(order.map((k) => b.subarray(k.p, k.p + k.size))).copy(b, moov.p + 8);
  writeFileSync(dest, b);
}

async function rawStreams(path: string) {
  const r = await realSpawn("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    path,
  ]);
  return (JSON.parse(r.stdout).streams ?? []) as Array<{
    codec_type: string;
    width?: number;
    disposition?: { attached_pic?: number };
  }>;
}

d("cover art ahead of the video stream (real ffmpeg)", () => {
  let env: Env;
  let coverPath: string;
  let video: string;
  let artAudio: string;

  const call = async (name: string, input: unknown) => {
    const tool = toolOf(pack, name);
    return (await tool.run(tool.input.parse(input), env.ctx)) as Record<string, any>;
  };
  const probe = async (artifactId: string) =>
    call("local_media_probe", { artifact_id: artifactId });

  beforeAll(async () => {
    env = makeEnv({ spawn: realSpawn });
    // Square 64x64 art against a 4:3 320x240 video, so any output made from
    // the art has the wrong shape as well as the wrong size.
    const art = await makeFixture(env, "cover.png", [
      "-f",
      "lavfi",
      "-i",
      "color=red:size=64x64:duration=1",
      "-frames:v",
      "1",
    ]);
    const tail = await makeFixture(env, "cover-last.mp4", [
      "-i",
      art,
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=25:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-map",
      "0",
      "-map",
      "1",
      "-map",
      "2",
      "-c:v:0",
      "png",
      "-disposition:v:0",
      "attached_pic",
      "-c:v:1",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
    ]);
    coverPath = tail.replace("cover-last.mp4", "cover-first.mp4");
    coverFirst(tail, coverPath);
    video = env.addFile(coverPath, "video/mp4", "video");
    artAudio = env.addFile(
      await makeFixture(env, "art.m4a", [
        "-i",
        art,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=2",
        "-map",
        "0",
        "-map",
        "1",
        "-c:v",
        "png",
        "-disposition:v:0",
        "attached_pic",
        "-c:a",
        "aac",
      ]),
      "audio/mp4",
      "audio",
    );
  }, 60_000);

  afterAll(() => env?.cleanup());

  it("the fixture really has the cover art as stream 0", async () => {
    const s = await rawStreams(coverPath);
    expect(s[0]?.codec_type).toBe("video");
    expect(s[0]?.disposition?.attached_pic).toBe(1);
    expect(s[0]?.width).toBe(64);
    expect(s[1]?.codec_type).toBe("video");
    expect(s[1]?.disposition?.attached_pic).toBe(0);
    expect(s[1]?.width).toBe(320);
  });

  it("the probe describes the real video, not the art", async () => {
    const info = await probeFile(env.ctx, coverPath);
    expect(info.hasVideo).toBe(true);
    expect(info.isImage).toBe(false);
    expect([info.width, info.height]).toEqual([320, 240]);
    expect(info.videoCodec).toBe("h264");
    expect(info.streams[0]?.type).toBe("cover_art");
    const p = await probe(video);
    expect([p.width, p.height]).toEqual([320, 240]);
    expect(p.duration_s).toBeGreaterThan(1.5);
  });

  it("convert scales, thumbnails and gifs the real video", async () => {
    const s = await call("local_media_convert", {
      artifact_id: video,
      operation: "scale",
      width: 160,
    });
    const sp = await probe(s.artifact.id);
    expect([sp.width, sp.height]).toEqual([160, 120]);
    expect(sp.duration_s).toBeGreaterThan(1.5);
    const t = await call("local_media_convert", {
      artifact_id: video,
      operation: "thumbnail",
      at_s: 1,
    });
    const tp = await probe(t.artifact.id);
    expect([tp.width, tp.height]).toEqual([320, 240]);
    const g = await call("local_media_convert", {
      artifact_id: video,
      operation: "gif",
      duration_s: 1,
      width: 160,
    });
    const gp = await probe(g.artifact.id);
    expect([gp.width, gp.height]).toEqual([160, 120]);
  }, 120_000);

  it("concat, mux and upscale use the real video", async () => {
    const c = await call("local_video_concat", { artifact_ids: [video, video], fps: 25 });
    const cp = await probe(c.artifact.id);
    expect([cp.width, cp.height]).toEqual([320, 240]);
    expect(cp.duration_s).toBeGreaterThan(3.5);
    const m = await call("local_video_mux_audio", {
      video_artifact_id: video,
      audio_artifact_id: artAudio,
    });
    const mp = await probe(m.artifact.id);
    expect([mp.width, mp.height]).toEqual([320, 240]);
    expect(mp.streams.filter((s: { type: string }) => s.type === "video")).toHaveLength(1);
    const u = (await upscaleVideo(env.ctx, { artifact_id: video, scale: 2 }, "video.upscale")) as {
      artifacts: Array<{ id: string }>;
    };
    const up = await probe(u.artifacts[0]?.id as string);
    expect([up.width, up.height]).toEqual([640, 480]);
  }, 180_000);

  it("audio with only cover art stays audio-only", async () => {
    const p = await probe(artAudio);
    expect(p.has_video).toBe(false);
    expect(p.has_audio).toBe(true);
    await expect(
      call("local_media_convert", { artifact_id: artAudio, operation: "gif" }),
    ).rejects.toThrow(/gif needs a video input/);
    await expect(
      call("local_media_convert", { artifact_id: artAudio, operation: "thumbnail" }),
    ).rejects.toThrow(/no video or image frame/);
    await expect(
      call("local_video_mux_audio", { video_artifact_id: artAudio, audio_artifact_id: artAudio }),
    ).rejects.toThrow(/not a video/);
    const a = await call("local_media_convert", {
      artifact_id: artAudio,
      operation: "extract_audio",
      audio_format: "mp3",
    });
    expect(a.artifact.mime).toBe("audio/mpeg");
  }, 60_000);
});
