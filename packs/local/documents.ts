// packs/local/documents.ts
//
// document.parse and document.convert with local command-line tools.
//   parse:   PDF -> pdftotext (Poppler); a PDF without a text layer is OCRed
//            with OCRmyPDF first. Images -> Tesseract. Office, HTML, EPUB and
//            similar documents -> pandoc to Markdown or plain text.
//   convert: pandoc (with --sandbox, so a document cannot pull in other files)
//            between the formats it reads and writes; LibreOffice (soffice
//            --headless, with a throwaway profile seeded with the hardened
//            registrymodifications.xcu: no macros, no link updates, all
//            network through a dead proxy) for PDF output, spreadsheets,
//            presentations and anything pandoc cannot do; HTML references
//            are sanitised before LibreOffice sees them.
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { type ArtifactKind, CapabilityError, type PackContext } from "plughive/pack";
import { artifactIdProblem, assertSafePath, run, stderrTail } from "./lib/ffmpeg.js";
import { binaryStatus, requireBinary } from "./lib/probe.js";
import { HINTS, LocalBackendError, artifactOut, withWorkDir } from "./lib/util.js";

const TOOL_TIMEOUT_MS = 10 * 60_000;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
/** Fewer non-blank characters per page than this means "no text layer". */
const MIN_CHARS_PER_PAGE = 16;

const unsupported = (what: string) =>
  new CapabilityError(`The local backends cannot do ${what}.`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });

export type DocType =
  | "pdf"
  | "docx"
  | "doc"
  | "odt"
  | "rtf"
  | "html"
  | "md"
  | "txt"
  | "epub"
  | "pptx"
  | "ppt"
  | "odp"
  | "xlsx"
  | "xls"
  | "ods"
  | "csv"
  | "png"
  | "jpg"
  | "webp"
  | "gif"
  | "tiff"
  | "bmp";

const MIME_TYPE: Record<string, DocType> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
  "application/epub+zip": "epub",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "text/csv": "csv",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
};

const OUT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  html: "text/html",
  md: "text/markdown",
  txt: "text/plain",
  epub: "application/epub+zip",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};

const IMAGE_TYPES = new Set<DocType>(["png", "jpg", "webp", "gif", "tiff", "bmp"]);
const EXT_TYPE = new Set<string>(Object.values(MIME_TYPE));

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * What kind of document an artifact is. The library stores HTML as text/plain
 * and office files as application/octet-stream, keeping the declared type in
 * meta.declaredMime, so that is read first, then the stored type, then a file
 * name in meta.
 */
export function docTypeOf(record: {
  mime: string;
  meta: Record<string, unknown> | null;
}): DocType | null {
  const declared = str(record.meta?.declaredMime);
  for (const m of [declared, record.mime]) {
    const t = m ? MIME_TYPE[(m.split(";")[0] ?? "").trim().toLowerCase()] : undefined;
    if (t && !(t === "txt" && m === record.mime && declared === undefined && nameType(record)))
      return t;
  }
  return nameType(record);
}

function nameType(record: { meta: Record<string, unknown> | null }): DocType | null {
  for (const key of ["filename", "name", "file_name", "format"]) {
    const v = str(record.meta?.[key]);
    if (!v) continue;
    const ext = (v.includes(".") ? v.slice(v.lastIndexOf(".") + 1) : v).toLowerCase();
    const t =
      ext === "jpeg"
        ? "jpg"
        : ext === "htm"
          ? "html"
          : ext === "markdown"
            ? "md"
            : ext === "tif"
              ? "tiff"
              : ext;
    if (EXT_TYPE.has(t)) return t as DocType;
  }
  return null;
}

/** Copy the artifact into the work dir as `in.<ext>`. */
export async function stageDocument(ctx: PackContext, work: string, id: string) {
  const problem = artifactIdProblem(id);
  if (problem) throw new Error(problem);
  const record = await ctx.library.get(id);
  if (!record) throw new Error(`artifact not found: ${id}`);
  const type = docTypeOf(record);
  if (!type) {
    throw unsupported(
      `documents of type ${String(record.meta?.declaredMime ?? record.mime)} (artifact ${id})`,
    );
  }
  const path = join(work, `in.${type}`);
  const copy = await ctx.library.materialize(id, { dir: relative(ctx.pack.dataDir, work) });
  await rename(copy.path, path);
  return { path, type, record };
}

