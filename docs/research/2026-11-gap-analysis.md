# plughive gap analysis (2026-11-24)

Goal: make plughive the one thing a person sets up. After that, it tells
them what else they need, installs local software for them, and connects
to the keys and app logins they already have.

Method: an inventory of this repo, plus four web research passes. They
covered media aggregators, MCP gateways, agent-utility APIs and local
installers / CLI bridges. Prices are as found on 2026-11-24; ones marked
"~" are approximate. Check them before relying on them.

## 1. What plughive has today

16 packs, 111 tools, bring-your-own-key (BYOK), local daemon, 0% markup.

| Area | Have |
| --- | --- |
| Media routing (`media` pack) | 6 capabilities: image, video, speech, music, transcribe, chat, with fallback and cooldowns |
| Model marketplaces | OpenRouter, fal (1000+ models), Replicate, Gemini, ElevenLabs |
| Local | ffmpeg tools, whisper.cpp, Ollama chat/embed, Kokoro, ComfyUI, pandoc. **Detected only; prints an `install_hint`, never installs** |
| Web | Firecrawl scrape/search/map/crawl, Playwright screenshot |
| Growth / SEO | Apollo leads plus a local lead store, AI scoring and outreach drafting; DataForSEO |
| Messaging / links | Telegram, Dub |
| Remote MCP mounts | 17 preconfigured (Exa, Tavily, Browserbase, GitHub, Linear, Notion, ...), header/query auth only. **OAuth-only servers can't be mounted** |
| Platform | Tool search/describe/execute, profiles, jobs, artifact library, usage ledger with cost estimates, workflow dry-run, machines (SSH), user packs |
| Missing platform pieces | Spend caps, approvals, webhooks/triggers/schedules, response caching, MCP resources/prompts |

## 2. What the market does

**Media aggregators** (fal, Replicate, Runware, WaveSpeed, Kie.ai, Segmind,
Krea, Magnific, Higgsfield, ...)
- Sell 200–1000+ models across image, video, audio, 3D and training.
- Common features: async queue with webhooks, CDN uploads, a price-estimate
  endpoint, no charge for failed jobs, LoRA training, and pipeline builders
  (Segmind PixelFlow, fal workflows).
- Most now ship an official MCP server: fal, Replicate, Runware, Krea,
  Magnific.
- Markup: Kie.ai and Runware claim prices 30–80% below the official rate.
  Others set their own per-output prices.

**LLM gateways** (OpenRouter, Vercel, Cloudflare, LiteLLM, Portkey)
- Fees: OpenRouter takes **5.5% on credits** (BYOK free to $25k/mo);
  Cloudflare Unified Billing +5%; Eden AI +5.5%; Vercel 0% markup with
  paid add-ons.
- Features: budgets per key/user/project, fallback, caching, rate limits,
  guardrails/data-loss prevention (DLP), OpenTelemetry tracing, cost
  analytics.

**MCP / app gateways** (Composio/Rube, Pipedream, Zapier MCP, Arcade, Nango,
Merge, Docker MCP Toolkit, Cloudflare portals, Kong)
- Size: 600 to 9,000 apps.
- Standard features: managed OAuth with per-user connected accounts, tool
  search and execute meta-tools, allowlists, call logs.
- Differentiators: triggers/webhooks, code mode / sandboxes, DLP, per-action
  authorisation, self-host.
- Pricing: ~$0.005–0.01 per call, or $2 per user per month.
- Nobody really ships **human-in-the-loop approvals**. That is an opening.
- Market churn: Smithery's hosted services shut down on 2026-10-31 (it joined
  Arcade). mcp.run is winding down. Pipedream is now Workday's.

**Pay-per-call marketplaces**
- RapidAPI takes 25%, Apify 20%, Nevermined 1–2%.
- Coinbase x402 has a ~0% facilitator fee (USDC per call, no API key);
  AgentCash wraps it as an MCP.
- Stripe MPP and Cloudflare Monetization Gateway charge per MCP tool call.

