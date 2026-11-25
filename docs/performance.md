# Performance

How fast the daemon starts and answers, what it costs in memory and disk, how
to measure it, and what has been done about it.

## Measuring

Build first (`pnpm build`), then:

```sh
node scripts/bench.mjs                  # the way the CLI, login service and app start it
node scripts/bench.mjs --entry server   # dist/src/server.js directly, no compile cache
node scripts/bench.mjs --runs 10 --iters 500 --json out.json
```

The script starts the built daemon on a throwaway home with a throwaway
keychain service (port 7795, or `BENCH_PORT`) and reports:

- cold and warm start times (spawn until the first 200 from `/health`)
- startup CPU time, which is much less noisy than wall time on a busy machine
- RSS at start, idle and after the request load
- latency and throughput for `/health`, MCP `initialize`, `tools/list`,
  `resources/list`, a `tools/call`, the dashboard API reads, the dashboard
  index, and its main script (compressed and plain)

On a machine with other load, wall-clock times swing by 10x between runs. Use
CPU time, alternate the variants being compared (A, B, A, B and so on) rather
than running all of A then all of B, and take the median over at least 10
rounds.

## What was done (November 2026)

All measurements: Node v26.7.0, macOS arm64, 37 packs, a fresh home.
"Before" is commit 934b897.

### Fewer modules at startup

execa and the MCP client SDK (`@modelcontextprotocol/client`) were imported
at the top of modules that every start loads. They are only needed when
software is installed, a pack starts a child process, or a remote/stdio mount
connects. They are now loaded on first use (`src/lib/lazy-execa.ts`,
`src/lib/lazy-mcp-client.ts`).

| startup                  | before   | after    |
| ------------------------ | -------- | -------- |
| modules loaded           | 962      | 791      |
| module source read       | 7.2 MB   | 6.0 MB   |
| CPU to first `/health`\* | 1210 ms  | 1070 ms  |
| RSS at start\*           | 179 MB   | 165 MB   |

\* Median of 20 alternating rounds, `cli.js start`, warm home.

### V8 compile cache

`plughive start` (src/cli.ts) and the app's launcher (app/scripts/launcher.mjs)
turn on V8's compile cache before the daemon's modules load
(src/lib/compile-cache.ts). Every start after the first then reads about 500
compiled modules from the cache (about 4 MB) instead of compiling them again.
On this machine the gain is a few percent of startup CPU, within the noise of
the table above.

The cache is not in Node's default `os.tmpdir()/node-compile-cache`. On Linux
that is usually the shared `/tmp`, where another local user could plant
compiled code first. It lives in the user's cache directory instead
(`~/Library/Caches`, `%LOCALAPPDATA%`, or `$XDG_CACHE_HOME` / `~/.cache`,
then `plughive/node-compile-cache`). That directory is created 0700 and used
only when this user owns it and no one else can write to it. An explicit
`NODE_COMPILE_CACHE` is used as is. Node 22.0, which lacks the call, skips
the cache, and `NODE_DISABLE_COMPILE_CACHE=1` turns it off. To confirm it is
used:

```sh
NODE_DEBUG_NATIVE=COMPILE_CACHE plughive start 2>&1 | grep -c "reading cache"
```

### Compressed dashboard

The dashboard build (web/vite.config.ts) writes a `.br` (brotli quality 11)
and a `.gz` (gzip level 9) copy next to each script, stylesheet and SVG of at
least 1 KB under `assets/`. The daemon sends the copy when the browser accepts
it, with `Content-Encoding` and `Vary: Accept-Encoding`, and the plain file
otherwise (src/core/http/dashboard.ts). Compression happens once at build
time, so a request costs the daemon no CPU.

| first load, over the wire | before  | after (br) |
| ------------------------- | ------- | ---------- |
| main script               | 231 KB  | 66.7 KB    |
| stylesheet                | 59 KB   | 9.8 KB     |

### Smaller app payload

The app bundles `node_modules` (about 50 MB). The payload build
(app/scripts/build-payload.mjs) now also removes these:

- the Playwright test runner. `playwright` keeps only its entry points; the
  daemon uses the library API from `playwright-core`. About 4.5 MB.
- `playwright-core/lib/vite`: the trace viewer, recorder and HTML report UIs.
  About 3.6 MB.

Together that is about 8 MB, roughly 16% of the bundled `node_modules`. Checked
by hand on a pruned copy: `import("playwright")`, launch headless Chromium,
`page.route`, `page.routeWebSocket`, `goto`, `textContent` and `screenshot`
all work. These are the calls packs/web makes.

### Not changed

- **Request latency.** It was already low: `/health`, MCP `initialize` and
  `tools/list` take about 2 ms at p50 on an idle machine.
- **Source maps.** `dist/**/*.map` (2.8 MB) stay in dist for debugging. The
  payload build already removes them.
