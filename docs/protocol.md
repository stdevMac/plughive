# Protocol

plughive speaks MCP over Streamable HTTP. This page is for people writing a
client or a script against it. Agents that already speak MCP need only the
endpoint and, when set, the access key.

## Endpoint

| Path | Serves |
| --- | --- |
| `POST /mcp` | the `default` profile |
| `POST /p/<id>/mcp` | the profile `<id>` (`404` when unknown) |

- The server is stateless. It builds a fresh MCP server for each request and
  mints no `Mcp-Session-Id`. A client that opens with `initialize` is
  answered; a client that sends `tools/call` straight away is answered too.
- `GET` and `DELETE` on these paths answer `405`. There is no server-to-client
  stream outside a request.
- The request body is at most 4 MB. Files travel as artifact ids or paths,
  never inline.
- Send `Accept: application/json, text/event-stream`. The answer is a
  single SSE `message` event.
- Besides tools, the server offers resources (library files) and prompts
  (workflows). See [Resources and prompts](#resources-and-prompts).

`GET /health` answers `{"ok": true, "version": ...}` and nothing else. With
the admin token (`Authorization: Bearer <token>`) it also returns tool, pack
and job counts. The access key does not unlock the full report.

## Authentication

With `PLUGHIVE_ACCESS_KEY` set, `/mcp`, `/p/*` and `/artifacts/*` need one of:

```
Authorization: Bearer <access key>
X-API-Key: <access key>
```

A key in the query string is never accepted. Without an access key the daemon
only binds a loopback address.

A request from a browser (one with an `Origin` header) is refused unless the
origin is the daemon's own or is listed in `PLUGHIVE_ALLOWED_ORIGINS`. There
is no CORS.

## Tool results

Every `tools/call` answer has a text content item holding JSON (an error may
add a second, human-readable item):

```json
{"ok": true, "result": {...}}
```

or, with `isError: true`:

```json
{"ok": false, "error": {"code": "TOOL_ERROR", "message": "...", "retryable": false}}
```

An unknown tool and arguments that do not match the schema are JSON-RPC
errors (`InvalidParams`) instead, with the validation issues in `data`.

| Code | Meaning |
| --- | --- |
| `MISSING_SECRET` | The tool needs a key that is not saved. The message says which key, for which pack, and where to set it. |
| `TOOL_ERROR` | The tool ran and failed. `retryable` says whether trying again can help. |
| `JOB_QUEUE_FULL` | Too many long-running calls are waiting. Retryable. |
| `JOB_FAILED` | A job ended in failure (from `wait_for_job`). |
| `NO_PROVIDER` | No provider is set up for the capability the tool needs. |

A result over 1 MiB is cut. The answer is then
`{"ok": true, "truncated": true, "notice": "...", "result_preview": "..."}`
with the first 100,000 characters. Large outputs belong in artifacts.

### Missing keys

When a key is missing, a client that supports URL elicitation is sent a link
to a local setup page on the daemon, where the user types the key. Other
clients get the `MISSING_SECRET` text. A key is never asked for in the chat.

## Long-running tools and jobs

Some tools (video, music, dubbing, every workflow) run as background jobs.

A client that declares the MCP tasks extension
(`io.modelcontextprotocol/tasks`) on the request gets an MCP task whose
`taskId` is the job id. Any other client gets, at once:

```json
{"ok": true, "result": {
  "job_id": "...",
  "status": "queued",
  "wait_with": "wait_for_job",
  "cancel_with": "cancel_job",
  "poll_with": "get_job_status"
}}
```

`poll_with` is there only when the profile offers `get_job_status`.

| Tool | Input | Does |
| --- | --- | --- |
| `wait_for_job` | `{job_id, timeout_s}` (default 25, at most 50) | Waits, then returns `{job_id, status, done, progress, result?, error?, hint?}`. Call it again while `done` is false. |
| `cancel_job` | `{job_id}` | Cancels a job that has not finished. |
| `get_job_status` | `{job_id}` | Returns the job's state without waiting. |

A client only sees jobs started from its own profile.

Job statuses: `queued`, `running`, `staging`, `submitting`, `submitted`,
`polling`, `downloading`, then one of the final ones: `succeeded`, `failed`,
`cancelled`, `expired`, `submission_unknown`. `submission_unknown` means the
daemon cannot tell whether the provider accepted the request. The daemon does
not retry it, because a retry could be billed twice; check the provider's own
dashboard before calling again.

Jobs are kept in `<home>/jobs.db`: 7 days, and at most the 1000 newest
finished ones. A job's input is at most 1 MB. A job that was running when the
daemon stopped is marked failed ("interrupted by restart; not retried
automatically").

When the request carries a progress token, the daemon sends MCP progress
notifications.

## Artifacts

`GET /artifacts/<id>` serves a file from the library. Tool results carry
links to it.

- With an access key, the route needs the key, or a signed link
  (`?exp=...&sig=...`) that the daemon puts in tool results. Signed links
  last one hour, so a browser can open them.
- Every answer has `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'`. HTML, SVG, XML and
  scripts are sent as `application/octet-stream`. Only a short list of media
  types is shown inline; the rest is a download.
- `?download=1` forces a download. The file is offered as `<kind>-<id>.<ext>`
  (for example `image-img_01J....png`).

## Resources and prompts

**Resources** are the files in the library, named `artifact://<id>`.

- A profile has resources only when it exposes `list_artifacts`, the tool that
  already lists the whole library, so resources never show more than the
  tools do. Without it, `resources/list` is empty and every read is refused.
- `resources/list` pages through the library, newest first, 50 per page, with
  `nextCursor` for the next page. `resources/templates/list` returns the
  template `artifact://{id}`.
- `resources/read` returns a text file (`text/*`, JSON, subtitles) as `text`
  and any other file as a base64 `blob` with its media type. Files over 16 MB
  are refused; open those through their link (`list_artifacts` gives it).
- A read finds the id in the library and refuses a file that is not inside
  the library's `artifacts` folder, after resolving symlinks. No URI can name
  any other file on disk. An unknown id answers resource-not-found.

**Prompts** are the workflows (`wf_<name>`) the profile exposes, one prompt
each, with the same name.

- The workflow's top-level input properties are the prompt's arguments, and
  its required properties are required arguments. Prompt arguments are
  strings: for a property that is not a string, the value is read as JSON when
  it parses (`3`, `true`, `["a","b"]`).
- `prompts/get` returns one user message that asks the model to call the
  workflow with those arguments and `dry_run: true`, then to run it for real
  and wait for the job. Getting a prompt runs nothing.
- An unknown argument, a missing required one or a prompt the profile does
  not expose answers invalid-params.

## Admin API

The dashboard uses a JSON API under `/api`. It needs the admin token (from
`<home>/admin-token` or `PLUGHIVE_ADMIN_TOKEN`) as
`Authorization: Bearer <admin token>`, or the dashboard's session cookie. The
access key is not accepted there: an agent must not be able to administer the
daemon.

A request that changes something must come from the daemon's own origin or,
without an `Origin` header, send `X-PlugHive-CSRF: 1`.

```sh
curl -s http://127.0.0.1:7777/api/packs \
  -H "Authorization: Bearer $(cat ~/.plughive/admin-token)"
```

| Route | Does |
| --- | --- |
| `GET /api/info` | Version, endpoint URL, bind address, home folder, secrets backend, `secrets_storage` (`keychain`, `file-encrypted`, `file-plain` or `memory`) and `secrets_keychain_service`. |
| `GET /api/packs` | Every pack with its state, tools and key names. |
| `GET /api/packs/<id>/consent` | What enabling a pack means, with the hashes to confirm. |
| `POST /api/packs/<id>/enable` | `{grants?, manifestHash?, entryHash?}`. A user pack needs both hashes from `/consent`. |
| `POST /api/packs/<id>/disable`, `/reload` | |
| `GET`, `PUT /api/packs/<id>/settings` | Read or change settings. |
| `GET /api/secrets` | Key names and whether each is set. Never a value. |
| `PUT`, `DELETE /api/secrets/<pack>/<name>` | Save (`{value}`) or remove a key. |
| `GET /api/capabilities`, `PUT /api/capabilities/<name>/preference` | Provider order per capability. |
| `GET`, `POST /api/mounts`, `POST /api/mounts/<owner>/<id>/enable` or `/disable`, `DELETE /api/mounts/user/<id>` | Remote MCP servers. |
| `GET /api/profiles` and the routes in [profiles-and-exposure.md](profiles-and-exposure.md) | Profiles. |
| `GET /api/tools`, `POST /api/tools/<name>/call` | The playground. A call runs as the default profile. |
| `GET /api/usage`, `GET /api/jobs`, `GET /api/jobs/<id>`, `POST /api/jobs/<id>/cancel`, `GET /api/artifacts` | Usage, jobs and the library. |
| `DELETE /api/artifacts/<id>` | Delete one library file and its record. Dashboard only: agents have no tool that deletes files. Jobs that made the file keep their record. |
| `GET /api/events` | Server-sent events for the dashboard. |
| `GET`, `POST`, `DELETE /api/session` | Dashboard sign-in. `POST {token}` sets the cookie. |

The admin API is for the dashboard and the CLI. It may change between
versions.
