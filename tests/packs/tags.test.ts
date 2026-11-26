// tests/packs/tags.test.ts
//
// Table-driven check of the policy tags on pack tools. PolicyGate.runTool
// (src/core/policy/gate.ts) only enforces spend caps, auto-approve and
// ask-before-sending for tools tagged "paid" / "sends" (or destructive), so a
// tool that bills an API directly — not through ctx.capabilities.run, which the
// capability router gates separately — must carry "paid", and a tool that
// reaches another person (message, email, post, call, booking) must carry
// "sends". Free reads (listing models, usage, history) and free-tier APIs (the
// Telegram bot API, Unsplash/Pexels/Massive/Alpha Vantage reads) stay untagged
// on purpose.
import { describe, expect, it } from "vitest";
import { loadBuiltinPacks } from "./support.js";

/** Tools that call a billed API directly with the pack's own key. */
const MUST_BE_PAID = [
  // gemini: generation and chat tools hit generativelanguage.googleapis.com
  "gemini_generate_image",
  "gemini_generate_video",
  "gemini_generate_speech",
  "gemini_generate_music",
  "gemini_transcribe",
  "gemini_chat",
  // elevenlabs: every generation tool uses credits
  "elevenlabs_text_to_speech",
  "elevenlabs_sound_effect",
  "elevenlabs_music",
  "elevenlabs_dub",
  "elevenlabs_transcribe",
  "elevenlabs_isolate_voice",
  // seo: DataForSEO is billed per request
  "seo_serp",
  "seo_keyword_volume",
  "seo_keywords_for_site",
  "seo_backlinks",
  "seo_onpage",
  // growth: the lead provider is billed per call; the aliases inherit the tag
  "find_people",
  "find_companies",
  "enrich_person",
  "enrich_people",
  "enrich_company",
  "pipeline_run",
  "apollo_search_people",
  "apollo_search_companies",
  "apollo_enrich_person",
  "apollo_bulk_enrich_people",
  "apollo_enrich_company",
  // dub: link creation is metered
  "dub_shorten_url",
  // phone: SMS segments and call minutes are billed
  "twilio_send_sms",
  "vapi_create_call",
  // web: Firecrawl credits
  "firecrawl_scrape",
  "firecrawl_search",
  "firecrawl_map",
  "firecrawl_crawl",
  // browser: sessions billed per minute, fetch API per call
  "browserbase_create_session",
  "browserbase_fetch",
  "steel_create_session",
  "steel_navigate",
  "steel_screenshot",
  // maps: billed per request
  "google_geocode",
  "google_places_search",
  "google_directions",
  "mapbox_geocode",
  "mapbox_directions",
  // already tagged before this table existed; kept so a refactor cannot drop them
  "fal_run",
  "fal_train_lora",
  "replicate_run",
  "replicate_train_lora",
  "x402_fetch",
  "openrouter_run",
  "openrouter_chat",
];

/** Tools that reach another person. */
const MUST_SEND = [
  "send_telegram",
  "twilio_send_sms",
  "vapi_create_call",
  "resend_send_email",
  "agentmail_reply",
  "ayrshare_post",
  "ayrshare_delete_post",
  "calcom_create_booking",
  "calcom_cancel_booking",
  // share: a public link reaches whoever gets it (R2-M1)
  "share_artifact",
  "share_unshare",
];

describe("pack tool tags", () => {
  it("tags every direct billed tool paid and every sending tool sends", async () => {
    const h = await loadBuiltinPacks();
    try {
      // x402 is disabled until enabled explicitly; its tools must be tagged too.
      await h.loader.enable("x402");
      const byName = new Map(h.registry.list().map((t) => [t.name, t]));
      for (const name of MUST_BE_PAID) {
        const t = byName.get(name);
        expect(t, `${name} is registered`).toBeDefined();
        expect(t!.tags, `${name} tags`).toContain("paid");
      }
      for (const name of MUST_SEND) {
        const t = byName.get(name);
        expect(t, `${name} is registered`).toBeDefined();
        expect(t!.tags, `${name} tags`).toContain("sends");
      }
      // A quote never pays, so it must not be gated as paid.
      expect(byName.get("x402_quote")!.tags).not.toContain("paid");
    } finally {
      await h.close();
    }
  });
});
