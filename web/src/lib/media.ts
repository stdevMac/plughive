// Finding media in a tool result, and keeping artifact links same-origin.

export type MediaKind = "image" | "video" | "audio" | "pdf" | "file";

export interface MediaRef {
  url: string;
  kind: MediaKind;
  mime: string | null;
  label: string | null;
}

/**
 * Artifact links point at the daemon's /artifacts route, sometimes with a
 * different host spelling (localhost vs 127.0.0.1) than the page. A relative
 * link keeps them same-origin, so the page's CSP (img-src 'self') allows them.
 * Links to other hosts are returned as they are.
 */
export function sameOriginArtifactUrl(
  url: string,
  origin: string = window.location.origin,
): string {
  try {
    const u = new URL(url, origin);
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    const here = new URL(origin);
    if (
      u.pathname.startsWith("/artifacts/") &&
      (u.origin === here.origin || (local && u.port === here.port))
    ) {
      return `${u.pathname}${u.search}`;
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * The same link with `download=1`, which makes the daemon send the file as an
 * attachment with a readable name. Only artifact links are changed; a path
 * stays a path, and anything unparsable is returned as it was.
 */
export function artifactDownloadUrl(url: string, origin: string = window.location.origin): string {
  try {
    const u = new URL(url, origin);
    if (!u.pathname.startsWith("/artifacts/")) return url;
    u.searchParams.set("download", "1");
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("//");
    return relative ? `${u.pathname}${u.search}` : u.toString();
  } catch {
    return url;
  }
}

export function isArtifactUrl(url: string): boolean {
  if (!isHttpUrl(url)) return false;
  try {
    return new URL(url, "http://x").pathname.startsWith("/artifacts/");
  } catch {
    return false;
  }
}

/**
 * True for a url the page may reference: it parses, is http(s), and is not
 * protocol-relative ("//evil.example/..." would resolve against the page's
 * scheme and point at another host).
 */
export function isHttpUrl(url: string): boolean {
  if (typeof url !== "string" || url === "" || url.startsWith("//")) return false;
  try {
    const u = new URL(url, "http://x");
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The absolute form of a link, or null when it does not parse (never throws):
 * an invalid url in a tool result ("https://[bad") must not crash the page
 * that renders it.
 */
export function absoluteUrl(url: string, origin?: string): string | null {
  const base =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "http://localhost");
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

function kindOf(mime: string | null, kind: unknown, url: string): MediaKind {
  const k = typeof kind === "string" ? kind : "";
  if (k === "image" || k === "video" || k === "audio" || k === "pdf") return k;
  const m = mime ?? "";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  const ext = url.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "svg"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return "file";
}

/**
 * Every media reference in a result: objects with a url plus a mime type or
 * kind, and bare artifact links. Depth and count are bounded.
 */
export function extractMedia(value: unknown, limit = 24): MediaRef[] {
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  const push = (ref: MediaRef) => {
    if (seen.has(ref.url) || out.length >= limit) return;
    seen.add(ref.url);
    out.push(ref);
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || out.length >= limit) return;
    if (typeof v === "string") {
      if (isArtifactUrl(v)) push({ url: v, kind: kindOf(null, null, v), mime: null, label: null });
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : typeof o.uri === "string" ? o.uri : null;
      const mime =
        typeof o.mime === "string"
          ? o.mime
          : typeof o.mimeType === "string"
            ? o.mimeType
            : typeof o.mime_type === "string"
              ? o.mime_type
              : null;
      if (url && (mime || typeof o.kind === "string" || isArtifactUrl(url)) && isHttpUrl(url)) {
        const label = typeof o.name === "string" ? o.name : typeof o.id === "string" ? o.id : null;
        push({ url, kind: kindOf(mime, o.kind, url), mime, label });
      }
      for (const [k, x] of Object.entries(o)) if (k !== "url" && k !== "uri") walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/** The text parts of an MCP-style result ({content: [{type:"text", text}]}), if any. */
export function textParts(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        !!c &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text);
}
