// Security fixes, batch D1, for the local pack: sanitizeHtmlRefs bypasses
// (D-H7), ZIP/XML bounds and external references in office documents
// (D-L3 / H-1 residual) and the argv-hardening of language keys, subtitle
// keys and ComfyUI output paths (D-M8).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { PackContext } from "plughive/pack";
import { afterEach, describe, expect, it } from "vitest";
import { collectOutputs, outputPathProblem } from "../../../packs/local/comfy.js";
import {
  safeHtmlUrl,
  safeSrcset,
  sanitizeHtmlRefs,
  stageDocument,
} from "../../../packs/local/documents.js";
import { speechLanguageProblem } from "../../../packs/local/engines.js";
import { scanZipDocument } from "../../../packs/local/lib/zip-scan.js";
import { pickSubtitles } from "../../../packs/local/transcript.js";
import { runEngines, whisperArgs } from "../../../packs/local/whisper.js";
import {
  AudioTranscribeInputSchema,
  MediaTranscriptInputSchema,
} from "../../../src/core/capabilities/schemas.js";
import { type Env, makeEnv } from "./harness.js";

// ---------------------------------------------------------------------------
// D-H7: sanitizeHtmlRefs must fail closed on srcset / srcdoc / DTD / PI / CSS
// ---------------------------------------------------------------------------

