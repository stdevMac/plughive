# Security

This page says what plughive protects, how, and where the protection ends.
To report a problem, see [SECURITY.md](../SECURITY.md).

## What it assumes

- One person runs the daemon, on a machine they control, for their own
  agents.
- Other local programs and users may try to reach the daemon over the
  network. Web pages in your browser may try too.
- Agents are not fully trusted. Prompt injection can make an agent call tools
  with odd arguments.
- Provider APIs and remote MCP servers return untrusted content.
- Code in a pack you add runs with your rights. The daemon cannot defend you
  from a pack you chose to trust.

## Network exposure

- The daemon binds `127.0.0.1` by default. It refuses to bind any other
  address unless `PLUGHIVE_ACCESS_KEY` is set, and on such an address the key
  must be at least 16 characters.
- On loopback, the `Host` header must be `localhost`, `127.0.0.1`, `[::1]` or
  the host of `PLUGHIVE_PUBLIC_URL`. This blocks DNS rebinding.
- A request with an `Origin` header is refused unless the origin is the
  daemon's own or is in `PLUGHIVE_ALLOWED_ORIGINS`. There is no CORS.
- The access key is accepted as `Authorization: Bearer` or `X-API-Key`, never
  in a query string. It is compared in constant time.
- HTTP limits: headers within 15 s, the whole request within 60 s, MCP bodies
  up to 4 MB.
- The daemon serves no TLS. To reach it from another machine, put it behind a
  TLS proxy and set `PLUGHIVE_PUBLIC_URL`. A network bind without it logs a
  warning: every `Host` name is then accepted and the cookie is not `Secure`.
- On a network bind the daemon refuses to start while provider keys would be
  kept in a plain `secrets.json`, unless `PLUGHIVE_ALLOW_PLAIN_SECRETS=1`.
- `PLUGHIVE_ACCESS_KEY`, `PLUGHIVE_ADMIN_TOKEN` and
  `PLUGHIVE_SECRETS_PASSPHRASE` can be read from a file named by the same
  variable with `_FILE` (Docker secrets), so `docker inspect` does not show
  them. The file must be a regular file of at most 4 KiB; the `_FILE`
  variable is removed before any child process starts.

## The admin token and the dashboard

- Everything under `/api` needs the admin token, even on loopback without an
  access key: "local" includes every other process on the machine.
- The token is 32 random bytes, written to `<home>/admin-token` with mode 0600
  and opened with `O_NOFOLLOW`. `PLUGHIVE_ADMIN_TOKEN` can set it instead.
- The access key is never accepted on `/api`, so an agent cannot change its own
  permissions.
- `plughive dashboard` opens a link with the token after `#token=`. A
  fragment is not sent to the server or kept in server logs. The page posts it
  to `POST /api/session` and gets a session cookie.
