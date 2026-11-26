# PlugHive desktop app (macOS, Windows, Linux)

A Tauri 2 tray app (the menu bar on macOS, the notification area on Windows,
the status area on Linux) that bundles the plughive daemon with its own Node.js
runtime, keeps it running on a loopback port, opens the dashboard in a native
window and writes MCP client configs for you.

Builds for macOS (Apple Silicon and Intel), Windows (x64, arm64) and Linux
(x64, arm64), each on its own OS. Not code-signed for distribution (ad-hoc on
macOS, unsigned on Windows), no updater.

## What you get

Tray icon. On macOS a template image, so macOS tints it for light and dark
menu bars; on Windows and Linux a colour icon with an amber dot while
starting and a red dot when it needs attention:

| Icon            | Status line                     |
| --------------- | ------------------------------- |
| dashed frame    | `Starting…`                     |
| solid frame     | `Running`                       |
| frame + badge   | `Needs attention: <reason>`     |

Menu:

- **Open Dashboard**: native window (default 1280x820, minimum 900x600,
  remembers size and position). Closing it keeps the app in the menu bar.
- **Approvals Waiting…**: shows how many calls are waiting for a person's
  OK and opens the dashboard's Approvals page. The app asks the daemon every
  5 seconds (one loopback request) and shows a system notification for each
  new approval, with the tool, the reason and the estimate. The notification
  only tells you; approving or denying happens on the dashboard.
- **Copy Endpoint**: copies `http://127.0.0.1:<port>/mcp`.
- **Connect a client ▸**: Claude Desktop, Claude Code, Cursor, Codex CLI,
  Hermes Agent. A check mark means the client's config already has an
  `plughive` entry. Clicking an unchecked client writes the entry; clicking a
  checked one asks, then removes it. A dialog shows the file, the backup and
  how to make the client reload.
- **Start at login**: tauri-plugin-autostart (a LaunchAgent on macOS, a
  `Run` registry value on Windows, an XDG autostart entry on Linux).
- **Troubleshoot ▸**: **Restart Daemon**, **Show Logs** (reveals `daemon.log`
  in Finder, Explorer or the file manager).
- **Quit PlugHive**.

On first run the dashboard opens by itself once the daemon is healthy.

On Linux the tray menu is shown through AppIndicator, which has no click
events: open the menu, not the icon, to reach the dashboard.

## Prerequisites (build machine)

All OSes:

- Rust 1.90 or later (tested with 1.99.1)
- Node 22 or later (tested with 26.7.0) and pnpm, with the repo dependencies
  installed: `pnpm install --frozen-lockfile` in the repo root. The payload
  pins its native modules to those versions.

Per OS:

