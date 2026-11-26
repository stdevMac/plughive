import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
// The newer local providers with spawn/fetch mocked: speech-engine choice,
// document parsing and conversion plans, yt-dlp transcripts, ComfyUI img2img,
// the Ollama text helpers, the capability guards and the local_status shape.
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { providers } from "../../../packs/local/capabilities.js";
import {
  EDIT_DENOISE,
  buildImg2ImgWorkflow,
  uploadImage,
  validateWorkflow,
} from "../../../packs/local/comfy.js";
import {
  LANGUAGE_VALUE,
  LO_PROFILE_XCU,
  convertDocument,
  convertPlan,
  convertWithSoffice,
  docTypeOf,
  hasTextLayer,
  parseDocument,
  safeHtmlUrl,
  sanitizeHtmlRefs,
  splitPages,
  tesseractLanguages,
  writeLoProfile,
} from "../../../packs/local/documents.js";
import {
  engineOrder,
  engineSetting,
  parseHexOutput,
  parseParakeetJson,
  parseWhisperxJson,
  toSrt,
} from "../../../packs/local/engines.js";
import { realesrganArgs } from "../../../packs/local/imaging.js";
import { localStatus } from "../../../packs/local/status.js";
import { chunkText, cosine, isEmbeddingModel, rerankTexts } from "../../../packs/local/text.js";
import {
  checkInfoUrls,
  infoUrls,
  mediaTranscript,
  parseVtt,
  pickSubtitles,
  pinDecide,
  segmentsText,
} from "../../../packs/local/transcript.js";
import { engineFromModel, planEngines } from "../../../packs/local/whisper.js";
import {
  type Env,
  type SpawnCall,
  jsonRes,
  makeEnv,
  recordingSpawn,
  routedFetch,
} from "./harness.js";

let env: Env | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const enoent = (b: string) => {
  throw Object.assign(new Error(`spawn ${b} ENOENT`), { code: "ENOENT" });
};
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
const provider = (cap: string) => {
  const p = providers.find((x) => x.capability === cap);
  if (!p) throw new Error(`no provider for ${cap}`);
  return p as unknown as { run: (input: unknown, ctx: Env["ctx"]) => Promise<unknown> };
};

describe("speech-to-text engine choice", () => {
  it("auto prefers parakeet on Apple silicon and whisper.cpp elsewhere; speakers force whisperX", () => {
    expect(engineOrder("auto", { platform: "darwin", arch: "arm64" })).toEqual([
      "parakeet",
      "hex",
      "whisper.cpp",
      "whisperx",
    ]);
    expect(engineOrder("auto", { platform: "linux", arch: "x64" })).toEqual([
      "whisper.cpp",
      "hex",
      "whisperx",
    ]);
    expect(engineOrder("hex")).toEqual(["hex"]);
    expect(engineOrder("whisper.cpp", { speakers: true })).toEqual(["whisperx"]);
  });

  it("reads the setting, ignoring unknown values, and maps engine names given as a model", () => {
    env = makeEnv({ settings: { transcriptionEngine: "whisperx" } });
    expect(engineSetting(env.ctx)).toBe("whisperx");
    env.cleanup();
    env = makeEnv({ settings: { transcriptionEngine: "bogus" } });
    expect(engineSetting(env.ctx)).toBe("auto");
    expect(engineFromModel("parakeet")).toBe("parakeet");
    expect(engineFromModel("auto")).toBeUndefined();
    expect(engineFromModel("large-v3")).toBeUndefined();
  });

  it("a forced engine is planned as is; auto with nothing installed lists every install hint", async () => {
    env = makeEnv({ spawn: async (b) => enoent(b), settings: { transcriptionEngine: "hex" } });
    expect(await planEngines(env.ctx, {})).toEqual(["hex"]);
    expect(await planEngines(env.ctx, { engine: "whisperx" })).toEqual(["whisperx"]);
    await expect(planEngines(env.ctx, { engine: "auto" })).rejects.toThrow(
      /No speech-to-text engine is installed/,
    );
  });

  it("auto keeps only the engines that answer", async () => {
    env = makeEnv({
      spawn: async (b) => (b === "hex" ? ok("hex 1.0") : enoent(b)),
    });
    expect(await planEngines(env.ctx, {})).toEqual(["hex"]);
  });

  it("parses parakeet, Hex and whisperX output", () => {
    const p = parseParakeetJson(
      JSON.stringify({
        text: "",
        sentences: [
          { text: " Hello. ", start: 0, end: 1.234 },
          { text: "", start: 1, end: 2 },
          { text: "World.", start: 1.5, end: 2.5 },
        ],
      }),
    );
    expect(p.text).toBe("Hello. World.");
    expect(p.segments).toEqual([
      { start_s: 0, end_s: 1.23, text: "Hello." },
      { start_s: 1.5, end_s: 2.5, text: "World." },
    ]);
    expect(() => parseParakeetJson("not json")).toThrow(/unreadable JSON/);
    expect(parseHexOutput('loading\n{"status":"transcript","text":"hi"}\n')).toEqual({
      status: "transcript",
      text: "hi",
    });
    expect(parseHexOutput("nothing here")).toBeNull();
    const x = parseWhisperxJson(
      JSON.stringify({
        language: "en",
        segments: [{ start: 0, end: 1, text: " Hi ", speaker: "SPEAKER_00" }],
      }),
    );
    expect(x).toEqual({
      text: "Hi",
      language: "en",
      segments: [{ start_s: 0, end_s: 1, text: "Hi", speaker: "SPEAKER_00" }],
    });
    expect(toSrt(x.segments)).toContain("00:00:00,000 --> 00:00:01,000");
  });
});