- The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/api` (and `Secure` over
  https). Sessions live in memory for 30 days after last use, at most 64 at a
  time. After ten wrong tokens within a minute, sign-in answers `429` until the
oldest of them is a minute old.
- A request that changes something must have the daemon's own `Origin`, or no
  `Origin` and `X-PlugHive-CSRF: 1`. An origin from
  `PLUGHIVE_ALLOWED_ORIGINS` that is not the daemon's own needs the header
  too: it is same-site with a loopback daemon, so a plain form posted from it
  would carry the session cookie.
- The Mac app starts the daemon with a fresh id and hands over the admin token
  only after `/health` echoes that id, so a program that took the port first
  is never given it. Its logs (redacted, lines capped at 64 KiB) and its
  config are written 0600 without following symbolic links, and its
  single-instance lock lives in its private data folder, not `/tmp`.
- The `plughive` CLI sends the admin token over plain http only to this
  machine, refuses redirects and keeps every request under `/api`. Text from
  the daemon is cleaned of terminal control and bidi characters before it is
  printed, so a tool name or error cannot rewrite your terminal.
- The dashboard asks before it runs a trigger, rotates a trigger secret,
  approves a request whose cost is unknown or whose summary was cut, or runs
  a destructive or sending tool from the Playground.

## Provider keys

- On macOS keys go to the Keychain. Elsewhere they go to
  `<home>/secrets.json` with mode 0600, encrypted with AES-256-GCM when
  `PLUGHIVE_SECRETS_PASSPHRASE` is set and plain JSON otherwise.
- The API never returns a key value. Keys are write-only from the dashboard.
- A pack reads only keys it declares and you granted. Packs you add and
  mounted servers never read the environment.
- Every key value is registered with a redactor that replaces it in logs,
  errors and tool results, including its JSON, URL, hex and base64 forms.
  The redactor masks values of 6 characters or more. It is a seatbelt, not a
  security boundary: a value that a pack transforms (reverses, splits,
  encrypts) is not recognised.
- The missing-key flow never asks for a key in the chat. Clients that support
  it get a link to a local setup page. The form only accepts a post from that
  page in a browser (a cookie set when the page is shown, plus same-origin
  fetch metadata), and it only fills a missing key: it never replaces one
  that is set, for a key the pack was granted. A script that holds the link
  can still act like a browser, so
  treat a setup link like a password until it is used. It expires after ten
  minutes and works once.
- Secret names are shared: two packs, or a pack and a mount you add, that use
  the same name share the value.
- Job arguments, results and error text are kept in `jobs.db` (an owner-only
  file) for the retention window. Only values that look like secrets are
  scrubbed. A stored result is capped at 8 MB. Every database and cache under
  the home folder is created 0600 in a 0700 folder.
- Tool results, errors and `resources/read` go through the redactor, and the
  prompts `resources/list` shows are redacted before they are cut. In results
  and errors the daemon's home folder is shown as `$PLUGHIVE_HOME` and your
  home folder as `~`. Files reach agents as artifact links, not paths.
- The daemon refuses to start with a secrets file that other users can write.
  Every key set in the environment is registered with the redactor at
  startup, and values up to 8192 characters are redacted.

## Packs

The permissions in `pack.json` are least privilege at the API level. They are
**not** an operating system sandbox. Pack code runs in the daemon's Node.js
process and could use `node:fs`, `node:child_process` or `fetch` directly.

What the daemon does:

- Bundled packs ship with the daemon. A pack you add stays disabled until you
  review its permissions in the dashboard and enable it.
- Consent is tied to a hash of the manifest and of every file. Any change
  makes the pack "needs review". A symbolic link in the pack refuses it.
- The daemon imports a snapshot copy of the files it hashed, so the code that
  runs is the code you approved.
- The consent screen flags shells, interpreters and remote-access programs
  (`sh`, `node`, `python`, `ssh`, `curl`, `git`, `docker` and others) in
  `permissions.spawn` as high risk.
- Pack key names that would read daemon settings (`PLUGHIVE_*`), process
  settings (`PATH`, `HOME`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`) or other tools'
  credentials (`AWS_*`, `SSH_*`, `GITHUB_TOKEN`, `NPM_TOKEN`) are refused.

Only add packs whose code you have read or whose author you trust.

### Outbound requests

`ctx.fetch` and the bundled packs use a guarded fetch:

- Only hosts in `permissions.network` (public) or `permissions.localNetwork`
  (exact `host:port`) are allowed.
- Every resolved address is checked. Private and loopback addresses are
  blocked unless listed in `localNetwork`. Link-local addresses and cloud
  metadata endpoints are blocked always, including when they are carried
  inside an IPv6 address (NAT64, 6to4, Teredo). Only `2000::/3` counts as
  public IPv6.
- The socket is opened to the checked IP, so DNS cannot change between the
  check and the connection.
- At most 5 redirects, each checked again. Cross-origin redirects keep only a
  safe list of headers.
- Responses are capped at 256 MiB and request bodies at 64 MiB by default.
- Requests from packs carry a mark, and the daemon refuses marked requests to
  its own routes.
- Inputs that the daemon forwards to a provider as a URL to fetch (openrouter
  message parts, fal and replicate image URLs) are refused unless the pack's
  `allow_url_inputs` setting is on, and then only https.
- Page text a pack scrapes reaches a model prompt inside a random per-call
  boundary marked untrusted. That makes prompt injection harder to pass off as
  instructions; it does not make it impossible.

### Programs

`ctx.spawn` runs only programs named in `permissions.spawn`, found once on
`PATH` when the pack loads. Arguments are an array; there is no shell. The
program does not inherit the daemon's environment: it gets `PATH`, `HOME` and
the variables the pack passes, minus names that change how programs load
code, such as `NODE_OPTIONS`, `LD_*`, `DYLD_*`, `PYTHONPATH`, `GIT_SSH_COMMAND`
and `PLUGHIVE_*`. The working folder stays
inside the pack's data folder. Default limits are a 60 s timeout (at most
30 min) and 10 MiB of output (at most 256 MiB).

