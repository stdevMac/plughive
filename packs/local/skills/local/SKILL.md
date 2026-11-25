---
name: local
description: Use media, speech, chat, image, document and transcript tools that run on this machine with no API key (ffmpeg, parakeet-mlx, Hex, whisper.cpp, whisperX, Ollama, Kokoro, ComfyUI, Real-ESRGAN, rembg, Demucs, Tesseract, pdftotext, OCRmyPDF, pandoc, LibreOffice, yt-dlp). Use when the user wants free or offline media editing, transcription, voiceover, local LLM chat, image generation or editing, document parsing or conversion, or asks what works without a key.
---

# Local pack (no API key)

Everything here runs on the user's machine. Start with `local_status`: it never fails, and reports which backends are up, which tools are usable and how to install what is missing.

## What works with what

| Backend | Needs | Tools |
| --- | --- | --- |
| ffmpeg | `ffmpeg` and `ffprobe` on PATH | `local_media_probe`, `local_media_convert`, `local_audio_mix`, `local_audio_concat`, `local_video_concat`, `local_video_mux_audio`, `local_video_burn_captions` |
| Speech to text | one of parakeet-mlx, Hex (`hex`), whisper.cpp (`whisper-cli` plus a ggml model) or whisperX, and ffmpeg | `local_transcribe` |
| Ollama | server on 127.0.0.1:11434 | `local_ollama_models`, `local_chat`, `local_embed` |
| Kokoro-FastAPI | server on 127.0.0.1:8880 | `local_voices`, `local_speak` |
| ComfyUI | server on 127.0.0.1:8188 with a checkpoint | `local_comfy_status`, `local_comfy_run_workflow`, `local_generate_image` |

`local_chat`, `local_speak`, `local_transcribe` and `local_generate_image` also serve the chat, speech.generate, audio.transcribe and image.generate capabilities, so other packs can use them as free fallbacks.

These backends have no `local_` tool of their own; they serve the provider-neutral media tools (`edit_image`, `parse_document`, ...) first, before any paid provider:

| Capability | Local backend |
| --- | --- |
| image.edit | ComfyUI img2img (no masks or reference images) |
| image.upscale | Real-ESRGAN (`realesrgan-ncnn-vulkan`) |
| image.remove_background | rembg |
| video.upscale | ffmpeg lanczos scaling (no AI models) |
| audio.separate_stems | Demucs |
| document.parse | pdftotext for PDFs with text, OCRmyPDF for scanned PDFs, Tesseract for images, plain text read directly |
| document.convert | pandoc and LibreOffice (`soffice`) |
| text.translate, text.embed, text.rerank | Ollama (rerank is cosine over an embedding model) |
| media.transcript | yt-dlp subtitles, else a download plus local speech to text for media up to 30 minutes. Only sites yt-dlp has an extractor for (not arbitrary pages or direct file links), every media host is checked against private and loopback addresses first, and audio is downloaded only from direct http(s) formats (not HLS playlists) |

When a request needs something the local backend cannot do (a mask, a named paid model, an output format it lacks), it hands over to the next provider instead of failing.

## Speech-to-text engines

The `transcriptionEngine` setting picks one: `auto` (the default) tries parakeet-mlx first on Apple silicon, then Hex, whisper.cpp and whisperX; elsewhere whisper.cpp, Hex, then whisperX. Passing an engine name as `model` (for example `parakeet`) picks that engine for one call. Speaker labels (`speakers: true`) always use whisperX and need the optional `HF_TOKEN` secret, a Hugging Face token that accepted the pyannote/speaker-diarization-3.1 terms.

## Installing each backend

Every tool error and `local_status` give the install hint for the user's OS (macOS, Windows or Linux); repeat that one rather than the macOS commands below.

