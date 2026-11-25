// Errors in plain words: what happened, why, and the one next step (with a
// link that does it). Pure, so it can be tested without a DOM. Never echoes
// a secret value: the daemon already redacts, and only names are used here.
import { t } from "../i18n";
import { ApiError } from "./api";
import { displayName } from "./format";

export interface HumanError {
  /** What happened, one short sentence. */
  what: string;
  /** Why, when we can tell. */
  why?: string;
  /** The one next step, as an in-app link. */
  next?: { label: string; to: string };
  /** The raw message, for a details disclosure. */
  detail?: string;
}

interface Shape {
  code?: string;
  message: string;
  status?: number;
  pack?: string;
  secret?: string;
  label?: string;
}

function shapeOf(e: unknown): Shape {
  if (e instanceof ApiError) {
    const d = e.details;
    return {
      code: e.code,
      message: e.message,
      status: e.status,
      ...(typeof d.pack === "string" ? { pack: d.pack } : {}),
      ...(typeof d.secret === "string" ? { secret: d.secret } : {}),
      ...(typeof d.label === "string" ? { label: d.label } : {}),
    };
  }
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    return {
      ...(typeof o.code === "string" ? { code: o.code } : {}),
      message:
        typeof o.message === "string"
          ? o.message
          : typeof o.code === "string"
            ? o.code
            : t("errors.somethingWentWrong"),
      ...(typeof o.pack === "string" ? { pack: o.pack } : {}),
      ...(typeof o.secret === "string" ? { secret: o.secret } : {}),
      ...(typeof o.label === "string" ? { label: o.label } : {}),
    };
  }
  if (e instanceof Error) return { message: e.message };
  return { message: typeof e === "string" ? e : t("errors.somethingWentWrong") };
}

const keyLink = (pack: string) => `/packs?pack=${encodeURIComponent(pack)}&key=1`;

/** `pack` is a fallback when the error does not name one (e.g. the tool's pack). */
export function humanError(e: unknown, opts: { pack?: string } = {}): HumanError {
  const s = shapeOf(e);
  const pack = s.pack ?? opts.pack;
  const name = pack ? displayName(pack) : null;
  const raw = s.message;

  if (s.code === "MISSING_SECRET") {
    return {
      what: name ? t("errors.missingSecret.what", { name }) : t("errors.missingSecret.whatNoName"),
      why: s.label
        ? t("errors.missingSecret.whyLabel", { label: s.label })
        : t("errors.missingSecret.why"),
      ...(pack
        ? { next: { label: t("errors.missingSecret.next", { name }), to: keyLink(pack) } }
        : {}),
    };
  }
  if (s.status === 0 || /failed to fetch|networkerror|network error/i.test(raw)) {
    return {
      what: t("errors.network.what"),
      why: t("errors.network.why"),
      next: { label: t("errors.network.next"), to: "reload:" },
      detail: raw,
    };
  }
  if (s.code === "INVALID_ARGUMENTS") {
    return { what: t("errors.invalidArguments"), why: raw, detail: raw };
  }
  if (s.code === "UNKNOWN_TOOL") {
    return {
      what: t("errors.unknownTool.what"),
      why: t("errors.unknownTool.why"),
      next: { label: t("errors.unknownTool.next"), to: "/packs" },
      detail: raw,
    };
  }
  if (s.code === "CANCELLED" || /cancel+ed/i.test(raw)) {
    return { what: t("errors.cancelled"), detail: raw };
  }
  // Provider answers, seen through tool errors.
  if (
    /\b(401|403)\b|unauthori[sz]ed|invalid api key|invalid key|forbidden|authentication/i.test(raw)
  ) {
    return {
      what: name ? t("errors.auth.what", { name }) : t("errors.auth.whatNoName"),
      why: t("errors.auth.why"),
      ...(pack ? { next: { label: t("errors.auth.next", { name }), to: keyLink(pack) } } : {}),
      detail: raw,
    };
  }
  if (/\b402\b|insufficient|balance|credits?|quota|billing|payment/i.test(raw)) {
    return {
      what: name ? t("errors.credit.what", { name }) : t("errors.credit.whatNoName"),
      why: t("errors.credit.why"),
      detail: raw,
    };
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(raw)) {
    return {
      what: t("errors.rateLimited.what"),
      why: t("errors.rateLimited.why"),
      detail: raw,
    };
  }
  if (/timed? ?out|timeout|ETIMEDOUT/i.test(raw)) {
    return {
      what: t("errors.timeout.what"),
      why: t("errors.timeout.why"),
      detail: raw,
    };
  }
  if (/\b5\d\d\b|bad gateway|service unavailable|internal server error/i.test(raw)) {
    return {
      what: t("errors.serverError.what"),
      why: t("errors.serverError.why"),
      detail: raw,
    };
  }
  if (/no_provider|no provider/i.test(raw)) {
    return {
      what: t("errors.noProvider.what"),
      why: t("errors.noProvider.why"),
      next: { label: t("errors.noProvider.next"), to: "/packs" },
      detail: raw,
    };
  }
  return { what: firstSentence(raw), detail: raw };
}

/** One line for a table row. */
export function oneLine(e: unknown, opts: { pack?: string } = {}): string {
  return humanError(e, opts).what;
}

function firstSentence(text: string): string {
  const txt = text.trim().replace(/\s+/g, " ");
  if (!txt) return t("errors.somethingWentWrong");
  const m = /^(.{1,160}?[.!?])(\s|$)/.exec(txt);
  const s = m?.[1] ?? (txt.length > 160 ? `${txt.slice(0, 157)}…` : txt);
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}
