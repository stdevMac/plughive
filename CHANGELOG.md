# Changelog

All notable changes are listed here. Versions follow semantic versioning.

## Unreleased

## 0.1.2

- npm releases are now published through npm trusted publishing (OIDC from
  GitHub Actions), with no npm token stored in the repository. No code
  changes.

## 0.1.1

### Fixed

- Windows: files that must not be followed through a symlink (the admin
  token, CLI artifact downloads, machines state) are now checked on Windows,
  which has no `O_NOFOLLOW`; a symlink is refused.
- Windows: a path inside the root written with another spelling of the root
  (an 8.3 short name or a symlinked prefix) is accepted.
- `plughive service` and the compile cache build paths for the target
  platform, not the host's.
- Capability settings changed twice within the same moment are no longer
  missed.
- local: staging a document on Windows works when the old file is read-only,
  and a staged file the zip check rejects is removed.
- Tests pass on Windows, so CI checks all three platforms.

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
- Release: every job that publishes (npm, Docker, the GitHub Release) runs
  in the `release` environment, so `DOCKERHUB_TOKEN` can live there instead
  of in the repository. npm is pinned to an exact version and installed
  without scripts, the package is packed in a step that holds no token and
  published with `--ignore-scripts`, and release images are built without a
  shared registry cache. The README's `docker run` keeps the access key and
  passphrase in a private `plughive.env` instead of the command line.
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
- Triggers: the trigger's saved args now win over the webhook body, and
  `dry_run` in the body is ignored. Before, the body could override both.
  Unsigned requests no longer use up a hook's signed run budget, a trigger
  has at most 5 runs unfinished at a time (the webhook answers `429 BUSY`
  past that), and callbacks are sent at most 4 at a time.
- Workflows: a workflow started inside an approved run is checked against
  its own cost rules, a `forEach` fallback is counted once per item, and
  `join`, `concat` and the run output have size limits (`concat` at 10,000
  items, the output at 1 MB).
- Approvals: an in-chat answer counts only if it answers a form the daemon
  showed, so a client cannot pre-supply `approval_decision` with its first
  call. Argument summaries keep every key, and control and bidi characters
  are removed from them and from the tool and reason. The new opt-in
  `max_sends_per_hour` rule caps calls to `sends` tools per profile.
- share: `share_artifact` and `share_unshare` carry the `sends` tag, so they
  ask by default. Active web types (HTML, SVG, XML, JS) are uploaded as
  `application/octet-stream`, so a share link cannot run script.
- Secrets: the daemon refuses a secrets file that other users can write.
  Every key from the environment is redacted from the start, values up to
  8192 characters are redacted, and errors, stored job results and success
  results are redacted and path-scrubbed. Preferences are written
  atomically at 0600, and the compile cache checks every parent folder.
- CLI: text from the daemon is cleaned of terminal control and bidi
  characters before it is printed. The CLI refuses to send the admin token
  over plain http to a host that is not this machine, refuses redirects, and
  keeps API paths under `/api`. Downloads stay inside the artifact path and
  never follow a symlink. `--set` refuses `__proto__`, `constructor` and
  `prototype`. `pack add` runs `git clone` without `file://` transports or
  symlinks.
- Network: IPv6 forms that carry an IPv4 address (NAT64, 6to4, Teredo) are
  checked for metadata and local addresses, and the web and local packs
  refuse everything outside `2000::/3`. `localhost.` counts as local.
  `web_screenshot` with `allowLocalUrls` blocks a redirect or a top-frame
  navigation from a public page to a local address.
- Mounts: mount headers may not contain CR, LF or NUL. Upstream tool
  descriptions lose control, bidi and zero-width characters, and upstream
  error messages are cut after redaction. A tool result over 16 MiB is
  refused (use artifacts), and a batch stops including results past 8 MiB.
  `resources/list` redacts the prompts it shows.
- Packs: firecrawl follows only further pages of the same crawl, up to 64
  MiB. growth no longer drafts for leads marked skipped or lost and keeps a
  lead's status when it redrafts. telegram responses are capped at 1 MiB.
  `research_prospect` carries `paid`. `x402_quote` sends the caller's
  headers only when `allowedHosts` is set.
- Dashboard: running a trigger now, rotating its secret, approving a request
  with an unknown cost or a cut summary, and running a destructive or
  sending tool from the Playground each ask first. The live event stream
  stops retrying after a sign-out, and config snippets quote values for the
  shell, TOML and YAML. The browser `web.fetch` provider cuts the page inside
  the browser.
- Mac app: log lines are capped and redacted before they are cut, logs and
  the app config are written 0600 without following symlinks, and
  notifications are cleaned and capped. The single-instance lock moved from
  `/tmp` to the app's private data folder.
- local: the HTML sanitiser used before a conversion now fails closed. It
  checks each `srcset` candidate, drops `srcdoc`, DOCTYPE and processing
  instructions, and removes CSS that could load a URL. Office files that are
  ZIP archives (docx, xlsx, pptx, odt, ods, odp, epub) are scanned before any
  tool runs: ZIP64, entries outside the archive, too many entries, more than
  256 MiB unpacked or a 200:1 ratio, external entities, `file:` and UNC
  references, and external links that are not http(s), `mailto:` or `tel:`
  are refused. Speech language codes, yt-dlp subtitle languages, ComfyUI
  output paths and model ids are checked before they reach a program.
- machines: the pack's state and pin files are read and written without
  following symbolic links, and uploads land through a temporary file.
  `machine_update_repo` now needs `machine_run` for every run that is not a
  dry run, not only for `post_update`. IPv6 hosts are parsed strictly and a
  zone id (`%`) is refused.

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
