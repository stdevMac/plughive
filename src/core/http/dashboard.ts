// src/core/http/dashboard.ts
//
// The web dashboard: the built single-page app in web/dist, served at `/`.
//
//   - Static files are public; every piece of data comes from /api, which
//     keeps its own access-key and CSRF rules.
//   - Any GET or HEAD that is not an API, MCP, artifact, health or setup path
//     and does not name a file gets index.html (client-side routing).
//   - Every response carries a strict Content-Security-Policy: no inline
//     script, no third-party origin, never framed.
//   - Without a build, `/` explains how to make one instead of a bare 404.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

/** Paths the dashboard never answers: they belong to the daemon. */
const RESERVED = /^\/(?:api|mcp|p|artifacts|health|setup)(?:\/|$)/;
/** A last path segment with an extension names a file, not a client route. */
const FILE_LIKE = /\/[^/]*\.[a-z0-9]{1,8}$/i;

export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Where the built dashboard lives. PLUGHIVE_WEB_DIR wins; otherwise the
 * `web/dist` next to the sources (`<repo>/web/dist` when run from source,
 * `dist/web/dist` in a build, where the build script copies it).
 */
export function defaultWebDir(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.PLUGHIVE_WEB_DIR?.trim();
  if (given) return resolve(given);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/dist");
}

function securityHeaders(res: Response, csp = DASHBOARD_CSP): void {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

const MISSING_STYLE =
  "body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#1f2328;background:#fff}" +
  "code{font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f3f5;padding:.1rem .35rem;border-radius:4px}" +
  "@media (prefers-color-scheme:dark){body{color:#e6e8eb;background:#16181c}code{background:#262a30}}";

function missingPage(): { html: string; csp: string } {
  const hash = createHash("sha256").update(MISSING_STYLE).digest("base64");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>plughive</title><style>${MISSING_STYLE}</style></head>
<body><h1>The dashboard is not built yet</h1>
<p>The daemon is running. Its API is at <code>/api</code> and agents connect at <code>/mcp</code>.</p>
<p>To use the dashboard, build it once from the repository and reload this page:</p>
<p><code>pnpm build:web</code></p>
</body></html>`;
  return { html, csp: DASHBOARD_CSP.replace("style-src 'self'", `style-src 'sha256-${hash}'`) };
}

export interface DashboardOptions {
  /** The built app. Default: defaultWebDir(). */
  dir?: string;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Serve the dashboard. Mount after every daemon route and before the JSON 404,
 * so a path the daemon owns is never answered with the app.
 */
export function mountDashboard(app: Express, opts: DashboardOptions = {}): void {
  const dir = opts.dir ?? defaultWebDir();
  const indexPath = join(dir, "index.html");
  const missing = missingPage();
  // Re-read when the file changes, so a build made while the daemon runs is picked up.
  let cached: { mtimeMs: number; html: Buffer } | null = null;
  const loadIndex = (): Buffer | null => {
    if (!existsSync(indexPath)) return null;
    const { mtimeMs } = statSync(indexPath);
    if (!cached || cached.mtimeMs !== mtimeMs) cached = { mtimeMs, html: readFileSync(indexPath) };
    return cached.html;
  };

  const assets = express.static(dir, {
    index: false,
    redirect: false,
    dotfiles: "ignore",
    fallthrough: true,
    setHeaders: (res, path) => {
      securityHeaders(res);
      // Vite fingerprints everything under assets/: safe to keep forever.
      const rel = path.slice(dir.length).replace(/\\/g, "/");
      const fingerprinted = rel.startsWith("/assets/");
      res.setHeader(
        "Cache-Control",
        fingerprinted ? "public, max-age=31536000, immutable" : "no-cache",
      );
      // The same URL may be answered compressed (sendCompressed below).
      if (fingerprinted) res.setHeader("Vary", "Accept-Encoding");
    },
  });

  // The build writes .br/.gz copies of large assets (web/vite.config.ts).
  // Files under assets/ are fingerprinted and never change, so whether a copy
  // exists is looked up once per path.
  const compressed = new Map<string, boolean>();
  const hasCopy = (path: string): boolean => {
    let known = compressed.get(path);
    if (known === undefined) {
      known = existsSync(path);
      if (compressed.size < 4096) compressed.set(path, known);
    }
    return known;
  };
  const root = resolve(dir) + sep;
  const sendCompressed = (req: Request, res: Response, next: NextFunction): boolean => {
    if (!req.path.startsWith("/assets/")) return false;
    const ext = extname(req.path);
    if (ext !== ".js" && ext !== ".css" && ext !== ".svg") return false;
    let file: string;
    try {
      file = resolve(dir, `.${decodeURIComponent(req.path)}`);
    } catch {
      return false;
    }
    if (!file.startsWith(root)) return false;
    const encoding = req.acceptsEncodings("br", "gzip");
    const suffix = encoding === "br" ? ".br" : encoding === "gzip" ? ".gz" : null;
    if (!suffix || !hasCopy(file + suffix)) return false;
    securityHeaders(res);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Encoding", encoding as string);
    res.setHeader("Vary", "Accept-Encoding");
    res.type(ext);
    // With `root`, the dotfile check covers only the path below the web
    // directory (as express.static does): an install under a dot directory
    // such as ~/.local must still be served.
    res.sendFile(file.slice(root.length) + suffix, { root, dotfiles: "ignore" }, (err) => {
      if (err && !res.headersSent) {
        res.removeHeader("Content-Encoding");
        compressed.delete(file + suffix);
        assets(req, res, next);
      }
    });
    return true;
  };

  // A client route is only answered with the app when a browser asks for a
  // page (Accept: text/html). An API client that asks for an unknown path
  // keeps getting the JSON 404.
  const isPageRequest = (req: Request) =>
    req.path === "/" ||
    req.path === "/index.html" ||
    /\btext\/html\b/i.test(req.get("accept") ?? "");

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (RESERVED.test(req.path)) return next();
    const fallback = () => {
      if (FILE_LIKE.test(req.path) && req.path !== "/index.html") return next();
      if (!isPageRequest(req)) return next();
      sendIndex(res, next);
    };
    if (!isDir(dir)) return fallback();
    if (req.path === "/index.html") return sendIndex(res, next);
    if (sendCompressed(req, res, fallback)) return;
    assets(req, res, fallback);
  });

  function sendIndex(res: Response, next: NextFunction): void {
    const html = loadIndex();
    if (!html) {
      if (isDir(dir)) next();
      else sendMissing(res);
      return;
    }
    securityHeaders(res);
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
  }

  function sendMissing(res: Response): void {
    securityHeaders(res, missing.csp);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).type("html").send(missing.html);
  }
}
