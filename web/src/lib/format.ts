// Small, locale-aware formatting helpers. They format for the dashboard's
// chosen language (see ../i18n).
import { getLocale, t } from "../i18n";

export function formatUsd(
  value: number | null | undefined,
  opts: { estimate?: boolean } = {},
): string {
  const v = value ?? 0;
  const digits = v !== 0 && Math.abs(v) < 0.1 ? 4 : 2;
  const s = new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(v);
  return opts.estimate ? `~${s}` : s;
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat(getLocale()).format(value ?? 0);
}

export function formatBytes(bytes: number | null | undefined): string {
  const b = bytes ?? 0;
  if (b < 1024) return t("format.bytes.b", { value: String(b) });
  const units = ["kb", "mb", "gb", "tb"] as const;
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return t(`format.bytes.${units[i]}`, { value: v.toFixed(v >= 10 ? 0 : 1) });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return t("format.duration.ms", { value: String(Math.round(ms)) });
  const s = ms / 1000;
  if (s < 60) return t("format.duration.s", { value: s.toFixed(s < 10 ? 1 : 0) });
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return t("format.duration.minSec", { min: String(m), sec: String(rem) });
  const h = Math.floor(m / 60);
  return t("format.duration.hMin", { h: String(h), min: String(m % 60) });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(getLocale(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.round((now - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 45) return t("common.time.justNow");
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), "hour");
  return rtf.format(-Math.round(diff / 86400), "day");
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** "openrouter" -> "OpenRouter" for the providers the dashboard knows; else capitalized.
 *  Product and pack names stay as they are; plain-word pack names are translated
 *  (format.names.*) so languages can localize them. */
const NAMES: Record<string, string> = {
  openrouter: "OpenRouter",
  fal: "fal",
  replicate: "Replicate",
  gemini: "Gemini",
  elevenlabs: "ElevenLabs",
  pdf: "PDF",
  seo: "SEO",
  dub: "Dub",
  telegram: "Telegram",
  deepl: "DeepL",
  exa: "Exa",
  jina: "Jina",
  mistral: "Mistral",
  tavily: "Tavily",
  parallel: "Parallel",
  brave: "Brave",
  supadata: "Supadata",
};

/** Pack ids whose display name is a plain word, mapped to its message key. */
const NAME_KEYS: Record<string, string> = {
  local: "format.names.local",
  core: "format.names.core",
  media: "format.names.media",
  web: "format.names.web",
  growth: "format.names.growth",
  machines: "format.names.machines",
  mounts: "format.names.mounts",
  gateway: "format.names.mounts",
  email: "format.names.email",
  phone: "format.names.phone",
  maps: "format.names.maps",
  social: "format.names.social",
  calendar: "format.names.calendar",
  memory: "format.names.memory",
  workflows: "format.names.workflows",
  "finance-data": "format.names.financeData",
  stock: "format.names.stock",
  browser: "format.names.browser",
  share: "format.names.share",
  sandbox: "format.names.sandbox",
  "cli-bridge": "format.names.cliBridge",
  x402: "format.names.x402",
};

// Packs that host several unrelated services are named by the service.
const PROVIDER_NAMES: Record<string, string> = {
  "web/firecrawl": "Firecrawl",
};

const PROVIDER_NAME_KEYS: Record<string, string> = {
  "web/browser": "format.names.headlessBrowser",
};

/** The name to show for one provider of a capability. */
export function providerDisplayName(pack: string, id: string): string {
  const k = `${pack}/${id}`;
  const key = PROVIDER_NAME_KEYS[k];
  if (key) return t(key);
  return PROVIDER_NAMES[k] ?? displayName(pack);
}

/**
 * Who made an artifact. The router saves a provider's output as
 * `<pack>/provider:<capability>`, which is not a tool you can open: show it as
 * "Local · image.upscale" with no tool to link to.
 */
export function artifactSource(tool: string): { label: string; tool: string | null } {
  const m = /^([^/]+)\/provider:(.+)$/.exec(tool);
  return m ? { label: `${displayName(m[1] ?? "")} · ${m[2]}`, tool: null } : { label: tool, tool };
}

export function displayName(id: string): string {
  const key = NAME_KEYS[id];
  if (key) return t(key);
  return NAMES[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : id);
}

export function humanizeKey(key: string): string {
  const s = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : key;
}
