// src/http/artifacts.ts
//
// GET /artifacts/:id serves a file from the local library.
//
// Artifacts are untrusted content on the daemon's own origin (a model, an
// upstream API or an imported file produced them), so the route never lets one
// run as a page of that origin:
//   - `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`
//     on every response;
//   - only a short allow-list of media types is shown inline, everything else
//     is a download, and anything a browser could execute (HTML, SVG, XML,
//     scripts) is sent as application/octet-stream.
//
// When an access key is configured the route needs it, or a short-lived signed
// link (`?exp=&sig=`) minted by the daemon so that a URL in a tool result can
// be opened in a browser, which cannot send the key.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Express, Request, Response } from "express";
import { extractAuthToken, verifyAccessKey } from "../lib/access-key.js";
import { extensionForMime } from "../lib/library.js";

/** The part of the Library this route needs. */
export interface ArtifactSource {
  get(id: string): { id: string; path: string; mime: string; bytes: number; kind?: string } | null;
  /** The library root; artifacts live in `<root>/artifacts`. */
  readonly rootValue: string;
}

const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const ARTIFACT_LINK_TTL_MS = 60 * 60 * 1000;
export const ARTIFACT_CSP = "sandbox; default-src 'none'";

/** Types a browser may render in place, with the extension used for downloads. */
const INLINE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "application/pdf": "pdf",
};

/** Download-only types that keep a helpful extension. */
const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/zip": "zip",
  "video/quicktime": "mov",
  "image/svg+xml": "svg",
  "text/html": "html",
};

const ACTIVE_CONTENT = /html|svg|xml|script|css/;
const MIME_TOKEN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export interface ArtifactDelivery {
  contentType: string;
  disposition: "inline" | "attachment";
  filename: string;
}

const KIND_WORD = /^[a-z]{1,16}$/;

/**
 * How one stored artifact is sent. Pure, so the policy is testable on its own.
 * The library keeps no original file name, so the name is derived from what
 * it does keep: `<kind>-<id>.<ext>`, the extension from the stored media type.
 */
export function artifactDelivery(id: string, mime: string, kind?: string): ArtifactDelivery {
  const type = (mime.split(";", 1)[0] ?? "").trim().toLowerCase();
  const safeId = ARTIFACT_ID.test(id) ? id : "artifact";
  const stem = kind !== undefined && KIND_WORD.test(kind) ? `${kind}-${safeId}` : safeId;
  const inlineExt = Object.hasOwn(INLINE_TYPES, type) ? INLINE_TYPES[type] : undefined;
  if (inlineExt)
    return { contentType: type, disposition: "inline", filename: `${stem}.${inlineExt}` };
  const ext = Object.hasOwn(DOWNLOAD_EXTENSIONS, type)
    ? (DOWNLOAD_EXTENSIONS[type] as string)
    : extensionForMime(type);
  const contentType =
    !MIME_TOKEN.test(type) || ACTIVE_CONTENT.test(type) ? "application/octet-stream" : type;
  return { contentType, disposition: "attachment", filename: `${stem}.${ext}` };
}

const MAX_FILENAME = 180;

/**
 * A Content-Disposition value that cannot inject a header or a parameter:
 * `type; filename="<ascii>"; filename*=UTF-8''<RFC 5987 encoded>`. Control
 * characters, quotes, backslashes, percent signs and path separators are
 * dropped from the name; the ASCII form also replaces anything non-ASCII.
 */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  let name = "";
  for (const ch of filename) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) continue;
    if (ch === '"' || ch === "\\" || ch === "%" || ch === "/" || ch === ";") continue;
    if (cp === 0x2028 || cp === 0x2029) continue;
    name += ch;
  }
  name = [...name].slice(0, MAX_FILENAME).join("").trim();
  if (name === "" || name === "." || name === "..") name = "artifact";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${(c.codePointAt(0) as number).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// ---------------------------------------------------------------------------
// Signed links
// ---------------------------------------------------------------------------

export interface ArtifactSignerOptions {
  /** HMAC key, at least 32 bytes. Default: random per process (links die with the daemon). */
  key?: Buffer;
  ttlMs?: number;
  now?: () => number;
}

export interface ArtifactSigner {
  /** Query string values for a link to `id` that works until `exp` (ms since epoch). */
  sign(id: string): { exp: number; sig: string };
  verify(id: string, exp: unknown, sig: unknown): boolean;
  /** `${base}/artifacts/${id}?exp=...&sig=...` */
  url(base: string, id: string): string;
}

export function createArtifactSigner(opts: ArtifactSignerOptions = {}): ArtifactSigner {
  const key = opts.key ?? randomBytes(32);
  if (key.length < 32) throw new Error("artifact link key must be at least 32 bytes");
  const ttlMs = opts.ttlMs ?? ARTIFACT_LINK_TTL_MS;
  const now = opts.now ?? Date.now;
  const mac = (id: string, exp: number) =>
    createHmac("sha256", key).update(`plughive.artifact.v1:${id}:${exp}`).digest();
  const sign = (id: string) => {
    const exp = now() + ttlMs;
    return { exp, sig: mac(id, exp).toString("base64url") };
  };
  return {
    sign,
    verify(id, exp, sig) {
      if (typeof exp !== "string" || typeof sig !== "string") return false;
      if (!ARTIFACT_ID.test(id) || !/^\d{1,16}$/.test(exp) || sig.length > 64) return false;
      const expiry = Number(exp);
      if (now() >= expiry) return false;
      // Compared as text: one signature has exactly one accepted spelling.
      const given = Buffer.from(sig, "utf8");
      const expected = Buffer.from(mac(id, expiry).toString("base64url"), "utf8");
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
    url(base, id) {
      const { exp, sig } = sign(id);
      return `${base}/artifacts/${id}?exp=${exp}&sig=${sig}`;
    },
  };
}

const MAX_WALK_DEPTH = 12;

/**
 * Replace every plain artifact URL of this daemon found in a tool result with
 * a signed one, so the link a client shows the user opens in a browser when
 * the daemon requires an access key. Only exact `${base}/artifacts/<id>`
 * strings are touched; the input is not modified.
 */
export function signArtifactLinks(value: unknown, base: string, signer: ArtifactSigner): unknown {
  const prefix = `${base}/artifacts/`;
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") {
      if (!node.startsWith(prefix)) return node;
      const id = node.slice(prefix.length);
      return ARTIFACT_ID.test(id) ? signer.url(base, id) : node;
    }
    if (depth >= MAX_WALK_DEPTH || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;
    // Null prototype: an input key "__proto__" must become an own key, not
    // change the prototype of the object being built.
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, depth + 1);
    return out;
  };
  return walk(value, 0);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export interface ArtifactRouteOptions {
  /** When set, the route needs this key or a signed link. */
  accessKey?: string | null;
  signer?: ArtifactSigner;
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}

const notFound = (res: Response) =>
  res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "artifact not found" } });