function failed(binary: string, r: { exitCode: number; stderr: string; stdout: string }): Error {
  return new Error(
    `${binary} failed (exit ${r.exitCode}): ${stderrTail(r.stderr) || stderrTail(r.stdout) || "no output"}`,
  );
}

// ---------------------------------------------------------------------------
// document.parse
// ---------------------------------------------------------------------------

const TESSERACT_LANG: Record<string, string> = {
  en: "eng",
  de: "deu",
  fr: "fra",
  es: "spa",
  it: "ita",
  pt: "por",
  nl: "nld",
  ru: "rus",
  uk: "ukr",
  pl: "pol",
  cs: "ces",
  sv: "swe",
  da: "dan",
  no: "nor",
  nb: "nor",
  fi: "fin",
  tr: "tur",
  el: "ell",
  he: "heb",
  ar: "ara",
  fa: "fas",
  hi: "hin",
  ja: "jpn",
  ko: "kor",
  zh: "chi_sim",
  vi: "vie",
  th: "tha",
  id: "ind",
  ro: "ron",
  hu: "hun",
  bg: "bul",
};

/**
 * A language value exactly as it may reach a command line: letters, digits,
 * "_" and "+" only, at most 64 characters. Checked before any argv is built
 * (the capability schema allows a similar shape, this is the hard gate).
 */
