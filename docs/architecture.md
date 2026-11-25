# Architecture

This page is for people who want to change the daemon. It says where the code
is and how a request moves through it.

## One process

plughive is one Node.js process. It serves MCP, the admin API, the dashboard
and the artifact files on one port. State is in SQLite files and JSON files in
the home folder. There is no other service to run.

```
src/
  server.ts      daemon entry: config, logger, databases, runtime, HTTP server
  cli.ts, cli/   the plughive command (start, status, dashboard, pack, connect, doctor)
  app.ts         the Express app: middleware and routes
  http/          /mcp and /artifacts handlers
  core/
    runtime.ts   builds the tool registry, packs, router and mounts
    pack-api.ts  the API packs are written against (plughive/pack)
    tools/       the registry and the core tools
    packs/       manifest, loader, pack context, fetch guard, pack mounts
    capabilities/ capability names, schemas and the router
    mcp/         the MCP server, search tools, scopes, tasks
    profiles.ts  profiles and tool selection
    mounts/      remote and stdio MCP servers mounted as tools
    workflows/   recipe schema, planner and runner
    secrets/     layered secret store, backends, redactor
    fs/, http/, net/  file, HTTP and address helpers
  lib/           config, logger, jobs, library, usage ledger, admin token, auth
packs/           bundled packs
web/             the dashboard (React, built to web/dist)
app/             a Tauri spike for a Mac app
```

## Start-up

`src/server.ts` does, in order:

1. Imports `lib/network.js` first. It sets the global fetch dispatcher before
   any other module can call `fetch`.
2. Loads `.env` unless `PLUGHIVE_NO_DOTENV=1`.
3. Reads the config (`lib/config.ts`) and refuses unsafe binds: a
   non-loopback address without an access key, or the removed
   `PLUGHIVE_API_KEYS` variables.
4. Opens `library.db`, `jobs.db` and `usage.db`, and loads or creates the
   admin token.
5. Builds the runtime (below), then the app, then listens.

## A request

`src/app.ts` applies, in order:

1. On a loopback bind, a `Host` header check (against DNS rebinding).
2. A refusal of requests that packs made to the daemon itself.
3. The `Origin` guard, except on the key setup page.
4. A request log line (method, path, status, time; no query string; not for
   `/artifacts`).
5. `GET /health`.
6. `/artifacts/<id>`.
7. The key setup page used by the missing-key flow.
8. `/api/session`, then the admin check for everything else under `/api`, then
   the admin routes (info, events, data, profiles, packs, secrets, mounts,
   capabilities, tools).
9. The access key check on `/mcp` and `/p`, then the MCP handler.
10. The dashboard files, a JSON 404 and the error handler.

The HTTP server waits at most 15 s for headers and 60 s for a whole request.

The MCP handler (`src/http/mcp.ts`, `src/core/mcp/`) is stateless. For each
request it resolves the profile from the path, builds an MCP server that lists
the profile's tools (or the search tools), and answers. See
[protocol.md](protocol.md).

## The runtime

`src/core/runtime.ts` builds what the daemon serves:

- **The registry** (`core/tools/registry.ts`). One table of every callable
  tool: pack tools, tools of mounted servers and workflow tools. Names are
  unique; a pack whose tool name is taken is refused as a whole. `call()`
  validates input, wraps the result as `{ok, result}` or `{ok: false, error}`,
  redacts secrets, logs and meters.
