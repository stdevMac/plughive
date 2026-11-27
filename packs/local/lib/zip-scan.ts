// packs/local/lib/zip-scan.ts
//
// ZIP-based documents (docx, xlsx, pptx, odt, odp, ods, epub — and any file
// whose bytes are a ZIP, whatever it is called) are containers that pandoc
// and LibreOffice open entry by entry, so the container is checked before
// any tool runs on it:
//   - the end record must be unambiguous (its comment reaches the end of the
//     file, exactly one such record) and the central directory must sit
//     right before it, parse completely and list every local entry, with no
//     gaps or overlaps, so every reader sees the same entries as this scan;
//   - the central directory is read without decompressing anything, which
//     bounds zip bombs by the sizes the file itself declares (and the XML
//     scan below inflates with a hard cap, so a lying header is caught too),
//     and refuses entry names that would escape the archive (zip slip),
//     symlink entries and encrypted entries;
//   - every XML-like part (by name, or by its first bytes: svg, xhtml,
//     manifest, rdf, anything starting with "<" or a UTF-16 mark) is decoded
//     the way an XML parser would (UTF-8 or UTF-16; anything else is refused)
//     and searched for entity declarations, DOCTYPEs that load a DTD, and
//     file:// / UNC / out-of-package references. The hardened LibreOffice
//     profile routes http(s)/ftp through a dead proxy, but file: is not
//     proxied, so an external DTD or an external relationship pointing at a
//     local file must never reach the converter;
//   - Word fields that load files or other programs' data (INCLUDEPICTURE,
//     INCLUDETEXT, INCLUDE, LINK, IMPORT, DDE, DDEAUTO, DATABASE), in
//     fldSimple or in complex fields whose instruction is split across
//     runs, are refused in every part, as are HYPERLINK fields to local
//     files and ODF DDE links;
//   - a package nested in a part (an embedded .xlsx, a .zip attachment) is
//     scanned with the same rules and the same limits, up to two levels
//     deep; deeper, unreadable or OLE-wrapped packages are refused.
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { gunzipSync, inflateRawSync, constants as zlibConstants } from "node:zlib";

/** Bounds for the container, from the declared (central directory) sizes. */
export const MAX_ZIP_ENTRIES = 20_000;
export const MAX_ZIP_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024;
export const MAX_ZIP_ENTRY_RATIO = 200;
/** Bounds for the XML content scan, from the really inflated bytes. */
const MAX_XML_PART_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_XML_PART_COMPRESSED = 128 * 1024 * 1024;
const MAX_XML_SCAN_TOTAL = 256 * 1024 * 1024;
/** How much of a part is read to decide whether it is XML. */
const SNIFF_COMPRESSED = 4096;
const SNIFF_BYTES = 512;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;

export class ZipScanError extends Error {}

interface Entry {
  name: string;
  method: number;
  flags: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
  /** Filled in when the local header is read. */
  dataStart?: number;
}

function readAt(fd: number, buf: Buffer, offset: number): void {
  let done = 0;
  while (done < buf.length) {
    const n = readSync(fd, buf, done, buf.length - done, offset + done);
    if (n === 0) throw new ZipScanError("the file ends inside a ZIP structure");
    done += n;
  }
}

function openNoFollow(path: string, label: string): number {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new ZipScanError(`${label}: it is a symlink, not a regular file`);
    throw e;
  }
}

function entryNameProblem(name: string): string | null {
  if (name.includes("\0")) return "contains a NUL byte";
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name))
    return "is an absolute path";
  if (name.split(/[/\\]/).includes("..")) return 'contains a ".." segment';
  return null;
}

// ---------------------------------------------------------------------------
// Reference values
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * An attribute value as the converter reads it: XML character and named
 * entities decoded (so `&#x66;ile:` is `file:`), percent-escapes decoded
 * until nothing changes (so `%2e%2e` is `..`, as a URI-to-path mapping
 * reads it), compatibility forms folded (NFKC: full-width letters), then
 * every control, space, separator or format character removed (URL parsers
 * drop tabs and newlines inside a scheme, and some drop wider Unicode
 * spaces too). Lowercased for the prefix checks.
 */
export function refValue(raw: string): string {
  let v = decodeEntities(raw);
  for (let i = 0; i < 8 && /%[0-9a-f]{2}/i.test(v); i++) {
    v = v.replace(/%([0-9a-f]{2})/gi, (_m, h: string) =>
      String.fromCharCode(Number.parseInt(h, 16)),
    );
  }
  return v
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Z}\s]/gu, "")
    .toLowerCase();
}

/** XML character and named entity references decoded, as a parser reads them. */
function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? Number.parseInt(ref.slice(2), 16)
          : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? m;
  });
}

/** Schemes that read local or package-relative resources without the proxy. */
const LOCAL_SCHEMES = /^(?:file|smb|nfs|afp|cifs|jar|vnd\.sun\.star\.(?:pkg|expand|tdoc|zip)):/;

