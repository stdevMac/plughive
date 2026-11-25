---
name: media
description: Make images, video, speech and music, transcribe audio and chat through whichever provider the user has set up. Use these tools when no specific provider is asked for.
---

# Media pack

These tools route each call to a configured provider pack (Gemini, ElevenLabs, local ComfyUI/Kokoro/whisper/Ollama, ...). Keyed providers spend the user's own quota.

| Tool | Capability |
| --- | --- |
| `generate_image` | image.generate |
| `generate_video` | video.generate |
| `generate_speech` | speech.generate |
| `generate_music` | music.generate |
| `transcribe_audio` | audio.transcribe |
| `chat` | chat |
| `list_media_providers` | shows providers, setup state and models |

- Call `list_media_providers` first when unsure what is set up, or before passing `model`.
- Omit `provider` to route automatically; set it to pin one provider (no fallback).
- A "no provider is set up" error names the keys or local backends that would enable the capability. Tell the user; do not retry.
- Results are library artifacts (`id`, `url`, `mime`). Chain them by id, for example `transcribe_audio` on a `generate_speech` result.