- **macOS** 12 or later: Xcode or the Command Line Tools.
- **Windows** 10 or 11: the MSVC build tools ("Desktop development with
  C++") and WebView2 (preinstalled on Windows 11).
- **Linux**: the Tauri system packages. On Debian or Ubuntu:
  `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl file`.

## Build

Build on the OS you are building for: the payload's native modules
(better-sqlite3, sharp) come from a production install on that machine.

```sh
pnpm build                        # repo root: compiles dist/ and the dashboard
cd app
npm install                       # local @tauri-apps/cli 2.12.6, nothing global
npm run build                     # payload, Node sidecar, then this OS's installers
```

`npm run build` runs `scripts/build-payload.mjs` and then
`scripts/bundle.mjs`, which calls `tauri build --bundles` with:

| OS      | Output (under `src-tauri/target/release/bundle/`)           |
| ------- | ------------------------------------------------------------ |
| macOS   | `macos/PlugHive.app`                                        |
| Windows | `nsis/PlugHive_<version>_x64-setup.exe` (per-user, no admin)|
| Linux   | `deb/*.deb` and `appimage/*.AppImage`                        |

The payload script downloads the official Node build for this machine
(`node-v26.13.1-<os>-<arch>.tar.gz`, or `.zip` on Windows) and its
`SHASUMS256.txt` from nodejs.org into `app/.cache/` (once), checks the
sha256 and writes `src-tauri/binaries/node-<target triple>` (`.exe` on
Windows). It installs the payload's production dependencies with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, keeps only this platform's
better-sqlite3 addon, and fails if it is missing.

Icons are committed. To regenerate them:

```sh
npm run icons     # scripts/make-icons.mjs, then `tauri icon` for the .icns, .ico and PNGs
```

## Run

macOS:

```sh
open "src-tauri/target/release/bundle/macos/PlugHive.app"
```

Windows: run the setup `.exe`; it installs for the current user only.
SmartScreen warns about an unsigned installer the first time ("More info",
then "Run anyway").

Linux: `sudo apt install ./src-tauri/target/release/bundle/deb/*.deb`, or
make the AppImage executable and run it. GNOME needs the AppIndicator
extension to show tray icons.

On macOS, copy `PlugHive.app` to `/Applications` first. A copy that came from a
download or AirDrop is quarantined: macOS refuses an ad-hoc signed app, so use
System Settings > Privacy & Security > Open Anyway once, or
`xattr -dr com.apple.quarantine "PlugHive.app"`.

## What is bundled

```
PlugHive.app/Contents/
  MacOS/plughive-app      the Rust app (tray, window, supervisor)
  MacOS/node               Node v26.13.1 darwin-arm64, re-signed ad-hoc
  Resources/daemon/        dist/ (daemon + dashboard), config/, skills/,
                           node_modules/ (production deps, darwin-arm64 only),
                           app/launcher.mjs, app/clients.mjs
  Info.plist               LSUIElement (no Dock icon while no window is open)
```

Windows and Linux bundles hold the same `daemon/` folder and a
`node-<triple>` sidecar next to the app binary.

Not bundled: Playwright browsers, ffmpeg, Pandoc, TeX and other external
tools that some packs call. The daemon finds them on a PATH that depends on
the OS:

- macOS: `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin` and the
  system directories.
- Linux: `~/.local/bin`, `/usr/local/bin`, the system directories,
  `/snap/bin`, plus the absolute folders of the PATH the app was started with.
- Windows: the PATH the app was started with (user and system PATH from the
  registry), falling back to `System32`.

The daemon's own Software page can install many of these tools for you.

## Where things live

Bundle id `dev.plughive.desktop`. The table shows macOS paths. On Windows
data lives in `%APPDATA%\dev.plughive.desktop\` and logs in
`%LOCALAPPDATA%\dev.plughive.desktop\logs\`; on Linux in
`~/.local/share/dev.plughive.desktop/` and
`~/.local/share/dev.plughive.desktop/logs/`. Pack secrets go to Windows
Credential Manager, or on Linux to the Secret Service (GNOME Keyring,
KWallet) when one answers and an owner-only file otherwise.

| What                       | Path                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| App settings (port, window)| `~/Library/Application Support/dev.plughive.desktop/app-config.json`     |
| Daemon data root           | `~/Library/Application Support/dev.plughive.desktop/daemon/`             |
| Admin token                | `.../daemon/admin-token` (file mode 0600)                                |
| Pack secrets               | Keychain, service `plughive` (plus an index item `plughive.index`)     |
| Logs                       | `~/Library/Logs/dev.plughive.desktop/app.log` and `daemon.log`           |
| Login item                 | `~/Library/LaunchAgents/PlugHive.plist` (only while Start at login is on)|

Logs rotate at 5 MB and keep three old files (`daemon.log.1` to `.3`). Lines
are filtered before they are written: the admin token and anything after
`token=` or `Bearer ` is replaced with `[redacted]`.

## How the daemon is run

- `node app/launcher.mjs` from the bundle, with a cleared environment: only
  `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `PLAYWRIGHT_BROWSERS_PATH` are
  passed through, plus the PATH above. Linux adds the `XDG_*` folders and
  `DBUS_SESSION_BUS_ADDRESS` (for the Secret Service); Windows passes the
  variables programs need to start (`SystemRoot`, `WINDIR`, `COMSPEC`,
  `PATHEXT`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `ProgramData`, `ProgramFiles`, ...).
- Set by the app: `PLUGHIVE_BIND_HOST=127.0.0.1`, `PLUGHIVE_PORT`,
  `PLUGHIVE_ROOT`, `PLUGHIVE_NO_DOTENV=1`, on macOS
  `PLUGHIVE_SECRETS=keychain`,
  `PLUGHIVE_LOG_PRETTY=0`, `PLUGHIVE_PARENT_WATCH=1`. No access key: the
  daemon only listens on loopback.
- **Port.** The first run picks a free loopback port and saves it. Later runs
  reuse it, so client configs stay valid. If it is taken (checked for 3 s),
  the app picks a new one, tells you, and offers to update the clients that
  pointed at the old URL.
- **Health.** `/health` every 5 s. Three failed checks in a row, or a daemon
  that does not get healthy within 45 s, means a restart. A crash means a
  restart. Backoff starts at 1 s and doubles up to 30 s; it resets after
  60 s of healthy running.
- **Quit.** The app closes the daemon's stdin pipe, which makes the launcher
  shut the daemon down cleanly on every OS. On macOS and Linux it also sends
  SIGTERM to the daemon's process group, waits 8 s, then SIGKILL. On Windows
  the daemon runs in a Job Object that kills every process in it when the
  app ends, even if the app crashes; after the 8 s grace the app terminates
  the job.
- **Orphan guard.** The launcher exits when its stdin pipe from the app closes
  or its parent changes, so a crashed or force-quit app does not leave a
  daemon behind.
- **One instance.** Opening the app again shows the dashboard of the copy
  that is already running. On macOS an exclusive lock on `app.lock` in the
  private data directory, taken before anything starts, decides which copy
  runs (also for two copies started a few milliseconds apart), and a later
  copy asks the running one to show its dashboard over `app.sock` in the
  same directory, so nothing is shared with other accounts through `/tmp`.
  On Windows (named mutex) and Linux (D-Bus) `tauri-plugin-single-instance`
  does it.

## Dashboard window

The window loads `http://127.0.0.1:<port>/#token=<admin token>`; the
dashboard reads the token and removes the fragment from the address at
once. The token never goes into a query string. Navigation is
limited to the daemon's origin. Other links, and anything that would open a
new window, go to the default browser. The window has no Tauri IPC: no
capabilities, `withGlobalTauri` off, no custom commands. After a daemon
restart or port change the window is pointed at the new URL.

## Connect a client

The menu calls `app/clients.mjs` with the bundled node, which uses
`src/clients` from the repo. It edits only the `plughive` entry:

| Client         | File                                                       | Entry                          |
| -------------- | ---------------------------------------------------------- | ------------------------------ |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/`) | `npx -y mcp-remote@<pinned version> <url> --transport http-only` |
| Claude Code    | `~/.claude.json` (user scope)                              | `{type: "http", url}`          |
| Cursor         | `~/.cursor/mcp.json`                                       | `{url}`                        |
| Codex CLI      | `~/.codex/config.toml`                                     | `[mcp_servers.plughive] url`  |
| Hermes Agent   | `~/.hermes/config.yaml`                                    | `mcp_servers.plughive.url`    |

Every write keeps the rest of the file byte for byte, is atomic, keeps the
file mode, makes one timestamped backup next to the file
(`<name>.plughive-backup-<time>`) and does nothing if the entry is already
right. A file that does not parse is left alone and reported. That includes
a Cursor `mcp.json` with comments or trailing commas: it is refused, not
rewritten. Claude Desktop
needs Node with `npx` on its PATH, because its config file only takes local
servers.

## Testing without touching your real setup

`PLUGHIVE_APP_HOME=<dir>` moves everything the app owns under `<dir>`: data
in `<dir>/data`, logs in `<dir>/logs`, client configs in `<dir>/home`, and
`PLAYWRIGHT_BROWSERS_PATH=<dir>/ms-playwright` (so it behaves like a machine
without Playwright browsers). The Keychain is still the real one.

```sh
open -n --env PLUGHIVE_APP_HOME="$PWD/.scratch" "src-tauri/target/release/bundle/macos/PlugHive.app"
```

## Signing

`signingIdentity` is `-` (ad-hoc), hardened runtime off. The bundler signs the
app and the node sidecar ad-hoc. `codesign --verify --deep --strict` passes;
Gatekeeper (`spctl -a -t exec`) rejects it, as it does every ad-hoc app.
Distributing it needs a Developer ID certificate, hardened runtime with the
JIT entitlements Node needs, and notarization. None of that is set up here.

## Known limits

- Each OS's app is built on that OS; there is no cross-compiled or universal
  macOS build. CI type-checks the Rust code on all three.
- Not signed for distribution: no Developer ID or notarization on macOS, no
  Authenticode certificate on Windows.
- Playwright browsers are not bundled. `screenshot_url` then fails with:
  `Chromium is not installed for Playwright. Install it once with: npx playwright install chromium`.
  With the bundled runtime:
  ```sh
  cd "/Applications/PlugHive.app/Contents/Resources/daemon"
  ../../MacOS/node node_modules/playwright-core/cli.js install chromium
  ```
  Browsers go to `~/Library/Caches/ms-playwright`, outside the app.
- The Keychain service name is fixed to `plughive`, so the app and a daemon
  run from the repo share pack secrets.
- Claude Desktop goes through `npx mcp-remote@<version>`, pinned to one exact release (`MCP_REMOTE_VERSION` in `src/clients/index.ts`) and downloaded on first use. A bundled bridge is future work.
- Client paths that other tools let you move with environment variables
  (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`) are not honoured from the
  menu: the app runs the writer with a cleared environment and the default
  paths.
- The dashboard window is the system web view: WKWebView on macOS, WebView2
  on Windows, WebKitGTK on Linux.
- Alerts shown while no window is open (port moved, client errors) are
  system alerts drawn by macOS, not by the app. If you quit the app while
  one is up, it stays on screen until you click it. Clicking it then does
  nothing.
- The built `.app` is about 201 MiB, mostly Node and `node_modules`; the
  other installers are of the same order.