/** Attributes holding a reference (matched on the local name, any prefix). */
const REF_ATTRS = new Set([
  "href",
  "src",
  "target",
  "action",
  "data",
  "poster",
  "base",
  "image-data",
  "background",
  "codebase",
  "archive",
  "classid",
  "usemap",
  "longdesc",
  "full-path",
]);

/** Does a relative path climb above the package root, starting in folder dir? */
function escapesRoot(dir: string, ref: string): boolean {
  let depth = dir === "" ? 0 : dir.split("/").length;
  const path = ref.split(/[?#]/)[0] ?? "";
  for (const seg of path.split(/[/\\]/)) {
    if (seg === "..") {
      depth--;
      if (depth < 0) return true;
    } else if (seg !== "." && seg !== "") depth++;
  }
  return false;
}

/** Why an attribute points outside the package, or null. */
function attrProblem(attr: string, raw: string, partDir: string): string | null {
  const v = refValue(raw);
  const name = attr.toLowerCase();
  const local = name.slice(name.lastIndexOf(":") + 1);
  // Only reference attributes are loaded; others (Excel's <x15ac:absPath
  // url="\\server\..."> records where the file was saved) are not.
  if (!REF_ATTRS.has(local)) return null;
  if (
    v.includes("file:") ||
    v.startsWith("\\\\") ||
    LOCAL_SCHEMES.test(v) ||
    v.startsWith("//") ||
    v.startsWith("\\/") ||
    v.startsWith("/\\")
  )
    return "a file:// or UNC reference";
  if (name === "xml:base") {
    return v === "" || /^https?:\/\//.test(v)
      ? null
      : "an xml:base that moves relative references outside the package";
  }
  // Relationship targets are package paths ("/word/x.xml", "../media/a.png")
  // resolved inside the package; external ones are checked per element.
  if (local === "target") return null;
  if (local === "full-path") {
    return v === "/" || !entryNameProblem(v) ? null : "a manifest path outside the package";
  }
  if (/^[a-z]:/.test(v)) return "an absolute local path";
  // A scheme (two letters or more: one letter is a drive) is not a path.
  if (/^[a-z][a-z0-9+.-]+:/.test(v)) return null;
  if (v.startsWith("/") || v.startsWith("\\")) return "an absolute local path";
  // ODF xlink:href is relative to the document's folder, not the package:
  // any "../" reaches the file system beside it.
  if (name === "xlink:href") {
    return v.split(/[/\\]/).includes("..")
      ? 'a reference outside the document (a ".." segment)'
      : null;
  }
  if (escapesRoot(partDir, v)) return 'a reference outside the document (a ".." segment)';
  return null;
}

// ---------------------------------------------------------------------------
// XML decoding
// ---------------------------------------------------------------------------

/** Does this start of a part look like XML (or markup an XML parser would read)? */
function looksLikeXml(b: Buffer): boolean {
  if (b.length >= 2) {
    const a = b[0];
    const c = b[1];
    if ((a === 0xff && c === 0xfe) || (a === 0xfe && c === 0xff)) return true;
    if ((a === 0x3c && c === 0x00) || (a === 0x00 && c === 0x3c)) return true;
    if (a === 0x00 && c === 0x00 && b[2] === 0x00 && b[3] === 0x3c) return true;
    if (a === 0x4c && c === 0x6f && b[2] === 0xa7 && b[3] === 0x94) return true; // EBCDIC "<?xm"
  }
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return b[i] === 0x3c;
}

const EIGHT_BIT_ENCODINGS =
  /^(?:utf-?8|us-ascii|ascii|iso-?8859-\d+|iso_8859-\d+|latin-?1|windows-125\d|cp125\d)$/;
const XML_DECL_ENCODING = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']\s*([^"'\s]+)\s*["']/i;

/**
 * Decode an XML part as an XML parser would (BOM, then the first bytes, then
 * the declaration). UTF-8, UTF-16 and ASCII-compatible 8-bit encodings are
 * read; UTF-32, EBCDIC and any other declared encoding are refused, since
 * the patterns this scan looks for would not be visible in them.
 */
function decodeXml(buf: Buffer): { text: string } | { problem: string } {
  const b0 = buf[0];
  const b1 = buf[1];
  if (
    (b0 === 0xff && b1 === 0xfe && buf[2] === 0 && buf[3] === 0) ||
    (b0 === 0 && b1 === 0) ||
    (b0 === 0x3c && b1 === 0 && buf[2] === 0 && buf[3] === 0)
  ) {
    return { problem: "UTF-32 text, which the scan does not read" };
  }
  if (b0 === 0x4c && b1 === 0x6f && buf[2] === 0xa7 && buf[3] === 0x94) {
    return { problem: "EBCDIC text, which the scan does not read" };
  }
  let text: string;
  let wide = false;
  if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0x3c && b1 === 0)) {
    if (buf.length % 2 !== 0) return { problem: "truncated UTF-16 text" };
    text = buf.subarray(b0 === 0xff ? 2 : 0).toString("utf16le");
    wide = true;
  } else if ((b0 === 0xfe && b1 === 0xff) || (b0 === 0 && b1 === 0x3c)) {
    if (buf.length % 2 !== 0) return { problem: "truncated UTF-16 text" };
    const swapped = Buffer.from(buf.subarray(b0 === 0xfe ? 2 : 0));
    swapped.swap16();
    text = swapped.toString("utf16le");
    wide = true;
  } else {
    text = buf.toString("utf8");
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const decl = text.slice(0, 512).match(XML_DECL_ENCODING);
  if (decl) {
    const enc = (decl[1] as string).toLowerCase();
    if (wide ? !/^(?:utf-?16(?:le|be)?|ucs-?2)$/.test(enc) : !EIGHT_BIT_ENCODINGS.test(enc)) {
      return { problem: `text declared as ${JSON.stringify(enc)}, which the scan does not read` };
    }
  }
  if (text.includes("\u0000")) {
    return { problem: "NUL characters (an encoding the scan does not read)" };
  }
  return { text };
}

