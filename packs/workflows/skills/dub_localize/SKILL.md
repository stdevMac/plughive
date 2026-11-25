---
name: dub_localize
description: Dub a library video or audio file into 1-5 languages with wf_dub_localize - ElevenLabs dubbing when set up, otherwise transcribe, translate and text-to-speech. Runs as a job; dry run first.
---

# Dub and localize (`wf_dub_localize`)

## When to use
The user has a video or audio artifact and wants versions in other languages. The source is never changed; each language is a new artifact.

## Inputs
- `artifact_id` (required), `languages` (required, 1-5 codes such as es, fr, pt-BR).
- `media`: video (default) or audio. `source_language` (omit to detect). `voice`: the text-to-speech voice of the fallback path.

## Two paths
- With `elevenlabs_dub` available (ElevenLabs key set): `dubs` dubs each language (two at a time, up to 25 minutes each, original voices kept); for a video `dub_videos` swaps the audio track locally.
- Otherwise: `transcript` (one transcription), `translations` (one `chat` per language), `speech` (one speech call per language), and for a video `tts_videos` lays each track under the picture. Timing is not lip-synced; long sources are cut at 8000 characters per language.

Paid calls: one per language on ElevenLabs (billed per minute of media), or 1 + 2 per language on the fallback path. The dry run shows which path the run takes (`runs` is "no" on the other path's steps).

## Dry run
Call it with `"dry_run": true` to see the path, what is missing and `paid_calls_max`.

## Recovering by hand
Nothing is retried. A failed language stops the run; the error lists the languages that finished with their artifact ids. Dub the missing one with `elevenlabs_dub` (or `elevenlabs_get_dub` with the project id from its error), then `local_video_mux_audio` with mode replace.
