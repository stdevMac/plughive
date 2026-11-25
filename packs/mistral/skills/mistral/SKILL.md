---
name: mistral
description: Extract the text of a library PDF or image as Markdown with parse_document through Mistral OCR (provider "mistral"). Use for scanned documents, PDFs with tables, or text in images.
---

# Mistral OCR

Use the `parse_document` tool. Pass `provider: "mistral"` to force Mistral OCR.

## Inputs

- `artifact_id` (required): a library PDF or raster image (PNG, JPEG, WebP, ...), up to 50 MB.
- `format` (optional): markdown only. For plain text, leave the router to pick another provider.
- `language` (optional): ignored; Mistral OCR detects the language.
- `model` (optional): defaults to mistral-ocr-latest.

## Output

`text` (Markdown, pages joined by blank lines, tables inline), `format` and `pages`.

## Setup

Set `MISTRAL_API_KEY` (https://console.mistral.ai/api-keys).
