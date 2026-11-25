// src/core/http/secret-setup.ts
//
// The local page a client is sent to (MCP URL elicitation) when a tool needs a
// key that is not set.
//
//   GET  /setup/secret?token=...   a form with one password field
//                                  (&multiline=1: a textarea, for PEM keys)
//   POST /setup/secret             stores the value in the SecretStore
//
// The token (see core/mcp/setup-token.ts) is the authorization for this page:
// it names one secret of one pack, expires after a few minutes and works once.
// The page is therefore reachable without the access key, which a browser
// navigation could not send anyway. The value goes from the browser straight
// to the SecretStore: it is never echoed, logged or returned.
//
// The token says what was true when it was minted. When the form comes back,
// the name is checked again: it must not be on the deny list, an enabled pack
// must still declare it, and it must still be unset. Otherwise nothing is
// stored: the link only ever fills a missing key, never replaces one.
//
// The token alone is not enough to store a value. Whoever calls the tool gets
// the link, so the POST must also show that it is the form this daemon
// rendered in a browser:
//   - a cookie set when the page was rendered (HttpOnly, SameSite=Strict,
//     Path=/setup, a fresh random nonce bound to this token by an HMAC), and
//   - `Sec-Fetch-Site: same-origin`, or, from a browser that sends no fetch
//     metadata, an Origin that is the daemon's own.
// A script can still play both parts (fetch the page, keep the cookie, set the
// headers); what this stops is a single blind POST of a token it was handed.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import {
  type SetupClaim,
  type SetupTokenFailure,
  type SetupTokens,
  safeHelpUrl,
  safeLabel,
} from "../mcp/setup-token.js";
import { isDeniedSecretName } from "../packs/manifest.js";
import type { OriginPolicy } from "./origin.js";

export const MAX_SECRET_VALUE_LENGTH = 8192;
/** A percent-encoded multi-line value can take three bytes per character. */
const FORM_BODY_LIMIT = "32kb";

export interface SecretSink {
  set(name: string, value: string): Promise<void>;
}

interface SetupLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface SecretSetupDeps {
  tokens: SetupTokens;
  secrets: SecretSink;
  logger?: SetupLogger;
  /** The daemon's own origin: a POST that names another origin is refused. */
  origin: OriginPolicy;
  /**
   * True when `pack` is enabled now and declares `secret`. Asked when the form
   * is submitted. Absent: only the deny list is checked.
   */
  declared?: (pack: string, secret: string) => boolean | Promise<boolean>;
  /**
   * True when the secret already has a value. Asked when the page is rendered
   * and again when the form is submitted: a set key is never replaced from
   * here. Absent: not checked.
   */
  present?: (secret: string) => boolean | Promise<boolean>;
}

/** The render cookie lives as long as the link could. */
const COOKIE_MAX_AGE_S = 10 * 60;
const COOKIE_PREFIX = "mcp_setup_";

