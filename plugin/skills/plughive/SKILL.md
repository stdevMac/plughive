---
name: plughive
description: How to use the tools of a local plughive daemon (image, video, speech, music, media, web, SEO and more). Use when a task needs a tool that is not in your tool list, when a tool result carries a job_id, or when a result links to an artifact.
---

# Using plughive

plughive is one MCP server that fronts many tools. Most of them are not in
your tool list. You find them with search, read their schema, then run them.

## Find, describe, run

1. `search_tools` with a few words about the task, for example
   `{"query": "convert video format"}`. It returns ranked tool names with a
   one-line description.
2. `describe_tool` with one name or a list of up to 20:
   `{"name": "local_media_convert"}`. It returns the input JSON schema.
3. `execute_tool` with the name and arguments that match the schema:
   `{"name": "...", "arguments": {...}}`. The result is the tool's own result.

Tools already in your list (for example `generate_image`) can be called
directly. Do not guess argument names: describe the tool first.

## Results

Each result is JSON in a text item. `ok: true` carries `result`. `ok: false`
carries an error with a message; read it before retrying. A message about a
missing key means the owner has not saved that provider key in the dashboard.
Tell the user which key is missing. Do not retry paid calls in a loop.

## Long jobs

Some tools run in the background and return `job_id` instead of a result.

- `wait_for_job` with `{"job_id": "...", "timeout_s": 25}` waits up to 50
  seconds. Call it again while `done` is false.
- `get_job_status` returns the status at once, without waiting.
- `cancel_job` stops a job that has not finished.

## Artifacts

Generated files (images, video, audio, documents) are saved in the artifact
library. A result gives an artifact `id` and a `url` under `/artifacts/`.
`list_artifacts` lists them, newest first, with filters for tool, kind, model,
time and prompt text. Give the user the URL; do not paste file contents.

## Connection

The plugin connects to `${PLUGHIVE_URL}/mcp` (default
`http://127.0.0.1:7777/mcp`) and sends `PLUGHIVE_ACCESS_KEY` as a bearer
token when it is set. If the server does not answer, the daemon is not
running: the user starts it with `plughive start`.