describe("sanitizeHtmlRefs fail-closed (D-H7)", () => {
  it("drops a srcset whose second candidate is a file: URL after a data: one", () => {
    expect(safeSrcset("data:image/png;base64,AAAA 1x, file:///etc/passwd 2x")).toBe(false);
    expect(safeSrcset("data:image/png;base64,AAAA 1x")).toBe(true);
    expect(safeSrcset("pic.png 1x, https://evil.example.com/2x.png 2x")).toBe(false);
    const out = sanitizeHtmlRefs(
      '<img srcset="data:image/png;base64,AAAA 1x, file:///etc/passwd 2x" src="x.png">',
    );
    expect(out).not.toContain("srcset");
    expect(out).not.toContain("file:///etc/passwd");
    expect(out).not.toContain("x.png");
    // A fully safe srcset survives.
    const ok = sanitizeHtmlRefs(
      '<img srcset="data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x">',
    );
    expect(ok).toContain("srcset");
    expect(ok).toContain("base64,AAAA");
  });

  it("drops srcdoc entirely (its inline markup decodes entities when parsed)", () => {
    const out = sanitizeHtmlRefs(
      `<iframe srcdoc="&lt;img src=file:///etc/passwd&gt;"></iframe>` +
        `<iframe srcdoc="<img src='file:///etc/passwd'>"></iframe>`,
    );
    expect(out).not.toContain("srcdoc");
    expect(out).not.toContain("file:///etc/passwd");
  });

  it("strips DOCTYPEs (external DTD / entity declarations) and processing instructions", () => {
    const out = sanitizeHtmlRefs(
      `<?xml version="1.0"?><?xml-stylesheet href="file:///etc/passwd"?>` +
        `<!DOCTYPE html SYSTEM "file:///etc/passwd">` +
        `<!DOCTYPE x [ <!ENTITY e SYSTEM "file:///etc/passwd"> ]>` +
        "<html><body><p>hi</p></body></html>",
    );
    expect(out).not.toContain("DOCTYPE");
    expect(out).not.toContain("ENTITY");
    expect(out).not.toContain("xml-stylesheet");
    expect(out).not.toContain("file:///etc/passwd");
    expect(out).toContain("<p>hi</p>");
  });

  it("neutralises CSS url()/@import/image-set including comment and escape tricks", () => {
    const out = sanitizeHtmlRefs(
      [
        "<style>",
        "a{background:url(file:///etc/passwd)}",
        'b{background:url( "file:///etc/hosts" )}',
        'c{background:url(/*c*/"file:///etc/shadow")}',
        'd{background:image-set("file:///etc/passwd" 1x)}',
        'e{background:image-set("data:image/png;base64,AAAA" 1x)}',
        "@import 'file:///etc/passwd';",
        "@import /*x*/ 'https://evil.example.com/x.css';",
        "</style>",
        '<div style="color:red;background:url(file:///etc/shadow)">x</div>',
        '<div style="background:url(&#102;ile:///etc/passwd)">y</div>',
        "<style>f{background:\\75 rl(file:///etc/passwd)}</style>",
      ].join("\n"),
    );
    expect(out).not.toContain("file:///etc/passwd");
    expect(out).not.toContain("file:///etc/hosts");
    expect(out).not.toContain("file:///etc/shadow");
    expect(out).not.toContain("evil.example.com");
    expect(out).not.toMatch(/@import/i);
    expect(out).toContain("url(#)");
    // The data: image-set survives, the file: one does not.
    expect(out).toContain("base64,AAAA");
    // A style attribute carrying an entity is dropped whole (fail closed).
    expect(out).toContain('style=""');
    // A style block carrying a CSS escape is dropped whole.
    expect(out).not.toContain("75 rl");
  });

  it("still rewrites plain URL attributes and keeps fragments and data:", () => {
    const out = sanitizeHtmlRefs(
      `<a href="https://evil.example.com/">x</a><a href="#frag">y</a>` +
        `<img src="data:image/png;base64,AAAA"><img src="pic.png"><a ping="https://evil.example.com/p">z</a>`,
    );
    expect(out).not.toContain("evil.example.com");
    expect(out).toContain('href="#frag"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).toContain('src="#"');
    expect(safeHtmlUrl("#frag")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D-L3 / H-1: ZIP-based office documents are scanned before any tool opens them
// ---------------------------------------------------------------------------

interface ZipEntrySpec {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  /** Lets a test lie in the central directory (bomb headers). */
  compressedOverride?: number;
  uncompressedOverride?: number;
}

/** Build a real (minimal) ZIP container in memory. */
function makeZip(entries: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const method = e.method ?? 8;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(e.compressedOverride ?? data.length, 20);
    central.writeUInt32LE(e.uncompressedOverride ?? raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("scanZipDocument (D-L3 / H-1)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const writeZip = (buf: Buffer, name = "in.docx") => {
    dir = mkdtempSync(join(tmpdir(), "zip-scan-"));
    const p = join(dir, name);
    writeFileSync(p, buf);
    return p;
  };

  it("accepts a small clean office container", () => {
    const p = writeZip(
      makeZip([
        { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types/>' },
        {
          name: "word/document.xml",
          data: "<w:document><w:body><w:p>hello</w:p></w:body></w:document>",
        },
      ]),
    );
    expect(() => scanZipDocument(p)).not.toThrow();
  });

  it("refuses a zip bomb from its declared sizes", () => {
    const p = writeZip(
      makeZip([
        {
          name: "big.bin",
          data: Buffer.alloc(64, 1),
          compressedOverride: 64,
          uncompressedOverride: 100_000_000,
        },
      ]),
    );
    expect(() => scanZipDocument(p)).toThrow(/expands .* zip bomb|over the/);
  });

  it("refuses an entry that inflates past its declared size", () => {
    const p = writeZip(
      makeZip([
        {
          name: "word/document.xml",
          data: Buffer.alloc(4 * 1024 * 1024, 65),
          uncompressedOverride: 100,
        },
      ]),
    );
    expect(() => scanZipDocument(p)).toThrow(/inflates past its declared size/);
  });

  it("refuses zip-slip entry names", () => {
    const p = writeZip(makeZip([{ name: "../evil.xml", data: "<x/>" }]));
    expect(() => scanZipDocument(p)).toThrow(/zip slip/);
  });

  it("refuses external entities (XXE) and file:// references in XML parts", () => {
    const xxe = writeZip(
      makeZip([
        {
          name: "word/document.xml",
          data: '<!DOCTYPE w [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document/>',
        },
      ]),
    );
    expect(() => scanZipDocument(xxe)).toThrow(/external entity/);
    const fileref = writeZip(
      makeZip([
        {
          name: "word/document.xml",
          data: '<w:document><w:drawing><a:blip xlink:href="file:///etc/passwd"/></w:drawing></w:document>',
        },
      ]),
    );
    expect(() => scanZipDocument(fileref)).toThrow(/file:\/\/ or UNC/);
  });

  it("refuses external relationships that are not http(s) (file:, UNC)", () => {
    const p = writeZip(
      makeZip([
        {
          name: "word/_rels/document.xml.rels",
          data: '<Relationships><Relationship Id="r1" Type="http://x" Target="file:///etc/shadow" TargetMode="External"/><Relationship Id="r2" Type="http://y" Target="\\\\server\\share\\x" TargetMode="External"/></Relationships>',
        },
      ]),
    );
    expect(() => scanZipDocument(p)).toThrow(/file:\/\/ or UNC|external relationship/);
  });

  it("allows mailto:, tel: and https external relationships and internal relative targets", () => {
    const p = writeZip(
      makeZip([
        {
          name: "word/_rels/document.xml.rels",
          data: '<Relationships><Relationship Id="r1" Type="http://x" Target="mailto:a@example.com" TargetMode="External"/><Relationship Id="r2" Type="http://y" Target="tel:+15550100" TargetMode="External"/><Relationship Id="r3" Type="http://z" Target="https://example.com/" TargetMode="External"/><Relationship Id="r4" Type="http://w" Target="../media/x.png"/></Relationships>',
        },
      ]),
    );
    expect(() => scanZipDocument(p)).not.toThrow();
  });

  it("refuses entity-encoded file: references", () => {
    const p = writeZip(
      makeZip([
        {
          name: "content.xml",
          data: '<office:document><draw:image xlink:href="&#x66;ile:///etc/passwd"/></office:document>',
        },
      ]),
    );
    expect(() => scanZipDocument(p)).toThrow(/file:\/\/ or UNC/);
  });

  it("refuses ODF xlink:href with an absolute path or a .. segment, allows https links", () => {
    for (const href of ["/etc/passwd", "C:\\secret.txt", "../../outside.png", "Pictures/../../x"]) {
      const p = writeZip(
        makeZip([
          {
            name: "content.xml",
            data: `<office:document><draw:image xlink:href="${href}"/></office:document>`,
          },
        ]),
      );
      expect(() => scanZipDocument(p), href).toThrow();
    }
    const ok = writeZip(
      makeZip([
        {
          name: "content.xml",
          data: '<office:document><text:a xlink:href="https://example.com/"/><draw:image xlink:href="Pictures/a.png"/></office:document>',
        },
      ]),
    );
    expect(() => scanZipDocument(ok)).not.toThrow();
  });

  it("refuses a non-ZIP file", () => {
    const p = writeZip(Buffer.from("this is not a zip at all........"));
    expect(() => scanZipDocument(p)).toThrow(/not a ZIP/);
  });

  it("stageDocument scans ZIP-based artifacts before any tool runs", async () => {
    const env: Env = makeEnv();
    try {
      const hostile = makeZip([
        {
          name: "word/document.xml",
          data: '<!DOCTYPE w [<!ENTITY e SYSTEM "file:///etc/passwd">]><w:document/>',
        },
      ]);
      const id = env.add(
        "in.docx",
        hostile,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "document",
      );
      const work = join(env.dir, "work");
      await expect(stageDocument(env.ctx, work, id)).rejects.toThrow(/external entity/);
      // A clean docx stages fine.
      const clean = makeZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "word/document.xml", data: "<w:document/>" },
      ]);
      const id2 = env.add(
        "ok.docx",
        clean,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "document",
      );
      const staged = await stageDocument(env.ctx, work, id2);
      expect(staged.type).toBe("docx");
    } finally {
      env.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D-M8: language codes, subtitle keys and ComfyUI output paths never reach argv
// ---------------------------------------------------------------------------

describe("argv hard gates (D-M8)", () => {
  it("refuses a language value that is not a plain code in whisperArgs and runEngines", () => {
    expect(speechLanguageProblem("pt-BR")).toBeNull();
    expect(speechLanguageProblem("auto")).toBeNull();
    expect(speechLanguageProblem("--diarize")).toMatch(/language code/);
    expect(speechLanguageProblem("-l /etc/passwd")).toMatch(/language code/);
    expect(() => whisperArgs("/m.bin", "/w.wav", "/out", "--diarize", 4)).toThrow(/language code/);
    expect(whisperArgs("/m.bin", "/w.wav", "/out", "pt-BR", 4)).toEqual(
      expect.arrayContaining(["-l", "pt-BR"]),
    );
    const ctx = {} as PackContext;
    return expect(
      runEngines(ctx, ["hex"], {
        wav: "/w/speech.wav",
        work: "/w",
        duration_s: 1,
        language: "-x",
      }),
    ).rejects.toThrow(/language code/);
  });

  it("ignores subtitle keys that are not plain language codes", () => {
    const info = {
      subtitles: {
        "-o": [{ ext: "vtt" }],
        "en; rm -rf /": [{ ext: "vtt" }],
        en: [{ ext: "vtt" }],
      },
      automatic_captions: { "all.*": [{ ext: "vtt" }] },
    };
    expect(pickSubtitles(info)).toEqual({ key: "en", auto: false, language: "en" });
    // A wanted language that only exists as a hostile key finds nothing.
    expect(pickSubtitles({ subtitles: { "-x": [{ ext: "vtt" }] } }, "-x")).toBeNull();
    expect(pickSubtitles(info, "de")).toBeNull();
  });

  it("refuses ComfyUI output names that could traverse on /view", () => {
    expect(outputPathProblem("plughive_00001_.png", "")).toBeNull();
    expect(outputPathProblem("plughive_00001_.png", "sub/dir")).toBeNull();
    expect(outputPathProblem("../../etc/passwd", "")).toMatch(/plain name/);
    expect(outputPathProblem("a/b.png", "")).toMatch(/plain name/);
    expect(outputPathProblem("-rf.png", "")).toMatch(/plain name/);
    expect(outputPathProblem("..", "")).toMatch(/plain name/);
    expect(outputPathProblem("ok.png", "sub/../x")).toMatch(/slash-separated/);
    expect(outputPathProblem("ok.png", "sub\\x")).toMatch(/backslash/);
    expect(() =>
      collectOutputs({
        outputs: {
          a: { images: [{ filename: "../../etc/passwd", subfolder: "", type: "output" }] },
        },
      }),
    ).toThrow(/refusing a ComfyUI output/);
    expect(
      collectOutputs({
        outputs: { a: { images: [{ filename: "ok.png", subfolder: "s", type: "output" }] } },
      }),
    ).toEqual([{ filename: "ok.png", subfolder: "s", type: "output" }]);
  });

  it("tightens the capability schemas: model ids and transcribe languages", () => {
    expect(
      AudioTranscribeInputSchema.safeParse({ artifact_id: "a", language: "--diarize" }).success,
    ).toBe(false);
    expect(
      AudioTranscribeInputSchema.safeParse({ artifact_id: "a", language: "pt-BR" }).success,
    ).toBe(true);
    expect(AudioTranscribeInputSchema.safeParse({ artifact_id: "a", model: "-evil" }).success).toBe(
      false,
    );
    expect(
      AudioTranscribeInputSchema.safeParse({ artifact_id: "a", model: "org/model-1" }).success,
    ).toBe(true);
    expect(
      MediaTranscriptInputSchema.safeParse({ url: "https://v.test/x", language: "-x" }).success,
    ).toBe(false);
    expect(
      MediaTranscriptInputSchema.safeParse({ url: "https://v.test/x", language: "en" }).success,
    ).toBe(true);
  });
});
