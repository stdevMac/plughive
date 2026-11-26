# Changelog

All notable changes are listed here. Versions follow semantic versioning.

## Unreleased

## 0.1.0

The first public release.

### Security

Some of these close access that was open before. If a tool now refuses, its
error names the setting to change.

- machines: a machine can be added and used only if its host is in the new
  `allowedHosts` setting and its identity file is in `allowedIdentityFiles`.
  Both are empty by default. Host keys live only in the pack's own
  `known_hosts`; `~/.ssh/known_hosts` is no longer read or updated. The type
  of a downloaded file is taken from its content; the `mime` input is gone.
- telegram: `send_telegram` sends only to `defaultChatId` and the chats in
  `allowedChatIds`. Before, any chat was allowed when `allowedChatIds` was
  empty. `chat_id` must be a numeric id or an `@channel` name; text is capped
  at 4096 characters and captions at 1024.
- local: `local_comfy_run_workflow` is off unless the new
  `allowRawComfyWorkflows` setting is on.
- `plughive connect`: a client config file that holds an access key is
  written 0600, and every backup is created 0600. The Claude Desktop bridge is
  pinned to `mcp-remote@0.16.7`.
- growth: `sender.json` is written 0600, including a file an older version
  left 0644.
- web, machines: length limits on `web_screenshot` `url` and `wait_for` and on
  machine names.
- The npm package is built from a clean `dist` (`prepack`), lists only the
  build outputs it needs, and CI checks its contents with `pnpm check:pack`.
- `.gitignore` covers every `.env` variant except `.env.example`, plus
  `admin-token` and the file secrets store.
- Network bind: the daemon refuses to start on an address other than loopback
  while provider keys would sit in a plain `secrets.json`. Set
  `PLUGHIVE_SECRETS_PASSPHRASE` (or `_FILE`), or
  `PLUGHIVE_ALLOW_PLAIN_SECRETS=1` to accept the plain file. A network bind
  without `PLUGHIVE_PUBLIC_URL` logs a warning.
- Docker: `PLUGHIVE_ACCESS_KEY_FILE`, `PLUGHIVE_ADMIN_TOKEN_FILE` and
  `PLUGHIVE_SECRETS_PASSPHRASE_FILE` read a credential from a file (Docker
  secrets), so it is not in the container's environment. The image runs as
  the `node` user on a pinned base; the compose file uses a read-only root,
  drops every capability and publishes the port on the host loopback only.
- Spend caps: calls that are still running count against a cap, so parallel
  calls can no longer pass it together. An approval no longer covers the
  same call at a higher `max_cost_usd`, an invalid `max_cost_usd` is refused,
  always-ask and destructive tools still ask inside an approved workflow,
  the paid cache is kept per profile, a cache hit still asks when a rule says
  so, and a queued tool checks its profile's scope again when it runs.
- Billed and sending tools: every tool that calls a billed API directly now
  carries the `paid` tag, so caps and approvals see it (gemini, elevenlabs,
  seo, growth, dub, firecrawl, browser sessions, maps, phone), and
  `send_telegram` carries `sends`.
- phone, email: new `allowedRecipients` (numbers or prefixes; addresses or
  `@domain`) and `lockSender` settings. Empty keeps the old behaviour.
  `agentmail_reply` replies only to plain addresses in the original message
  and checks them against `allowedRecipients`.
- openrouter, fal, replicate: URLs inside inputs (message parts, model image
  URLs) are refused unless the new `allow_url_inputs` setting is on, and then
  https only. social, growth and dub accept only http(s) URLs.
- Scraped page text reaches model prompts inside a random per-call boundary,
  the workflow recipes mark interpolated page text as untrusted, and an
  outreach draft that links anywhere but its CTA or the prospect's own site
  is refused.
- x402: every redirect is checked against `allowedHosts` again and drops the
  caller's headers when it changes origin, paid requests never follow one,
  `x402_quote` sends no body, and the signed USDC domain is pinned.
- web: `web_screenshot` runs Chromium without QUIC, its own DNS or unproxied
  WebRTC. A local page stays reachable only while every frame is local: once
  a public frame loads, or a local name answers with a public address, the
  capture loses local access. More reserved ranges (Teredo, 6to4 relay,
  documentation, NAT64 local use) are refused.
- HTTP: a write from an origin in `PLUGHIVE_ALLOWED_ORIGINS` that is not the
  daemon's own needs the CSRF header too. Artifact files are opened with
  `O_NOFOLLOW` and checked to be inside the library.