### Bundled packs that reach further

Some bundled packs can act outside the daemon. Each one is closed until you
open it in the dashboard (Packs > <pack> > Settings):

- **machines** runs commands over `ssh` and `rsync`. A machine can be added
  and used only if its host matches `allowedHosts` and its identity file is
  listed in `allowedIdentityFiles`. Both are empty by default, so nothing is
  reachable until you list it. The check runs again on every use, so removing
  a host from the list stops it at once. Host keys are kept in the pack's own
  `known_hosts` (`StrictHostKeyChecking=accept-new`): your
  `~/.ssh/known_hosts` and the system file are not read or written, and the
  first connection to a host trusts the key it presents, unless the machine
  was added with `host_key`: then that one key is required from the first
  connection (`StrictHostKeyChecking=yes`). Auth is chosen per machine:
  `identity_file` offers only that key, `use_agent` only the agent at
  `sshAuthSock`, and `use_default_keys` your default `~/.ssh` keys, which also
  needs `allowDefaultKeys` on. A machine with none of these is refused. Upload
  and download refuse a remote symlink at the named path; anything further
  on the remote side is bounded by that account's own permissions. A repo's
  `machine_update_repo` (other than a dry run) needs a caller that may also
  use `machine_run`. The pack's state files are never followed through a
  symbolic link. The
  type of a downloaded file is taken from its content, not from the caller.
- **sandbox** `docker_run` runs the container as the daemon's user with no
  capabilities, no new privileges and no network by default, with `HOME` set
  to `/tmp`. Files are
  collected from `/work` without following symbolic links.
- **cli-bridge** runs the agent CLIs you have installed. The `chat` provider,
  whose prompt can carry page or mail text, starts each CLI in its most
  restricted mode: Claude Code with no tools and no MCP servers, Gemini and
  agy in plan mode, opencode with its plan agent and Copilot without tool
  approval. Codex has no no-tools mode: it runs with a read-only sandbox, so
  it can still read files the daemon can read. `ask_agent_cli` itself runs
  the CLI with its normal tools.
- **local** document conversion runs LibreOffice with a fresh profile that
  turns off macros, OLE and link updates and points every web request at a
  dead proxy. HTML input keeps only `data:` and `#` references; every other
  URL or path is removed before it is converted, and anything the sanitiser
  cannot read safely (CSS escapes, `srcdoc`, processing instructions) is
  dropped. The sanitiser reads attributes the way a browser does and writes
  the markup back in one fixed form; `data:` is kept only for raster images
  in image attributes, and `<meta http-equiv>`, `<script>` and `<base>` are
  removed. Document inputs are checked by their bytes, not their declared
  type: anything that is a ZIP gets the ZIP scan and anything that is XML gets
  the XML scan, whatever its extension. The ZIP scan refuses ZIP64 and
  multi-disk archives, more than one end record, a directory that does not
  match the entries, entries outside the archive, symlink entries, oversized
  or highly compressed content, and DTD files. Every XML part (and SVG, HTML
  and the like inside the package) is refused if it holds a DTD internal
  subset, an entity declaration, a non-http(s) external DTD, `file:` or UNC
  references, or external links other than http(s), `mailto:` and `tel:`;
  references are decoded (entities, percent-encoding, Unicode forms) before
  they are checked, and UTF-16 parts are decoded rather than skipped. OCR and
  speech languages must be plain codes (OCR codes joined by `+`).
- **telegram** sends only to the default chat (`defaultChatId`) and to the
  chats in `allowedChatIds`. With neither set it sends nothing. Message text
  is capped at 4096 characters and captions at 1024.
- **local** `local_comfy_run_workflow` runs a raw ComfyUI graph, which can use
  any node installed on that ComfyUI server. It is refused unless
  `allowRawComfyWorkflows` is on. The fixed-recipe local tools are not
  affected.
- **growth** keeps the sender profile (`sender.json`, your name and email) at
  mode 0600. An outreach draft may link only to its CTA or the prospect's own
  site.
- **phone** and **email** send to any recipient unless `allowedRecipients`
  is set (numbers or prefixes; addresses or `@domain`). `lockSender` stops a
  call from choosing its own sender. `agentmail_reply` answers only plain
  addresses from the original message and fails closed on quoted or commented
  ones. Set `allowedRecipients` before you let an agent read mail it did not
  write: a message can ask to be answered.