// ---------------------------------------------------------------------------
// XML scan: a small tokenizer, so a quoted ">" or a comment cannot hide an
// attribute from the checks
// ---------------------------------------------------------------------------

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

interface XmlScanContext {
  /** Directory of the part inside the package ("" at the root). */
  dir: string;
  /** Base names of every entry in the package, lowercased. */
  entryBases: ReadonlySet<string>;
  fail: (what: string) => never;
  /** Word complex fields still open in this part (fldChar begin seen). */
  fields?: Array<{ instr: string; inCode: boolean }>;
}

// ---------------------------------------------------------------------------
// Word field codes and ODF DDE links
// ---------------------------------------------------------------------------

/**
 * Word fields that load a file or another program's data when the document
 * is opened or its fields are updated. They are refused outright: the
 * target is a path (or a DDE topic) that the field syntax lets the author
 * spell in many ways, so a target check would be easy to get wrong.
 */
const FETCHING_FIELDS = new Set([
  "INCLUDEPICTURE",
  "INCLUDETEXT",
  "INCLUDE",
  "LINK",
  "IMPORT",
  "DDE",
  "DDEAUTO",
  "DATABASE",
]);

/** ODF elements that hold a DDE link to another program or file. */
const ODF_DDE = new Set(["dde-connection-decl", "dde-source", "dde-link"]);

/** The arguments of a field instruction: quoted strings and bare words. */
function fieldArgs(rest: string): string[] {
  const out: string[] = [];
  for (const m of rest.matchAll(/"([^"]*)"?|(\S+)/g)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/** Why a Word field instruction ("INCLUDEPICTURE \"x\" \\d") is refused, or null. */
function fieldProblem(instr: string): string | null {
  // Format characters (zero-width joiners and the like) are dropped, so they
  // cannot split the field name; any other space or control separates.
  const v = instr.normalize("NFKC").replace(/\p{Cf}/gu, "");
  const m = v.match(/^[\s\p{Z}\p{Cc}]*([\p{L}\p{N}]+)([\s\S]*)$/u);
  if (!m) return null;
  const kind = (m[1] as string).toUpperCase();
  if (FETCHING_FIELDS.has(kind)) {
    return `a Word ${kind} field, which loads a file or another program's data into the document (INCLUDEPICTURE, INCLUDETEXT, INCLUDE, LINK, IMPORT, DDE, DDEAUTO and DATABASE fields are refused)`;
  }
  if (kind === "HYPERLINK") {
    for (const arg of fieldArgs(m[2] as string)) {
      const t = refValue(arg);
      if (
        t.includes("file:") ||
        LOCAL_SCHEMES.test(t) ||
        t.startsWith("\\\\") ||
        t.startsWith("//") ||
        /^[a-z]:[\\/]/.test(t)
      ) {
        return "a Word HYPERLINK field to a local file or UNC path";
      }
    }
  }
  return null;
}

function checkField(ctx: XmlScanContext, instr: string): void {
  const what = fieldProblem(instr);
  if (what) ctx.fail(what);
}

/** fldSimple, fldChar and ODF DDE elements; instrText is read by the tokenizer. */
function checkFieldTag(ctx: XmlScanContext, local: string, attrs: Array<[string, string]>): void {
  if (ODF_DDE.has(local)) {
    ctx.fail("an ODF DDE link (a live link to another program or file), which is refused");
  }
  const attr = (n: string) => {
    for (const [k, v] of attrs) if (k.slice(k.lastIndexOf(":") + 1) === n) return v;
    return undefined;
  };
  if (local === "fldSimple") {
    checkField(ctx, decodeEntities(attr("instr") ?? ""));
    return;
  }
  if (local !== "fldChar") return;
  ctx.fields ??= [];
  const stack = ctx.fields;
  const type = refValue(attr("fldCharType") ?? "");
  if (type === "begin") {
    stack.push({ instr: "", inCode: true });
  } else if (type === "separate") {
    const top = stack[stack.length - 1];
    if (top?.inCode) {
      top.inCode = false;
      checkField(ctx, top.instr);
    }
  } else if (type === "end") {
    const top = stack.pop();
    if (top?.inCode) checkField(ctx, top.instr);
  }
}

