---
name: elevenlabs
description: Use ElevenLabs for voiceover, sound effects, music, dubbing, transcription and noise removal through your own ELEVENLABS_API_KEY. Covers voice and model selection and credit awareness.
---

# ElevenLabs pack

ElevenLabs bills in credits (roughly one per character of speech). Check `elevenlabs_usage` before big jobs and tell the user what a request will use.

## Tools

| Tool | Use it for |
| --- | --- |
| `elevenlabs_usage` | Tier, characters used and remaining, reset date. Free. |
| `elevenlabs_list_models` | Speech models and their limits. |
| `elevenlabs_list_voices` | Find a voice. Filter by `search`, `gender`, `accent`, `use_case`, `category`. |
| `elevenlabs_text_to_speech` | Voiceover, up to 5000 characters per call. |
| `elevenlabs_sound_effect` | Foley and effects, 0.5 to 30 s. |
| `elevenlabs_music` | Songs and beds, 3 to 600 s (music_v2_5). Slow. |
| `elevenlabs_dub` | Translate and re-voice a clip into another language. Very slow. Returns FLAC audio only, even for video input. |
| `elevenlabs_get_dub` | Collect a dub by `dubbing_id` (after `elevenlabs_dub` timed out). Never submits a new job. |
| `elevenlabs_transcribe` | Speech to text with Scribe (scribe_v3), optional speakers and timestamps. |
| `elevenlabs_isolate_voice` | Strip noise and music, keep the voice. |

## Picking a voice

1. Decide the need first: narration, conversational, character, ad read.
2. Call `elevenlabs_list_voices` with `use_case`, `gender` and `accent` and a small `limit` (5 to 10). Rows are compact; do not page through everything.
3. Offer the user two or three candidates with their `preview_url`, then pass the chosen `id` as `voice`.
4. Reuse the same voice and model across a project so the sound stays consistent.

## Picking a model

- `eleven_multilingual_v2` (default): best all-round quality, 29 languages.
- `eleven_flash_v2_5`: fastest and cheaper, good for drafts and many short lines.
- `eleven_v3`: most expressive, supports audio tags like `[whispers]`. Check `elevenlabs_list_models` that the key has it.
- Draft with flash, finalise with multilingual or v3. Long scripts: split at paragraph boundaries into calls under 5000 characters and keep the same voice, `seed` and settings.
- `stability` lower is more emotional, higher is steadier. Leave the defaults unless the user asks.

## Inputs and outputs

- Media inputs are library artifact ids only, never paths or URLs. Use the id from an earlier result.
- Results look like `{ artifacts: [{id, url, mime}], model, provider, characters_used }`. Share the `url`, keep the `id` to chain (for example sound effect or music, then `elevenlabs_isolate_voice` or a transcript).
- Input files are limited to 50 MB. Trim longer media first.
- Music and dubbing are long running. They report progress, can be cancelled, and a single request is limited to 60 seconds by the host, so very long music may fail: ask for a shorter duration and join pieces afterwards.

## Cost habits

- Music and dubbing cost the most. Confirm length and language with the user first.
- Do not regenerate to compare minor wording; change the text once, then render.
- A 429 means too many concurrent requests on the plan. Run jobs one at a time rather than retrying in a loop.

## When something fails

- "refused the API key": ask the user to fix `ELEVENLABS_API_KEY`.
- "plan or credits cannot cover": run `elevenlabs_usage`, shorten the text, or stop and tell the user.
- "does not know that voice": the id is stale or from another account. List voices again.
- Dubbing "still running": the job continues on ElevenLabs and is billed. Collect it with `elevenlabs_get_dub {dubbing_id}` using the id in the error. Do not run `elevenlabs_dub` again, that bills a second time.
- Dubbing "stale": the transcript was edited after the audio was rendered. Nothing new was started; re-render it in the ElevenLabs dubbing editor, then collect it.

## Dubbing lifecycle

- Results and errors name the dubbing project id. The dubbed FLAC comes from a signed `storage.googleapis.com/eleven-dubbing/...` link that expires after an hour; `elevenlabs_get_dub` fetches a fresh one. Links anywhere else are refused.
- Cancelling a dub sends a DELETE for the project (ElevenLabs has no cancel endpoint). The error says whether it was sent. A dub that had already started is still billed.

## Needs live verification

Checked against the public docs only; no keyed calls were made.

- The `scribe_v3` model id (default for `elevenlabs_transcribe`).
- The dubbing flow end to end: project and language status values, `outputs.lossless_audio`, and the output link host and path.
- Whether the DELETE after a cancel stops billing for a dub that has not started yet.