- ffmpeg: `brew install ffmpeg` (macOS), `winget install Gyan.FFmpeg` (Windows) or `apt install ffmpeg`. `local_video_burn_captions` also needs ffmpeg built with libass (the `subtitles` filter); `local_status` reports this. On macOS the Homebrew `ffmpeg` formula has no libass: `brew install ffmpeg-full` (keg-only), put `$(brew --prefix ffmpeg-full)/bin` first on the daemon PATH and restart the daemon. Debian/Ubuntu `ffmpeg` includes libass.
- whisper.cpp: `brew install whisper-cpp` (macOS), the `whisper-bin-x64.zip` release (Windows) or a source build (Linux), then download a model such as `ggml-base.en.bin` from the whisper.cpp project into `~/.cache/whisper` or `./models`, or set the `whisperModelPath` setting to the absolute file path.
- Ollama: install from ollama.com, run `ollama serve`, then `ollama pull llama3.2` (or any model). Set `ollamaModel` to choose a default; embeddings need an embedding model such as `nomic-embed-text`.
- parakeet-mlx (Apple silicon), whisperX, rembg, Demucs and OCRmyPDF are Python tools: `uv tool install <name>` puts them on PATH. Hex is a macOS app with a `hex` command-line tool. Tesseract, Poppler (pdftotext), pandoc, LibreOffice and yt-dlp come from Homebrew, winget or the system package manager. Real-ESRGAN is a release download of `realesrgan-ncnn-vulkan` with its models folder. `local_status` gives the exact command for each.
- Kokoro: `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`. Set `kokoroVoice` for a default voice; `local_voices` lists them.
- ComfyUI: install ComfyUI, put a checkpoint in `models/checkpoints`, and run `python main.py`. `local_generate_image` picks the checkpoint automatically (or pass `model`); `local_comfy_run_workflow` takes a workflow in API format ("Save (API Format)"), not the UI format. It runs arbitrary node graphs, including custom nodes that read files, download models or reach the network, so only pass workflows you trust. It is off by default: if it is refused, tell the user it needs the pack setting "Allow raw ComfyUI workflows" (`allowRawComfyWorkflows`) turned on in the dashboard, or use `local_generate_image` instead.

## Rules of thumb

- Media tools take library artifact ids, never file paths or URLs. Get ids from earlier tool results.
- Long jobs (convert, mix, audio and video concat, mux, captions, transcribe, image generation) run as tasks; they can be cancelled. Cancelling a ComfyUI job removes only that prompt from the queue, or interrupts it by prompt id if it is running; other jobs on the server are not touched. The error says whether the stop request reached ComfyUI.
- Captions must be SRT or WebVTT. Only the timed cues are re-written as plain SRT before ffmpeg sees them; styled ASS/SSA and files with no cues are refused.
- Backend URLs must be loopback or private-network addresses. A non-default port also has to be allowed in the pack's `localNetwork` permission, or the connection is blocked.
- A typical ad: `local_speak` for the voice, `local_audio_mix` with preset `ad` to put it over music, `local_video_mux_audio` to lay it on a video.
- A podcast: one `local_speak` call per turn, then `local_audio_concat` with the turn ids in order (`gap_ms` around 300-600 for natural pauses, `loudnorm: true` for -16 LUFS), then optionally `local_audio_mix` with preset `podcast` to add a music bed. Up to 200 items and 30 minutes in total.
- A missing backend returns an error that says how to start or install it. Relay that to the user instead of retrying.

## Needs live verification

Covered by mocked tests only, not yet checked against real servers:

- ComfyUI `GET /queue`, `POST /queue {"delete": [...]}` and `POST /interrupt {"prompt_id": ...}` behave as assumed (targeted interrupt needs a recent ComfyUI; older ones ignore `prompt_id` and interrupt whatever is running).
- Kokoro-FastAPI default voice `af_heart` and the `/v1/audio/speech` response formats.
- The `brew install ffmpeg-full` route actually provides the `subtitles` filter on current Homebrew.
- parakeet-mlx, Hex, whisperX, Real-ESRGAN, rembg, Demucs, OCRmyPDF and LibreOffice command lines; ComfyUI `POST /upload/image` and the img2img graph; Ollama translation, `/api/embed` and reranking.