/** Add instrText to the innermost open field (a split instruction is joined). */
function addInstrText(ctx: XmlScanContext, text: string): void {
  const top = ctx.fields?.[ctx.fields.length - 1];
  if (top) top.instr += text;
  else checkField(ctx, text);
}

/**
 * The character data of an element, read at `start` and running to its
 * first child or end tag: entities decoded, CDATA sections unwrapped, comments skipped.
 */
function readCharData(text: string, start: number): { value: string; next: number } {
  let value = "";
  let i = start;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    const stop = lt < 0 ? n : lt;
    value += decodeEntities(text.slice(i, stop));
    i = stop;
    if (lt < 0) break;
    if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt + 9);
      value += text.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
    } else break;
  }
  return { value, next: i };
}

function checkAttrs(ctx: XmlScanContext, tag: string, attrs: Array<[string, string]>): void {
  for (const [name, value] of attrs) {
    const what = attrProblem(name, value, ctx.dir);
    if (what) ctx.fail(what);
  }
  if (tag.slice(tag.lastIndexOf(":") + 1) === "Relationship") {
    const get = (n: string) => attrs.find(([k]) => k === n)?.[1] ?? "";
    if (refValue(get("TargetMode")) === "external") {
      const target = get("Target");
      // http(s) goes to the dead proxy; mailto: and tel: open nothing.
      if (!/^(?:https?:\/\/|mailto:|tel:)/.test(refValue(target))) {
        ctx.fail(
          `an external relationship to ${JSON.stringify(target.slice(0, 120))}, which is not http(s), mailto: or tel: (file:// and UNC targets are refused)`,
        );
      }
    }
  }
}

/** Attributes of a tag body (or a processing instruction's pseudo-attributes). */
function readAttrs(text: string, start: number, stop: (j: number) => boolean) {
  const attrs: Array<[string, string]> = [];
  let j = start;
  const n = text.length;
  while (j < n && !stop(j)) {
    const c = text[j];
    if (isSpace(c) || c === "/") {
      j++;
      continue;
    }
    const ns = j;
    j++;
    while (j < n && !isSpace(text[j]) && text[j] !== "/" && text[j] !== "=" && !stop(j)) j++;
    const name = text.slice(ns, j);
    while (j < n && isSpace(text[j])) j++;
    let value = "";
    if (text[j] === "=") {
      j++;
      while (j < n && isSpace(text[j])) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const end = text.indexOf(q, j + 1);
        value = text.slice(j + 1, end < 0 ? n : end);
        j = end < 0 ? n : end + 1;
      } else {
        const vs = j;
        while (j < n && !isSpace(text[j]) && !stop(j)) j++;
        value = text.slice(vs, j);
      }
    }
    attrs.push([name, value]);
  }
  return { attrs, end: j };
}

function readDoctype(ctx: XmlScanContext, text: string, start: number): number {
  const n = text.length;
  let j = start;
  const ws = () => {
    while (j < n && isSpace(text[j])) j++;
  };
  const literal = (): string => {
    const q = text[j];
    if (q !== '"' && q !== "'") return ctx.fail("a malformed DOCTYPE");
    const end = text.indexOf(q, j + 1);
    if (end < 0) return ctx.fail("a malformed DOCTYPE");
    const v = text.slice(j + 1, end);
    j = end + 1;
    return v;
  };
  ws();
  while (j < n && !isSpace(text[j]) && text[j] !== "[" && text[j] !== ">") j++;
  ws();
  let systemId: string | null = null;
  const kw = text.slice(j, j + 6).toUpperCase();
  if (kw === "SYSTEM") {
    j += 6;
    ws();
    systemId = literal();
  } else if (kw === "PUBLIC") {
    j += 6;
    ws();
    literal();
    ws();
    if (text[j] === '"' || text[j] === "'") systemId = literal();
  }
  ws();
  if (text[j] === "[") ctx.fail("a DOCTYPE with an internal subset (entity declarations)");
  if (text[j] !== ">") ctx.fail("a malformed DOCTYPE");
  if (systemId !== null) {
    const v = refValue(systemId);
    // A DTD named by URL goes to the dead proxy; a bare file name that is
    // not in the package (old OpenOffice "Manifest.dtd") loads nothing.
    // Anything else (file:, a path, a DTD shipped inside the package) could
    // define entities, so it is refused.
    const bare = /^[a-z0-9._-]+$/.test(v) && v !== "." && v !== "..";
    if (!(/^https?:\/\//.test(v) || (bare && !ctx.entryBases.has(v)))) {
      ctx.fail(`a DOCTYPE that loads the DTD ${JSON.stringify(systemId.slice(0, 120))}`);
    }
  }
  return j + 1;
}

function scanXmlText(ctx: XmlScanContext, text: string): void {
  if (/<!\s*ENTITY/i.test(text)) {
    ctx.fail("an XML entity declaration (external entity / entity expansion)");
  }
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt + 9);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const e = text.indexOf("?>", lt + 2);
      const end = e < 0 ? n : e;
      let t = lt + 2;
      while (t < end && !isSpace(text[t])) t++;
      // <?xml-stylesheet href="file://..."?> and similar.
      checkAttrs(ctx, "", readAttrs(text, t, (j) => j >= end).attrs);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (text.slice(lt, lt + 9).toLowerCase() === "<!doctype") {
      i = readDoctype(ctx, text, lt + 9);
      continue;
    }
    if (text[lt + 1] === "!") ctx.fail("a markup declaration outside a DOCTYPE");
    if (text[lt + 1] === "/") {
      const e = text.indexOf(">", lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !isSpace(text[j]) && text[j] !== "/" && text[j] !== ">") j++;
    const tag = text.slice(lt + 1, j);
    const { attrs, end } = readAttrs(text, j, (k) => text[k] === ">");
    checkAttrs(ctx, tag, attrs);
    const local = tag.slice(tag.lastIndexOf(":") + 1);
    checkFieldTag(ctx, local, attrs);
    i = end + 1;
    if ((local === "instrText" || local === "delInstrText") && text[end - 1] !== "/") {
      const { value, next } = readCharData(text, i);
      addInstrText(ctx, value);
      i = next;
    }
  }
  // Fields left open at the end of the part are checked as they stand.
  for (const f of ctx.fields ?? []) checkField(ctx, f.instr);
}