- MCP: `resources/read` results go through the redactor, and a stored job
  result is capped at 8 MB.
- Pack mounts: a mount that would send a secret or OAuth token over plain
  http to another machine is refused, the consent screen names the headers a
  mount sends, and a pack you add needs a valid entry hash to be enabled.
- `plughive connect` and `plughive service`: config and service files are
  written atomically and owner-only. Values with a newline, carriage return
  or NUL are refused before they reach a systemd unit, plist or task. Config
  files are parsed into null-prototype objects and reserved server names are
  refused.
- Databases and caches under the home folder are created owner-only (0600
  files, 0700 folders).
- Mac app: the supervisor gives the daemon a fresh id per launch and hands
  over the admin token only when `/health` returns it, so a process that took
  the port first gets nothing. Its logs carry no secrets.
- Dashboard: only same-origin media renders inline, external links must be
  http(s), and form drafts cannot set prototype keys.
- CI: actions are pinned to commits, workflows have least-privilege
  permissions, and Dependabot watches npm, actions and cargo.
- Profiles: the default profile's excludes now also stop capability
  provider routing, as they do for every other profile.
- Setup links: a missing-key link works only for a key the pack was granted,
  and two live links for one key cannot both store a value.
- Mounts: a mount whose prefix another mount already uses is refused. An OAuth
  sign-in page must be https; a local one only for a mount on this machine,
  and never on a port the daemon uses. The client registration token and a
  reloaded PKCE verifier are redacted, and sign-in errors are redacted before
  they are logged.
- Packs: a `localNetwork` entry a pack declares must be a local name
  (`localhost` or a private IP), like the ones you grant. A spawned program no
  longer takes `HOME`, proxy variables, CA bundle settings, `OPENSSL_*` or
  `GLIBC_TUNABLES` from the pack.
- Installer: archives with hard-linked entries are refused, and installs
  running at once no longer lose each other's `lock.json` entries.
- Files: paths through a macOS `..namedfork` are refused, and
  `import_artifact` takes the file type from the file it opened.
- Secrets: the file store and its lock are read without following symbolic
  links, and permissions are checked and fixed on the open file.
- Telegram approvals: the new `telegram.allowed_user_ids` limits who may
  press Approve in a group chat.
- Workflows: a recipe input with `additionalProperties: false` refuses
  unknown keys instead of dropping them.
- machines: a machine needs an explicit auth method: `identity_file`,
  `use_agent` or `use_default_keys`. A machine added without one, including
  one added by an older version, is refused until you add it again.
  `use_default_keys` also needs the new `allowDefaultKeys` setting, and
  `SSH_AUTH_SOCK` reaches only `use_agent` machines. The new `host_key` input
  pins one host key from the first connection. Upload and download refuse a
  remote symlink, and `machine_update_repo` runs a `post_update` command only
  for a caller that may use `machine_run`.
- sandbox: `docker_run` collects files without following symbolic links and
  runs the container as the daemon's user instead of root, with `HOME` set to
  `/tmp`.
- cli-bridge: the `chat` provider starts each agent CLI in its no-tools or
  read-only mode, and `generate_image_via_agy` turns off slash commands.
- local: LibreOffice conversions run with macros, OLE, link updates and web
  access off, and HTML input keeps only `data:` and `#` references. An OCR
  `language` must be codes joined by `+`.

### Added

- Languages: the dashboard and the desktop menu are in English and Spanish.
  Home asks for the language on first run, the sidebar, sign-in page and
  Settings can change it, and the choice is saved with the daemon
  (`GET`/`PUT /api/preferences`) so the desktop menu, its dialogs and
  notifications follow it. A new language is a folder of JSON files:
  `pnpm i18n:new <code> "<Name>"` starts one, and `pnpm i18n:status` shows what
  is left. See [docs/i18n.md](docs/i18n.md).
- Paid-call cache: the same paid media call made again within 24 hours returns
  the saved result (`cached: true`, no new charge) while its artifacts are
  still in the library. `cache: false` asks for a fresh call;
  `PLUGHIVE_PAID_CACHE=0` turns it off. The Usage page shows how many calls
  were reused from the cache.
- Every media tool now takes `max_cost_usd` and `cache`, not only the first
  six.
