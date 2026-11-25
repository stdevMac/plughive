---
name: video_launch_film_16x9
description: Make a 16:9 product launch film in five beats (hook, problem, solution, proof, call to action) with wf_video_launch_film_16x9. Runs as a job; dry run first.
---

# Launch film (`wf_video_launch_film_16x9`)

## When to use
A product launch or feature announcement video in landscape, built from product notes and optionally the product page. For vertical social cuts use `wf_video_short_9x16`.

## Inputs
- `product` (required), `pitch`, `audience`, `key_points` (facts the film must state), `style`, `beat_seconds` 3-10 (default 6), `voice`, `language`.
- `url`: the product page, read with `firecrawl_scrape` (one paid call, needs `FIRECRAWL_API_KEY`; skipped on failure).
- Extras, off unless asked: `keyframes`, `music`, `captions`.

## Steps and cost
1. `page` (with `url`): Firecrawl.
2. `script`: one `chat` call writing exactly five beats.
3. `frames` (keyframes only): one image per beat.
4. `clips`: five `generate_video` calls at 1080p, two at a time.
5. `voice`: one speech call. `music` + `mix` with music.
6. `joined`, `muxed`: local concat and mux. `captions_srt`, `captioned` with captions (local).

Paid calls: 7 by default, 8 with `url`, up to 14 with every extra. The run is capped at 90 minutes.

## Dry run
Call it with `"dry_run": true` to see the steps, missing providers or keys and `paid_calls_max` before spending anything.

## Recovering by hand
Nothing is retried. The error lists completed steps and artifact ids. Regenerate a failed beat with `generate_video` (16:9), join the beat clips in order with `local_video_concat`, then lay the voice artifact on with `local_video_mux_audio`.
