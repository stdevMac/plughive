// packs/local/lib/zip-scan.ts
//
// ZIP-based documents (docx, xlsx, pptx, odt, odp, ods, epub) are containers
// that pandoc and LibreOffice open entry by entry, so the container is
// checked before any tool runs on it:
//   - the central directory is read without decompressing anything, which
//     bounds zip bombs by the sizes the file itself declares (and the XML
//     scan below inflates with a hard cap, so a lying header is caught too),
//     and refuses entry names that would escape the archive (zip slip);
//   - XML parts are searched for external entity declarations (XXE) and
//     file:// / UNC references. The hardened LibreOffice profile routes
//     http(s)/ftp through a dead proxy, but file: is not proxied, so an
//     external DTD or an external relationship pointing at a local file must
//     never reach the converter.
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Bounds for the container, from the declared (central directory) sizes. */
export const MAX_ZIP_ENTRIES = 20_000;
export const MAX_ZIP_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024;
export const MAX_ZIP_ENTRY_RATIO = 200;
/** Bounds for the XML content scan, from the really inflated bytes. */
const MAX_XML_PART_UNCOMPRESSED = 64 * 1024 * 1024;
const MAX_XML_PART_COMPRESSED = 128 * 1024 * 1024;
const MAX_XML_SCAN_TOTAL = 256 * 1024 * 1024;

export class ZipScanError extends Error {}

interface Entry {
  name: string;
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
}

function readAt(fd: number, buf: Buffer, offset: number): void {
  let done = 0;
  while (done < buf.length) {
    const n = readSync(fd, buf, done, buf.length - done, offset + done);
    if (n === 0) throw new ZipScanError("the file ends inside a ZIP structure");
    done += n;
  }
}

function entryNameProblem(name: string): string | null {
  if (name.includes("\0")) return "contains a NUL byte";
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name))
    return "is an absolute path";
  if (name.split(/[/\\]/).includes("..")) return 'contains a ".." segment';
  return null;
}

/** External entities and local-file references in an XML part. */
const XML_DANGERS: ReadonlyArray<[RegExp, string]> = [
  [/<!\s*ENTITY[^>]*?\b(?:SYSTEM|PUBLIC)\b/i, "an external entity declaration (XXE)"],
];

/** Reference attributes, read with their quoted value. */
const REF_ATTR =
  /\b(xlink:href|href|src|Target|action|data|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * An attribute value as the converter reads it: XML character and named
 * entities decoded (so `&#x66;ile:` is `file:`), then every control or
 * space character removed, since URL parsers drop tabs and newlines inside a
 * scheme. Lowercased for the prefix checks.
 */
export function refValue(raw: string): string {
  const decoded = raw.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, ref: string) => {
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  return decoded.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
}

/** Why a reference attribute points outside the package, or null. */
function refProblem(attr: string, value: string): string | null {
  const v = refValue(value);
  if (v.startsWith("file:") || v.startsWith("\\\\") || v.startsWith("//") || v.startsWith("\\/"))
    return "a file:// or UNC reference";
  // ODF xlink:href is relative to the document's folder, not the package:
  // "../" or an absolute path reaches the file system beside it.
  if (attr.toLowerCase() === "xlink:href") {
    if (v.startsWith("/") || v.startsWith("\\") || /^[a-z]:(?:[/\\]|$)/.test(v))
      return "an absolute local path";
    if (v.split(/[/\\]/).includes("..")) return 'a reference outside the document (a ".." segment)';
  }
  return null;
}

function scanXmlPart(label: string, name: string, text: string): void {
  for (const m of text.matchAll(REF_ATTR)) {
    const what = refProblem(m[1] as string, m[2] ?? m[3] ?? "");
    if (what) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${JSON.stringify(name)} contains ${what}; external entities and local-file references are refused before the document is opened`,
      );
    }
  }
  for (const [re, what] of XML_DANGERS) {
    if (re.test(text)) {
      throw new ZipScanError(
        `${label}: the ZIP entry ${JSON.stringify(name)} contains ${what}; external entities and local-file references are refused before the document is opened`,
      );
    }
  }
  if (/\.rels$/i.test(name)) {
    // An external relationship must be http(s) (the converter's dead proxy
    // blocks it); file:, UNC and anything else is refused.
    for (const tag of text.matchAll(/<Relationship\b[^>]*>/gi)) {
      const t = tag[0];
      if (!/TargetMode\s*=\s*["']External["']/i.test(t)) continue;
      const target =
        /Target\s*=\s*"([^"]*)"/i.exec(t)?.[1] ?? /Target\s*=\s*'([^']*)'/i.exec(t)?.[1] ?? "";
      const v = refValue(target);
      // http(s) goes to the dead proxy; mailto: and tel: open nothing.
      if (!/^(?:https?:\/\/|mailto:|tel:)/.test(v)) {
        throw new ZipScanError(
          `${label}: ${JSON.stringify(name)} has an external relationship to ${JSON.stringify(target.slice(0, 120))}, which is not http(s), mailto: or tel:; file:// and UNC targets are refused`,
        );
      }
    }
  }
}