- **Core tools** (`core/tools/builtin/`): `gateway_status`, `list_artifacts`,
  `import_artifact`, `get_job_status`, `usage_report` and `batch_run` (one
  tool over many inputs as a single job; items take the same scoped call path
  as a pack's `ctx.tools.call`). The MCP layer adds
  `search_tools`, `describe_tool`, `execute_tool`, `wait_for_job` and
  `cancel_job`.
- **The pack loader** (`core/packs/loader.ts`). It reads bundled packs from
  `packs/` (on by default) and your packs from `<home>/packs` (off until you
  enable them). For each pack it checks the manifest, builds a context limited
  to the pack's permissions (`core/packs/context.ts`), imports the entry and
  registers its tools, providers, skills, workflows and mounts. A user pack is
  imported from a hashed copy in `<home>/pack-snapshots`. Your choices are in
  `<home>/packs.json`.
- **The capability router** (`core/capabilities/router.ts`). Packs register
  providers for `image.generate`, `video.generate`, `speech.generate`,
  `music.generate`, `audio.transcribe` and `chat`. Tools such as
  `generate_image` call the router, which picks a provider.
- **Mounts** (`core/mounts/manager.ts`). Remote MCP servers declared by packs
  and the ones in `<home>/mounts.json` (http or stdio). Their tools are added
  to the registry with a prefix. A mount whose prefix is in use is skipped.

### How the router picks a provider

1. A call that names a `provider` runs only that provider.
2. A call that names a `model` keeps only providers that list it.
3. Otherwise: your order for the capability (`<home>/capabilities.json`), then
   the provider's priority, then its id. Providers cooling down after a rate
   limit go last. A provider from a pack you added is used only once you put
   it in the order.

It falls back to the next provider only when the failure provably happened
before the provider accepted the request: nothing but `GET` or `HEAD` was
sent, or a non-`GET` request was refused (no connection, `429`, `401`, `403`),
or the provider says the error is retryable. A timeout, a reset or a `5xx`
after a non-`GET` request is ambiguous and ends the call, so a paid job is not
sent twice. Every attempt is a row in the usage ledger.

## Jobs

A tool marked `longRunning` runs as a job (`lib/jobs.ts`, `jobs.db`). The
queue runs `PLUGHIVE_JOB_CONCURRENCY` jobs at once (default 2) and refuses
new ones past `PLUGHIVE_MAX_QUEUED_JOBS` (default 200). The database has mode
0600 and argument values that look like secrets are not written to it. A job
that was running when the daemon stopped is failed, unless its handler says it
can resume. Finished jobs are kept 7 days, at most 1000.

Triggers (`core/triggers/`) also live in `jobs.db`. A 15-second scheduler tick
claims due cron slots with a conditional update, so each slot starts once even
across restarts, and starts the workflow through the job queue. Signed
webhooks at `/hooks/<id>` start them the same way; the route is mounted before
the `/api` guard because the signature is its credential. Job-done callbacks
go out once, through the outbound guard or the Telegram pack. See
[triggers.md](triggers.md).

## Library and usage

- The library (`lib/library.ts`) keeps files in `<home>/artifacts` and their
  rows in `library.db`. Ids start with the kind (`img_`, `vid_`, `aud_`,
  `pdf_`, `doc_`, ...).
- The usage ledger (`lib/usage.ts`, `usage.db`) has one row per tool call and
  per provider attempt: tool, capability, provider, cost when known, time and
  status.

## Keys

`core/secrets/store.ts` is a layered store: one writable backend (macOS
Keychain, `<home>/secrets.json`, or memory) over the environment. A saved
value wins. The environment is read only for names a bundled pack declares.
Every value read or written is given to the redactor, which the logger and
the registry apply to their output. See [security.md](security.md).

## Profiles and workflows

- `core/profiles.ts` reads `<home>/profiles.json` and decides which tools an
  endpoint offers. See [profiles-and-exposure.md](profiles-and-exposure.md).
- `core/workflows/` turns a pack's JSON recipes into `wf_<name>` tools. The
  planner checks a run before it starts; the runner calls tools through the
  pack's context. See [workflows.md](workflows.md).
- `core/mcp/resources.ts` serves library files as MCP resources and the
  exposed workflows as MCP prompts. See [protocol.md](protocol.md).

## Dashboard and CLI

- The dashboard is a React app in `web/`. `pnpm build` builds it to
  `web/dist`, which the daemon serves. It talks to the daemon through `/api`.
- The CLI (`src/cli.ts`, `src/cli/`) starts the daemon in the same process
  (`start`) or talks to a running one over HTTP with the admin token
  (`status`, `pack`, `dashboard`).

## Files in the home folder

| Path | Written by |
| --- | --- |
| `admin-token` | `lib/admin-token.ts` |
| `secrets.json` | the file secret backend |
| `library.db`, `artifacts/` | the library |
| `jobs.db` | the job queue |
| `usage.db` | the usage ledger |
| `logs/server.jsonl` | the logger |
| `packs/`, `packs.json`, `pack-snapshots/`, `pack-data/<id>/` | the pack loader |
| `profiles.json` | profiles |
| `capabilities.json` | the capability router |
| `mounts.json` | user mounts |
