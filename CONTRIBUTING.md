# Contributing

Thanks for helping. This file says how to build, test and send a change.

## Rules that are not up for debate

- **No telemetry.** The daemon makes no network call that the user did not
  cause through a tool or a setting. No analytics, no update checks, no crash
  reports. A pull request that adds one will be closed.
- **No paid calls in tests.** Tests mock every provider. A test must never
  need a real key or spend money.
- **No secrets in logs, errors, tool results or artifacts.** Read keys through
  the secret store and let the redactor see them.
- **Local first.** The daemon binds `127.0.0.1` by default. Do not change
  defaults in a way that exposes it.

## Set up

You need Node.js 22 or later and pnpm 9.

```sh
pnpm install --frozen-lockfile
```

Some tests and tools use ffmpeg, pandoc or pdflatex when they are installed.
Tests that need a missing program are skipped.

## Check your change

```sh
pnpm typecheck
PLUGHIVE_NO_DOTENV=1 pnpm test
pnpm build
pnpm exec biome check <the files you changed>
```

`PLUGHIVE_NO_DOTENV=1` keeps the tests from loading a `.env` file you may
have in the repo root.

`pnpm lint` checks the whole repository. It reports errors in many existing
files today, so check the files you changed instead, and do not add new
errors. `pnpm exec biome check --write <files>` applies the safe fixes.

`pnpm typecheck:tests` type-checks the tests. It reports errors in some test
files today; do not add new ones.

If you change a bundled pack's manifest or tools, regenerate the pack list:

```sh
pnpm docs:packs
```

If you add a production dependency, check its license:

```sh
pnpm run licenses
```

(`pnpm licenses` without `run` is a different, built-in pnpm command.) It fails on a license that is not on the permissive list in
`scripts/check-licenses.mjs`.

## Run it while you work

```sh
pnpm dev
```

runs the daemon from source. Use another port and home folder if you already
run one:

```sh
PLUGHIVE_PORT=7790 PLUGHIVE_HOME=/tmp/plughive-dev pnpm dev
```

`pnpm dev` loads `.env` from the repo root. See
[docs/configuration.md](docs/configuration.md).

## Send a change

- Keep a pull request to one topic.
- Add or update tests for what you changed.
- Update the docs in `docs/` when behavior changes, and add a line to
  `CHANGELOG.md`.
- Write plain commit messages that say what changed and why.

By sending a contribution you agree to license it under Apache-2.0.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
