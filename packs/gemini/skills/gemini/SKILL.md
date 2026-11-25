---
name: gemini
description: Use Google Gemini for images, video, speech, music, transcription and chat through your own GEMINI_API_KEY. Covers model choice, cost, and how to chain library artifacts.
---

# Gemini pack

Every tool here spends the user's own Gemini quota. Pick the cheapest model that does the job, and say what a call will cost before making several.

## Tools

| Tool | Use it for | Default model | Rough cost |
| --- | --- | --- | --- |
| `gemini_list_models` | Discover what the key can use. Call before choosing a non-default model. | n/a | free |
| `gemini_generate_image` | Make or edit pictures. Pass `image_inputs` (library artifact ids) to edit. | `gemini-nano-banana-2.1` | about $0.034 (1K), $0.05 (2K), $0.11 (4K) per image |
| `gemini_generate_video` | 3 to 15 s clips, optional first and last frame. | `gemini-omni-1.2-flash` | about $0.07/s at 720p, $0.10 at 1080p, $0.21 at 4k |
| `gemini_generate_speech` | Narration, dialogue (two speakers). | `gemini-3.8-flash-tts` | small, token based |
| `gemini_generate_music` | Songs and clips with Lyria. | `lyria-3.5` | $0.08 full song, $0.04 for `lyria-3-clip-preview` |
| `gemini_transcribe` | Audio or video artifact to text, optional speakers and timestamps. | `gemini-3.5-transcribe` | token based |
| `gemini_chat` | Text reasoning, JSON extraction. | `gemini-4-hydrogen` | token based |
| `gemini_get_interaction` | Collect a video or music job by `interaction_id` (after a timeout). | n/a | free (no resubmit) |

## Choosing well

- Images: start at 1K. Only ask for 2K or 4K when the user needs print or large display. Make `n` small, each image is a separate paid request.
- Video: this is the expensive tool. Use 720p and a short duration for drafts, then re-run once at 1080p. Video takes minutes; the call reports progress and can be cancelled.
- Video from a still: generate or pick the image first, then pass its artifact id as `image_input` so the first frame is exactly what the user approved.
- Speech: choose a voice by name (default Kore). Use `style` for delivery ("calm", "excited"). For dialogue pass two `speakers` and prefix lines with the speaker names. Output is a 24 kHz WAV.
- Music: length cannot be set exactly. `duration_seconds` is a hint, 30 s or less selects the cheaper clip model. Use the full model for a real song.
- Chat: `gemini-4-carbon` for hard reasoning, `gemini-3.5-flash-lite` for cheap bulk work. Set `json: true` when you will parse the answer.
- Transcribe: files must be 15 MB or less. Re-encode longer audio to a lower bitrate or split it first.

## Inputs and outputs

- Media inputs are always library artifact ids, never file paths or URLs. Use the id returned by an earlier tool call.
- Media inputs may be artifacts any tool saved (for example a fal image), not only Gemini's own.
- Generated files land in the library. Results look like `{ artifacts: [{id, url, mime}], model, provider, cost_usd_estimate }`. Hand the `url` to the user and keep the `id` for chaining.
- `cost_usd_estimate` is an estimate from published prices and returned token counts, not the billed amount. It is not recorded as the artifact's cost.

## When something fails

- "refused the API key": ask the user to set or fix `GEMINI_API_KEY`.
- Rate limit or quota: wait, or pick a cheaper model. Do not loop retries.
- "no image/video returned": the safety filter likely blocked the prompt. Rephrase rather than retrying unchanged.
- Unknown model: run `gemini_list_models` and use an id from it.
- The `seed` option is accepted but ignored by this API.

## Long jobs, cancels and collecting

- Video and music run as background interactions. Results include `interaction_id`.
- If a job outlives the wait limit it is **not** cancelled (it is already paid for). The error names the interaction id: collect it with `gemini_get_interaction {interaction_id}` instead of resubmitting, which would bill twice.
- Cancelling a call sends a cancel request to Gemini. The error says whether it was sent; work Gemini already did may still be billed.
- With `n > 1` images, images made before a failure are kept and returned with a `note`.

## Needs live verification

These were checked against the public docs only; no keyed calls were made.

- Transcription body (`gemini_transcribe`): matches the audio docs (`input` array with an `audio` part, JSON `response_format` with `{speaker, timestamp, content}` segments), but has not been run against the live API.
- `gemini_chat`: the `system_instruction` and `generation_config` field shapes are not confirmed by the API reference.
- Interaction cancel (`POST /v1beta/interactions/{id}/cancel`) and whether a cancelled job is billed.
- The prices behind `cost_usd_estimate`.
