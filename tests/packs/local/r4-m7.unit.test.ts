// R4-M7: media bounds that could be stepped around: cover-art streams skipped
// by the size check, durationless videos taken for still images, the x4
// realesrgan pass over the size limit, and unchecked Demucs stem names.
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { demucsArgs, pickDemucsModel, upscalePlan } from "../../../packs/local/imaging.js";
import pack from "../../../packs/local/index.js";
import { parseProbe } from "../../../packs/local/lib/ffmpeg.js";
import { toolOf } from "../support.js";
import { type Env, makeEnv, recordingSpawn } from "./harness.js";

let env: Env | undefined;
afterEach(() => env?.cleanup());

function probing(body: object) {
  const m = recordingSpawn(async (call) => {
    if (call.binary === "ffprobe") return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
    writeFileSync(call.args[call.args.length - 1] as string, "out");
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  env = makeEnv({ spawn: m.spawn });
  return env;
}

describe("ffmpeg probe bounds (R4-M7)", () => {
  it("refuses an oversized cover-art picture, not only the first video stream", async () => {
    const e = probing({
      format: { format_name: "mp3", duration: "3.0" },
      streams: [
        { index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 },
        {
          index: 1,
          codec_type: "video",
          codec_name: "mjpeg",
          width: 30000,
          height: 30000,
          disposition: { attached_pic: 1 },
        },
      ],
    });
    const id = e.add("song.mp3", "x", "audio/mpeg", "audio");
    await expect(toolOf(pack, "local_media_probe").run({ artifact_id: id }, e.ctx)).rejects.toThrow(
      /larger than 8192 pixels/,
    );
  });

  it("a video container without a duration is a video, not a still image", () => {
    const stream = { index: 0, codec_type: "video", codec_name: "vp9", width: 640, height: 360 };
    expect(
      parseProbe({ format: { format_name: "matroska,webm" }, streams: [stream] }).isImage,
    ).toBe(false);
    expect(parseProbe({ format: { format_name: "png_pipe" }, streams: [stream] }).isImage).toBe(
      true,
    );
    expect(parseProbe({ format: { format_name: "gif" }, streams: [stream] }).isImage).toBe(true);
  });
});

describe("imaging bounds (R4-M7)", () => {
  it("counts realesrgan's own x4 pass against the size limit", () => {
    // 4096 px at scale 2 is 8192 px out, but x4plus renders 16384 px first.
    expect(() => upscalePlan(4096, 4096, 2, "realesrgan-x4plus")).toThrow(/x4 first/);
    expect(upscalePlan(2048, 1024, 2, "realesrgan-x4plus")).toBe(4);
    expect(upscalePlan(4096, 4096, 2, "realesr-animevideov3")).toBe(2);
    expect(() => upscalePlan(4096, 100, 3, "realesr-animevideov3")).toThrow(/over 8192 px/);
  });

  it("refuses a scale outside 2 to 4 even when called past the schema", async () => {
    const e = probing({});
    for (const scale of [1, 2.5, 8]) {
      await expect(
        (await import("../../../packs/local/imaging.js")).upscaleVideo(
          e.ctx,
          { artifact_id: "x", scale },
          "video.upscale",
        ),
      ).rejects.toThrow(/upscale factor/);
    }
  });

  it("accepts only known Demucs stem names, so none can read as an option", () => {
    expect(demucsArgs("htdemucs", "/w/out", "/w/mix.wav", "vocals")).toEqual(
      expect.arrayContaining(["--two-stems", "vocals"]),
    );
    expect(() => demucsArgs("htdemucs", "/w/out", "/w/mix.wav", "--help")).toThrow(/stem/);
    expect(() => pickDemucsModel({ two_stems: "-o/tmp" })).toThrow(/stem/);
  });
});