// Parts joined by "+"; each starts with a letter or digit, so no part can be
// read as an option. "-" is allowed inside a part for region tags (pt-BR).
export const LANGUAGE_VALUE =
  /^(?=.{1,64}$)[A-Za-z0-9][A-Za-z0-9_-]*(\+[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

/**
 * `en+de` -> `eng+deu`; three-letter and `chi_sim` style codes pass through.
 * Anything outside LANGUAGE_VALUE is refused before it can reach tesseract /
 * ocrmypdf argv.
 */
export function tesseractLanguages(language: string | undefined): string {
  if (!language) return "eng";
  if (!LANGUAGE_VALUE.test(language)) {
    throw unsupported(
      `OCR in the language ${language.slice(0, 64)}: codes of letters, digits, "_" and "-" joined by "+", max 64 characters`,
    );
  }
  return language
    .split("+")
    .map((part) => {
      const code = part.toLowerCase();
      // A region tag (pt-BR) maps by its language: Tesseract has no regions.
      const base = code.split("-")[0] ?? code;
      if (TESSERACT_LANG[base]) return TESSERACT_LANG[base];
      if (/^[a-z0-9]{2,8}(_[a-z0-9]{2,8})?$/.test(code)) return code;
      throw unsupported(`OCR in the language ${part}`);
    })
    .join("+");
}

export interface ParseInput {
  artifact_id: string;
  format?: "markdown" | "text";
  language?: string;
}

export interface ParseResult {
  text: string;
  format: "markdown" | "text";
  pages?: number;
  model: string;
}

/** pdftotext output: pages end in form feeds. */
export function splitPages(text: string): string[] {
  const pages = text.split("\f");
  if (pages.length > 1 && (pages[pages.length - 1] ?? "").trim() === "") pages.pop();
  return pages;
}

export function hasTextLayer(text: string): boolean {
  const pages = splitPages(text);
  const chars = text.replace(/\s+/g, "").length;
  return chars >= MIN_CHARS_PER_PAGE * Math.max(1, pages.length) * 0.5 && chars > 0;
}

async function pdfText(ctx: PackContext, work: string, pdf: string): Promise<string> {
  assertSafePath(pdf);
  const r = await run(ctx, "pdftotext", ["-layout", "-enc", "UTF-8", pdf, "-"], {
    cwd: work,
    timeoutMs: TOOL_TIMEOUT_MS,
    hint: HINTS.pdftotext,
    maxOutputBytes: MAX_TEXT_BYTES,
  });
  if (r.exitCode !== 0) throw failed("pdftotext", r);
  return r.stdout;
}

async function parsePdf(
  ctx: PackContext,
  work: string,
  pdf: string,
  language: string | undefined,
): Promise<ParseResult> {
  await requireBinary(ctx, "pdftotext", HINTS.pdftotext, ["-v"]);
  ctx.progress?.(0.2, "extracting text");
  let text = await pdfText(ctx, work, pdf);
  let model = "pdftotext";
  if (!hasTextLayer(text)) {
    const ocr = await binaryStatus(ctx, "ocrmypdf", HINTS.ocrmypdf);
    if (!ocr.available) {
      throw new LocalBackendError(
        `This PDF has no text layer and ocrmypdf is not installed. ${HINTS.ocrmypdf}`,
      );
    }
    ctx.progress?.(0.3, "running OCR");
    const out = join(work, "ocr.pdf");
    assertSafePath(out);
    const r = await run(
      ctx,
      "ocrmypdf",
      ["--skip-text", "--quiet", "-l", tesseractLanguages(language), pdf, out],
      { cwd: work, timeoutMs: 30 * 60_000, hint: HINTS.ocrmypdf },
    );
    if (r.exitCode !== 0) throw failed("ocrmypdf", r);
    text = await pdfText(ctx, work, out);
    model = "ocrmypdf+pdftotext";
  }
  const pages = splitPages(text);
  return {
    text: pages.map((p) => p.replace(/[ \t]+$/gm, "").trim()).join("\n\n"),
    format: "text",
    pages: pages.length,
    model,
  };
}

async function parseImage(
  ctx: PackContext,
  work: string,
  image: string,
  language: string | undefined,
): Promise<ParseResult> {
  const langs = tesseractLanguages(language);
  await requireBinary(ctx, "tesseract", HINTS.tesseract);
  assertSafePath(image);
  ctx.progress?.(0.2, "running OCR");
  const r = await run(ctx, "tesseract", [image, "stdout", "-l", langs], {
    cwd: work,
    timeoutMs: TOOL_TIMEOUT_MS,
    hint: HINTS.tesseract,
    maxOutputBytes: MAX_TEXT_BYTES,
  });
  if (r.exitCode !== 0) {
    if (/Failed loading language|Error opening data file/i.test(r.stderr)) {
      throw unsupported(`OCR in ${langs}: that Tesseract language pack is not installed`);
    }
    throw failed("tesseract", r);
  }
  return { text: r.stdout.replace(/\f/g, "").trim(), format: "text", pages: 1, model: "tesseract" };
}

const PANDOC_READS = new Set<DocType>(["docx", "odt", "rtf", "html", "md", "txt", "epub", "csv"]);
const PANDOC_FROM: Partial<Record<DocType, string>> = {
  md: "markdown",
  txt: "commonmark",
  html: "html",
  docx: "docx",
  odt: "odt",
  rtf: "rtf",
  epub: "epub",
  csv: "csv",
};

async function parseWithPandoc(
  ctx: PackContext,
  work: string,
  path: string,
  type: DocType,
  format: "markdown" | "text",
): Promise<ParseResult> {
  await requireBinary(ctx, "pandoc", HINTS.pandoc);
  assertSafePath(path);
  ctx.progress?.(0.2, "converting with pandoc");
  const r = await run(
    ctx,
    "pandoc",
    [
      "--sandbox",
      "-f",
      PANDOC_FROM[type] ?? "markdown",
      "-t",
      format === "markdown" ? "gfm" : "plain",
      "--wrap=none",
      path,
    ],
    { cwd: work, timeoutMs: TOOL_TIMEOUT_MS, hint: HINTS.pandoc, maxOutputBytes: MAX_TEXT_BYTES },
  );
  if (r.exitCode !== 0) throw failed("pandoc", r);
  return { text: r.stdout.trim(), format, model: "pandoc" };
}

export async function parseDocument(ctx: PackContext, input: ParseInput): Promise<ParseResult> {
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "reading document");
    const doc = await stageDocument(ctx, work, input.artifact_id);
    if (doc.type === "pdf") return parsePdf(ctx, work, doc.path, input.language);
    if (IMAGE_TYPES.has(doc.type)) return parseImage(ctx, work, doc.path, input.language);
    if (doc.type === "txt" || doc.type === "md" || doc.type === "csv") {
      const text = (await readFile(doc.path, "utf8")).replace(/^\uFEFF/, "").trim();
      if (doc.type !== "md" || input.format !== "text")
        return { text, format: doc.type === "md" ? "markdown" : "text", model: "plain" };
    }
    if (PANDOC_READS.has(doc.type)) {
      return parseWithPandoc(ctx, work, doc.path, doc.type, input.format ?? "markdown");
    }
    // Office formats pandoc cannot read: LibreOffice to text.
    const out = await convertWithSoffice(ctx, work, doc.path, doc.type, "txt");
    return { text: (await readFile(out, "utf8")).trim(), format: "text", model: "soffice" };
  });
}