/**
 * Refuse a hostile ZIP-based document before pandoc/soffice open it.
 * Throws ZipScanError with an actionable message; returns quietly when the
 * container is within bounds and its XML parts carry no external references.
 */
export function scanZipDocument(path: string): void {
  const label = `refusing to open ${basename(path)}`;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new ZipScanError(`${label}: it is a symlink, not a regular file`);
    throw e;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < 22) throw new ZipScanError(`${label}: too small to be a ZIP container`);
    // End-of-central-directory record: search the last 64 KiB (+ comment).
    const window = Math.min(size, 22 + 65_536);
    const tail = Buffer.alloc(window);
    readAt(fd, tail, size - window);
    let eocd = -1;
    for (let i = window - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipScanError(`${label}: no ZIP end record, not a ZIP container`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipScanError(
        `${label}: ZIP64 archives are refused (over 4 GiB or over 65535 entries)`,
      );
    }
    if (cdSize > size || cdOffset > size || cdOffset + cdSize > size) {
      throw new ZipScanError(`${label}: the ZIP central directory is out of bounds`);
    }
    const cd = Buffer.alloc(cdSize);
    readAt(fd, cd, cdOffset);
    const entries: Entry[] = [];
    let p = 0;
    let totalUncompressed = 0;
    while (p + 46 <= cd.length) {
      if (cd.readUInt32LE(p) !== 0x02014b50) {
        throw new ZipScanError(`${label}: the ZIP central directory is corrupt`);
      }
      if (entries.length >= MAX_ZIP_ENTRIES) {
        throw new ZipScanError(
          `${label}: over ${MAX_ZIP_ENTRIES} ZIP entries; use a smaller document`,
        );
      }
      const method = cd.readUInt16LE(p + 10);
      const compressed = cd.readUInt32LE(p + 20);
      const uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
        throw new ZipScanError(`${label}: ZIP64 entries are refused`);
      }
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      const nameProblem = entryNameProblem(name);
      if (nameProblem) {
        throw new ZipScanError(
          `${label}: the ZIP entry ${JSON.stringify(name.slice(0, 120))} ${nameProblem} (zip slip refused)`,
        );
      }
      if (method !== 0 && method !== 8) {
        throw new ZipScanError(
          `${label}: the ZIP entry ${JSON.stringify(name.slice(0, 120))} uses compression method ${method}, only stored/deflate are allowed`,
        );
      }
      if (compressed > 0 && uncompressed / compressed > MAX_ZIP_ENTRY_RATIO) {
        throw new ZipScanError(
          `${label}: the ZIP entry ${JSON.stringify(name.slice(0, 120))} expands ${Math.round(uncompressed / compressed)}:1 (over the ${MAX_ZIP_ENTRY_RATIO}:1 limit) — a zip bomb; use a smaller document`,
        );
      }
      totalUncompressed += uncompressed;
      if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED) {
        throw new ZipScanError(
          `${label}: the ZIP entries declare over ${MAX_ZIP_TOTAL_UNCOMPRESSED} bytes uncompressed in total; use a smaller document`,
        );
      }
      entries.push({ name, method, compressed, uncompressed, localOffset });
    }
    // XML parts: inflate with a hard cap and refuse external references.
    let scannedTotal = 0;
    for (const e of entries) {
      if (!/\.(xml|rels)$/i.test(e.name)) continue;
      if (e.uncompressed > MAX_XML_PART_UNCOMPRESSED || e.compressed > MAX_XML_PART_COMPRESSED) {
        throw new ZipScanError(
          `${label}: the XML entry ${JSON.stringify(e.name.slice(0, 120))} is over the ${MAX_XML_PART_UNCOMPRESSED} byte scan limit; use a smaller document`,
        );
      }
      scannedTotal += e.uncompressed;
      if (scannedTotal > MAX_XML_SCAN_TOTAL) {
        throw new ZipScanError(
          `${label}: the XML entries are over the scan limit; use a smaller document`,
        );
      }
      const local = Buffer.alloc(30);
      readAt(fd, local, e.localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) {
        throw new ZipScanError(
          `${label}: the local header of ${JSON.stringify(e.name.slice(0, 120))} is corrupt`,
        );
      }
      const dataStart = e.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = Buffer.alloc(e.compressed);
      readAt(fd, raw, dataStart);
      let data: Buffer;
      try {
        data = e.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: e.uncompressed + 1 });
      } catch {
        throw new ZipScanError(
          `${label}: the ZIP entry ${JSON.stringify(e.name.slice(0, 120))} inflates past its declared size`,
        );
      }
      if (data.length > e.uncompressed) {
        throw new ZipScanError(
          `${label}: the ZIP entry ${JSON.stringify(e.name.slice(0, 120))} inflates past its declared size`,
        );
      }
      scanXmlPart(label, e.name, data.toString("utf8"));
    }
  } finally {
    closeSync(fd);
  }
}