describe("documents", () => {
  it("detects the type from the declared MIME, the stored MIME, then a file name", () => {
    expect(
      docTypeOf({
        mime: "application/octet-stream",
        meta: {
          declaredMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      }),
    ).toBe("docx");
    expect(docTypeOf({ mime: "text/plain", meta: { declaredMime: "text/html" } })).toBe("html");
    expect(docTypeOf({ mime: "application/pdf", meta: null })).toBe("pdf");
    expect(docTypeOf({ mime: "text/plain", meta: { filename: "notes.markdown" } })).toBe("md");
    expect(docTypeOf({ mime: "text/plain", meta: null })).toBe("txt");
    expect(docTypeOf({ mime: "application/octet-stream", meta: { name: "scan.TIF" } })).toBe(
      "tiff",
    );
    expect(docTypeOf({ mime: "application/octet-stream", meta: null })).toBeNull();
  });

  it("maps OCR languages to Tesseract codes and refuses unknown ones", () => {
    expect(tesseractLanguages(undefined)).toBe("eng");
    expect(tesseractLanguages("en+de")).toBe("eng+deu");
    expect(tesseractLanguages("pt-BR")).toBe("por");
    expect(tesseractLanguages("chi_sim")).toBe("chi_sim");
    expect(() => tesseractLanguages("klingon!")).toThrow(/cannot do OCR/);
  });

  it("refuses a language value that is not codes joined by + (max 64) before any argv", () => {
    // Strict gate: anything else never reaches a command line.
    for (const bad of [
      "-psm",
      "eng+-c",
      "eng+",
      "eng; rm -rf /",
      "eng$(id)",
      "eng`id`",
      'eng" "x',
      "eng\n--help",
      "eng ",
      "e".repeat(65),
      "eng+",
      "+eng",
    ]) {
      expect(() => tesseractLanguages(bad), JSON.stringify(bad)).toThrow(/cannot do OCR/);
    }
    expect(tesseractLanguages("en")).toBe("eng");
    expect(tesseractLanguages("ENG+deu")).toBe("eng+deu");
    expect(tesseractLanguages("chi_sim")).toBe("chi_sim");
    expect(tesseractLanguages("abcdefgh+abcdefgh")).toBe("abcdefgh+abcdefgh");
    expect(LANGUAGE_VALUE.test("en+de")).toBe(true);
    expect(LANGUAGE_VALUE.test("a".repeat(64))).toBe(true);
    expect(LANGUAGE_VALUE.test("a".repeat(65))).toBe(false);
    expect(LANGUAGE_VALUE.test("en;de")).toBe(false);
  });

  it("plans conversions: LibreOffice first for office files, pandoc first for markup", () => {
    expect(convertPlan("docx", "pdf")).toEqual(["soffice"]);
    expect(convertPlan("docx", "md")).toEqual(["pandoc"]);
    expect(convertPlan("odt", "html")).toEqual(["soffice", "pandoc"]);
    expect(convertPlan("md", "docx")).toEqual(["pandoc"]);
    expect(convertPlan("html", "docx")).toEqual(["pandoc", "soffice"]);
    expect(convertPlan("xlsx", "csv")).toEqual(["soffice"]);
    expect(convertPlan("pptx", "pdf")).toEqual(["soffice"]);
    expect(convertPlan("pdf", "docx")).toEqual([]);
    expect(convertPlan("png", "pdf")).toEqual([]);
  });

  it("splits pdftotext pages and spots a missing text layer", () => {
    expect(splitPages("a\fb\f")).toEqual(["a", "b"]);
    expect(hasTextLayer("\f\f\f")).toBe(false);
    expect(hasTextLayer("A real page of text with enough characters.\f")).toBe(true);
  });

  it("parses a PDF with pdftotext, and a text-less one without ocrmypdf says how to install it", async () => {
    const m = recordingSpawn((c: SpawnCall) => {
      if (c.binary === "pdftotext" && c.args[0] === "-layout")
        return ok("First page has plenty of words.  \fSecond page also has words.\f");
      if (c.binary === "pdftotext") return ok("pdftotext version 24");
      return enoent(c.binary);
    });
    env = makeEnv({ spawn: m.spawn });
    const id = env.add("doc.pdf", "%PDF-1.4", "application/pdf", "pdf");
    const r = await parseDocument(env.ctx, { artifact_id: id });
    expect(r).toEqual({
      text: "First page has plenty of words.\n\nSecond page also has words.",
      format: "text",
      pages: 2,
      model: "pdftotext",
    });
    const pdf = m.calls.find((c) => c.args[0] === "-layout") as SpawnCall;
    expect(pdf.args.slice(0, 3)).toEqual(["-layout", "-enc", "UTF-8"]);
    expect(pdf.args[pdf.args.length - 1]).toBe("-");
    env.cleanup();

    env = makeEnv({
      spawn: async (b, args) =>
        b === "pdftotext" ? ok(args[0] === "-layout" ? "\f" : "v") : enoent(b),
    });
    const id2 = env.add("scan.pdf", "%PDF-1.4", "application/pdf", "pdf");
    await expect(parseDocument(env.ctx, { artifact_id: id2 })).rejects.toThrow(
      /no text layer and ocrmypdf is not installed/,
    );
  });

  it("reads plain text directly without spawning", async () => {
    const m = recordingSpawn((c) => enoent(c.binary));
    env = makeEnv({ spawn: m.spawn });
    const id = env.add("a.txt", "﻿just text\n", "text/plain", "document");
    const r = await parseDocument(env.ctx, { artifact_id: id });
    expect(r).toEqual({ text: "just text", format: "text", model: "plain" });
    expect(m.calls).toHaveLength(0);
  });
});

describe("media.transcript second-hop URL checks", () => {
  const info = (formatUrl: string, subUrl = "https://93.184.216.34/s.vtt") => ({
    url: "https://93.184.216.34/v.mp4",
    formats: [
      { url: formatUrl, fragment_base_url: "https://93.184.216.35/f/", fragments: [{ url: "x" }] },
    ],
    subtitles: { en: [{ ext: "vtt", url: subUrl }] },
    requested_downloads: [{ url: "https://93.184.216.34/v.mp4" }],
    title: "not a url",
  });

  it("collects one URL per host from every *url / *_url string, resolving fragment paths", () => {
    // The first URL seen for a host stands for it (v.mp4 and s.vtt share one).
    expect(infoUrls(info("https://93.184.216.36/a")).sort()).toEqual(
      ["https://93.184.216.34/v.mp4", "https://93.184.216.35/f/", "https://93.184.216.36/a"].sort(),
    );
  });

  it("fails closed on fragment paths, relative values, too many hosts and deep nesting", async () => {
    const withPath = (path: string) => ({
      formats: [
        {
          url: "https://93.184.216.36/m",
          fragment_base_url: "https://93.184.216.35/f/",
          fragments: [{ path }],
        },
      ],
    });
    expect(infoUrls(withPath("seg1.m4s"))).toEqual([
      "https://93.184.216.36/m",
      "https://93.184.216.35/f/",
    ]);
    await expect(checkInfoUrls(withPath("http://127.0.0.1:7777/x"))).rejects.toThrow(/URL refused/);
    await expect(checkInfoUrls(withPath("//10.0.0.5/x"))).rejects.toThrow(/URL refused/);
    expect(() => infoUrls({ formats: [{ url: "not/absolute" }] })).toThrow(/not an absolute URL/);
    const many = {
      formats: Array.from({ length: 65 }, (_, i) => ({ url: `https://h${i}.example/` })),
    };
    expect(() => infoUrls(many)).toThrow(/over 64 hosts/);
    let deep: unknown = { url: "https://93.184.216.34/" };
    for (let i = 0; i < 40; i++) deep = { x: deep };
    expect(() => infoUrls(deep)).toThrow(/nested too deeply/);
    // Forms a WHATWG parser and Python's urllib can read as different hosts.
    for (const raw of [
      "http://93.184.216.34\\@127.0.0.1/",
      "http://user@93.184.216.34/",
      "http://93.184.216.34@127.0.0.1/",
      "http://127.0.0.%31/",
      "http://93.184.216.34/a b",
      "http://93.184.216.34/\tx",
    ]) {
      expect(() => infoUrls({ formats: [{ url: raw }] }), raw).toThrow(/URL refused/);
    }
    // Thumbnails are never downloaded, so a data: thumbnail does not refuse the item.
    expect(infoUrls({ thumbnails: [{ url: "data:image/png;base64,AAAA" }] })).toEqual([]);
  });

  it("allows public media hosts", async () => {
    await expect(checkInfoUrls(info("https://93.184.216.36/a"))).resolves.toBeUndefined();
  });

  it("refuses a format or subtitle track on a private, loopback or metadata address", async () => {
    for (const bad of [
      "http://127.0.0.1:7777/api/secrets",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/x",
      "file:///etc/passwd",
    ]) {
      await expect(checkInfoUrls(info(bad)), bad).rejects.toThrow(/URL refused/);
      await expect(checkInfoUrls(info("https://93.184.216.36/a", bad)), bad).rejects.toThrow(
        /URL refused/,
      );
    }
  });
});

describe("media.transcript (yt-dlp)", () => {
  const info = {
    title: "A talk",
    duration: 60,
    language: "en",
    subtitles: { en: [{ ext: "vtt" }], live_chat: [{ ext: "vtt" }] },
    automatic_captions: { "de-orig": [{ ext: "vtt" }], fr: [{ ext: "vtt" }] },
  };

  it("picks uploaded subtitles, then original-language automatic captions", () => {
    expect(pickSubtitles(info)).toEqual({ key: "en", auto: false, language: "en" });
    expect(pickSubtitles(info, "de")).toEqual({ key: "de-orig", auto: true, language: "de" });
    expect(pickSubtitles(info, "fr-CA")).toEqual({ key: "fr", auto: true, language: "fr" });
    expect(pickSubtitles(info, "ja")).toBeNull();
    expect(pickSubtitles({ subtitles: { es: [{ ext: "srv3" }] } })).toBeNull();
  });

  it("parses WebVTT and drops rolling-caption repeats, tags and entities", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "",
      "00:00:00.000 --> 00:00:02.000 align:start",
      "<c>Hello</c> &amp; welcome",
      "",
      "00:00:02.000 --> 00:00:02.010",
      "Hello &amp; welcome",
      "",
      "00:00:02.010 --> 00:00:04.500",
      "Hello &amp; welcome",
      "to the talk .",
      "",
      "not a time --> 01:01.000",
      "bad times are skipped",
    ].join("\n");
    const segs = parseVtt(vtt);
    expect(segs).toEqual([
      { start_s: 0, end_s: 2, text: "Hello & welcome" },
      { start_s: 2.01, end_s: 4.5, text: "to the talk ." },
    ]);
    expect(segmentsText(segs)).toBe("Hello & welcome to the talk.");
  });

  it("refuses local and non-http URLs before running yt-dlp", async () => {
    const m = recordingSpawn((c) => enoent(c.binary));
    env = makeEnv({ spawn: m.spawn });
    for (const url of [
      "http://127.0.0.1:7777/x",
      "http://169.254.169.254/latest",
      "http://192.168.1.2/v",
      "file:///etc/passwd",
    ]) {
      await expect(mediaTranscript(env.ctx, { url }), url).rejects.toThrow(/URL refused/);
    }
    expect(m.calls).toHaveLength(0);
  });

  it("downloads the chosen subtitles with config, playlists and cache off", async () => {
    const m = recordingSpawn((c: SpawnCall) => {
      if (c.args.includes("--version")) return ok("2026.01.01");
      if (c.args.includes("--dump-single-json")) return ok(JSON.stringify(info));
      if (c.args.includes("--write-subs")) {
        const out = c.args[c.args.indexOf("-o") + 1] as string;
        writeFileSync(
          `${dirname(out)}/sub.en.vtt`,
          "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi there.\n",
        );
        return ok();
      }
      return enoent(c.binary);
    });
    env = makeEnv({ spawn: m.spawn });
    const r = await mediaTranscript(env.ctx, { url: "https://93.184.216.34/watch?v=1" });
    expect(r).toEqual({
      text: "Hi there.",
      segments: [{ start_s: 1, end_s: 2, text: "Hi there." }],
      language: "en",
      title: "A talk",
      model: "yt-dlp subtitles",
      source: "subtitles",
    });
    const yt = m.calls.filter((c) => c.binary === "yt-dlp" && !c.args.includes("--version"));
    expect(yt).toHaveLength(2);
    for (const c of yt) {
      expect(c.args.slice(0, 5)).toEqual([
        "--ignore-config",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--no-cache-dir",
      ]);
    }
    expect(yt[0]?.args.slice(-2)).toEqual(["--", "https://93.184.216.34/watch?v=1"]);
    // Every run goes through the same loopback pinning proxy.
    const proxies = yt.map((c) => c.args[c.args.indexOf("--proxy") + 1]);
    expect(proxies[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new Set(proxies).size).toBe(1);
  });

  it("the proxy refuses a hop to a local address while yt-dlp runs, and closes after", async () => {
    let proxy = "";
    let status = 0;
    const m = recordingSpawn(async (c: SpawnCall) => {
      if (c.args.includes("--version")) return ok("2026.01.01");
      if (c.args.includes("--dump-single-json")) {
        proxy = c.args[c.args.indexOf("--proxy") + 1] as string;
        // What a redirect (or a rebinding answer) to the daemon would look like.
        status = await viaProxy(proxy, "http://127.0.0.1:7777/api/secrets");
        return ok(JSON.stringify({ title: "Long", duration: 7200 }));
      }
      return enoent(c.binary);
    });
    env = makeEnv({ spawn: m.spawn });
    await expect(mediaTranscript(env.ctx, { url: "https://93.184.216.34/v" })).rejects.toThrow();
    expect(status).toBe(403);
    await expect(viaProxy(proxy, "http://93.184.216.34/")).rejects.toThrow();
  });

  it("pinDecide pins public addresses and refuses local ones", async () => {
    await expect(pinDecide("https://93.184.216.34/a")).resolves.toEqual({
      ok: true,
      address: "93.184.216.34",
    });
    for (const bad of ["http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/"]) {
      await expect(pinDecide(bad), bad).resolves.toMatchObject({ ok: false });
    }
  });

  it("a long video without subtitles is left to another provider", async () => {
    const m = recordingSpawn((c: SpawnCall) => {
      if (c.args.includes("--dump-single-json"))
        return ok(JSON.stringify({ title: "Long", duration: 7200 }));
      return c.binary === "yt-dlp" ? ok("v") : enoent(c.binary);
    });
    env = makeEnv({ spawn: m.spawn });
    await expect(
      mediaTranscript(env.ctx, { url: "https://93.184.216.34/v" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPTION", retryable: true });
  });
});

describe("ComfyUI img2img", () => {
  it("builds a valid graph that loads, encodes, batches and partially denoises", () => {
    const wf = buildImg2ImgWorkflow({
      checkpoint: "sd15.safetensors",
      image: "in/mcp.png",
      prompt: "make it night",
      negative: "",
      n: 2,
      seed: 7,
      steps: 25,
      cfg: 7,
      denoise: EDIT_DENOISE,
    });
    expect(validateWorkflow(wf)).toEqual(wf);
    expect(wf.load?.inputs.image).toBe("in/mcp.png");
    expect(wf.batch?.inputs).toEqual({ samples: ["encode", 0], amount: 2 });
    expect(wf.sampler?.inputs.denoise).toBe(0.6);
    expect(wf.sampler?.inputs.latent_image).toEqual(["batch", 0]);
    expect(wf.save?.inputs.filename_prefix).toBe("plughive-edit");
  });

  it("uploads the image as multipart and returns the stored name", async () => {
    let body: unknown;
    const log: string[] = [];
    env = makeEnv({
      fetch: routedFetch(
        {
          "POST /upload/image": (init) => {
            body = init?.body;
            return jsonRes({ name: "x.png", subfolder: "sub", type: "input" });
          },
        },
        log,
      ),
    });
    const name = await uploadImage(env.ctx, new Uint8Array([1, 2, 3]), "image/png", "x.png");
    expect(name).toBe("sub/x.png");
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("type")).toBe("input");
    expect((form.get("image") as File).name).toBe("x.png");
    expect(log[0]).toMatch(/^POST \/upload\/image 127\.0\.0\.1:8188$/);
  });
});

describe("Ollama text helpers", () => {
  it("chunks long text on paragraph boundaries, never losing characters", () => {
    expect(chunkText("short", 10)).toEqual(["short"]);
    const text = `${"a".repeat(30)}\n\n${"b".repeat(30)}\n\n${"c".repeat(10)}`;
    const chunks = chunkText(text, 40);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((c) => c.length <= 40)).toBe(true);
    expect(chunks[0]).toBe(`${"a".repeat(30)}\n\n`);
    expect(chunks[1]?.startsWith("b")).toBe(true);
    const solid = "x".repeat(25);
    expect(chunkText(solid, 10).join("")).toBe(solid);
  });

  it("cosine and embedding-model detection", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(isEmbeddingModel({ name: "nomic-embed-text:latest", family: "nomic-bert" })).toBe(true);
    expect(isEmbeddingModel({ name: "bge-m3", family: "x" })).toBe(true);
    expect(isEmbeddingModel({ name: "llama3.2", family: "llama" })).toBe(false);
  });

  it("reranks by cosine with the first installed embedding model", async () => {
    const vec: Record<string, number[]> = { q: [1, 0], a: [0, 1], b: [0.9, 0.1], c: [0.5, 0.5] };
    env = makeEnv({
      fetch: routedFetch({
        "GET /api/tags": () =>
          jsonRes({
            models: [
              { name: "llama3.2", details: { family: "llama" } },
              { name: "nomic-embed-text", details: { family: "nomic-bert" } },
            ],
          }),
        "POST /api/embed": (init) => {
          const b = JSON.parse(String(init?.body)) as { model: string; input: string[] };
          return jsonRes({ model: b.model, embeddings: b.input.map((t) => vec[t]) });
        },
      }),
    });
    const r = await rerankTexts(env.ctx, { query: "q", documents: ["a", "b", "c"], top_n: 2 });
    expect(r.model).toBe("nomic-embed-text");
    expect(r.results.map((x) => x.index)).toEqual([1, 2]);
  });
});

