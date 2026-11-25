// packs/machines/mime.ts
//
// The type a downloaded remote file is stored under. Remote content is
// untrusted and so is the agent, so neither gets to pick it: binary formats
// are recognised by their magic bytes, text formats need a matching extension
// AND content that is valid UTF-8 without NUL bytes, and everything else is
// application/octet-stream.

const OCTET = "application/octet-stream";

function startsWith(b: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (b.byteLength < offset + sig.length) return false;
  return sig.every((v, i) => b[offset + i] === v);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Binary types recognised from content alone. */
function sniffBinary(b: Uint8Array): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) return "image/gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(b, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (startsWith(b, ascii("ftyp"), 4)) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  return null;
}

const TEXT_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

function isPlainText(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

export function sniffMime(bytes: Uint8Array, remotePath: string): string {
  const binary = sniffBinary(bytes);
  if (binary) return binary;
  const base = remotePath.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const text = TEXT_BY_EXT[ext];
  if (text && isPlainText(bytes)) return text;
  return OCTET;
}