**Our position:** BYOK, local and 0% markup is a real differentiator against
every gateway above. Keep it. To charge later, the natural add-ons are
optional x402 pay-per-call (no keys needed at all) or a hosted tier. Raw
markup is not.

## 3. Gaps, in priority order

### Tier 1: "only set up plughive" foundations

1. **Setup advisor.**
   - A `setup_plan` tool plus a Home step. The user says what they want
     ("make short videos", "find clients", "transcribe meetings").
   - It answers with the keys, installs and logins that unlock it, what each
     costs, and the free/local path first. It is built from pack manifests
     plus the `local_status` detection we already have.
2. **Managed installer** (`install_software`, `uninstall_software`,
   `list_installable`).
   - Runs as background jobs in a no-sudo prefix
     `~/.plughive/tools/<name>/<version>`.
   - Sources: Homebrew, `uv tool install`, or binaries pinned by SHA256
     stored in our own manifest.
   - Each install ends with a probe and is recorded in a lockfile.
   - Ask the user before large or gated downloads, showing size and licence.
   - First batch: ffmpeg, yt-dlp, ImageMagick, tesseract + ocrmypdf,
     pandoc, LibreOffice headless, whisper.cpp, parakeet-mlx, Kokoro,
     demucs, rembg, Real-ESRGAN (ncnn), Ollama, ComfyUI (`comfy-cli`),
     llama.cpp / MLX-LM.
3. **CLI bridge pack** (opt-in, off by default). Spawns the user's own
   official binary and parses its JSON.
   - Antigravity CLI `agy -p --output-format json`. Gemini CLI was replaced
     for personal accounts on 2026-06-18. Can also make images via its
     built-in Nano Banana tool.
   - `claude -p --output-format json`
   - `codex exec --json`
   - `opencode run --format json`
   - `copilot -p`
   - **Never read or proxy their token files.** Show each vendor's terms
     notice and offer API-key mode next to it.
     - Google warns that piggybacking on Gemini CLI OAuth can suspend the
       account.
     - Anthropic bars third parties from routing plan credentials for
       others. One user running the unmodified binary is the allowed case.
4. **Hex (anomalyco/hex) as a transcription engine.**
   - `hex transcribe <file> --json` works without the app running.
   - When the app is running, its local API on 127.0.0.1 is faster (token in
     `local-api.json`).
   - Install: `brew install --cask anomalyco/tap/hex`.
   - Plug it into `audio.transcribe` routing next to parakeet-mlx (default
     on Apple silicon), whisper.cpp and whisperX (speaker labels, needs an
     HF token).
5. **Spend controls.**
   - A per-call `max_cost_usd`, plus daily and monthly caps per provider and
     per profile, backed by the usage ledger we already have.
   - A price preview before paid calls (fal, Replicate and WaveSpeed expose
     prices).
   - Block, or ask, once over a cap.
6. **OAuth for mounts.**
   - Many official remote MCPs are OAuth-only, and the loader currently
     refuses them (`loader.ts:643`).
   - This one feature unlocks Notion, Linear, Sentry, Atlassian, Asana,
     Stripe, Cloudflare, HubSpot and more without us writing integrations.

### Tier 2: capabilities (new routed capabilities, local first, then paid)

| Capability | Local engine | Paid providers |
| --- | --- | --- |
| `image.edit` / inpaint / outpaint | ComfyUI | fal, Replicate, Gemini, OpenRouter |
| `image.upscale` | Real-ESRGAN | fal, Magnific, Replicate |
| `image.remove_background` | rembg | fal, Replicate |
| `video.lipsync`, avatar / talking head | — | fal, Replicate |
| `video.upscale`, interpolate | ffmpeg (basic) | fal, Replicate |
| `audio.separate_stems` | demucs | fal, Replicate |
| `voice.clone`, voice change | Chatterbox / F5-TTS | ElevenLabs |
| `sound.effect` | — | ElevenLabs, fal |
| `3d.generate` | — | fal (Trellis, Meshy, Hunyuan3D) |
| `document.parse` / OCR | tesseract, ocrmypdf | Mistral OCR, LlamaParse |
| `document.convert` | LibreOffice, pandoc | — |
| `translate` | Ollama | DeepL, Gemini |
| `embed`, `rerank`, `memory` | Ollama + sqlite-vec, a free local memory store | — |
| `web.search` | — | Firecrawl, Exa, Tavily, Parallel, Brave (native, routed) |
| `web.fetch` | Playwright | Firecrawl, Jina |
| `youtube/podcast.transcript` | yt-dlp + local speech-to-text | Supadata |

