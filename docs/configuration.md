# Configuration

plughive is configured with environment variables. All are optional. With
none set, the daemon listens on `http://127.0.0.1:7777`, keeps its state in
`~/.plughive` and asks for no access key.

## Where the values come from

- The daemon entry (`node dist/src/server.js`, `pnpm dev`, `pnpm start`)
  loads `.env` from the current folder at start, unless
  `PLUGHIVE_NO_DOTENV=1` is set in the real environment. A value already in
  the environment wins over the file.
- The `plughive` command does not read `.env`. Export the variables, or run
  `node --env-file=.env dist/src/cli.js start`.
- Command-line options of `plughive start` (`--port`, `--host`, `--home`)
  win over the variables.

[`.env.example`](../.env.example) lists every variable with a short comment.

## Network

| Variable | Default | What it does |
| --- | --- | --- |
| `PLUGHIVE_PORT` | `7777` | Port to listen on. |
| `PLUGHIVE_BIND_HOST` | `127.0.0.1` | Address to bind. Any address that is not loopback (for example `0.0.0.0`) needs `PLUGHIVE_ACCESS_KEY`, or the daemon refuses to start. |
| `PLUGHIVE_PUBLIC_URL` | derived from bind address and port | The origin people reach the daemon on, as `scheme://host[:port]` with no path, for example `https://store.example.com` behind a TLS proxy. Every link the daemon hands out starts with it, and browser `Origin` checks use it. Never taken from a request's `Host` header. |
| `PLUGHIVE_ALLOWED_ORIGINS` | none | Extra browser origins, comma-separated, allowed to call `/mcp`, `/p/*` and `/api/*`. Requests with no `Origin` header (all non-browser MCP clients) are not affected. |

## Access

| Variable | Default | What it does |
| --- | --- | --- |
| `PLUGHIVE_ACCESS_KEY` | none | When set, `/mcp`, `/p/*` and `/artifacts/*` need `Authorization: Bearer <key>` or `X-API-Key: <key>`. Must be at least 16 characters on a non-loopback bind. Never accepted in a query string. |
| `PLUGHIVE_API_KEY` | none | Older name for `PLUGHIVE_ACCESS_KEY`, still read. |
| `PLUGHIVE_ADMIN_TOKEN` | generated | Token for the dashboard and `/api`. 24 to 512 characters, and different from the access key. Unset: the daemon creates a random one on first start and keeps it in `<home>/admin-token` (mode 0600). |
| `PLUGHIVE_API_KEYS`, `PLUGHIVE_API_KEYS_PATH` | none | Removed. The daemon stops with an error when either is set. Use `PLUGHIVE_ACCESS_KEY`. |

## State and keys

| Variable | Default | What it does |
| --- | --- | --- |
| `PLUGHIVE_HOME` | `~/.plughive` | Home folder: databases, artifacts, logs, your packs and settings. |
| `PLUGHIVE_ROOT` | none | Older name for `PLUGHIVE_HOME`. When both are set, this one wins. |
| `PLUGHIVE_SECRETS` | `keychain` on macOS, `file` elsewhere | Where saved keys live. `keychain`: the macOS Keychain. `file`: `<home>/secrets.json`, mode 0600. `memory`: lost when the daemon stops (tests). |
| `PLUGHIVE_SECRETS_PASSPHRASE` | none | With the file store, encrypts `secrets.json` (AES-256-GCM, key from scrypt). Without it the file is plain JSON protected by its mode only. |
| `PLUGHIVE_KEYCHAIN_SERVICE` | `plughive` | The macOS Keychain service name keys are saved under. Letters, digits, `.`, `_` and `-`, up to 64 characters, starting with a letter or digit. An invalid value stops the daemon from starting. Keys saved under one name are not visible under another. |
| `PLUGHIVE_IMPORT_ROOTS` | none | Folders, comma-separated, that `import_artifact` may copy files from. `~` is expanded. Unset: `import_artifact` refuses every path. |
| `PLUGHIVE_WEB_DIR` | `web/dist` next to the code | Folder with the built dashboard. |

## Jobs

