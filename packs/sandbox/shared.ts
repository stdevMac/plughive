// packs/sandbox/shared.ts — limits and result shapes shared by the providers.

/** Most characters of stdout or stderr returned. */
export const MAX_OUTPUT_CHARS = 100_000;
/** Largest file moved in or out of a sandbox. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

export interface CommandResult {
  exit_code: number;
  stdout: string;
  stderr?: string;
  error?: string;
  truncated?: boolean;
  timed_out?: boolean;
}

export function capText(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[output cut at ${MAX_OUTPUT_CHARS} characters]`
    : text;
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pdf: "application/pdf",
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/plain",
  log: "text/plain",
};

/** A mime type from a file name's extension. */
export function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

export function kindOf(mime: string): "image" | "video" | "audio" | "pdf" | "data" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/json" || mime === "text/csv") return "data";
  return "other";
}

/** UTF-8 text when the bytes decode cleanly, else null. */
export function asText(bytes: Uint8Array, max = 1024 * 1024): string | null {
  if (bytes.byteLength > max) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
