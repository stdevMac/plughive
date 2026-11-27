// packs/local/sheet.ts
//
// local_contact_sheet: lay out library images (or the first frame of videos) on
// one grid image with ffmpeg's tile filter. Each input is scaled to fit a square
// tile and padded, the tiles are concatenated into a frame sequence, and tile
// packs that sequence into one frame (a partly filled last row stays black).
import { join } from "node:path";
import { defineTool, z } from "plughive/pack";
import type { PackContext } from "plughive/pack";
import { MAX_OUTPUT_DIM, inputArgs, runFfmpeg, stageInput } from "./lib/ffmpeg.js";
import { ARTIFACT_ID, artifactOut, withWorkDir } from "./lib/util.js";

export const MAX_SHEET_ITEMS = 100;
const PADDING = 4;

export const ContactSheetInput = z.object({
  artifact_ids: z
    .array(z.string().regex(ARTIFACT_ID, "an artifact id, not a path or URL"))
    .min(1)
    .max(MAX_SHEET_ITEMS)
    .describe("Image (or video) artifacts, laid out left to right, top to bottom."),
  columns: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("Tiles per row. Default: about the square root of the number of items."),
  tile: z
    .number()
    .int()
    .min(32)
    .max(1024)
    .optional()
    .describe("Edge of each square tile in pixels. Default 256."),
});
export type ContactSheetArgs = z.output<typeof ContactSheetInput>;

export interface SheetLayout {
  columns: number;
  rows: number;
  tile: number;
  width: number;
  height: number;
}

/** Grid size for `n` items; the tile shrinks so the sheet stays within MAX_OUTPUT_DIM. */
export function sheetLayout(n: number, columns?: number, tile = 256): SheetLayout {
  const cols = Math.max(1, Math.min(columns ?? Math.ceil(Math.sqrt(n)), n));
  const rows = Math.ceil(n / cols);
  const edge = (count: number, t: number) => count * t + (count + 1) * PADDING;
  let t = tile;
  while (t > 16 && (edge(cols, t) > MAX_OUTPUT_DIM || edge(rows, t) > MAX_OUTPUT_DIM)) t -= 8;
  // Even sizes keep every encoder happy.
  t -= t % 2;
  return { columns: cols, rows, tile: t, width: edge(cols, t), height: edge(rows, t) };
}

/** The filter graph: scale+pad each input to a tile, concat, tile. Output label [sheet]. */
export function buildContactSheetGraph(n: number, layout: SheetLayout): string {
  const t = layout.tile;
  const fit = `scale=${t}:${t}:force_original_aspect_ratio=decrease,pad=${t}:${t}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgb24`;
  const parts: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`[${i}:V:0]trim=end_frame=1,${fit}[t${i}]`);
    labels.push(`[t${i}]`);
  }
  parts.push(
    `${labels.join("")}concat=n=${n}:v=1:a=0,tile=${layout.columns}x${layout.rows}:padding=${PADDING}:margin=${PADDING}:color=black[sheet]`,
  );
  return parts.join(";");
}

export async function runContactSheet(ctx: PackContext, input: ContactSheetArgs) {
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "staging images");
    const staged = [];
    for (const [i, id] of input.artifact_ids.entries()) {
      const s = await stageInput(ctx, work, id, i);
      if (!s.info.hasVideo && !s.info.isImage) throw new Error(`artifact ${id} has no picture`);
      staged.push(s);
    }
    const layout = sheetLayout(staged.length, input.columns, input.tile ?? 256);
    const args: string[] = [];
    for (const s of staged) args.push(...inputArgs(s.path));
    args.push(
      "-filter_complex",
      buildContactSheetGraph(staged.length, layout),
      "-map",
      "[sheet]",
      "-frames:v",
      "1",
    );
    const outPath = join(work, "sheet.png");
    ctx.progress?.(0.4, "tiling");
    await runFfmpeg(ctx, work, args, outPath);
    const ref = await ctx.library.importFile({
      kind: "image",
      mime: "image/png",
      sourcePath: outPath,
      tool: "local_contact_sheet",
      meta: { sources: input.artifact_ids, ...layout },
    });
    return { artifact: artifactOut(ref), items: staged.length, ...layout };
  });
}

export const sheetTools = [
  defineTool({
    name: "local_contact_sheet",
    description:
      "Lay out library images (or the first frame of videos) on one grid image (a contact sheet) with local ffmpeg. Inputs are artifact ids; the result is a new PNG artifact.",
    input: ContactSheetInput,
    annotations: {
      title: "Contact sheet (ffmpeg)",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    longRunning: true,
    tags: ["local", "ffmpeg", "image"],
    run: (input, ctx) => runContactSheet(ctx, input),
  }),
];