// ---------------------------------------------------------------------------
// document.convert
// ---------------------------------------------------------------------------

export type DocTarget =
  | "pdf"
  | "docx"
  | "odt"
  | "rtf"
  | "html"
  | "md"
  | "txt"
  | "epub"
  | "pptx"
  | "xlsx"
  | "csv";

const PANDOC_WRITES: Partial<Record<DocTarget, string>> = {
  docx: "docx",
  odt: "odt",
  rtf: "rtf",
  html: "html5",
  md: "gfm",
  txt: "plain",
  epub: "epub3",
  pptx: "pptx",
};

const WRITER = new Set<DocType>(["docx", "doc", "odt", "rtf", "html", "md", "txt", "epub"]);
const SHEET = new Set<DocType>(["xlsx", "xls", "ods", "csv"]);
const SLIDES = new Set<DocType>(["pptx", "ppt", "odp"]);

/** LibreOffice export filters for targets whose plain extension is ambiguous. */
const SOFFICE_FILTER: Partial<Record<DocTarget, string>> = {
  txt: "txt:Text (encoded):UTF8",
  csv: "csv:Text - txt - csv (StarCalc):44,34,76,1",
  html: "html:XHTML Writer File:UTF8",
};

// ---------------------------------------------------------------------------
// LibreOffice hardening (untrusted documents)
// ---------------------------------------------------------------------------

/**
 * The seeded content of the throwaway profile's user/registrymodifications.xcu.
 * soffice is run on documents from the artifact library, which can be hostile:
 * the profile turns off everything a document can trigger on load —
 *   - macros (security level "very high" plus execution disabled outright,
 *     no Python runtime, no active content / OLE / DDE),
 *   - linked content: never update links, block untrusted referer links,
 *   - all network: a manual proxy pointing at 127.0.0.1:9 (the discard port,
 *     nothing listens there), so http(s)/ftp fetches — SSRF to localhost or
 *     the cloud metadata endpoint, WEBSERVICE() formulas, remote images —
 *     fail instead of bypassing the daemon's own SSRF guard. file: URLs are
 *     not proxied, so the HTML path additionally strips them (see
 *     sanitizeHtmlRefs).
 * Paths verified against LibreOffice's officecfg schema
 * (org.openoffice.Office.Common/Security/Scripting, the per-app
 * Content/Update/Link, org.openoffice.Inet/Settings).
 */
export const LO_PROFILE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisablePythonRuntime" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
 <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Office.Impress/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetProxyType" oor:op="fuse"><value>2</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPProxyName" oor:op="fuse"><value>127.0.0.1</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPProxyPort" oor:op="fuse"><value>9</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPSProxyName" oor:op="fuse"><value>127.0.0.1</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetHTTPSProxyPort" oor:op="fuse"><value>9</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetFTPProxyName" oor:op="fuse"><value>127.0.0.1</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetFTPProxyPort" oor:op="fuse"><value>9</value></prop></item>
 <item oor:path="/org.openoffice.Inet/Settings"><prop oor:name="ooInetNoProxyList" oor:op="fuse"><value></value></prop></item>