/** One cookie per link, so two open setup pages do not overwrite each other. */
function cookieName(token: string): string {
  return COOKIE_PREFIX + createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** `declared` for a pack loader: the pack is loaded, enabled, and granted the secret. */
export function declaredByLoadedPack(loader: {
  listPacks(): Promise<
    Array<{
      id: string;
      enabled: boolean;
      state: string;
      secrets: Array<{ name: string; granted?: boolean }>;
    }>
  >;
}): NonNullable<SecretSetupDeps["declared"]> {
  return async (pack, secret) => {
    const found = (await loader.listPacks()).find((p) => p.id === pack);
    return (
      found?.enabled === true &&
      found.state === "loaded" &&
      found.secrets.some((s) => s.name === secret && s.granted === true)
    );
  };
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const FAILURE_TEXT: Record<SetupTokenFailure, string> = {
  invalid: "This setup link is not valid.",
  expired: "This setup link has expired.",
  used: "This setup link was already used.",
};

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #1c1c1a; }
  main { max-width: 30rem; margin: 12vh auto; padding: 2rem; background: #fff; border: 1px solid #deded8; border-radius: 10px; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: .5rem 0; }
  code { background: #f0f0ec; padding: .1rem .3rem; border-radius: 4px; }
  label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
  textarea { font: 13px/1.4 ui-monospace, monospace !important; resize: vertical; }
  input[type=password], textarea { width: 100%; box-sizing: border-box; padding: .6rem; font: inherit; border: 1px solid #b9b9b0; border-radius: 6px; }
  button { margin-top: 1rem; padding: .6rem 1.2rem; font: inherit; color: #fff; background: #1c1c1a; border: 0; border-radius: 6px; cursor: pointer; }
  .muted { color: #62625c; font-size: .9rem; }
`;

function send(res: Response, status: number, title: string, body: string): void {
  const nonce = randomBytes(16).toString("base64");
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "Cache-Control": "no-store",
      // same-origin, not no-referrer: with no-referrer a browser submits the
      // form with `Origin: null`. The token in the URL still never leaves this
      // origin (the help link carries rel="noreferrer").
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main></body></html>`,
    );
}

function message(res: Response, status: number, title: string, text: string): void {
  send(res, status, title, `<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
}

function rejected(res: Response, reason: SetupTokenFailure): void {
  message(
    res,
    400,
    "Link not usable",
    `${FAILURE_TEXT[reason]} Run the tool again in your MCP client to get a new one.`,
  );
}

function form(res: Response, token: string, claim: SetupClaim, multiline: boolean): void {
  const helpUrl = safeHelpUrl(claim.helpUrl);
  const help = helpUrl
    ? `<p class="muted">Where to get it: <a href="${esc(helpUrl)}" rel="noreferrer noopener" target="_blank">${esc(helpUrl)}</a></p>`
    : "";
  const label = safeLabel(claim.label);
  const common = `id="value" name="value" required maxlength="${MAX_SECRET_VALUE_LENGTH}" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus`;
  const field = multiline
    ? `<textarea ${common} rows="10" wrap="off"></textarea>`
    : `<input ${common} type="password">`;
  const here = `/setup/secret?token=${encodeURIComponent(token)}`;
  const toggle = multiline
    ? `<a href="${esc(here)}">Use a single-line field</a>`
    : `<a href="${esc(`${here}&multiline=1`)}">Paste a multi-line value (for example a PEM key)</a>`;
  send(
    res,
    200,
    "Set a key for plughive",
    `<h1>Set a key for plughive</h1>
<p>The pack <code>${esc(claim.pack)}</code> needs <code>${esc(claim.secret)}</code>${label ? ` (${esc(label)})` : ""}.</p>
${help}
<form method="post" action="/setup/secret" autocomplete="off">
<input type="hidden" name="token" value="${esc(token)}">
<label for="value">${esc(label ?? claim.secret)}</label>
${field}
<button type="submit">Save</button>
</form>
<p class="muted">${toggle}</p>
<p class="muted">The key is stored on this machine only. It is never shown again and never sent to your MCP client.</p>`,
  );
}

/**
 * Who may POST the form: a browser submitting it from the daemon's own page.
 * `Sec-Fetch-Site: same-origin` when the browser sends fetch metadata (Chrome,
 * Edge, Firefox 90+, Safari 16.4+), else an Origin that is the daemon's own
 * (older Safari and Firefox). `Origin: null` is accepted only together with
 * `Sec-Fetch-Site: same-origin`: Chromium sends null for a form on a page with
 * a strict referrer policy. A request with neither header is refused.
 */
function postAllowed(req: Request, policy: OriginPolicy): boolean {
  const site = req.header("sec-fetch-site");
  const origin = req.header("origin");
  const opaque = origin === undefined || origin === "" || origin === "null";
  // An Origin that names another site is refused whatever else is sent.
  if (!opaque && !policy.isOwn(origin)) return false;
  if (site !== undefined) return site === "same-origin";
  return !opaque;
}

/** Line endings as the user pasted them (browsers submit CRLF), no outer whitespace. */
function normalizeValue(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export function mountSecretSetup(
  app: Express,
  { tokens, secrets, logger, origin, declared, present }: SecretSetupDeps,
): void {
  // Binds a render cookie to its token. Never leaves the process.
  const cookieKey = randomBytes(32);
  const bind = (token: string, nonce: string) =>
    createHmac("sha256", cookieKey)
      .update(`plughive.setup-render.v1:${token}:${nonce}`)
      .digest("base64url");
  const secure = (req: Request) => req.secure || origin.base().startsWith("https:");
  const cookieAttrs = (req: Request, maxAge: number) =>
    `Path=/setup; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure(req) ? "; Secure" : ""}`;
  /** A fresh nonce for every render of the page. */
  const setRenderCookie = (req: Request, res: Response, token: string) => {
    const nonce = randomBytes(16).toString("base64url");
    res.append(
      "Set-Cookie",
      `${cookieName(token)}=${nonce}.${bind(token, nonce)}; ${cookieAttrs(req, COOKIE_MAX_AGE_S)}`,
    );
  };
  const clearRenderCookie = (req: Request, res: Response, token: string) => {
    res.append("Set-Cookie", `${cookieName(token)}=; ${cookieAttrs(req, 0)}`);
  };
  /** The POST carries the cookie a render of the page set for this token. */
  const rendered = (req: Request, token: string): boolean => {
    const value = readCookie(req, cookieName(token));
    if (!value) return false;
    const dot = value.indexOf(".");
    if (dot <= 0) return false;
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(bind(token, value.slice(0, dot)));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  /** True when the key has a value now. A failing check counts as set: nothing is replaced blind. */
  const alreadySet = async (secret: string): Promise<boolean> => {
    if (!present) return false;
    try {
      return (await present(secret)) !== false;
    } catch {
      return true;
    }
  };
  const alreadySetPage = (res: Response, pack: string, secret: string) =>
    message(
      res,
      409,
      "Key already set",
      `${secret} for the pack ${pack} already has a value, so this link cannot change it. To replace the key, use the plughive dashboard.`,
    );

  /**
   * One check-and-set at a time per secret name: two live setup links for the
   * same key cannot both pass `alreadySet` and race their values in.
   */
  const setChains = new Map<string, Promise<unknown>>();
  const perSecret = <T>(secret: string, task: () => Promise<T>): Promise<T> => {
    const prev = setChains.get(secret) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(task);
    setChains.set(secret, run);
    return run.finally(() => {
      if (setChains.get(secret) === run) setChains.delete(secret);
    });
  };

  /** The name as it stands now, not as it stood when the token was minted. */
  const stillWanted = async (pack: string, secret: string): Promise<boolean> => {
    if (isDeniedSecretName(secret)) return false;
    if (!declared) return true;
    try {
      return (await declared(pack, secret)) === true;
    } catch {
      return false;
    }
  };

  app.get("/setup/secret", async (req: Request, res: Response) => {
    const token = req.query.token;
    // A used token fails here too: the link cannot be replayed after a save.
    const check = tokens.verify(token);
    if (!check.ok) return rejected(res, check.reason);
    if (await alreadySet(check.claim.secret)) {
      return alreadySetPage(res, check.claim.pack, check.claim.secret);
    }
    setRenderCookie(req, res, token as string);
    form(res, token as string, check.claim, req.query.multiline === "1");
  });

  app.post(
    "/setup/secret",
    express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT, parameterLimit: 4 }),
    async (req: Request, res: Response) => {
      if (!postAllowed(req, origin)) {
        return message(
          res,
          403,
          "Request refused",
          "This form can only be submitted from the plughive setup page.",
        );
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const check = tokens.verify(body.token);
      if (!check.ok) return rejected(res, check.reason);
      const token = body.token as string;
      if (!rendered(req, token)) {
        // Not consumed: the user can open the link again and submit from the page.
        logger?.warn(
          { pack: check.claim.pack, secret: check.claim.secret },
          "setup page refused a submission that did not come from the rendered form",
        );
        return message(
          res,
          403,
          "Request refused",
          "Open the setup link in your browser and submit the form on that page. If the page was open for more than ten minutes, run the tool again to get a new link.",
        );
      }
      const value = typeof body.value === "string" ? normalizeValue(body.value) : "";
      if (value === "" || value.length > MAX_SECRET_VALUE_LENGTH) {
        // The token is not consumed: the user can go back and try again.
        return message(
          res,
          400,
          "Key not saved",
          "The key was empty or too long. Go back and try again.",
        );
      }
      // Burn the token before storing, so a concurrent replay cannot overwrite the value.
      const burned = tokens.consume(body.token);
      if (!burned.ok) return rejected(res, burned.reason);
      const { pack, secret } = burned.claim;
      if (!(await stillWanted(pack, secret))) {
        logger?.warn({ pack, secret }, "setup page refused a secret no enabled pack declares");
        return message(
          res,
          409,
          "Key not saved",
          "No enabled pack asks for this key any more, so it was not stored. Run the tool again to get a new link.",
        );
      }
      clearRenderCookie(req, res, token);
      // The "is it set yet" check and the store run as one step per secret, so
      // a second link for the same key sees the first one's value.
      const outcome = await perSecret(secret, async () => {
        if (await alreadySet(secret)) return "already_set" as const;
        try {
          await secrets.set(secret, value);
          return "saved" as const;
        } catch {
          // Never log the cause: a store error could quote the value.
          return "store_failed" as const;
        }
      });
      if (outcome === "already_set") {
        logger?.warn(
          { pack, secret },
          "setup page refused to replace a secret that is already set",
        );
        return alreadySetPage(res, pack, secret);
      }
      if (outcome === "store_failed") {
        logger?.warn({ pack, secret }, "setup page could not store the secret");
        return message(
          res,
          500,
          "Key not saved",
          "The key could not be stored. Run the tool again to get a new link.",
        );
      }
      logger?.info({ pack, secret }, "secret set through the setup page");
      message(
        res,
        200,
        "Key saved",
        `${secret} is stored. Return to your MCP client and run the tool again.`,
      );
    },
  );

  // Body-parser errors (oversized or malformed form bodies).
  app.use(
    "/setup/secret",
    (err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
      const status = (err as { status?: number }).status === 413 ? 413 : 400;
      message(res, status, "Request refused", "The submitted form could not be read.");
    },
  );
}