/** File names whose parts are always scanned as XML. */
const XML_NAME =
  /\.(?:xml|rels|svg|xhtml|xht|html?|opf|ncx|rdf|vml|xsl|xslt|xsd|smil|kml|plist|xcu|xba|xlb|xdl)$/i;
/** DTDs and entity files have no business inside an office package. */
const DTD_NAME = /\.(?:dtd|ent|mod)$/i;

function scanDecoded(
  data: Buffer,
  dir: string,
  entryBases: ReadonlySet<string>,
  fail: (what: string) => never,
): void {
  const decoded = decodeXml(data);
  if ("problem" in decoded) fail(decoded.problem);
  else scanXmlText({ dir, entryBases, fail }, decoded.text);
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/** Offsets of end records whose comment reaches exactly the end of `tail`. */
function eocdCandidates(tail: Buffer): number[] {
  const found: number[] = [];
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      found.push(i);
    }
  }
  return found;
}

/**
 * True when the file is a ZIP container: it starts with a ZIP signature, or
 * it ends with a well-formed end record (a ZIP with data in front of it).
 * Used to scan a file whatever its declared type or name says.
 */
export function looksLikeZip(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < 4) return false;
    const head = Buffer.alloc(4);
    readAt(fd, head, 0);
    if (head[0] === 0x50 && head[1] === 0x4b && [3, 5, 7].includes(head[2] as number)) return true;
    if (size < 22) return false;
    const window = Math.min(size, 22 + 65_535);
    const tail = Buffer.alloc(window);
    readAt(fd, tail, size - window);
    return eocdCandidates(tail).length > 0;
  } finally {
    closeSync(fd);
  }
}

/** Does this file start like an XML document (any encoding mark)? */
export function looksLikeXmlFile(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(Math.min(fstatSync(fd).size, SNIFF_BYTES));
    readAt(fd, head, 0);
    return head.length > 0 && looksLikeXml(head);
  } finally {
    closeSync(fd);
  }
}

/**
 * Refuse a hostile standalone XML document (flat ODF, Word 2003 XML,
 * SpreadsheetML: LibreOffice recognises them by content whatever the name)
 * before it is opened: the same checks as an XML part of a ZIP.
 */
export function scanXmlDocument(path: string): void {
  const label = `refusing to open ${basename(path)}`;
  const fd = openNoFollow(path, label);
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_XML_PART_UNCOMPRESSED) {
      throw new ZipScanError(
        `${label}: the XML document is over the ${MAX_XML_PART_UNCOMPRESSED} byte scan limit; use a smaller document`,
      );
    }
    const data = Buffer.alloc(size);
    readAt(fd, data, 0);
    scanDecoded(data, "", new Set(), (what) => {
      throw new ZipScanError(
        `${label}: the XML document contains ${what}; external entities and local-file references are refused before the document is opened`,
      );
    });
  } finally {
    closeSync(fd);
  }
}

/** Random access to the bytes of a ZIP: the file itself, or an embedded part. */
interface ZipSource {
  size: number;
  read(buf: Buffer, offset: number): void;
}