</oor:items>
`;

/** Seed the throwaway LibreOffice profile with the hardened settings. */
export async function writeLoProfile(profileDir: string): Promise<void> {
  const user = join(profileDir, "user");
  await mkdir(user, { recursive: true });
  await writeFile(join(user, "registrymodifications.xcu"), LO_PROFILE_XCU, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// HTML reference sanitising (html -> pdf and friends go through soffice,
// which resolves src/href/url() references; the profile's dead proxy blocks
// remote fetches, this also removes file:, absolute and relative paths)
// ---------------------------------------------------------------------------

/**
 * A URL is kept only when it is a fragment or inline data. Relative URLs are
 * dropped too: soffice resolves them against the input's folder, so
 * "/etc/passwd" or "../../x" would read a local file, and the uploaded
 * document is the only file in that folder anyway. Anything encoded (HTML
 * entities, CSS escapes) does not start with "data:" or "#" and is dropped.
 */
export function safeHtmlUrl(u: string): boolean {
  const t = u.trim();
  return t === "" || t.startsWith("#") || t.slice(0, 5).toLowerCase() === "data:";
}

const ATTR_URL =
  /\b(src|srcset|href|data|action|formaction|poster|background|lowsrc|dynsrc|longdesc|codebase|archive|classid|usemap|cite|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * Neutralise every remote or local-file reference in an HTML document:
 * URL attributes that are not a fragment or data: become "#", a
 * <base> tag (which would make relative URLs remote) and meta refresh are
 * dropped, and url()/@import in CSS only keep data: URLs.
 * Best-effort on untrusted markup, on top of the profile's dead proxy.
 */
export function sanitizeHtmlRefs(html: string): string {
  let out = html.replace(ATTR_URL, (m, attr: string, dq?: string, sq?: string, bare?: string) => {
    const raw = (dq ?? sq ?? bare ?? "").trim();
    if (safeHtmlUrl(raw)) return m;
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
    return `${attr}=${q}#${q}`;
  });
  // A <base> tag redirects every relative URL: remove it entirely.
  out = out.replace(/<base\b[^>]*>/gi, "");
  // <meta http-equiv="refresh" content="0;url=..."> navigates on load.
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  // CSS url() and @import.
  out = out.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi,
    (m, dq?: string, sq?: string, bare?: string) => {
      const raw = (dq ?? sq ?? bare ?? "").trim();
      return safeHtmlUrl(raw) ? m : "url(#)";
    },
  );
  out = out.replace(
    /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))[^;]*;?/gi,
    (m, dq?: string, sq?: string, bare?: string) => {
      const raw = (dq ?? sq ?? bare ?? "").trim();
      return safeHtmlUrl(raw) ? m : "";
    },
  );
  return out;
}

/** Can LibreOffice convert this source type to this target? */
export function sofficeCan(from: DocType, to: DocTarget): boolean {
  if (from === "pdf" || IMAGE_TYPES.has(from) || from === "epub" || from === "md") return false;
  if (to === "pdf") return true;
  if (SHEET.has(from)) return to === "xlsx" || to === "csv" || to === "html";
  if (SLIDES.has(from)) return to === "pptx";
  return to === "docx" || to === "odt" || to === "rtf" || to === "html" || to === "txt";
}

export function pandocCan(from: DocType, to: DocTarget): boolean {
  return PANDOC_READS.has(from) && PANDOC_WRITES[to] !== undefined;
}

/** Which tools may convert, in the order to try them. */
export function convertPlan(from: DocType, to: DocTarget): Array<"pandoc" | "soffice"> {
  const plan: Array<"pandoc" | "soffice"> = [];
  // LibreOffice keeps office layout better; pandoc is better for markup formats.
  const officeFirst = WRITER.has(from) && from !== "md" && from !== "txt" && from !== "html";
  if (officeFirst && sofficeCan(from, to)) plan.push("soffice");
  if (pandocCan(from, to)) plan.push("pandoc");
  if (!officeFirst && sofficeCan(from, to)) plan.push("soffice");
  return plan;
}