describe("capability guards hand over to the next provider", () => {
  // Guards throw synchronously; the router awaits run() inside its try.
  const expectUnsupported = (run: () => Promise<unknown>) =>
    expect(Promise.resolve().then(run)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPTION",
      retryable: true,
    });

  it("refuses what the local backends cannot do, before touching them", async () => {
    const m = recordingSpawn((c) => enoent(c.binary));
    env = makeEnv({ spawn: m.spawn, fetch: (() => Promise.reject(new Error("no"))) as never });
    const ctx = env.ctx;
    await expectUnsupported(() =>
      provider("image.edit").run({ artifact_id: "a", prompt: "p", mask_id: "m" }, ctx),
    );
    await expectUnsupported(() =>
      provider("image.edit").run({ artifact_id: "a", prompt: "p", reference_ids: ["r"] }, ctx),
    );
    await expectUnsupported(() =>
      provider("video.upscale").run({ artifact_id: "a", model: "topaz" }, ctx),
    );
    await expectUnsupported(() =>
      provider("document.parse").run({ artifact_id: "a", model: "x" }, ctx),
    );
    await expectUnsupported(() =>
      provider("document.convert").run({ artifact_id: "a", to: "mobi" }, ctx),
    );
    expect(m.calls).toHaveLength(0);
    // Speaker labels need whisperX and HF_TOKEN.
    await expectUnsupported(() =>
      provider("audio.transcribe").run({ artifact_id: "a", speakers: true }, ctx),
    );
  });
});