function bufferSource(data: Buffer): ZipSource {
  return {
    size: data.length,
    read(buf, offset) {
      if (offset < 0 || offset + buf.length > data.length) {
        throw new ZipScanError("the file ends inside a ZIP structure");
      }
      data.copy(buf, 0, offset, offset + buf.length);
    },
  };
}

/**
 * Limits shared by a document and every package nested inside it, so that
 * nesting cannot multiply the entry, size or scan limits.
 */
interface ScanBudget {
  entries: number;
  uncompressed: number;
  scanned: number;
}

/** How deep packages may nest inside a document (a ZIP in a ZIP in the document). */
export const MAX_ZIP_NESTING = 2;
/** The largest embedded part that is read whole to look for a package in it. */
const MAX_EMBEDDED_PART = 64 * 1024 * 1024;

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PK_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PK_EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Do these bytes hold a ZIP a reader would open: a ZIP signature at the
 * start, or a plausible end record at the end (a ZIP with data in front)?
 * `head` is the start of the part; `tail` is its last bytes, starting at
 * `tailStart` within a part of `size` bytes.
 */
function holdsZip(head: Buffer, tail: Buffer, tailStart: number): boolean {
  if (head[0] === 0x50 && head[1] === 0x4b && [3, 5, 7].includes(head[2] as number)) return true;
  for (const i of eocdCandidates(tail)) {
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    if (cdOffset + cdSize <= tailStart + i) return true;
  }
  return false;
}

/**
 * Refuse a hostile ZIP-based document before pandoc/soffice open it.
 * Throws ZipScanError with an actionable message; returns quietly when the
 * container is within bounds and its XML parts carry no external references.
 * Packages embedded in it (an .xlsx inside a .docx, a .zip attachment) are
 * scanned the same way, up to MAX_ZIP_NESTING deep, within the same limits.
 */
export function scanZipDocument(path: string): void {
  const label = `refusing to open ${basename(path)}`;
  const fd = openNoFollow(path, label);
  try {
    const source: ZipSource = {
      size: fstatSync(fd).size,
      read: (buf, offset) => readAt(fd, buf, offset),
    };
    scanZipSource(source, label, [], { entries: 0, uncompressed: 0, scanned: 0 });
  } finally {
    closeSync(fd);
  }
}