- **x402** pays any host until `allowedHosts` is set; set it. Every redirect
  hop is checked again, a paid request never follows one, it signs only
  for the known USDC domain, and it never pays a price quoted by a page it
  was redirected to.
- **share** links are signed with `response-content-disposition=attachment`,
  so a shared HTML or SVG file downloads instead of opening on the bucket's
  site.
- Provider replies are read with an 8 MiB cap before they are parsed.
- **web** `web_screenshot` resolves every name through its own pinning proxy:
  Chromium runs without QUIC, its own DNS or unproxied WebRTC. With
  `allowLocalUrls` a local page may be captured, but once a public frame
  loads, or a local name answers with a public address, the capture loses
  local access. A popup the page opens is closed at once.
- **browser** `steel_start_session` returns Steel's `viewer_url` and
  `debug_url`: anyone with those links can watch and drive the session until
  it is released.
- Tools that call a billed API directly carry the `paid` tag and tools that
  send carry `sends`, so spend caps and approval rules see them.

## Artifacts

Files in the library came from models, APIs or imports and are untrusted.
`/artifacts/<id>` sends them with `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox; default-src 'none'`. HTML, SVG, XML and
scripts are sent as `application/octet-stream`. Signed links in tool results
last one hour.

`import_artifact` copies local files into the library only from folders in
`PLUGHIVE_IMPORT_ROOTS`. Unset, it refuses every path.

## Mounted servers

A remote MCP server you mount is reached like a pack's fetch, with its own
key. Its tools are prefixed and cannot replace a pack tool or a daemon tool.
Treat what it returns as untrusted.

- A mount that would send a secret or an OAuth token over plain `http://` to
  another machine is refused; plain http is allowed only to this machine. This
  covers mounts a pack declares as well as mounts you add. The consent screen
  names every header a pack mount sends.
- Errors, logs and the mount list show a remote mount's URL as origin and
  path only, so a key carried in a query string (Browserbase) is not printed.
  Path segments that look like keys (16 or more characters with letters and
  digits, as in `/s/<key>/mcp`) show as `[redacted]`. Mounted tool schemas
  lose `$comment`, `examples` and `x-*` fields.
- For a stdio mount you add, pass secrets in `env`, not in arguments: other
  local users can see a process's arguments in `ps`.
- Mount headers may not contain CR, LF or NUL. A bad header is refused by
  name; its value is never echoed.
- Upstream tool descriptions lose control, bidi and zero-width characters
  before they are cut to 2000 characters, and an upstream error is cut after
  redaction. A tool result over 16 MiB is refused (write an artifact), and a
  `batch` stops including results once they pass 8 MiB.

### Mounts an agent proposes

Agents have tools to list, switch on and off, sign in to and remove mounts
(`list_mounts`, `enable_mount`, `disable_mount`, `connect_mount`,
`remove_mount`) and to propose a new one (`add_mount`). Adding is the step that
can start a program as you or send your keys somewhere, so:

- `add_mount` never writes `mounts.json` on its own. Each new mount opens a
  request in the approvals queue that shows the whole mount: the URL and header
  names, or the full command line and env names. Only the next identical call
  after you approve it on the dashboard or in Telegram adds it, and that uses
  the approval up. A different URL, command or argument is a new request. The
  in-chat approval form is not offered for it.
- Without the approvals queue (no policy gate), `add_mount` refuses and sends
  you to the Mounts page.
- The approval text shows the proposed name escaped (quoted, new lines as
  `\n`), so a name cannot make the request read as something else.
- `enable_mount` on a local (stdio) server of your own asks the same way, with
  its command, because switching it back on starts a program as you. Catalog
  and remote mounts switch on without asking.
- `optimize_mounts` can set smart mount's wake to `ask` but not back to
  `auto`: once you choose "Ask first", only you change it.
- An agent cannot put a key into a mount. A credential header, a key-like URL
  parameter and every `env` value must be a `${secret:NAME}` reference. You
  type the value on the Mounts page.
- An agent cannot point a new mount at a key you already stored: a
  `${secret:NAME}` that already has a value is refused, so a proposed mount
  always starts with a fresh name you fill in yourself. The approval shows
  each header and env value as written (`Authorization: Bearer
  ${secret:NAME}`), so you see which key goes where.
- A mount whose description would not fit in the approval text (500
  characters) is refused, so nothing hides past the cut.
- A proposed mount may not set `env` names that change what runs or where it
  connects (`PATH`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, proxies and the rest of
  the list pack programs lose), may not use a key name only a bundled pack may
  read, and may not put a literal key in a credential header or an
  `--api-key` argument. A stdio mount you write yourself keeps its `env` as
  written.