/** True when `path` lies strictly inside `root` (both absolute, symlinks resolved). */
function strictlyInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * The real path of an artifact file that lies inside the library's artifacts
 * folder, or null. Same rule as resources/read (src/core/mcp/resources.ts) and
 * Library.remove: the stored path is resolved with symlinks and must stay in
 * the real artifacts folder, and the file itself is opened with O_NOFOLLOW, so
 * a row whose path is a symlink out of the library serves nothing.
 */
function artifactRealPath(rootValue: string, path: string): string | null {
  if (!isAbsolute(path) || path.includes("\0")) return null;
  try {
    const realRoot = realpathSync(join(rootValue, "artifacts"));
    const real = realpathSync(path);
    if (!strictlyInside(realRoot, real)) return null;
    const fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return null;
    } finally {
      closeSync(fd);
    }
    return real;
  } catch {
    return null;
  }
}

export function mountArtifacts(
  app: Express,
  library: ArtifactSource,
  opts: ArtifactRouteOptions = {},
): void {
  app.get("/artifacts/:id", (req: Request, res: Response) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": ARTIFACT_CSP,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });
    const id = String(req.params.id ?? "");
    if (opts.accessKey) {
      const keyed = verifyAccessKey(opts.accessKey, extractAuthToken(req));
      const signed = opts.signer?.verify(id, req.query.exp, req.query.sig) ?? false;
      if (!keyed && !signed) {
        res.status(401).json({
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "this artifact needs the access key or a signed link that has not expired",
          },
        });
        return;
      }
    }
    const art = ARTIFACT_ID.test(id) ? library.get(id) : null;
    if (!art) {
      notFound(res);
      return;
    }
    const real = artifactRealPath(library.rootValue, art.path);
    if (!real) {
      // The row exists, but the file is not a regular file inside the library's
      // artifacts folder (gone, unreadable, or a symlink leading out of it).
      opts.logger?.warn({ artifact: art.id }, "artifact file could not be read");
      notFound(res);
      return;
    }
    const delivery = artifactDelivery(art.id, art.mime, art.kind);
    // ?download=1 asks for a save, even for a type shown in place.
    const disposition = req.query.download === "1" ? "attachment" : delivery.disposition;
    res.sendFile(
      real,
      {
        dotfiles: "allow",
        acceptRanges: true,
        cacheControl: false,
        headers: {
          "Content-Type": delivery.contentType,
          "Content-Disposition": contentDisposition(disposition, delivery.filename),
        },
      },
      (err) => {
        if (!err) return;
        // The row exists but the file is gone, unreadable, or the client went
        // away mid-stream. Never a crash, never a path in the reply.
        const status =
          (err as { status?: number; statusCode?: number }).status ??
          (err as { statusCode?: number }).statusCode;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (status === 416) {
          res.status(416).json({
            ok: false,
            error: { code: "RANGE_NOT_SATISFIABLE", message: "requested range not satisfiable" },
          });
          return;
        }
        opts.logger?.warn({ artifact: art.id }, "artifact file could not be read");
        res.removeHeader("Content-Type");
        res.removeHeader("Content-Disposition");
        notFound(res);
      },
    );
  });
}
