---
name: video_narrated_ad
description: Make a narrated video ad, script first, with wf_video_narrated_ad - script lines with visuals, one voice-over, a generated clip per line, in 9:16, 16:9 or 1:1. Runs as a job; dry run first.
---

# Narrated ad (`wf_video_narrated_ad`)

## When to use
An ad where the words matter most: the script is written first, then each line gets a visual. Pick the aspect for the placement (9:16 stories, 16:9 pre-roll, 1:1 feed).

## Inputs
- `brief` (required): product, audience and the action to take. `brand`, `tone`, `style`, `voice`, `language`.
- `aspect` (default 9:16), `max_lines` 2-6 (default 4), `line_seconds` 2-10 (default 5).
- Extras, off unless asked: `music`, `captions` (local).

## Steps and cost
1. `script`: one `chat` call returning lines (`text` + `visual`).
2. `voice`: one `generate_speech` call reading the whole script.
3. `clips`: one `generate_video` call per line, two at a time.
4. `music` + `mix` (music only). 5. `joined`, `muxed`: local. 6. `captions_srt`, `captioned` (captions only, local).

Paid calls: 2 + max_lines (6 by default), 3 + max_lines with music. The dry run counts the clips at their cap of 6 lines, so its `paid_calls_max` is the worst case (8, or 9 with music).

## Dry run
Call it with `"dry_run": true`; check `paid_calls_max` and `blocking` before a real run.

## Recovering by hand
Nothing is retried. The error lists finished steps with artifact ids. Re-make a failed line with `generate_video` using its `visual`, join the clips with `local_video_concat` (same aspect), and add the voice with `local_video_mux_audio`.