- `optimize_mounts` asks before it parks mounts, applies keep lists, switches
  the sweep to `auto`, removes a keep or lowers `idle_days`; smart mount
  changes run one at a time.
- `describe_tool` on a parked or hidden tool says so; it does not wake the
  mount.
- `connect_mount` hands the agent the vendor's sign-in link for you to open.
  The tokens go to the secret store, not to the agent.

### OAuth sign-in

A pack mount declared with `auth: "oauth"` is signed in to from the dashboard
(Remote servers, Connect). The daemon is the OAuth client: it finds the server's
authorization server, registers itself (dynamic client registration) with the
redirect `http://127.0.0.1:<port>/oauth/callback` and uses PKCE.

- The tokens, the client registration, the PKCE verifier and the discovered
  authorization server are kept in the secret store (Keychain, OS keyring or
  the encrypted file), never in a file of their own. Their names are
  `OAUTH_<ID>_<HASH>_TOKENS` (and `_CLIENT`, `_VERIFIER`, `_DISCOVERY`), where
  `<ID>` is the mount id made readable and `<HASH>` is 12 hex digits of the
  SHA-256 of the exact id: two mounts never share names, and a mount whose
  names would collide with another's is refused.
- Every record names the mount and server URL it was written for; a record for
  another mount or URL is ignored.
- No pack and no mount you add may declare or read an `OAUTH_` name, and
  `/api/secrets` does not list them. The admin API hands out the vendor's
  authorization URL and a signed-in flag, never a token.
- `/oauth/callback` needs no admin token: the browser arrives from the
  vendor's site. What authorizes it is the `state`: 32 random bytes, bound to
  one mount, single-use and valid for ten minutes. An unknown, reused or
  expired state is refused before any request is made, and the code can only
  be redeemed with the verifier the daemon holds. The page echoes nothing the
  vendor sent and is served with `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`.
- The authorization server's sign-in page must be https. A local address is
  allowed only for a mount on this machine and never on a port the daemon
  uses. The sign-in requests go through the same outbound checks as the mount
  itself.
- Token strings are registered with the log redactor. An expired access token
  is refreshed; when the vendor refuses the refresh token, the mount shows
  "needs sign-in" instead of opening a browser by itself.
- Sign out (Mounts) deletes all four records. It does not revoke the grant at
  the vendor: remove the app in the vendor's settings for that.

## MCP client config files

`plughive connect` writes the daemon's address into an MCP client's config
file. When it writes an access key, the file is set to mode 0600, and every
backup it makes of a config file is created 0600 whatever the original's mode.
Clients that only speak stdio (Claude Desktop) reach the daemon through
`mcp-remote`, run by `npx`. The version is pinned (`mcp-remote@0.16.7`) so an
upgrade of that package is a change you make, not one `npx` makes for you.
`mcp-remote` is a third-party package and sees the access key. `connect`
refuses to write the access key for a plain `http://` endpoint on another
machine unless you pass `--allow-http`.

## Files the daemon writes

The log, client config backups, downloads and secret files are opened without
following symlinks and checked to be the file that was opened before they are
truncated, so a symlink swapped in at the last moment is refused rather than
written through (on Windows too). The daemon refuses to start if
`server.jsonl` is a symbolic link. Log files are owner-only before the first
line is written.

## Spend caps and approvals

See [spend-and-approvals.md](spend-and-approvals.md) for how they work.

- Agents cannot approve their own requests: approving and editing the policy
  are admin routes under `/api` (admin token and CSRF header), and no MCP tool
  reaches them.
- An approval covers one call (a hash of the tool, provider, profile and
  arguments) and is used at most once. It expires, 30 minutes by default. It
  does not cover the same call with a higher `max_cost_usd`.
- Calls still running count against caps, so parallel calls cannot pass a cap
  together. Paid calls whose cost is not known up front run one at a time per
  cap (the lock is let go while a call waits for approval); one such call can
  still overshoot, since its cost is known only after it runs.
- Every item of a `batch`, every `tools.call` in a script and the contact
  sheet's inner call is checked by the policy on its own; the outer approval
  does not carry into them. Always-ask and destructive tools still ask inside an approved
  workflow run, and a paid-cache hit asks when a rule says so.
- A workflow started inside an approved run is checked against its own
  rules, so an approval for the outer call does not carry into it.
