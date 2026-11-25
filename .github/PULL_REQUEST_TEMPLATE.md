**What this changes and why**

**How you tested it**

**Checklist**

- [ ] `pnpm typecheck`, `PLUGHIVE_NO_DOTENV=1 pnpm test` and `pnpm build` pass
- [ ] Tests mock every provider; nothing calls a paid API
- [ ] No telemetry and no new network call the user did not ask for
- [ ] No secret can reach a log, error, tool result or artifact
- [ ] Docs and `CHANGELOG.md` updated if behavior changed
- [ ] `pnpm docs:packs` run if a bundled pack changed
