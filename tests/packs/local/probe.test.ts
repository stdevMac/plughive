// The probe cache must not hide a program installed a moment ago (Software page,
// install_software): a plain "not found" is asked again, a hit stays cached.
import { afterEach, describe, expect, it } from "vitest";
import { binaryStatus, clearProbeCache } from "../../../packs/local/lib/probe.js";
import { type Env, makeEnv, recordingSpawn } from "./harness.js";

let env: Env | undefined;
afterEach(() => {
  env?.cleanup();
  clearProbeCache();
});

describe("binaryStatus cache", () => {
  it("sees a program installed right after a miss, and caches the hit", async () => {
    let installed = false;
    const { calls, spawn } = recordingSpawn((c) => {
      if (!installed) {
        throw Object.assign(new Error(`spawn ${c.binary} ENOENT`), { code: "ENOENT" });
      }
      return { stdout: "2026.11.23\n", stderr: "", exitCode: 0 };
    });
    env = makeEnv({ spawn });

    const miss = await binaryStatus(env.ctx, "yt-dlp", "install it");
    expect(miss).toMatchObject({
      available: false,
      error: "yt-dlp not found",
      install_hint: "install it",
    });

    installed = true;
    const hit = await binaryStatus(env.ctx, "yt-dlp", "install it");
    expect(hit).toMatchObject({ available: true, details: { version: "2026.11.23" } });

    const before = calls.length;
    await binaryStatus(env.ctx, "yt-dlp", "install it");
    expect(calls.length).toBe(before);
  });

  it("still caches a failure that is not 'not found' (it costs a process start)", async () => {
    const { calls, spawn } = recordingSpawn(() => {
      throw new Error("bad CPU type in executable");
    });
    env = makeEnv({ spawn });
    const a = await binaryStatus(env.ctx, "realesrgan-ncnn-vulkan", "h");
    expect(a.available).toBe(false);
    const n = calls.length;
    await binaryStatus(env.ctx, "realesrgan-ncnn-vulkan", "h");
    expect(calls.length).toBe(n);
  });
});

describe("install hints offer the managed installer", () => {
  it("leads with install_software, names real catalog ids, keeps the manual route", async () => {
    const { hintsFor } = await import("../../../packs/local/lib/util.js");
    const { readFileSync } = await import("node:fs");
    const catalog = JSON.parse(
      readFileSync(new URL("../../../src/core/installer/catalog.json", import.meta.url), "utf8"),
    ) as { items: { id: string }[] };
    const ids = new Set(catalog.items.map((i) => i.id));
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const h = hintsFor(platform);
      expect(h.ytdlp).toMatch(
        /^Install it from plughive's Software page.*install_software with id "yt-dlp".*Or yourself: /,
      );
      for (const text of Object.values(h)) {
        const m = text.match(/install_software with id "([^"]+)"/);
        if (m) expect(ids.has(m[1] as string), m[1]).toBe(true);
      }
    }
    expect(hintsFor("linux").parakeet).not.toMatch(/install_software/);
    expect(hintsFor("darwin").parakeet).toMatch(/"parakeet-mlx"/);
  });
});