- A request keeps a redacted summary of the arguments, never the arguments.
  The summary keeps every key (each value gets a share of the space), and
  control and bidi characters are removed from it and from the tool and
  reason, so a long or crafted argument cannot hide another one.
- With `approve_in_chat` on, an answer counts only if it echoes the token of
  a form the daemon showed. A client that answers that form itself still
  approves: the daemon cannot tell who filled it in.
- `max_sends_per_hour` (off by default) caps calls to `sends` tools per
  profile. The count is in memory and starts again when the daemon restarts.
- A trigger webhook cannot change what the trigger runs: the saved args win
  over the request body, and `dry_run` in the body is ignored. A trigger has
  at most 5 runs unfinished at a time. Webhook signing secrets are registered
  with the log redactor. See [triggers.md](triggers.md).
- `policy.json` is written atomically, mode 0600. A file that does not
  validate is never overwritten, and the daemon fails closed while it is
  broken: calls that may cost money and destructive tools are refused.
- Caps are only as exact as the costs providers report: a provider that
  reports none counts as zero.
- Telegram approvals are off unless turned on with a list of allowed chats.
  The daemon polls Telegram and opens no port; button presses from any other
  chat are ignored. In a group chat every member can press Approve unless
  `telegram.allowed_user_ids` names who may. It sends the tool and provider ids, the estimate, the
  reason and the redacted argument summary.

## No telemetry

The daemon makes no network calls of its own. Outbound traffic comes only from
tools you call, mounts you enable and the dashboard loading its own files.

## Known limits

- Pack code is not sandboxed (see above). A pack that ships code runs it with
  your full rights; the consent screen says so, and its permission lines
  describe what the daemon mediates, not a sandbox. Programs a pack runs get
  only an allowlisted environment (`PATH`, a private `HOME` and temp folder,
  locale, and the keys it declared).
- With no access key (the default on loopback), any process or user on this
  machine can call every enabled tool. Profiles limit what each endpoint
  lists, not who may call which endpoint, and `list_artifacts` shows artifacts
  from every profile. Set `PLUGHIVE_ACCESS_KEY` if other local users or
  untrusted local apps could reach the port.
- On a network bind with `PLUGHIVE_PUBLIC_URL`, only requests addressed to
  localhost, the bind address or the public host are answered.
- Wrong dashboard sign-in tokens are rate limited per address; the right token
  always works.
- The redactor matches the exact key in common encodings. It does not catch
  fragments, HTML-entity or double-encoded forms, or other transformations.
- Without `PLUGHIVE_SECRETS_PASSPHRASE`, the file store (the default on Linux
  and in Docker) is plain JSON protected by its file mode only. The dashboard
  shows a warning when that is the case.
- Sessions are in memory; a restart signs every browser out.
- The Mac app is ad-hoc signed and not notarized.
- Provider integrations are tested against mocks only.
- x402 compares amounts with ordinary BigInt arithmetic, not in constant
  time. The amounts are public (they come from the server's quote), so this
  leaks nothing secret.
- A `wf_*` step counts as free in the parent workflow's plan, and a paid tool
  called from inside a code tool that is not tagged `paid` is not seen by the
  caps. Caps on the inner tool's own calls still apply.
- Tools tagged only destructive (`uninstall_software`, `remove_mount`,
  `forget`, closing a browser session) ask only when `ask_before_destructive`
  is on, which it is not by default. Add them to `always_ask_tools` to make
  them ask.
- Trigger webhooks limit unsigned requests per hook, not per client, so a
  flood of unsigned requests can use up one hook's budget for a minute. Signed
  requests have their own budget.
- Trust in a mounted server's tool hints only adds friction: a server that
  claims a tool is read-only controls what that tool does anyway.
- `web_screenshot` with `allowLocalUrls` follows a redirect to a local
  host and port the page already requested directly.
- The Mac app does not use the hardened runtime.
- Binary office formats (doc, xls, ppt, rtf) cannot be scanned like the ZIP
  formats. They rely only on the locked-down LibreOffice profile. A ZIP
  nested inside a document is not scanned again, and Word field codes
  (INCLUDEPICTURE, INCLUDETEXT) are not checked.
- `run_tool_script` (`PLUGHIVE_CODE_MODE`) runs in `node:vm`, which is not a
  security boundary. Only strings cross between the script and the daemon,
  and its Promises and Errors are made inside the sandbox, but turn it on only
  for your own agent.
