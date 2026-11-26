import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pdfPack, {
  PDF_ENGINE,
  READER_FORMAT,
  SAFETY_FILTER,
  engineEnv,
  pandocArgs,
  readConfined,
  resolveConfined,
} from "../../../packs/pdf/index.js";
import { itSymlink } from "../../support/platform.js";
import { artifactRef, fakeCtx, loadBuiltinPacks, toolNames, toolOf } from "../support.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pdf-pack-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const workClean = () => {
  const work = join(dir, "work");
  return !existsSync(work) || readdirSync(work).length === 0;
};

type SpawnOpts = { cwd?: string; input?: string };
const okSpawn = (expectInput?: string) =>
  vi.fn(async (_b: string, args: string[], opts: SpawnOpts) => {
    writeFileSync(args[args.indexOf("-o") + 1] as string, "%PDF-1.4");
    if (expectInput !== undefined) expect(opts.input).toBe(expectInput);
    return { exitCode: 0, stdout: "", stderr: "" };
  });

describe("resolveConfined", () => {
  it("accepts a file inside the base", async () => {
    writeFileSync(join(dir, "a.md"), "# hi");
    expect(await resolveConfined(dir, "a.md")).toMatch(/a\.md$/);
  });

  it("rejects absolute paths, .. segments and NUL", async () => {
    await expect(resolveConfined(dir, "/etc/passwd")).rejects.toThrow(/relative/);
    await expect(resolveConfined(dir, "../x.md")).rejects.toThrow(/\.\./);
    await expect(resolveConfined(dir, "a\0b")).rejects.toThrow(/NUL/);
  });

  it("rejects a missing file", async () => {
    await expect(resolveConfined(dir, "nope.md")).rejects.toThrow(/not found/);
  });

  itSymlink("rejects a symlink that leaves the base", async () => {
    const outside = mkdtempSync(join(tmpdir(), "pdf-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "secret");
      symlinkSync(join(outside, "secret.md"), join(dir, "link.md"));
      await expect(resolveConfined(dir, "link.md")).rejects.toThrow(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("readConfined", () => {
  it("reads a confined file", async () => {
    writeFileSync(join(dir, "a.md"), "# hi");
    expect(await readConfined(dir, "a.md")).toBe("# hi");
  });

  it("refuses an oversized file before reading it", async () => {
    writeFileSync(join(dir, "big.md"), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    await expect(readConfined(dir, "big.md")).rejects.toThrow(/larger than/);
  });

  it("refuses a directory", async () => {
    mkdirSync(join(dir, "sub"));
    await expect(readConfined(dir, "sub")).rejects.toThrow(/regular file/);
  });
});

describe("pandoc hardening", () => {
  it("builds a sandboxed argv with raw input and TeX math disabled", () => {
    const args = pandocArgs({
      filterPath: "/w/f.lua",
      outPath: "/w/o.pdf",
      dataDir: "/w/d",
      title: "T",
    });
    expect(args[0]).toBe("--sandbox");
    expect(args).toContain(READER_FORMAT);
    for (const ext of [
      "raw_tex",
      "raw_html",
      "raw_attribute",
      "yaml_metadata_block",
      "tex_math_dollars",
      "tex_math_single_backslash",
      "tex_math_double_backslash",
      "latex_macros",
    ]) {
      expect(READER_FORMAT).toContain(`-${ext}`);
    }
    expect(args).toContain("--lua-filter=/w/f.lua");
    expect(args).toContain("--data-dir=/w/d");
    expect(args).toContain(`--pdf-engine=${PDF_ENGINE}`);
    expect(args).toContain("--pdf-engine-opt=-no-shell-escape");
    expect(args).toContain("--metadata=title:T");
    expect(
      pandocArgs({ filterPath: "f", outPath: "o", dataDir: "d" }).some((a) =>
        a.startsWith("--metadata"),
      ),
    ).toBe(false);
  });

  it("the filter drops images and turns math and raw nodes into code", () => {
    expect(SAFETY_FILTER).toContain("function Image");
    expect(SAFETY_FILTER).toContain("el.caption");
    expect(SAFETY_FILTER).toContain("function Math");
    expect(SAFETY_FILTER).toContain("function RawInline");
    expect(SAFETY_FILTER).toContain("function RawBlock");
  });

  it("runs the engine with paranoid file access and no shell escape", () => {
    const env = engineEnv("/d/texmf", "/d/work/x");
    expect(env).toMatchObject({
      openin_any: "p",
      openout_any: "p",
      shell_escape: "f",
      TMPDIR: "/d/work/x",
      TEXMFOUTPUT: "/d/work/x",
      TEXMFHOME: join("/d/texmf", "home"),
    });
  });
});

// --- the real pandoc output stage (no LaTeX engine needed) -------------------

const hasBinary = (name: string) =>
  spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).status === 0;
const HAS_PANDOC = hasBinary("pandoc");
const HAS_PDFLATEX = HAS_PANDOC && hasBinary("pdflatex");

/** Strip escaped backslashes, then look for TeX primitives that read, write or retokenise. */
const DANGEROUS = /\\(input|include|openin|openout|read|write18|write|catcode|immediate|csname)\b/;
function dangerousIn(tex: string): string | null {
  const body = tex.slice(Math.max(0, tex.indexOf("\\begin{document}")));
  const titleLines = tex.split("\n").filter((l) => /\\title\{|pdftitle=/.test(l));
  const cleaned = [body, ...titleLines]
    .join("\n")
    .replace(/\\textbackslash(\{\}| )?/g, "")
    .replace(/\\(input|include)enc\b/g, "");
  return cleaned.match(DANGEROUS)?.[0] ?? null;
}

function toLatex(markdown: string, opts: { title?: string; reader?: string } = {}): string {
  const filterPath = join(dir, "safety.lua");
  const outPath = join(dir, "out.tex");
  const dataDir = join(dir, "pandoc-data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(filterPath, SAFETY_FILTER);
  let args = pandocArgs({ filterPath, outPath, dataDir, title: opts.title, to: "latex" });
  if (opts.reader) args = args.map((a) => (a === READER_FORMAT ? (opts.reader as string) : a));
  const r = spawnSync("pandoc", args, { input: markdown, encoding: "utf8", cwd: dir });
  if (r.status !== 0) throw new Error(`pandoc failed: ${r.stderr}`);
  return readFileSync(outPath, "utf8");
}

const ATTACKS = [
  "Inline $\\input{/etc/shells}$ math",
  "$$\\mbox{\\catcode`\\#=12 \\catcode`\\_=12 \\input{/Users/x/.ssh/config}}$$",
  "\\(\\input{/etc/c}\\) and \\[\\input{/etc/d}\\]",
  "\\\\(\\input{/etc/c}\\\\) and \\\\[\\input{/etc/d}\\\\]",
  "\\input{/etc/b} \\include{x} \\openin1=/etc/passwd \\read1 to \\x \\write18{id}",
  "\\newcommand{\\foo}{\\input{/etc/l}}\n\n$\\foo$",
  "\\begin{verbatim}\n\\input{/etc/p}\n\\end{verbatim}",
  "```{=latex}\n\\input{/etc/j}\n```\n\n`\\input{x}`{=latex}",
  "<span>\\input{k}</span> <!-- \\input{h} -->",
  "```\n\\end{verbatim}\n\\input{/etc/h}\n```",
  "~~~ {.latex}\n\\end{Highlighting}\\input{/etc/i}\n~~~",
  "[l](http://x/\\input{f}) <http://a/\\input{g}> [\\input{m}]{.x}",
  "| a | b |\n|---|---|\n| \\input{n} | `\\write18{x}` |",
  "Note[^1]\n\n[^1]: $\\openin\\read\\catcode$\n\n    \\input{/etc/o}",
  "% Title $\\input{/etc/a}$\n\nbody",
  "---\nheader-includes: \\input{/etc/y}\n---\n\nbody",
];

describe.skipIf(!HAS_PANDOC)("pandoc output stage (real pandoc, no TeX engine)", () => {
  it.each(ATTACKS)("no TeX file or shell primitive survives: %s", (md) => {
    const tex = toLatex(md);
    expect(dangerousIn(tex)).toBeNull();
  });

  it("a title from the tool argument cannot inject TeX either", () => {
    const tex = toLatex("body", { title: "$\\input{/etc/a}$ \\catcode" });
    expect(dangerousIn(tex)).toBeNull();
  });

  it("the Lua filter alone neutralises math even with the math reader on", () => {
    // Belt and braces: if the reader settings were ever relaxed, the filter
    // still writes math as escaped code rather than verbatim TeX.
    const tex = toLatex("Inline $\\input{/etc/shells}$", { reader: "markdown" });
    expect(dangerousIn(tex)).toBeNull();
  });

  it("the check itself catches the passthrough (sanity)", () => {
    // Plain pandoc markdown with no filter: math reaches the LaTeX verbatim.
    const r = spawnSync("pandoc", ["--sandbox", "-f", "markdown", "-t", "latex"], {
      input: "Inline $\\input{/etc/shells}$",
      encoding: "utf8",
    });
    expect(r.stdout).toContain("\\input{/etc/shells}");
    expect(dangerousIn(`\\begin{document}${r.stdout}`)).toBe("\\input");
  });

  it("ordinary markdown still renders", () => {
    const tex = toLatex("# Heading\n\nSome *emphasis*, `code`, a [link](https://example.com).");
    expect(tex).toContain("\\section{Heading}");
    expect(tex).toContain("\\emph{emphasis}");
  });
});

describe.skipIf(!HAS_PDFLATEX)("full render with a TeX engine", () => {
  const realSpawn = vi.fn(
    async (
      bin: string,
      args: readonly string[],
      opts: { cwd?: string; input?: string; env?: Record<string, string> },
    ) => {
      const r = spawnSync(bin, [...args], {
        cwd: opts.cwd,
        input: opts.input,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...opts.env },
      });
      return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
    },
  );

  it("renders a PDF and the engine refuses absolute \\input paths", async () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "TOPSECRETMARKER");
    let imported = "";
    const ctx = fakeCtx({
      packId: "pdf",
      dataDir: dir,
      spawn: realSpawn as never,
      library: {
        importFile: (async (a: { sourcePath: string }) => {
          imported = readFileSync(a.sourcePath, "latin1");
          return artifactRef("pdf_real");
        }) as never,
      },
    });
    await toolOf(pdfPack, "md_to_pdf").run(
      { markdown: `# Hi\n\n$\\input{${secret}}$`, title: "T" },
      ctx,
    );
    expect(imported.startsWith("%PDF")).toBe(true);

    // The engine environment on its own: a direct \input of an absolute path fails.
    const work = mkdtempSync(join(dir, "eng-"));
    writeFileSync(join(work, "t.tex"), `\\input{${secret}}\\bye`);
    const r = spawnSync("pdftex", ["-interaction=nonstopmode", "t.tex"], {
      cwd: work,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: dir, ...engineEnv(join(dir, "texmf"), work) },
    });
    expect(`${r.stdout}${r.stderr}`).toMatch(/not reading from|I can't find file/i);
  });
});

describe("md_to_pdf tool", () => {
  const tool = () => toolOf(pdfPack, "md_to_pdf");

  it("exposes md_to_pdf and requires some markdown source", () => {
    expect(toolNames(pdfPack)).toEqual(["md_to_pdf"]);
    expect(tool().input.safeParse({}).success).toBe(false);
    expect(tool().input.safeParse({ markdown: "# x" }).success).toBe(true);
    expect(tool().input.safeParse({ artifact_id: "a1" }).success).toBe(true);
    // Inline markdown is capped in the schema, before the tool runs.
    expect(tool().input.safeParse({ markdown: "x".repeat(5 * 1024 * 1024 + 1) }).success).toBe(
      false,
    );
  });

  it("sends markdown on stdin, saves the pdf and cleans the work dir", async () => {
    const importFile = vi.fn(async (_a: unknown) => artifactRef("pdf_1"));
    const spawn = okSpawn("# Hello");
    const ctx = fakeCtx({
      packId: "pdf",
      dataDir: dir,
      spawn: spawn as never,
      library: { importFile: importFile as never },
    });
    const out = (await tool().run(
      tool().input.parse({ markdown: "# Hello", title: "Doc" }),
      ctx,
    )) as { artifact: { id: string } };
    expect(out.artifact.id).toBe("pdf_1");
    expect(spawn.mock.calls[0]?.[0]).toBe("pandoc");
    expect(spawn.mock.calls[0]?.[1]).toContain("--sandbox");
    expect(importFile).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pdf", mime: "application/pdf", tool: "md_to_pdf" }),
    );
    expect(workClean()).toBe(true);
  });

  it("reads artifact_id from the library", async () => {
    const spawn = okSpawn("# From library");
    const ctx = fakeCtx({
      packId: "pdf",
      dataDir: dir,
      spawn: spawn as never,
      library: {
        get: (async () => artifactRef("a1")) as never,
        read: (async () => Buffer.from("# From library")) as never,
        importFile: (async () => artifactRef("pdf_2")) as never,
      },
    });
    await tool().run(tool().input.parse({ artifact_id: "a1" }), ctx);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reads markdown_path from inside the data dir only", async () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "a.md"), "# File");
    const spawn = okSpawn("# File");
    const ctx = fakeCtx({
      packId: "pdf",
      dataDir: dir,
      spawn: spawn as never,
      library: { importFile: (async () => artifactRef("pdf_3")) as never },
    });
    await tool().run(tool().input.parse({ markdown_path: "docs/a.md" }), ctx);
    await expect(
      tool().run(tool().input.parse({ markdown_path: "/etc/passwd" }), ctx),
    ).rejects.toThrow(/relative/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports a pandoc failure and still removes the work dir", async () => {
    const spawn = vi.fn(async () => ({ exitCode: 43, stdout: "", stderr: "latex missing" }));
    const ctx = fakeCtx({ packId: "pdf", dataDir: dir, spawn: spawn as never });
    await expect(tool().run(tool().input.parse({ markdown: "x" }), ctx)).rejects.toThrow(
      /pandoc failed \(exit 43\): latex missing/,
    );
    expect(workClean()).toBe(true);
  });

  it("rejects missing artifacts", async () => {
    const ctx = fakeCtx({
      packId: "pdf",
      dataDir: dir,
      library: { get: (async () => null) as never },
    });
    await expect(tool().run(tool().input.parse({ artifact_id: "zzz" }), ctx)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("pdf pack via the loader", () => {
  it("loads md_to_pdf", async () => {
    const h = await loadBuiltinPacks();
    try {
      expect(h.registry.get("md_to_pdf")).toBeDefined();
    } finally {
      await h.close();
    }
  });
});
