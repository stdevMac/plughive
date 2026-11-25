import { randomUUID } from "node:crypto";
// packs/pdf/index.ts
//
// md_to_pdf: markdown to PDF through pandoc.
//
// Hardening, because the markdown may come from an untrusted source:
//  - the markdown reaches pandoc on stdin, never as a path it resolves itself;
//  - `--sandbox` stops pandoc reading or writing anything not named on argv,
//    and `--data-dir` points at an empty directory so no per-user pandoc
//    templates or defaults are picked up;
//  - raw TeX, raw HTML, raw attributes, YAML metadata blocks, TeX math and
//    LaTeX macro definitions are switched off in the reader. Math matters:
//    pandoc writes the content of `$...$` into the LaTeX output verbatim, so
//    with math on, `$\input{/etc/passwd}$` reaches the TeX engine as a
//    command. With it off, `$` and `\` are ordinary text and get escaped;
//  - the Lua filter is a second line: every Math, RawInline and RawBlock node
//    that still turns up becomes literal code text, and every image is
//    replaced with its caption, so no image path or URL is ever opened;
//  - the TeX engine itself is pinned to pdflatex and runs with
//    `-no-shell-escape`, `shell_escape=f`, and kpathsea's paranoid file
//    access (`openin_any=p`, `openout_any=p`: no absolute paths, no `..`,
//    no dotfiles), with TEXMFHOME/TEXMFCONFIG/TEXMFVAR inside the pack's
//    data directory instead of the user's home;
//  - `markdown_path` is confined to the pack's data directory (symlinks
//    included, re-checked after the file is opened), and `artifact_id`
//    reads from the artifact library instead.
import { constants } from "node:fs";
import { mkdir, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { definePack, defineTool, z } from "plughive/pack";

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const PANDOC_TIMEOUT_MS = 120_000;
const MAX_TITLE_CHARS = 300;

export const READER_FORMAT =
  "markdown-raw_tex-raw_html-raw_attribute-yaml_metadata_block" +
  "-tex_math_dollars-tex_math_single_backslash-tex_math_double_backslash-latex_macros";

export const PDF_ENGINE = "pdflatex";

/**
 * Lua filter: images become their caption (pandoc would otherwise open the
 * referenced path or URL), and any math or raw node that survives the reader
 * settings becomes literal code, which the LaTeX writer escapes.
 */
export const SAFETY_FILTER = [
  "function Image(el)",
  "  return el.caption",
  "end",
  "function Math(el)",
  "  return pandoc.Code(el.text)",
  "end",
  "function RawInline(el)",
  "  return pandoc.Code(el.text)",
  "end",
  "function RawBlock(el)",
  "  return pandoc.CodeBlock(el.text)",
  "end",
  "",
].join("\n");

/**
 * Environment for pandoc and the TeX engine it spawns. kpathsea reads these
 * from the environment ahead of texmf.cnf. Paranoid mode refuses absolute
 * paths unless they sit under TEXMFOUTPUT, so pandoc's temporary directory
 * (where it writes input.tex and runs the engine) is put inside the work
 * directory via TMPDIR, and TEXMFOUTPUT names that same directory. `work`
 * must be a canonical path (kpathsea compares strings). Exported for tests.
 */
export function engineEnv(texRoot: string, work: string): Record<string, string> {
  return {
    openin_any: "p",
    openout_any: "p",
    shell_escape: "f",
    TMPDIR: work,
    TEMP: work,
    TMP: work,
    TEXMFOUTPUT: work,
    TEXMFHOME: join(texRoot, "home"),
    TEXMFCONFIG: join(texRoot, "config"),
    TEXMFVAR: join(texRoot, "var"),
  };
}

/**
 * Resolve `rel` inside `base`, following symlinks, or throw. Rejects absolute
 * paths, "..", NUL and any symlink that leaves `base`.
 */
export async function resolveConfined(base: string, rel: string): Promise<string> {
  if (rel.includes("\0")) throw new Error("markdown_path contains a NUL byte");
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error("markdown_path must be relative to the pack data directory");
  }
  if (rel.split(/[\\/]/).includes("..")) {
    throw new Error('markdown_path must not contain ".." segments');
  }
  const root = await realpath(base);
  let real: string;
  try {
    real = await realpath(join(root, rel));
  } catch {
    throw new Error(`markdown_path not found inside the pack data directory: ${rel}`);
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error("markdown_path resolves outside the pack data directory");
  }
  return real;
}

/**
 * Read a confined markdown file without following a symlink swapped in after
 * the path was resolved: the final component is opened with O_NOFOLLOW, the
 * handle must be a regular file within the size cap, and the path is
 * resolved again afterwards and must still name the same inode inside `base`.
 */