| Variable | Default | What it does |
| --- | --- | --- |
| `PLUGHIVE_JOB_CONCURRENCY` | `2` | Long-running calls that run at once. |
| `PLUGHIVE_MAX_QUEUED_JOBS` | `200` | Waiting jobs above this make new long-running calls fail with `JOB_QUEUE_FULL`. |

Finished jobs are kept for 7 days, and at most the newest 1000. These limits
are not configurable.

## Triggers and code mode

| Variable | Default | What it does |
| --- | --- | --- |
| `PLUGHIVE_TRIGGERS` | on | `0`, `false`, `no` or `off` turns off triggers: no scheduler, no `/hooks`, no `/api/triggers`. Saved triggers stay in `jobs.db` and run again when it is back on. See [triggers.md](triggers.md). |
| `PLUGHIVE_HOOK_RATE_LIMIT` | `30` | Inbound webhook requests per minute, per hook. All hooks together get 10 times this. |
| `PLUGHIVE_PAID_CACHE` | on | `0` turns off the paid-call cache. With it on, the same paid media call made again within 24 h returns the saved result (`cached: true`, no new charge); `cache: false` on a call asks for a fresh one. See [spend and approvals](spend-and-approvals.md#repeated-paid-calls). |
| `PLUGHIVE_CODE_MODE` | off | `1` registers `run_tool_script`, which runs a short JavaScript snippet that chains tool calls through `tools.call`, limited to the caller's profile. It runs in a worker thread, in a frozen `node:vm` context with no `require`, `process`, `import` or `eval`, with limits on time (30 s, at most 120 s), calls (25, at most 100), code (64 KB), output (256 KB) and memory. `node:vm` is not a security boundary: turn this on only for your own agent. |

## Logs

| Variable | Default | What it does |
| --- | --- | --- |
| `PLUGHIVE_LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` or `silent`. |
| `PLUGHIVE_LOG_PRETTY` | readable on a terminal, JSON otherwise | `1` forces readable lines, `0` forces JSON. The file `<home>/logs/server.jsonl` is always JSON. |
| `PLUGHIVE_LOG_ARGS` | off | `1` records argument values (masked) in the call log, instead of only their names and sizes. Use it to debug a pack. |

## Provider keys

Save provider keys in the dashboard, under **Packs & keys**. A saved key wins
over the environment.

The environment is a fallback for bundled packs only. A bundled pack reads a
key it declares (for example `FAL_KEY`) from the environment when the store
has nothing under that name. Packs you add yourself and servers you mount
never read the environment.

The names of every key are in [packs.md](packs.md).

## Other variables

| Variable | Used by | What it does |
| --- | --- | --- |
| `PLUGHIVE_NO_DOTENV` | daemon | `1`: do not load `.env`. Set it for tests and service managers. |
| `PLUGHIVE_URL` | `pnpm smoke`, the Claude Code plugin | Base URL of a running daemon. Default `http://127.0.0.1:7777`. |
| `PLUGHIVE_KEYCHAIN_TESTS` | test suite | `1`: run the tests that write to the real macOS Keychain. |
| `HOME` | daemon | Base for `~` in the default home folder and in `PLUGHIVE_IMPORT_ROOTS`. |
| `PATH` | daemon | Where pack programs (ffmpeg, pandoc, ...) are looked up, once, when a pack loads. |

## Settings kept in files

Some settings are made in the dashboard and kept in the home folder:

- `profiles.json`: profiles. See [profiles-and-exposure.md](profiles-and-exposure.md).
- `capabilities.json`: the provider order for each capability.
- `mounts.json`: remote MCP servers you added.
- `packs.json`: which packs are on, their settings and the keys you granted.
- `policy.json`: spend caps and approval rules. No file means no limits. A
  file that does not validate is never overwritten, and while it is broken,
  calls that may cost money and destructive tools are refused. Approvals over
  Telegram also need the `TELEGRAM_BOT_TOKEN` key. See
  [spend-and-approvals.md](spend-and-approvals.md).

### Pack settings that open access

These bundled-pack settings start closed. Set them in the dashboard (Packs >
<pack> > Settings); [packs.md](packs.md) lists every setting.

| Pack | Setting | Default | Effect |
|---|---|---|---|
| machines | `allowedHosts` | empty | Hosts a machine may point at, as `host`, `user@host`, `host:port` or `user@host:port` (exact names or IPs, no wildcards; a part left out matches any value). Checked when a machine is added and on every use. |
| machines | `allowedIdentityFiles` | empty | SSH identity files a machine may use, as absolute or `~/` paths. |
| telegram | `defaultChatId` | none | The chat messages go to when no `chat_id` is given. Always allowed. |
| telegram | `allowedChatIds` | empty | Other chats `send_telegram` may send to. |
| local | `allowRawComfyWorkflows` | off | Lets `local_comfy_run_workflow` run a raw ComfyUI graph. |
| sandbox | `allowedImages` | `python:3.12-slim`, `node:22-slim`, `alpine:3.20` | Docker images `docker_run` may start, matched exactly as written (pin tags). Agents cannot change it. The pack itself is off until you switch it on. |
| sandbox | `allowNetwork` | off | Lets `docker_run` give a container network access when the call asks for it. Off: containers run with `--network none`. |
| cli-bridge | `allowedFolders` | empty | Absolute or `~/` folders an agent may pass as `cwd` to `ask_agent_cli`; the CLI can read and change files there. Empty: every run uses an empty scratch folder. The pack itself is off until you switch it on. |
| share | `maxExpirySeconds` | `86400` (1 day) | The longest a shared link can live, at most `604800` (7 days). |

### Other pack settings

Defaults the action packs use when a call leaves a value out. Set them in the
same place.

| Pack | Setting | Default | Effect |
|---|---|---|---|
| email | `defaultFrom` | none | Sender `resend_send_email` uses when a call gives no `from`, for example `Acme <hello@acme.com>`. Its domain must be verified in Resend. |
| phone | `defaultFrom` | none | Twilio number (E.164, such as `+14155550100`), short code or alphanumeric sender id `twilio_send_sms` uses when it gets no `from`. |
| phone | `defaultMessagingServiceSid` | none | Twilio Messaging Service (`MG...`) used when `twilio_send_sms` gets no `from`. Wins over `defaultFrom`. |
| phone | `defaultAssistantId` | none | Vapi assistant that runs calls placed by `vapi_create_call` when a call gives none. |
| phone | `defaultPhoneNumberId` | none | Vapi phone number that places calls when a call gives none. |
| stock | `unsplashAppName` | `plughive` | Your Unsplash application name, used as `utm_source` in the attribution links Unsplash requires. |
| browser | `browserbaseProjectId` | the API key's project | Project Browserbase sessions start in. |
| share | `endpoint` | none | Bare https origin of the S3 API: `https://<account id>.r2.cloudflarestorage.com` for R2, `https://s3.<region>.amazonaws.com` for AWS. |
| share | `bucket` | none | Bucket the shared copies are uploaded to. Use a bucket only for this. |
| share | `region` | `auto` for R2, `us-east-1` otherwise | Signing region. |
| share | `keyPrefix` | `plughive/` | Prefix of the uploaded object keys. |
| sandbox | `dockerHost` | none | `DOCKER_HOST` for the docker CLI, for example `unix:///Users/you/.docker/run/docker.sock`. The pack runs docker with its own `HOME`, so set it when docker cannot find its socket. |
| cli-bridge | `defaultTimeoutSeconds` | `600` | How long a CLI may run when a call gives no `timeout_s` (10 to 1800). The whole process tree is stopped after it. |
| cli-bridge | `maxOutputBytes` | `4194304` (4 MiB) | Most output a CLI may print before it is stopped (64 KiB to 64 MiB). |
| cli-bridge | `claudeConfigDir` | none | `CLAUDE_CONFIG_DIR` for `claude`, when Claude Code is signed in with a non-default config folder. Passed on, never read. |
| cli-bridge | `npmPrefix` | `%APPDATA%\npm` | Windows only: the npm global prefix the CLIs were installed into. |
| cli-bridge | `chatCli` | none | CLI that answers the `chat` capability for other packs. Used only after you also add cli-bridge to the chat provider order. |
