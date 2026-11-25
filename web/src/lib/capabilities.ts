// Preferred services: routing order, what runs now, and the free-first preset.
import { t } from "../i18n";
import { displayName } from "./format";
import type { Capability, CapabilityProvider } from "./types";

export type ProviderCost = NonNullable<CapabilityProvider["cost"]>;

/** Providers in the order the daemon tries them: the saved order first, then the rest. */
export function orderedProviders(cap: Capability): CapabilityProvider[] {
  const rank = (p: CapabilityProvider) => {
    const i = cap.preference.indexOf(p.id);
    return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
  };
  return cap.providers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);
}

export const costOf = (p: CapabilityProvider | undefined): ProviderCost => p?.cost ?? "paid";
export const isCooling = (p: CapabilityProvider) =>
  !!p.coolingDownUntil && Date.parse(p.coolingDownUntil) > Date.now();

/** The provider a call would run first, from the server or worked out here. */
export function wouldUse(cap: Capability): CapabilityProvider | null {
  if (cap.wouldUse !== undefined) {
    return cap.providers.find((p) => p.id === cap.wouldUse) ?? null;
  }
  const ready = orderedProviders(cap).filter((p) => p.configured && p.autoRoute !== false);
  return ready.find((p) => !isCooling(p)) ?? ready[0] ?? null;
}

/**
 * The "free and local first" preset: for every job with a choice, the
 * services that run on this computer go first; the rest keep their order.
 * Services that run only when named stay out (adding them would turn them on).
 */
export function freeFirstOrders(caps: Capability[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const cap of caps) {
    if (cap.providers.length < 2) continue;
    const current = orderedProviders(cap).filter(
      (p) => p.autoRoute !== false || cap.preference.includes(p.id),
    );
    const next = [
      ...current.filter((p) => costOf(p) === "local"),
      ...current.filter((p) => costOf(p) !== "local"),
    ].map((p) => p.id);
    const before = current.map((p) => p.id);
    if (next.join(",") !== before.join(",")) out[cap.name] = next;
  }
  return out;
}

/**
 * A setup hint short enough for a row: its first sentence, capitalised. The
 * full text stays available as a tooltip; agents read the full hint from the API.
 */
export function shortHint(hint: string | null | undefined): string | null {
  const text = hint?.trim();
  if (!text) return null;
  const end = text.search(/\.\s/);
  const first = (end === -1 ? text : text.slice(0, end)).replace(/\.$/, "").trim();
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Capability id -> the camelCase key of its label in locales/<code>/capabilities.json. */
const CAP_LABEL_KEY: Record<string, string> = {
  "image.generate": "imageGenerate",
  "image.edit": "imageEdit",
  "image.upscale": "imageUpscale",
  "image.remove_background": "imageRemoveBackground",
  "3d.generate": "3dGenerate",
  "video.generate": "videoGenerate",
  "video.upscale": "videoUpscale",
  "video.lipsync": "videoLipsync",
  "media.transcript": "mediaTranscript",
  "speech.generate": "speechGenerate",
  "music.generate": "musicGenerate",
  "audio.transcribe": "audioTranscribe",
  "audio.separate_stems": "audioSeparateStems",
  "voice.clone": "voiceClone",
  "sound.effect": "soundEffect",
  chat: "chat",
  "text.translate": "textTranslate",
  "text.embed": "textEmbed",
  "text.rerank": "textRerank",
  "document.parse": "documentParse",
  "document.convert": "documentConvert",
  "web.search": "webSearch",
  "web.fetch": "webFetch",
};

/** The plain-words name and blurb of a capability such as "image.upscale". */
export function capabilityLabel(name: string): { title: string; blurb: string } {
  const k = CAP_LABEL_KEY[name];
  if (k) {
    return {
      title: t(`capabilities.labels.${k}.title`),
      blurb: t(`capabilities.labels.${k}.blurb`),
    };
  }
  return { title: displayName(name), blurb: name.replace(/[._]/g, " ") };
}
