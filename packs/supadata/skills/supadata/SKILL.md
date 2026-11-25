---
name: supadata
description: Get the transcript of a YouTube, TikTok, X, Instagram or Facebook video, or a media file URL, with get_media_transcript through Supadata (provider "supadata").
---

# Supadata transcripts

Use the `get_media_transcript` tool. Pass `provider: "supadata"` to force Supadata.

## Inputs

- `url` (required): the video page or media file URL.
- `language` (optional): preferred language, such as en. Supadata falls back to the first available one.
- `timestamps` (optional): true returns `segments` with start and end in seconds.
- `model` (optional): auto (default: native captions, else generated), native (captions only) or generate (AI transcription).

## Output

`text`, `language`, and `segments` when timestamps were asked for.

## Tips

- Long or generated transcripts run as a job and can take minutes.
- A video with no captions fails with TRANSCRIPT_UNAVAILABLE under mode native; try auto or generate.

## Setup

Set `SUPADATA_API_KEY` (https://dash.supadata.ai).