export async function convertWithSoffice(
  ctx: PackContext,
  work: string,
  path: string,
  from: DocType,
  to: DocTarget,
): Promise<string> {
  await requireBinary(ctx, "soffice", HINTS.soffice);
  assertSafePath(path);
  const outDir = join(work, "out");
  const profileDir = join(work, "lo-profile");
  // Seed the throwaway profile BEFORE soffice starts, so the run reads the
  // hardened settings (macros off, links never updated, dead proxy).
  await writeLoProfile(profileDir);
  const profile = pathToFileURL(profileDir).href;
  ctx.progress?.(0.2, "converting with LibreOffice");
  const r = await run(
    ctx,
    "soffice",
    [
      `-env:UserInstallation=${profile}`,
      "--headless",
      "--norestore",
      "--nologo",
      "--convert-to",
      SOFFICE_FILTER[to] ?? to,
      "--outdir",
      outDir,
      path,
    ],
    { cwd: work, timeoutMs: TOOL_TIMEOUT_MS, hint: HINTS.soffice },
  );
  if (r.exitCode !== 0) throw failed("soffice", r);
  const files = (await readdir(outDir).catch(() => [] as string[])).filter((f) =>
    f.toLowerCase().endsWith(`.${to}`),
  );
  const file = files[0];
  if (!file) {
    throw new Error(
      `LibreOffice did not convert ${from} to ${to}${r.stderr || r.stdout ? `: ${stderrTail(r.stderr || r.stdout)}` : ""}`,
    );
  }
  return join(outDir, file);
}

async function convertWithPandoc(
  ctx: PackContext,
  work: string,
  path: string,
  from: DocType,
  to: DocTarget,
): Promise<string> {
  await requireBinary(ctx, "pandoc", HINTS.pandoc);
  const out = join(work, `out.${to}`);
  assertSafePath(path);
  assertSafePath(out);
  ctx.progress?.(0.2, "converting with pandoc");
  const r = await run(
    ctx,
    "pandoc",
    [
      "--sandbox",
      "-f",
      PANDOC_FROM[from] ?? "markdown",
      "-t",
      PANDOC_WRITES[to] as string,
      ...(to === "html" || to === "epub" ? ["-s", "--metadata", "title=Document"] : []),
      "-o",
      out,
      path,
    ],
    { cwd: work, timeoutMs: TOOL_TIMEOUT_MS, hint: HINTS.pandoc },
  );
  if (r.exitCode !== 0) throw failed("pandoc", r);
  return out;
}

export async function convertDocument(
  ctx: PackContext,
  input: { artifact_id: string; to: DocTarget },
  tool: string,
) {
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "reading document");
    const doc = await stageDocument(ctx, work, input.artifact_id);
    const plan = convertPlan(doc.type, input.to);
    if (plan.length === 0) throw unsupported(`converting ${doc.type} to ${input.to}`);
    // Skip a tool that is not installed when another one can do the job.
    let usable = plan;
    if (plan.length > 1) {
      const installed = await Promise.all(
        plan.map(async (t) => (await binaryStatus(ctx, t, HINTS[t])).available),
      );
      usable = plan.filter((_, i) => installed[i]);
      if (usable.length === 0) usable = plan.slice(0, 1);
    }
    const toolUsed = usable[0] as "pandoc" | "soffice";
    // HTML through LibreOffice resolves its references: strip remote and
    // file: ones first (the profile's dead proxy is the second layer).
    let source = doc.path;
    if (doc.type === "html" && toolUsed === "soffice") {
      const sanitized = join(work, "in-sanitized.html");
      await writeFile(sanitized, sanitizeHtmlRefs(await readFile(doc.path, "utf8")), {
        mode: 0o600,
      });
      source = sanitized;
    }
    const out =
      toolUsed === "pandoc"
        ? await convertWithPandoc(ctx, work, source, doc.type, input.to)
        : await convertWithSoffice(ctx, work, source, doc.type, input.to);
    const size = (await stat(out).catch(() => null))?.size ?? 0;
    if (size === 0) throw new Error(`${toolUsed} produced an empty file`);
    ctx.progress?.(0.9, "saving document");
    const kind: ArtifactKind =
      input.to === "pdf" ? "pdf" : input.to === "csv" ? "data" : "document";
    const ref = await ctx.library.importFile({
      kind,
      mime: OUT_MIME[input.to] ?? "application/octet-stream",
      sourcePath: out,
      tool,
      meta: { source: input.artifact_id, from: doc.type, format: input.to, converter: toolUsed },
    });
    return { artifacts: [artifactOut(ref)], model: toolUsed };
  });
}