export async function readConfined(base: string, rel: string): Promise<string> {
  const real = await resolveConfined(base, rel);
  const fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("markdown_path is not a regular file");
    if (st.size > MAX_MARKDOWN_BYTES) {
      throw new Error(`markdown is larger than ${MAX_MARKDOWN_BYTES} bytes`);
    }
    const again = await resolveConfined(base, rel);
    const now = await stat(again);
    if (again !== real || now.ino !== st.ino || now.dev !== st.dev) {
      throw new Error("markdown_path changed while it was being opened");
    }
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** The pandoc argv for a render. Exported for tests. */
export function pandocArgs(opts: {
  filterPath: string;
  outPath: string;
  dataDir: string;
  title?: string;
  /** Default "pdf". "latex" writes the .tex pandoc would hand the engine (tests). */
  to?: "pdf" | "latex";
}): string[] {
  const args = [
    "--sandbox",
    `--data-dir=${opts.dataDir}`,
    "-f",
    READER_FORMAT,
    `--lua-filter=${opts.filterPath}`,
  ];
  if ((opts.to ?? "pdf") === "pdf") {
    args.push(`--pdf-engine=${PDF_ENGINE}`, "--pdf-engine-opt=-no-shell-escape");
  } else {
    args.push("-t", "latex", "-s");
  }
  args.push("-o", opts.outPath);
  if (opts.title) args.push(`--metadata=title:${opts.title}`);
  return args;
}

const mdToPdf = defineTool({
  name: "md_to_pdf",
  description:
    "Render markdown to PDF via pandoc. Requires pandoc and pdflatex (a LaTeX install) on the daemon's PATH. " +
    "Pass markdown inline, an artifact_id of a stored markdown/text artifact, or a markdown_path " +
    "relative to the pack data directory. Images, math, raw TeX and raw HTML are not rendered " +
    "(math and raw snippets appear as literal text).",
  capability: "md_to_pdf",
  tags: ["pdf", "document"],
  input: z
    .object({
      markdown: z.string().max(MAX_MARKDOWN_BYTES).optional(),
      markdown_path: z.string().max(1024).optional(),
      artifact_id: z.string().max(200).optional(),
      title: z.string().max(MAX_TITLE_CHARS).optional(),
    })
    .refine((v) => !!(v.markdown || v.markdown_path || v.artifact_id), {
      message: "markdown, markdown_path or artifact_id required",
    }),
  async run(input, ctx) {
    let markdown: string;
    if (input.markdown) {
      markdown = input.markdown;
    } else if (input.artifact_id) {
      const rec = await ctx.library.get(input.artifact_id);
      if (!rec) throw new Error(`artifact not found: ${input.artifact_id}`);
      // Refuse before reading: an oversized artifact never enters memory.
      if (rec.bytes > MAX_MARKDOWN_BYTES) {
        throw new Error(`markdown is larger than ${MAX_MARKDOWN_BYTES} bytes`);
      }
      markdown = Buffer.from(await ctx.library.read(input.artifact_id)).toString("utf8");
    } else {
      markdown = await readConfined(ctx.pack.dataDir, input.markdown_path as string);
    }
    if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) {
      throw new Error(`markdown is larger than ${MAX_MARKDOWN_BYTES} bytes`);
    }
    // Control characters in a title have no business in a PDF and could
    // confuse argv-consuming tools; a newline would also end the metadata value.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    const title = input.title?.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || undefined;

    const texRoot = join(ctx.pack.dataDir, "texmf");
    const workPath = join(ctx.pack.dataDir, "work", randomUUID());
    await mkdir(workPath, { recursive: true, mode: 0o700 });
    try {
      const work = await realpath(workPath);
      const filterPath = join(work, "safety.lua");
      const outPath = join(work, "out.pdf");
      const pandocData = join(work, "pandoc-data");
      await mkdir(pandocData, { mode: 0o700 });
      await writeFile(filterPath, SAFETY_FILTER);

      const r = await ctx.spawn(
        "pandoc",
        pandocArgs({ filterPath, outPath, dataDir: pandocData, title }),
        {
          cwd: work,
          input: markdown,
          timeoutMs: PANDOC_TIMEOUT_MS,
          env: engineEnv(texRoot, work),
        },
      );
      if (r.timedOut) throw new Error(`pandoc was stopped after ${PANDOC_TIMEOUT_MS} ms`);
      if (r.truncated) throw new Error("pandoc printed more output than allowed and was stopped");
      if (r.exitCode !== 0) {
        throw new Error(`pandoc failed (exit ${r.exitCode}): ${r.stderr.slice(0, 400)}`);
      }

      const ref = await ctx.library.importFile({
        kind: "pdf",
        mime: "application/pdf",
        sourcePath: outPath,
        tool: "md_to_pdf",
        meta: { title: title ?? null },
      });
      ctx.logger.info("pdf generated", { id: ref.id, bytes: ref.bytes ?? null });
      return { artifact: ref };
    } finally {
      await rm(workPath, { recursive: true, force: true });
    }
  },
});

export default definePack({ tools: [mdToPdf] });
