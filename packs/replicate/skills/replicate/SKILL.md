---
name: replicate
description: Find and run Replicate models for images, image edits, video, speech, music and transcription with the user's own Replicate token. Use when the user wants media from a specific Replicate model, wants to compare Replicate models, or asks what Replicate can do for a task.
---

# Replicate

Replicate hosts thousands of community and official models behind one predictions API. This pack gives you search, each model's real input schema, and a runner that saves every output file to the library.

## Which tool

- `replicate_search_models`: search by text (`query`) or list a curated `collection` (`text-to-image`, `text-to-video`, `text-to-speech`, `image-editing`, `speech-to-text`, ...). `modality` is a best-effort filter. Results are cached.
- `replicate_describe_model`: the model's input fields, JSON Schema, output schema, version and a ready `replicate_run` call. Call it before running a model you have not used in this conversation.
- `replicate_run`: run any model with `{model, input}`. `model` is `owner/name` (latest version) or `owner/name:<version id>` to pin a version. The input is checked against the schema before a prediction is created, so a schema error costs nothing. It is a long-running tool: you may get a job handle to poll.
- Per-model tools such as `replicate_black_forest_labs_flux_schnell`, `replicate_google_nano_banana` and `replicate_minimax_video_01` take the model's own fields directly. The user picks which models get one with the `models` setting; they appear once the token is set.
- The shared media tools (`edit_image`, `upscale_image`, `remove_background`, `upscale_video`, `lipsync_video`, `separate_stems`, `generate_3d`, `generate_sound_effect`, plus generation and transcription) route to Replicate when the token is set. Defaults: `topazlabs/video-upscale` (maps the factor onto 720p, 1080p or 4k), `ryan5453/demucs` (one artifact per stem, labelled with `stem`; `two_stems` gives that stem plus `no_<stem>`), `firtoz/trellis` (image to GLB only; a text-only request falls through to another provider) and `zsxkib/mmaudio` (sound effects up to 30 s). Pass `model` to use another Replicate model; its fields are matched by name.

## Files in and out

- Pass a library file to any file field as `"artifact:<id>"` (for example `"image": "artifact:abc123"`). Files up to 256 KB go inline; bigger ones (up to 100 MB) are uploaded to Replicate first.
- Output files are downloaded into the library. The result lists them in `artifacts` (`id`, `url`, `mime`), and inside `output` each file is replaced by its `artifact_id`. Replicate deletes outputs after an hour, so never hand the user a Replicate URL.

## Cost notes

- Every prediction is billed to the user's Replicate account. Official models bill per output (per image, per second of video); other models bill by GPU time, and the first run may wait for a cold boot.
- The API does not report prices. Point the user at the model page (`url` in `replicate_describe_model`) before running video models or many outputs.
- Searching and describing models is free.

## Setup

Every Replicate endpoint needs `REPLICATE_API_TOKEN`, created at https://replicate.com/account/api-tokens. If a call fails with `MISSING_SECRET`, ask the user to set it. HTTP 401 means the token is wrong; 402 means the account needs billing set up; 429 means slow down and retry.

## Tips

- Use the model's own enum values exactly as `replicate_describe_model` shows them (for example `aspect_ratio: "16:9"`).
- Image-to-video and editing models take an image field such as `first_frame_image`, `image` or `image_input` (a list).
- A prediction still running after the `max_wait_minutes` setting is cancelled on Replicate too. Any error after a prediction was created quotes its id; collect it with `replicate_get_result` (`{prediction_id}`) instead of running the model again, which would bill twice.

## Needs live verification

These behaviours come from Replicate's docs and were not checked against the live API:

- That the default per-model ids still resolve to official models.
- Real predictions with the video upscale, stems, 3D and sound defaults. Their input schemas were taken from the public model pages (November 2026) and the tests run against them. The runner still checks every call against the live schema first, so if a model changes, a mismatch is refused before anything is billed and the router moves on to the next provider.
- Using `urls.get` as the file input for an uploaded file.
- `DELETE /v1/files/{id}`. Uploads are deleted when the call ends, even after a timeout or lost contact, so a prediction still running could lose its input.
- The `model` field on `GET /v1/predictions/{id}`.