describe("Real-ESRGAN arguments", () => {
  it("passes input, output, model and scale as separate arguments", () => {
    expect(realesrganArgs("/w/in.png", "/w/out.png", "realesrgan-x4plus", 4)).toEqual(
      expect.arrayContaining(["-i", "/w/in.png", "-o", "/w/out.png", "-n", "realesrgan-x4plus"]),
    );
  });

  it("passes the models folder as an absolute path when it is known", () => {
    const args = realesrganArgs("/w/in.png", "/w/out.png", "realesrgan-x4plus", 4, "/t/models");
    expect(args.slice(-2)).toEqual(["-m", "/t/models"]);
    expect(realesrganArgs("/w/in.png", "/w/out.png", "realesrgan-x4plus", 4, null)).not.toContain(
      "-m",
    );
    expect(() =>
      realesrganArgs("/w/in.png", "/w/o.png", "realesrgan-x4plus", 4, "models"),
    ).toThrow();
  });
});

describe("local_status", () => {
  const refused = (async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }) as never;

  it("reports every backend, the engine setting and no usable capability when nothing is installed", async () => {
    env = makeEnv({
      spawn: async (b) => enoent(b),
      fetch: refused,
      settings: { whisperModelPath: "", transcriptionEngine: "whisper.cpp" },
    });
    const s = await localStatus(env.ctx);
    expect(Object.keys(s.backends).sort()).toEqual([
      "comfyui",
      "demucs",
      "ffmpeg",
      "hex",
      "kokoro",
      "ocrmypdf",
      "ollama",
      "pandoc",
      "parakeet",
      "pdftotext",
      "realesrgan",
      "rembg",
      "soffice",
      "tesseract",
      "whisper",
      "whisperx",
      "ytdlp",
    ]);
    expect(s.ready).toEqual([]);
    expect(s.usable_capabilities).toEqual([]);
    expect(s.transcription_engine).toBe("whisper.cpp");
    expect(s.backends.pandoc?.install_hint).toMatch(/pandoc/i);
    expect(s.backends.ytdlp?.error).toBe("yt-dlp not found");
  });

  it("maps installed command-line tools to their capabilities", async () => {
    env = makeEnv({
      spawn: async (b) => (b === "pandoc" || b === "yt-dlp" ? ok(`${b} 1.0`) : enoent(b)),
      fetch: refused,
      settings: { whisperModelPath: "" },
    });
    const s = await localStatus(env.ctx);
    expect([...s.ready].sort()).toEqual(["pandoc", "ytdlp"]);
    expect(s.usable_capabilities).toEqual([
      "document.convert",
      "document.parse",
      "media.transcript",
    ]);
  });
});