- Spend caps and human approvals: daily or monthly caps (global, per provider,
  per profile) that block or ask, approval rules, `max_cost_usd` on media
  tools, workflow cost estimates in `dry_run`, an Approvals page and a cap
  editor on the dashboard, and opt-in approvals over Telegram. Off until you
  write `policy.json`. See [docs/spend-and-approvals.md](docs/spend-and-approvals.md).
- Cost estimates: fal providers price each call from fal's price API, and
  local or account providers count as $0. Before this, `max_cost_usd`
  skipped every provider that could not estimate.

### Removed

- `scripts/install-launchd.sh`. Use `plughive service install` instead. It
  writes the same LaunchAgent (`dev.plughive.daemon`) on macOS, a systemd
  user unit on Linux, and a logon task on Windows.

### What is in it

- One daemon that serves MCP over Streamable HTTP at `/mcp`, bound to
  `127.0.0.1:7777` by default.
- 36 bundled packs with 173 tools on by default (193 with the off-by-default
  machines, sandbox and cli-bridge packs). See [docs/packs.md](docs/packs.md).
- Five protocol tools that let a client find and call any tool without
  listing all of them: `search_tools`, `describe_tool`, `execute_tool`,
  `wait_for_job` and `cancel_job`.
- Profiles that choose which tools a client sees, served at `/p/<profile>`.
- A dashboard for keys, packs, profiles, a playground, the artifact library,
  jobs and usage.
- User packs: a folder with `pack.json` and an entry file. They stay off until
  you review and enable them.
- The `plughive` command: `start`, `dashboard`, `status`, `doctor`, `pack`
  and `cursor-link`.
- A Docker image, a compose file and a Claude Code plugin.

### Changed from the private build

The private build that came before 0.1.0 had a flat list of built-in tools.
Those tools now live in packs. Most kept their names. These did not:

| Old tool | What to use now |
| --- | --- |
| `convert_media` | `local_media_convert` |
| `mix_audio` | `local_audio_mix` |
| `generate_audio` | `generate_speech` (any provider) or `elevenlabs_text_to_speech` |
| `list_voices` | `elevenlabs_list_voices` or `local_voices` |
| `sample_voices` | Removed. Call `generate_speech` once per voice. |
| `list_video_models` | `openrouter_search_models`, `fal_search_models` or `replicate_search_models` |
| `media_backend_status` | `list_media_providers` and `local_status` |
| `reconcile_video_job` | Removed. A paid call is not retried automatically; check it with `get_job_status`. |
| `list_catalog` | `search_tools` |
| `route_capability` | Removed. The `media` pack tools (`generate_image`, `chat`, ...) pick a provider. |
| `gateway_reload` | Removed. Packs are enabled, disabled and reloaded one at a time from the dashboard. |
| `deploy_set_host`, `deploy_register_repo`, `deploy_remove_repo`, `deploy_list`, `update_repo` | The `machines` pack: `machine_add`, `machine_add_repo`, `machine_remove_repo`, `machines_list`, `machine_update_repo` (off by default) |

These tools kept their names and moved into a pack:

- `growth`: the `apollo_*` tools,
  `craft_icp`, `draft_cold_email`, `get_sender_profile`, `set_sender_profile`,
  `list_drafts`, `mark_contacted`, `personalize_outreach`, `pipeline_run`,
  `query_companies`, `query_leads`, `research_prospect` and `score_lead`.
- `web`: the `firecrawl_*` tools and `screenshot_url`.
- `seo`: the `seo_*` tools.
- `dub`: `dub_shorten_url`. `pdf`: `md_to_pdf`. `telegram`: `send_telegram`.
- `openrouter`: `openrouter_chat`.
- Core: `gateway_status`, `get_job_status`, `import_artifact`,
  `list_artifacts` and `usage_report`.

Other changes from the private build:

- One optional access key (`PLUGHIVE_ACCESS_KEY`) replaces the multi-key
  setup. `PLUGHIVE_API_KEYS` and `PLUGHIVE_API_KEYS_PATH` now stop the
  daemon with an error. `PLUGHIVE_API_KEY` is still read as an alias.
- Quotas, tenant accounts and the hosted-service code are gone.
- Cloud storage staging for artifacts is gone. Artifacts stay in the home
  folder and are served from `/artifacts/<id>`.
- Remote MCP servers are mounted from the dashboard: the preconfigured ones
  in the `mounts` pack, your own under Mounts (kept in `mounts.json`).