New packs, by agent value:
- **Code sandbox:** local Docker first, then E2B or Daytona.
- **Agent email:** Resend to send; AgentMail for an inbox the agent can
  receive and reply in.
- **SMS / voice calls:** Twilio, Vapi.
- **Cloud browser:** native Browserbase or Steel, beyond the mount.
- **Social posting:** Ayrshare.
- **Stock media:** Pexels, Unsplash, Freesound. Free; fills in b-roll for
  the video workflows.
- **Maps:** Google or Mapbox.
- **Finance data:** Polygon, Alpha Vantage.
- **Share links:** R2 or S3 public links for artifacts.
- **Calendar:** Cal.com.
- **Apps at scale:** instead of writing 1,000 integrations, offer
  Composio, Pipedream or Zapier MCP as preconfigured mounts. With OAuth
  mounts (Tier 1.6) the user picks their gateway.

### Tier 3: platform differentiators

- **Human approvals** for paid or destructive calls, from the dashboard,
  Telegram or the Mac app. Almost no competitor has this.
- **Triggers and schedules:** cron for workflows, inbound webhooks
  (for example "new email → triage"), job-done callbacks.
- **A cache** for identical paid calls (same model and input means the same
  artifact).
- **Batch runs:** many prompts, one job, a contact sheet.
- **Pass-through training** of LoRAs (fal, Replicate).
- **MCP resources/prompts:** serve the artifact library as resources and
  workflows as prompts.
- **Code mode:** one tool that runs a script against the tool registry.
- **x402 wallet pack** (optional): pay per call with no keys at all, with a
  spend cap.

## 4. Suggested build order

1. Setup advisor plus managed installer. Every later feature reuses them.
2. Local engine recipes: parakeet-mlx, Hex, whisperX, demucs, rembg,
   Real-ESRGAN, yt-dlp, OCR, LibreOffice, then the new capabilities that sit
   on them.
3. Spend caps and approvals. Needed before more paid surface area is added.
4. OAuth mounts plus app-gateway mounts (Composio, Pipedream, Zapier).
5. CLI bridge pack (opt-in, terms notice).
6. New paid packs: search routing, sandbox, email, documents, stock media,
   social.
7. Triggers and schedules, cache, batch, resources/prompts.

## Sources (main)

- fal https://fal.ai/pricing
- Replicate MCP https://replicate.com/blog/remote-mcp-server
- OpenRouter fees https://openrouter.ai/docs/faq
- Vercel AI Gateway https://vercel.com/docs/ai-gateway/pricing
- Cloudflare AI Gateway https://developers.cloudflare.com/ai-gateway/reference/pricing
- Runware https://runware.ai/llms.txt
- Composio https://composio.dev/pricing
- Pipedream https://pipedream.com/pricing
- Zapier MCP https://zapier.com/mcp
- Arcade and Smithery https://arcade.dev/blog/smithery-joins-arcade
- Docker dynamic MCP https://docs.docker.com/ai/mcp-catalog-and-toolkit/dynamic-mcp/
- x402 Bazaar https://docs.cdp.coinbase.com/x402/bazaar.md
- RapidAPI fees https://docs.rapidapi.com/docs/payouts-and-finance
- Hex https://github.com/anomalyco/hex (CLI: docs/cli.md)
- Antigravity CLI https://antigravity.google/docs/cli/headless
- Gemini CLI FAQ (OAuth piggybacking) https://geminicli.com/docs/resources/faq/
- Claude Code legal https://code.claude.com/docs/en/legal-and-compliance
- Codex auth https://learn.chatgpt.com/docs/auth
- parakeet-mlx https://pypi.org/project/parakeet-mlx/