/** GET `target` through the proxy at `proxy`; resolves with the status code. */
function viaProxy(proxy: string, target: string): Promise<number> {
  const u = new URL(proxy);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: u.hostname, port: Number(u.port), method: "GET", path: target, timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

describe("LibreOffice hardening and HTML sanitising", () => {
  it("seeds a profile with macros off, links never updated and a dead proxy", () => {
    const xcu = LO_PROFILE_XCU;
    // macros and active content
    expect(xcu).toContain('oor:path="/org.openoffice.Office.Common/Security/Scripting"');
    expect(xcu).toMatch(/MacroSecurityLevel[^>]*>\s*<value>3</);
    expect(xcu).toMatch(/DisableMacrosExecution[^>]*>\s*<value>true</);
    expect(xcu).toMatch(/DisablePythonRuntime[^>]*>\s*<value>true</);
    expect(xcu).toMatch(/DisableActiveContent[^>]*>\s*<value>true</);
    expect(xcu).toMatch(/BlockUntrustedRefererLinks[^>]*>\s*<value>true</);
    // link updates: 2 = never, for Writer, Calc and Impress
    for (const app of ["Writer", "Calc", "Impress"]) {
      expect(xcu).toContain(`oor:path="/org.openoffice.Office.${app}/Content/Update"`);
    }
    expect(xcu.match(/oor:name="Link"[^>]*>\s*<value>2</g)).toHaveLength(3);
    // all network through a dead proxy on 127.0.0.1:9
    expect(xcu).toContain('oor:path="/org.openoffice.Inet/Settings"');
    expect(xcu).toMatch(/ooInetProxyType[^>]*>\s*<value>2</);
    for (const proto of ["HTTP", "HTTPS", "FTP"]) {
      expect(xcu).toMatch(new RegExp(`ooInet${proto}ProxyName[^>]*>\\s*<value>127\\.0\\.0\\.1<`));
      expect(xcu).toMatch(new RegExp(`ooInet${proto}ProxyPort[^>]*>\\s*<value>9<`));
    }
    expect(xcu).toMatch(/ooInetNoProxyList[^>]*>\s*<value><\/value>/);
  });

  it("writeLoProfile writes user/registrymodifications.xcu", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lo-profile-"));
    try {
      await writeLoProfile(dir);
      expect(readFileSync(join(dir, "user", "registrymodifications.xcu"), "utf8")).toBe(
        LO_PROFILE_XCU,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seeds the hardened profile before soffice runs", async () => {
    let profileAtSpawn: string | null = null;
    let convertPath: string | null = null;
    const m = recordingSpawn((c: SpawnCall) => {
      if (c.binary === "soffice" && c.args.includes("--version")) return ok("LibreOffice 25.2");
      if (c.binary === "soffice") {
        const work = c.opts?.cwd ?? "";
        const xcu = join(work, "lo-profile", "user", "registrymodifications.xcu");
        profileAtSpawn = existsSync(xcu) ? readFileSync(xcu, "utf8") : null;
        convertPath = c.args.at(-1) ?? null;
        return ok("");
      }
      return enoent(c.binary);
    });
    env = makeEnv({ spawn: m.spawn });
    const work = join(env.dir, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "in.docx"), "docx");
    // The conversion itself "fails" (no out file), but the profile must
    // already be seeded when soffice was spawned.
    await expect(
      convertWithSoffice(env.ctx, work, join(work, "in.docx"), "docx", "pdf"),
    ).rejects.toThrow(/did not convert/);
    expect(profileAtSpawn).toBe(LO_PROFILE_XCU);
    expect(convertPath).toBe(join(work, "in.docx"));
    const convertCall = m.calls.find((c) =>
      c.args.some((a) => a.startsWith("-env:UserInstallation=")),
    );
    expect(convertCall?.args).toContain(
      `-env:UserInstallation=${pathToFileURL(join(work, "lo-profile")).href}`,
    );
  });

  it("strips remote, file and path references from HTML but keeps fragments and data ones", () => {
    expect(safeHtmlUrl("image.png")).toBe(false);
    expect(safeHtmlUrl("/etc/passwd")).toBe(false);
    expect(safeHtmlUrl("../../etc/passwd")).toBe(false);
    expect(safeHtmlUrl("&#47;etc/passwd")).toBe(false);
    expect(safeHtmlUrl("data&#58;x")).toBe(false);
    expect(safeHtmlUrl("#frag")).toBe(true);
    expect(safeHtmlUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(safeHtmlUrl("https://evil.example.com/x.png")).toBe(false);
    expect(safeHtmlUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(safeHtmlUrl("file:///etc/passwd")).toBe(false);
    expect(safeHtmlUrl("//evil.example.com/x")).toBe(false);
    expect(safeHtmlUrl("ftp://host/x")).toBe(false);

    const out = sanitizeHtmlRefs(
      [
        "<html><head>",
        '<base href="https://evil.example.com/">',
        '<meta http-equiv="refresh" content="0;url=http://169.254.169.254/">',
        '<link rel="stylesheet" href="https://evil.example.com/s.css">',
        '<style>body{background:url("https://evil.example.com/bg.png")} a{background:url(/local.png)} @import "https://evil.example.com/x.css";</style>',
        "</head><body>",
        '<img src="https://evil.example.com/i.png">',
        "<img src='file:///etc/passwd'>",
        '<img src="pic.png">',
        '<img src="data:image/png;base64,AAAA">',
        '<iframe src="http://127.0.0.1:7777/x"></iframe>',
        '<a href="https://evil.example.com/">link</a>',
        '<a href="/rel/path">ok</a>',
        '<video poster="https://evil.example.com/p.png"></video>',
        '<img srcset="pic.png 1x, https://evil.example.com/2x.png 2x">',
        '<body background="file:///etc/hosts">',
        "</body></html>",
      ].join("\n"),
    );
    expect(out).not.toContain("evil.example.com");
    expect(out).not.toContain("169.254.169.254");
    expect(out).not.toContain("file:///etc/passwd");
    expect(out).not.toContain("<base");
    expect(out).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    expect(out).not.toMatch(/@import/);
    expect(out).toContain('src="#"');
    expect(out).toContain('href="#"');
    expect(out).toContain('src="#"');
    expect(out).not.toContain("pic.png");
    expect(out).not.toContain("/etc/hosts");
    expect(out).toContain('src="data:image/png;base64,AAAA"');
    expect(out).not.toContain("/rel/path");
    expect(out).not.toContain("/local.png");
    expect(out).toContain('poster="#"');
  });

  it("converts html -> pdf through a sanitised copy, not the original", async () => {
    let convertedPath: string | null = null;
    let convertedContent: string | null = null;
    const m = recordingSpawn((c: SpawnCall) => {
      if (c.binary === "soffice" && c.args.includes("--version")) return ok("LibreOffice 25.2");
      if (c.binary === "soffice") {
        convertedPath = c.args.at(-1) ?? null;
        convertedContent = convertedPath ? readFileSync(convertedPath, "utf8") : null;
        // Pretend the conversion produced the pdf.
        const outDir = c.args[c.args.indexOf("--outdir") + 1]!;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "in.pdf"), "%PDF-1.4");
        return ok("convert /work/in-sanitized.html -> /work/out/in.pdf using filter : pdf");
      }
      return enoent(c.binary);
    });
    env = makeEnv({ spawn: m.spawn });
    const id = env.add(
      "page.html",
      '<html><body><img src="file:///etc/passwd"><img src="https://evil.example.com/x.png"><p>hi</p></body></html>',
      "text/plain",
      "document",
    );
    // The library stores HTML as text/plain with the declared type in meta.
    env.records.get(id)!.meta = { declaredMime: "text/html" };
    const r = await convertDocument(env.ctx, { artifact_id: id, to: "pdf" }, "test");
    expect(r.model).toBe("soffice");
    expect(r.artifacts).toHaveLength(1);
    expect(convertedPath).toMatch(/in-sanitized\.html$/);
    expect(convertedContent).not.toBeNull();
    expect(convertedContent).not.toContain("file:///etc/passwd");
    expect(convertedContent).not.toContain("evil.example.com");
    expect(convertedContent).toContain("<p>hi</p>");
  });
});
