# Getting started

This page takes you from nothing to an agent that calls a tool through
plughive.

## 1. Check the machine

You need Node.js 22 or later. Optional programs add tools when they are on
`PATH`: ffmpeg (media tools), pandoc (Markdown to PDF), whisper.cpp
(transcription), Ollama, ComfyUI and Kokoro (local models), Playwright
Chromium (`screenshot_url`).

```sh
plughive doctor
```

Each line is `ok`, `warn` or `fail`. A missing optional program is a warning
only: the daemon starts and the tools that need it say so when called.

From a source checkout, use `node dist/src/cli.js` in place of `plughive`
after `pnpm build`, or `pnpm dev` to run the daemon from source.

## 2. Start the daemon

```sh
plughive start
```

`start` is also the default, so `plughive` alone does the same. It prints:

```
plughive on http://127.0.0.1:7777
```

and, on a terminal, a dashboard sign-in link. Options:

| Option | What it does |
| --- | --- |
| `--port N` | Listen on another port (same as `PLUGHIVE_PORT`). |
| `--host H` | Bind another address. Anything but loopback needs `PLUGHIVE_ACCESS_KEY`. |
| `--home DIR` | Keep state in another folder (same as `PLUGHIVE_HOME`). |
| `--open` | Open the dashboard once the daemon listens. |

The daemon runs in the foreground. Stop it with Ctrl-C.

The CLI does not read a `.env` file. Export the variables, or run
`node --env-file=.env dist/src/cli.js start`. The daemon itself
(`pnpm dev`, `node dist/src/server.js`) loads `.env` from the current folder
unless `PLUGHIVE_NO_DOTENV=1` is set. See [configuration.md](configuration.md).

## 3. Check that it answers

```sh
plughive status
```

prints whether the daemon runs, with its pack and tool counts.
`plughive status --json` prints the same as JSON.

Then call a tool. `search_tools` needs no key:

```sh
curl -s http://127.0.0.1:7777/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_tools","arguments":{"query":"image"}}}'
```

The daemon is stateless, so no `initialize` call is needed first. The answer
is one SSE event:

```
event: message
data: {"result":{"content":[{"type":"text","text":"{\"ok\":true,\"result\":{\"tools\":[...
```

## 4. Open the dashboard and add a key

```sh
plughive dashboard
```

opens the dashboard in your browser, already signed in. On a machine without a
browser, `plughive dashboard --print` prints the link. The link carries the
admin token after `#token=`: treat it like a password.

Under **Packs & keys**, pick a pack and choose **Set key**. On macOS the key
goes to the Keychain; elsewhere to `secrets.json` in the home folder (mode
0600). The pack's tools work at once; no restart.

Which key gives which tools: [packs.md](packs.md).

## 5. Connect your agent

The README has snippets for Cursor, Claude Code, Codex, Hermes and Claude
Desktop: [Connect a client](../README.md#connect-a-client).

Once connected, a client sees 11 tools by default: `search_tools`,
`describe_tool`, `execute_tool`, six pinned tools (`generate_image`,
`generate_video`, `generate_speech`, `generate_music`, `list_artifacts`,
`get_job_status`) and the job tools `wait_for_job` and `cancel_job`. It finds
the other tools with `search_tools` and runs them with `execute_tool`. To
change this, see [profiles-and-exposure.md](profiles-and-exposure.md).

## 6. Results

Files that tools make (images, video, audio, PDFs) go to the artifact library
in the home folder. Tools return a link such as
`http://127.0.0.1:7777/artifacts/<id>`. The dashboard's **Library** page
shows them all; **Jobs** shows long-running calls; **Usage** shows calls and
estimated cost.

## Where things live

Everything is under the home folder, `~/.plughive` by default:

| Path | What |
| --- | --- |
| `admin-token` | The dashboard token (mode 0600). |
| `secrets.json` | Saved keys when the file store is used (mode 0600). |
| `artifacts/`, `library.db` | The artifact library. |
| `jobs.db`, `usage.db` | Jobs and the usage ledger. |
| `logs/server.jsonl` | The log, as JSON lines. |
| `packs/`, `packs.json` | Packs you added and your pack choices. |
| `profiles.json`, `capabilities.json`, `mounts.json` | Profiles, provider order, your mounts. |

To start over, stop the daemon and remove the folder.

## Run it with Docker

The image runs the daemon on `0.0.0.0` inside the container, so it needs an
access key. In a checkout of the repository:

```sh
[ -e .env ] || printf 'PLUGHIVE_ACCESS_KEY=%s\nPLUGHIVE_ADMIN_TOKEN=%s\nPLUGHIVE_SECRETS_PASSPHRASE=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d --build
docker compose exec plughive plughive dashboard --print
```

The port is published on `127.0.0.1:7777` only. State is in the
`plughive-data` volume. Saved keys go to an encrypted `secrets.json` there.
Clients must send `Authorization: Bearer <PLUGHIVE_ACCESS_KEY>`.

To include Chromium for `screenshot_url`, build with
`docker build -t plughive --build-arg WITH_CHROMIUM=1 .` or set
`WITH_CHROMIUM: "1"` in `docker-compose.yml`.
