---
name: openrouter
description: Chat with any OpenRouter text model, and generate images, video and speech or transcribe audio through OpenRouter with the user's own OpenRouter key. Use when the user wants a specific OpenRouter model, wants one key for many vendors (Google, OpenAI, ByteDance, ElevenLabs and more), or asks what OpenRouter can do for a task.
---

# OpenRouter

OpenRouter puts hundreds of text models and a growing set of image, video, speech and speech-to-text models behind one key. This pack gives you chat, catalog search with each model's real parameters, and runners that save every output file to the library.

## Which tool

- `openrouter_chat`: chat completions with any text model. Supports `temperature`, `max_tokens`, `response_format` (or `json: true`), `tools`, `tool_choice`, `provider` routing and `reasoning`. Image parts may point at a library file with `"url": "artifact:<id>"`. Returns `text`, `tool_calls`, `usage` and `cost_usd`; `include_raw` adds the full response.
- `openrouter_generate_image`, `openrouter_generate_video`, `openrouter_generate_speech`, `openrouter_transcribe`: typed shortcuts with sensible default models. A field the chosen model does not support is an error that names what it does support.
- `openrouter_search_models`: with `modality` `image`, `video` or `speech` it filters OpenRouter's media catalogs; otherwise it searches the main model list (chat, transcription). No key needed.
- `openrouter_describe_model`: a model's kind, parameters, prices and a ready `openrouter_run` call. No key needed.
- `openrouter_video_result`: collect a video job an earlier call submitted, with `{job_id}`. Never submits or pays for a new job. Returns the saved video, or the job's status if it is still running.
- `openrouter_run`: run any video, image, speech or transcription model with `{model, input}`. The input is checked against the model's catalog parameters before anything is sent, so a bad field costs nothing.
- Per-model tools such as `openrouter_google_veo_3_1_fast` or `openrouter_openai_gpt_image_2` take the model's own fields. The user picks which models get one with the `models` setting.

## Files in and out

- Pass library files as `"artifact:<id>"`: video `first_frame` / `last_frame` / `input_references`, image `input_references`, transcription `audio`. They are sent inline, up to 20 MB each (25 MB for audio to transcribe). https URLs are refused unless the user turns on the `allow_url_inputs` setting, because OpenRouter and the model provider fetch them.
- Image models must return image data (`b64_json`); a model that only returns links fails, and the generation is still billed.
- Output files are saved to the library. The result lists them in `artifacts` (`id`, `url`, `mime`), and inside `output` each file is replaced by its `artifact_id`.

## Cost notes

- Every generation and chat call is billed to the user's OpenRouter credits. `cost_usd` is OpenRouter's own figure when it reports one.
- Video is the expensive one: prices are per second of output (see `pricing` in `openrouter_describe_model`). Confirm length and resolution with the user before long or 4K runs.
- OpenRouter has no way to cancel a video job. If a call is cancelled, times out (`max_wait_minutes` setting) or loses contact, the job keeps running and is billed. The error quotes the job id: collect it with `openrouter_video_result`, never by running the model again.
- `openrouter_chat` refuses `max_tokens` above the `max_chat_tokens` setting (default 32768). Speech results have no `cost_usd`.
- Searching and describing models is free and needs no key.

## Setup

Everything except search and describe needs `OPENROUTER_API_KEY`, created at https://openrouter.ai/settings/keys. If a call fails with `MISSING_SECRET`, ask the user to set it. HTTP 401 means the key is wrong; 402 means the account is out of credits (top up at https://openrouter.ai/settings/credits); 429 means slow down and retry.

## Tips

- Use parameter values exactly as `openrouter_describe_model` lists them (for example `resolution: "1080p"`, `aspect_ratio: "16:9"`, `duration: 8`).
- Video `duration` must be one of the model's listed lengths; `openrouter_generate_video` snaps `duration_seconds` to the nearest one.
- Speech returns mp3 unless the model and `response_format` say `pcm` (raw 16-bit audio, saved as `audio/pcm`).
- When search or describe returns `source_note`, the data came from the bundled catalog snapshot and may be out of date.

## Needs live verification

These behaviours come from OpenRouter's docs and were not checked against the live API:

- That `elevenlabs/scribe-v2` (the default transcription model) exists.
- Where a speech call's cost is reported (the pack reports none).
- Which image models return links instead of `b64_json`, and on which hosts.
- The video job id format and the shape of `GET /videos/{id}` right after submit.
