// src/core/http/oauth-callback.ts
//
// GET /oauth/callback: where a vendor's authorization server sends the
// browser back after the user signs in to an OAuth mount (Remote servers, Connect).
//
// No credential is asked for here: the browser arrives from the vendor's site
// and holds neither the admin token nor the access key. What authorizes the
// request is the `state` parameter: 32 random bytes the daemon minted when the
// sign-in started, bound to one mount, single-use and expiring after ten
// minutes (src/core/mounts/oauth.ts). An unknown, reused or expired state is
// refused before any network request is made. The authorization code is
// exchanged with the PKCE verifier only the daemon holds, so a code that
// leaks through the browser's history cannot be redeemed by anyone else.
//
// The page shows fixed messages only: nothing the vendor sent (an
// `error_description`, say) is echoed back.
import { randomBytes } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { OAuthFinishFailure, OAuthFinishResult } from "../mounts/oauth.js";
import { OAUTH_CALLBACK_PATH } from "../mounts/oauth.js";

export interface OAuthCallbackDeps {
  finish(params: URLSearchParams): Promise<OAuthFinishResult>;
  /** The display name of a mount, for the page. */
  mountName(mountId: string): Promise<string | null>;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  /** Makes an error message safe to log (tokens and codes redacted). */
  redact?: (text: string) => string;
}

const FAILURE_TEXT: Record<OAuthFinishFailure, string> = {
  invalid_state:
    "This sign-in link is not valid or was already used. Start again from the dashboard (Remote servers, Connect).",
  expired:
    "This sign-in took too long and expired. Start again from the dashboard (Remote servers, Connect).",
  denied: "The sign-in was cancelled or refused at the vendor. Nothing was saved.",
  failed:
    "The vendor did not hand over a usable sign-in. Nothing was saved; try again from the dashboard (Remote servers, Connect).",
};

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #1c1c1a; }
  main { max-width: 30rem; margin: 12vh auto; padding: 2rem; background: #fff; border: 1px solid #deded8; border-radius: 10px; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: .5rem 0; }
  a { color: inherit; }
  @media (prefers-color-scheme: dark) {
    body { background: #161615; color: #ececea; }
    main { background: #1f1f1d; border-color: #34342f; }
  }
  @media (max-width: 34rem) { main { margin: 6vh 16px; } }
`;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

function page(res: Response, status: number, title: string, text: string): void {
  const nonce = randomBytes(16).toString("base64");
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      "Cache-Control": "no-store",
      // The URL carries the code and the state: never hand it to another site.
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/mounts">Back to the dashboard</a></p></main></body></html>`,
    );
}

/** Serve GET /oauth/callback. */
export function mountOAuthCallback(app: Express, deps: OAuthCallbackDeps): void {
  app.get(OAUTH_CALLBACK_PATH, async (req: Request, res: Response) => {
    const params = new URLSearchParams();
    for (const key of ["state", "code", "error", "iss"]) {
      const v = req.query[key];
      if (typeof v === "string") params.set(key, v);
    }
    let result: OAuthFinishResult;
    try {
      result = await deps.finish(params);
    } catch (e) {
      // The upstream error may quote a token or code: redact before logging.
      const raw = String((e as Error)?.message ?? e).slice(0, 300);
      deps.logger.warn(
        { err: deps.redact ? deps.redact(raw) : raw },
        "mount sign-in callback failed",
      );
      result = { ok: false, reason: "failed" };
    }
    const name = result.mountId ? await deps.mountName(result.mountId).catch(() => null) : null;
    if (result.ok) {
      deps.logger.info({ mount: result.mountId }, "mount signed in");
      page(
        res,
        200,
        "Signed in",
        `${name ?? "The mount"} is signed in and switched on. You can close this tab.`,
      );
      return;
    }
    deps.logger.info(
      { mount: result.mountId ?? null, reason: result.reason },
      "mount sign-in refused",
    );
    const status = result.reason === "invalid_state" || result.reason === "expired" ? 400 : 502;
    page(
      res,
      result.reason === "denied" ? 200 : status,
      name ? `${name}: not signed in` : "Not signed in",
      FAILURE_TEXT[result.reason],
    );
  });
}
