# Live testing

The test suite never calls a paid provider. Every provider integration is
tested against mocked HTTP answers. This page says what the suite covers, what
it skips, and how to try a provider yourself.

## What the suite runs

```sh
PLUGHIVE_NO_DOTENV=1 pnpm test
```

`PLUGHIVE_NO_DOTENV=1` keeps a local `.env` (and any real keys in it) out of
the run. The suite needs no key and no network.

Some tests use real programs and are skipped when the program is missing:

| Tests | Run when |
| --- | --- |
| `tests/packs/local/ffmpeg.integration.test.ts` | `ffmpeg` and `ffprobe` are on `PATH`. The caption test needs an ffmpeg built with libass; the other one runs without it. |
| `tests/packs/pdf/pdf.test.ts`, pandoc block | `pandoc` is on `PATH`. |
| `tests/packs/pdf/pdf.test.ts`, TeX block | `pandoc` and `pdflatex` are on `PATH`. |
| `tests/core/secrets/keychain-backend.test.ts`, real keychain block | macOS and `PLUGHIVE_KEYCHAIN_TESTS=1`. |

The keychain tests write to your login keychain under a throwaway service name
and remove what they wrote. They are off by default because the system may ask
for permission:

```sh
PLUGHIVE_NO_DOTENV=1 PLUGHIVE_KEYCHAIN_TESTS=1 pnpm exec vitest run tests/core/secrets/keychain-backend.test.ts
```

## Smoke test against a running daemon

`pnpm smoke` checks a running daemon: `/health`, `initialize`, `tools/list`
and `list_artifacts`. All of these are free.

```sh
PLUGHIVE_URL=http://127.0.0.1:7800 pnpm smoke
```

- It sends no access key, so it only works against a daemon without one.
- It reads `.env` from the current folder.
- `pnpm smoke -- --paid` also calls `generate_image`, which is a paid call on
  your own provider account. Without `--paid` it is skipped.

## Platform check on a throwaway daemon

`pnpm live-check` starts the built daemon (`pnpm build` first) on port 7793
with a temporary home, admin token and keychain service. It checks the
platform features through MCP and the admin API:

- artifacts as MCP resources and workflows as prompts;
- `run_tool_script` (calls tools, has no `process`/`require`/`fetch`, stops
  at its time limit);
- `batch_run` and `setup_plan`;
- signed, unsigned, replayed and stale webhooks, and cron triggers;
- OAuth mounts listed and signed out;
- the action packs, and that every tool which sends or posts is destructive;
- chat workflows, `text.embed` and memory (remember, recall, forget), through
  the real local pack and router. The script serves a small Ollama-compatible
  stub on port 7792 (`LIVE_CHECK_OLLAMA_PORT`) and points the local pack at
  it, so no model is downloaded. `--no-stub` leaves it out; then those checks
  expect a clear "set up a provider" error instead.

Everything it checks is free, and it removes its temporary home when it ends.
`LIVE_CHECK_PORT` changes the port.

```sh
pnpm build && pnpm live-check
```

`pnpm live-check -- --cli-bridge` also enables the CLI bridge and asks your
Claude Code CLI to answer "PONG". That call is billed to your Claude account.
`LIVE_CHECK_CLAUDE_CONFIG_DIR` picks the Claude profile folder.

## Try a provider by hand

To check a real provider, use your own key, at your own cost, on a daemon that
does not touch your normal state.

1. Start a separate daemon with a throwaway home and a free port:

   ```sh
   export TRY_HOME="$(mktemp -d)"
   PLUGHIVE_SECRETS=memory plughive start --home "$TRY_HOME" --port 7800
   ```

   `PLUGHIVE_SECRETS=memory` keeps the key out of your Keychain and off disk;
   it is gone when the daemon stops.
2. In another terminal, run
   `PLUGHIVE_PORT=7800 plughive dashboard --home "$TRY_HOME"` (with the same
   `TRY_HOME`), or open the sign-in link the daemon printed. Save the key under
   **Packs & keys**.
3. In **Capabilities**, put the provider first for the capability you test.
4. Call the tool from the **Playground**, or point an agent at
   `http://127.0.0.1:7800/mcp`.
5. Read the result, then check **Usage** and the provider's own dashboard for
   what was billed.
6. Stop the daemon with Ctrl-C and remove `$TRY_HOME`.

Calls to video, music and dubbing providers can take minutes and cost more
than image calls. A job that ends in `submission_unknown` may have been
billed; check the provider before you call again.

## Reporting a provider problem

A provider may change its API without notice. If a real call fails where the
mocked test passes, open an issue with the tool, the provider, the error code
and message from the tool result, and the time of the call. Leave out keys,
prompts you do not want public, and artifact links.
