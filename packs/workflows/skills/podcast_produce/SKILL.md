---
name: podcast_produce
description: Produce a podcast episode from a topic and notes with wf_podcast_produce - script, text-to-speech (one or two hosts), optional music bed and Markdown show notes. Runs as a job; dry run first.
---

# Podcast episode (`wf_podcast_produce`)

## When to use
The user wants a listenable episode or a two-host conversation from notes, plus show notes.

## Inputs
- `topic` (required), `notes` (facts the script may use), `show_name`, `language`.
- `hosts`: 1 (default) or 2. `voices`: `{ "a": "<voice>", "b": "<voice>" }` (host a is also the single host).
- `minutes` 1-10 (default 4), `max_segments` 2-12 (two hosts: one speech call per turn).
- `music` (off by default, one host only): an intro/outro bed mixed and ducked locally.

## Steps and cost
1. `script`: one `chat` call (segments, show notes, music prompt).
2. One host: `full_voice`, one speech call (the script is cut at 8000 characters, about 9 minutes). With music: `music` + local `mix`.
3. Two hosts: `turns`, one speech call per segment, three at a time, then `join`: `local_audio_concat` puts the turns in order into one mp3 (0.4 s between turns, levelled to -16 LUFS). `join` is local and free; it runs only when the local pack's `local_audio_concat` is available.
4. `notes`: the show notes saved as `show-notes.md`.

Paid calls: 2 for one host (3 with music); 1 + the number of segments for two hosts (at most 1 + max_segments). The dry run counts the turns at their cap of 12, so its `paid_calls_max` for two hosts is 13.

## Output
- `episode`: the finished file. One host: the voice track, or the mix when `music` is on. Two hosts: the joined turns.
- `turns`: two hosts only, every turn's own audio file, in order (kept next to the joined episode).
- `segments` (the script) and `show_notes`.

Two hosts without a joined episode: `episode` is missing and `turns` holds the files. That happens when `local_audio_concat` is not available (the dry run shows `join` as not running), or when the join failed (the step is marked `continued` with the reason: ffmpeg not installed, fewer than two turns, or more than 30 minutes in total). Join them then with `local_audio_concat` yourself, or in an editor.

## Dry run
Call it with `"dry_run": true` to see the steps for this host count and `paid_calls_max`.

## Recovering by hand
Nothing is retried. The error lists finished steps and artifact ids. Re-read a failed turn with `generate_speech` using its text and voice; re-join with `local_audio_concat` (`artifact_ids` in turn order, `gap_ms` 400, `loudnorm` true); re-mix with `local_audio_mix` (preset podcast, voice first).
