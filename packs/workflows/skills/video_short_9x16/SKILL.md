---
name: video_short_9x16
description: Make a vertical 9:16 short (Reels, Shorts, TikTok) from a topic with wf_video_short_9x16 - planned shots, generated clips, voice-over and local captions. Runs as a job; dry run first.
---

# Vertical short (`wf_video_short_9x16`)

## When to use
The user wants a finished vertical short from an idea, not single clips. For one clip use `generate_video`; for a narrated ad with a script first use `wf_video_narrated_ad`.

## Inputs
- `topic` (required), `style`, `language` (default en), `voice`.
- `max_shots` 2-8 (default 4), `shot_seconds` 2-10 (default 5).
- Extras, off unless asked: `keyframes` (an image per shot as first frame), `music` (a ducked music bed). `captions` is on by default and runs locally.

## Steps and cost
1. `plan`: one `chat` call returning title, shots (prompt + narration) and a music prompt.
2. `frames` (keyframes only): one image call per shot; a failed frame is skipped.
3. `clips`: one `generate_video` call per shot, two at a time. This is the expensive part.
4. `voice`: one `generate_speech` call for the whole narration.
5. `music` + `mix` (music only): one music call, mixed locally with ducking.
6. `joined`, `muxed`: local ffmpeg concat and audio mux.
7. `captions_srt`, `captioned`: local whisper transcription and burned captions; skipped on failure.

Paid calls: 2 + max_shots by default (6 at the default 4 shots), up to 3 + 2 x max_shots with every extra (19 at 8 shots). The dry run counts the per-shot steps at their cap of 8 shots, so its `paid_calls_max` is the worst case (10 by default).

## Dry run
Call it with `"dry_run": true`. You get each step, whether it runs for this input, what is missing (no video provider, local pack disabled, ffmpeg tools missing) and `paid_calls_max`. Show the user the cap before a real run.

## Recovering by hand
Nothing is retried. A failure names the step and lists the completed steps with their artifact ids, so paid work is never lost:
- `clips` failed: the clips that finished are in the error detail; generate the missing shot with `generate_video` (9:16), then `local_video_concat` the clip ids in order.
- `joined`/`muxed` failed: run `local_video_concat` / `local_video_mux_audio` yourself with the listed ids.
- No captions: run `local_transcribe` on the voice artifact, then `local_video_burn_captions`.
