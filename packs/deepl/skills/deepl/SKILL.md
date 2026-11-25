---
name: deepl
description: Translate text with translate_text through DeepL (provider "deepl"). Use when the user wants text translated, with an optional formal or informal tone.
---

# DeepL translation

Use the `translate_text` tool. Pass `provider: "deepl"` to force DeepL.

## Inputs

- `text` (required).
- `target_language` (required): a code such as de, ja or pt-BR. Bare en and pt mean EN-US and PT-PT; pass en-GB or pt-BR for the other variant.
- `source_language` (optional): leave out to detect.
- `formality` (optional): default, more or less. Ignored for languages without formality.
- `model` (optional): quality_optimized, prefer_quality_optimized or latency_optimized.

## Output

`text` and `detected_source_language`.

## Setup

Set `DEEPL_API_KEY` (https://www.deepl.com/your-account/keys). Free keys (ending in :fx) and Pro keys both work.