function scanZipSource(
  src: ZipSource,
  baseLabel: string,
  nesting: string[],
  budget: ScanBudget,
): void {
  const label =
    nesting.length === 0
      ? baseLabel
      : `${baseLabel} (in the embedded package ${nesting.map((n) => JSON.stringify(n.slice(0, 120))).join(" / ")})`;
  const corrupt = (what: string): never => {
    throw new ZipScanError(`${label}: ${what}`);
  };
  const size = src.size;
  if (size < 22) throw new ZipScanError(`${label}: too small to be a ZIP container`);
  // End-of-central-directory record: in the last 64 KiB (+ its comment),
  // and its comment must run exactly to the end of the file.
  const window = Math.min(size, 22 + 65_535);
  const tail = Buffer.alloc(window);
  src.read(tail, size - window);
  const found = eocdCandidates(tail);
  if (found.length === 0) corrupt("no ZIP end record, not a ZIP container");
  if (found.length > 1) {
    corrupt(
      "the ZIP has more than one end record (one hidden in the archive comment), so readers would disagree on its entries",
    );
  }
  const eocd = found[0] as number;
  const eocdAbs = size - window + eocd;
  const diskNo = tail.readUInt16LE(eocd + 4);
  const cdDisk = tail.readUInt16LE(eocd + 6);
  const countHere = tail.readUInt16LE(eocd + 8);
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipScanError(
      `${label}: ZIP64 archives are refused (over 4 GiB or over 65535 entries)`,
    );
  }
  if (diskNo !== 0 || cdDisk !== 0 || countHere !== count) {
    corrupt("multi-disk (split) ZIP archives are refused");
  }
  // The central directory must end exactly where the end record starts:
  // anything between them (a ZIP64 locator, hidden data) is refused.
  if (cdOffset + cdSize !== eocdAbs) {
    corrupt("the ZIP central directory is out of bounds (it does not end at the end record)");
  }
  const cd = Buffer.alloc(cdSize);
  src.read(cd, cdOffset);
  const entries: Entry[] = [];
  let p = 0;
  while (p < cd.length) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
      corrupt("the ZIP central directory is corrupt");
    }
    budget.entries++;
    if (budget.entries > MAX_ZIP_ENTRIES) {
      throw new ZipScanError(
        `${label}: over ${MAX_ZIP_ENTRIES} ZIP entries (counting embedded packages); use a smaller document`,
      );
    }
    const madeBy = cd.readUInt8(p + 5);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const compressed = cd.readUInt32LE(p + 20);
    const uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttrs = cd.readUInt32LE(p + 38);
    const localOffset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) {
      corrupt("the ZIP central directory is corrupt (an entry runs past its end)");
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipScanError(`${label}: ZIP64 entries are refused`);
    }
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const shown = JSON.stringify(name.slice(0, 120));
    const nameProblem = entryNameProblem(name);
    if (nameProblem) {
      throw new ZipScanError(`${label}: the ZIP entry ${shown} ${nameProblem} (zip slip refused)`);
    }
    // Made on Unix (3) or macOS (19) with S_IFLNK in the mode bits.
    if ((madeBy === 3 || madeBy === 19) && ((externalAttrs >>> 16) & 0o170000) === 0o120000) {
      throw new ZipScanError(`${label}: the ZIP entry ${shown} is a symlink, which is refused`);
    }
    if (flags & 0x0001) {
      throw new ZipScanError(`${label}: the ZIP entry ${shown} is encrypted and cannot be checked`);
    }
    if (method !== 0 && method !== 8) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${shown} uses compression method ${method}, only stored/deflate are allowed`,
      );
    }
    if (compressed === 0 && uncompressed > 0) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${shown} declares ${uncompressed} bytes from no data (a zip bomb header)`,
      );
    }
    if (method === 0 && compressed !== uncompressed) {
      corrupt(`the stored ZIP entry ${shown} declares different stored and real sizes`);
    }
    if (compressed > 0 && uncompressed / compressed > MAX_ZIP_ENTRY_RATIO) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${shown} expands ${Math.round(uncompressed / compressed)}:1 (over the ${MAX_ZIP_ENTRY_RATIO}:1 limit) — a zip bomb; use a smaller document`,
      );
    }
    budget.uncompressed += uncompressed;
    if (budget.uncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED) {
      throw new ZipScanError(
        `${label}: the ZIP entries declare over ${MAX_ZIP_TOTAL_UNCOMPRESSED} bytes uncompressed in total (counting embedded packages); use a smaller document`,
      );
    }
    entries.push({ name, method, flags, compressed, uncompressed, localOffset });
  }
  if (entries.length !== count) {
    corrupt(
      `the ZIP end record lists ${count} entries but the central directory has ${entries.length}`,
    );
  }

  // Local headers: each must match its central entry, and together they
  // must tile the file up to the central directory with no gap or overlap,
  // so a reader walking local headers sees exactly these entries.
  const local = Buffer.alloc(30);
  let cursor = 0;
  for (const e of [...entries].sort((a, b) => a.localOffset - b.localOffset)) {
    const shown = JSON.stringify(e.name.slice(0, 120));
    if (e.localOffset !== cursor) {
      corrupt(
        `the ZIP has data outside its central directory (before ${shown}), or entries that overlap`,
      );
    }
    if (e.localOffset + 30 > cdOffset) corrupt(`the local header of ${shown} is corrupt`);
    src.read(local, e.localOffset);
    const localNameLen = local.readUInt16LE(26);
    if (
      local.readUInt32LE(0) !== SIG_LOCAL ||
      local.readUInt16LE(8) !== e.method ||
      e.localOffset + 30 + localNameLen > cdOffset
    ) {
      corrupt(`the local header of ${shown} is corrupt`);
    }
    const localName = Buffer.alloc(localNameLen);
    src.read(localName, e.localOffset + 30);
    if (localName.toString("utf8") !== e.name) {
      corrupt(`the local header of ${shown} names a different file than the central directory`);
    }
    e.dataStart = e.localOffset + 30 + localNameLen + local.readUInt16LE(28);
    cursor = e.dataStart + e.compressed;
    if (cursor > cdOffset) corrupt(`the data of ${shown} runs into the central directory`);
    if (e.flags & 0x0008) {
      // Data descriptor after the data: 12 bytes, or 16 with its signature.
      const sig = Buffer.alloc(4);
      if (cursor + 4 <= cdOffset) src.read(sig, cursor);
      cursor += sig.readUInt32LE(0) === SIG_DESCRIPTOR ? 16 : 12;
    }
  }
  if (cursor !== cdOffset) corrupt("the ZIP has data outside its central directory");

  const entryBases = new Set(
    entries.map((e) => e.name.slice(e.name.lastIndexOf("/") + 1).toLowerCase()),
  );
  const inflate = (e: Entry, raw: Buffer, full: boolean): Buffer => {
    if (e.method === 0) return raw;
    try {
      return full
        ? inflateRawSync(raw, { maxOutputLength: e.uncompressed + 1 })
        : inflateRawSync(raw, {
            finishFlush: zlibConstants.Z_SYNC_FLUSH,
            maxOutputLength: 8 * 1024 * 1024,
          });
    } catch {
      throw new ZipScanError(
        `${label}: the ZIP entry ${JSON.stringify(e.name.slice(0, 120))} inflates past its declared size or is corrupt`,
      );
    }
  };
  const readWhole = (e: Entry): Buffer => {
    const raw = Buffer.alloc(e.compressed);
    src.read(raw, e.dataStart as number);
    const data = inflate(e, raw, true);
    if (data.length > e.uncompressed) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${JSON.stringify(e.name.slice(0, 120))} inflates past its declared size`,
      );
    }
    return data;
  };

  // A package inside a part (an embedded .xlsx, a .zip attachment, an ODF
  // document) is opened by the converter too: scan it with the same rules,
  // the same budget and one level deeper. An OLE object (a compound file)
  // with a ZIP inside cannot be read by this scan, so it is refused.
  const checkEmbedded = (e: Entry, data: Buffer): void => {
    const shown = JSON.stringify(e.name.slice(0, 120));
    const tailStart = Math.max(0, data.length - (22 + 65_535));
    if (holdsZip(data.subarray(0, 4), data.subarray(tailStart), tailStart)) {
      if (nesting.length >= MAX_ZIP_NESTING) {
        throw new ZipScanError(
          `${label}: the ZIP entry ${shown} is a package nested more than ${MAX_ZIP_NESTING} deep inside the document, which is refused`,
        );
      }
      scanZipSource(bufferSource(data), baseLabel, [...nesting, e.name], budget);
      return;
    }
    if (
      data.subarray(0, 8).equals(CFB_MAGIC) &&
      (data.includes(PK_LOCAL) || data.includes(PK_EOCD))
    ) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${shown} is an OLE object with a ZIP package inside, which the scan cannot read; embedded OLE packages are refused`,
      );
    }
  };

  // XML parts (by name or by content): inflate with a hard cap and refuse
  // external references. Other parts are looked into for nested packages.
  for (const e of entries) {
    const shown = JSON.stringify(e.name.slice(0, 120));
    if (DTD_NAME.test(e.name)) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${shown} is a DTD, which can declare entities; DTDs inside documents are refused`,
      );
    }
    const dataStart = e.dataStart as number;
    let xml = XML_NAME.test(e.name);
    let gz = false;
    let head: Buffer = Buffer.alloc(0);
    if (!xml && e.compressed > 0) {
      const raw = Buffer.alloc(Math.min(e.compressed, SNIFF_COMPRESSED));
      src.read(raw, dataStart);
      head = inflate(e, raw, e.compressed <= SNIFF_COMPRESSED).subarray(0, SNIFF_BYTES);
      gz = head[0] === 0x1f && head[1] === 0x8b;
      // Nothing out of the first bytes of a non-empty part: scan it whole.
      xml = gz || looksLikeXml(head) || (head.length === 0 && e.uncompressed > 0);
    }
    if (!xml) {
      if (e.compressed === 0) continue;
      if (e.uncompressed > MAX_EMBEDDED_PART) {
        // Too big to read whole: a stored part's start and end can still be
        // read in place; a compressed one cannot be checked, so it is refused.
        const tooBig = `${label}: the ZIP entry ${shown} is over the ${MAX_EMBEDDED_PART} byte limit for checking embedded content; use a smaller document`;
        if (e.method !== 0) throw new ZipScanError(tooBig);
        const w = Math.min(e.compressed, 22 + 65_535);
        const end = Buffer.alloc(w);
        src.read(end, dataStart + e.compressed - w);
        if (holdsZip(head, end, e.compressed - w) || head.subarray(0, 8).equals(CFB_MAGIC)) {
          throw new ZipScanError(tooBig);
        }
        continue;
      }
      checkEmbedded(e, readWhole(e));
      continue;
    }
    if (e.uncompressed > MAX_XML_PART_UNCOMPRESSED || e.compressed > MAX_XML_PART_COMPRESSED) {
      throw new ZipScanError(
        `${label}: the XML entry ${shown} is over the ${MAX_XML_PART_UNCOMPRESSED} byte scan limit; use a smaller document`,
      );
    }
    budget.scanned += e.uncompressed;
    if (budget.scanned > MAX_XML_SCAN_TOTAL) {
      throw new ZipScanError(
        `${label}: the XML entries are over the scan limit; use a smaller document`,
      );
    }
    let data: Buffer = readWhole(e);
    if (gz) {
      // A gzipped part (an .svgz image): look inside it too.
      try {
        data = gunzipSync(data, { maxOutputLength: MAX_XML_PART_UNCOMPRESSED });
      } catch {
        throw new ZipScanError(
          `${label}: the gzipped ZIP entry ${shown} is corrupt or over the ${MAX_XML_PART_UNCOMPRESSED} byte scan limit`,
        );
      }
      budget.scanned += data.length;
      if (budget.scanned > MAX_XML_SCAN_TOTAL) {
        throw new ZipScanError(
          `${label}: the XML entries are over the scan limit; use a smaller document`,
        );
      }
      if (!looksLikeXml(data.subarray(0, SNIFF_BYTES))) {
        checkEmbedded(e, data);
        continue;
      }
    }
    const slash = e.name.lastIndexOf("/");
    scanDecoded(data, slash < 0 ? "" : e.name.slice(0, slash), entryBases, (what) => {
      throw new ZipScanError(
        `${label}: the ZIP entry ${shown} contains ${what}; external entities, local-file references and fields that load files are refused before the document is opened`,
      );
    });
  }
}
