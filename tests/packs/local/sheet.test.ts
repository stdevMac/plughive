// local_contact_sheet: grid layout, the filter graph, and a real ffmpeg run when installed.
import { describe, expect, it } from "vitest";
import pack from "../../../packs/local/index.js";
import { MAX_OUTPUT_DIM } from "../../../packs/local/lib/ffmpeg.js";
import { buildContactSheetGraph, sheetLayout } from "../../../packs/local/sheet.js";
import { toolOf } from "../support.js";
import { ffmpegPresent, makeEnv, makeFixture, realSpawn } from "./harness.js";

describe("contact sheet layout", () => {
  it("picks a near-square grid and keeps the sheet within the output limit", () => {
    expect(sheetLayout(3)).toMatchObject({ columns: 2, rows: 2, tile: 256 });
    expect(sheetLayout(1)).toMatchObject({ columns: 1, rows: 1 });
    expect(sheetLayout(5, 10)).toMatchObject({ columns: 5, rows: 1 });
    const big = sheetLayout(100, 20, 1024);
    expect(big.width).toBeLessThanOrEqual(MAX_OUTPUT_DIM);
    expect(big.height).toBeLessThanOrEqual(MAX_OUTPUT_DIM);
    expect(big.tile % 2).toBe(0);
  });

  it("builds one tile chain per input and a single tile filter", () => {
    const g = buildContactSheetGraph(3, sheetLayout(3));
    expect(g).toContain("[0:V:0]trim=end_frame=1,scale=256:256");
    expect(g).toContain("[t0][t1][t2]concat=n=3:v=1:a=0,tile=2x2");
    expect(g.endsWith("[sheet]")).toBe(true);
  });
});

describe.skipIf(!ffmpegPresent())("contact sheet (real ffmpeg)", () => {
  it("tiles three images into one PNG", async () => {
    const env = makeEnv({ spawn: realSpawn });
    try {
      const ids: string[] = [];
      for (const c of ["red", "green", "blue"]) {
        const file = await makeFixture(env, `${c}.png`, [
          "-f",
          "lavfi",
          "-i",
          `color=c=${c}:s=300x200`,
          "-frames:v",
          "1",
        ]);
        ids.push(env.addFile(file, "image/png", "image"));
      }
      const tool = toolOf(pack, "local_contact_sheet");
      const out = (await tool.run(tool.input.parse({ artifact_ids: ids, tile: 64 }), env.ctx)) as {
        artifact: { mime: string };
      };
      expect(out).toMatchObject({ items: 3, columns: 2, rows: 2, tile: 64 });
      expect(out.artifact.mime).toBe("image/png");
    } finally {
      env.cleanup();
    }
  }, 60_000);
});
