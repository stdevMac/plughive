---
name: pdf
description: Turn markdown into a PDF with the md_to_pdf tool. Use when the user wants a report, brief or document delivered as a PDF.
---

# Markdown to PDF

`md_to_pdf` renders markdown with pandoc and stores the PDF in the artifact library. It needs no API key.

## Inputs

Give exactly one source:

- `markdown`: the text itself.
- `artifact_id`: a stored markdown or text artifact (see `list_artifacts`).
- `markdown_path`: a path relative to the pack data directory. Absolute paths, `..` and symlinks that leave that directory are rejected.

Optional: `title` (PDF title metadata).

## What is not rendered

The renderer is locked down so untrusted markdown cannot read files. Images are replaced by their caption text, raw TeX and raw HTML are ignored, TeX math (`$...$`) is printed as literal text rather than typeset, and YAML metadata blocks are not parsed. Use `title` instead of a YAML header.

## Setup

Install pandoc and pdflatex (for example `brew install pandoc` plus MacTeX or BasicTeX). If the call fails with a pandoc error mentioning a missing PDF engine, tell the user to install LaTeX.

## Output

`artifact` with the id, path and url of the PDF. Pass the id to `send_telegram` or other delivery tools.
