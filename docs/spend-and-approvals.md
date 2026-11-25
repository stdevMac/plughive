# Spend caps and approvals

plughive can stop tools from spending more than you allow, and can hold a
call until a person approves it. Nothing is limited until you set it up: with
no `policy.json`, every tool runs as before.

Set it up on the dashboard (**Usage > Spend caps**) or write
`<home>/policy.json` by hand. Requests that wait for a decision are on the
**Approvals** page; the sidebar shows how many are waiting.

## policy.json

```json
{
  "version": 1,
  "caps": [
    { "scope": "global", "period": "daily", "limit_usd": 5, "mode": "ask" },
    { "scope": "provider", "id": "fal", "period": "monthly", "limit_usd": 20, "mode": "block" },
    { "scope": "profile", "id": "work", "period": "monthly", "limit_usd": 50, "mode": "ask" }
  ],
  "rules": {
    "auto_approve_under_usd": null,
    "always_ask_tools": [],
    "always_ask_providers": [],
    "ask_before_destructive": false,
    "ask_before_sending": true,
    "approve_in_chat": false
  },
  "profiles": {
    "work": { "auto_approve_under_usd": 0.5 }
  },
  "approval_ttl_minutes": 30,
  "telegram": { "enabled": false, "allowed_chat_ids": [], "allowed_user_ids": [] }
}
```

Every field except `version` may be left out; the values above are the
defaults (apart from the example caps and profile).

### Caps

A cap limits what is spent in a period: `daily` or `monthly`, starting at
00:00 UTC on the day or the first of the month. `scope` is one of:

- `global`: everything.
- `provider`: one provider, by id (`fal`, `replicate`, `gemini`, ...; the names
  in the **By provider** list on the Usage page).
- `profile`: calls made through one profile's endpoint.

`mode` says what happens when a call would go over the cap:

- `block`: the call is refused (`SPEND_BLOCKED`). For a capability with more
  than one provider, the router skips that provider and tries the next one.
- `ask`: a person is asked first. For a capability with another provider left,
  the router tries that one first and asks only when none is left.

Spend so far is read from the usage ledger (the numbers on the Usage page).
Providers that report no cost count as zero, so a cap is as exact as the costs
behind it. A call "would go over" a cap when its estimate does not fit in what
is left; a call with no estimate (cost unknown) never runs unchecked under a cap: the
router tries a provider with a price first, an `ask` cap asks and a `block`
cap refuses it. If the
ledger cannot be read, every cap counts as used up.

### Rules

- `auto_approve_under_usd`: calls estimated under this amount run without
  asking. Calls at or over it, and calls whose cost is unknown, ask. `null`
  (the default) turns this off.
- `always_ask_tools`: tool names that always ask, whatever they cost.
- `always_ask_providers`: provider ids that always ask, even when free.
- `ask_before_destructive`: ask before tools marked destructive and tools
  that send. A tool from a mounted MCP server counts as destructive unless the
  server marks it `readOnlyHint: true` or `destructiveHint: false` (the MCP
  default), so with this on, unhinted mounted tools ask.
- `ask_before_sending` (on by default): ask before tools that reach other
  people: sending an email or SMS, placing a call, posting or deleting a
  social post, creating or cancelling a booking. These tools are tagged
  `sends`. They ask even inside an approved workflow run (that approval
  covers the run's cost, not its messages), so a scheduled workflow that
  sends needs this off for its profile. Turn it off only for a profile you
  trust to send on its own.

- `approve_in_chat` (off by default): a client that supports MCP form
  elicitation shows an approve/deny form in the chat instead of the
  dashboard link, and the call runs as soon as you approve. The answer then
  comes from the MCP client, not from the dashboard, so turn this on only for
  clients you trust to show the form to you rather than answer it themselves.
  Closing the form leaves the request open on the Approvals page.

`profiles` overrides any of these rules for one profile. A field left out
keeps the global rule.

`approval_ttl_minutes` is how long a request stays open (default 30, at most
a week). A request nobody decides in time expires, and so does an approved
request that is not retried in time.

## Estimates

Before a provider runs, the router asks it for an estimate:

- Local providers (ComfyUI, local models) estimate 0. A free call never asks
  and never counts against a cap, unless its provider is in
  `always_ask_providers`.
- Gemini image, video and music calls estimate from a static price table.
- Other providers (fal, replicate, openrouter, ...) give no estimate: their
  cost is unknown until the call ran.

Pack tools that spend money without going through a capability are tagged
`paid` (the fal, replicate and openrouter run and catalog tools). Their cost is
unknown before they run: they are blocked or asked about only when a cap is
already used up, when an auto-approve amount is set, or when they are in
`always_ask_tools`. The `gemini_*` pack tools are not tagged.

## max_cost_usd

Every media tool takes an optional `max_cost_usd` (at most 10,000): the most this
one call may cost. A provider whose estimate is over it, or that has no
estimate, is skipped; the call fails with `SPEND_BLOCKED` when no provider is
left. With `max_cost_usd` set, a call can only run on providers that give an
estimate.

## Repeated paid calls

A paid provider's result that saved library artifacts is kept for 24 hours in
`~/.plughive/paid-cache.json`. Making the same call again in that time (same
capability, same `provider` if one was named, same model and the same input,
whatever its key order) returns the saved result marked `cached: true`, with
`cost_usd: 0`. No provider runs, so nothing is charged, estimated or sent for
approval. The usage ledger gets a row with no cost and `cached: true`, and the
Usage page counts these calls under "Reused from cache" (the API's
`summary.cached_calls`).

A saved result is used only while its provider is still loaded and the caller's
profile can reach it, and only while every one of its artifacts is still in
the library (a deleted artifact makes the next call run again). Local and
account providers are never cached, and neither are results without artifacts
(chat, translation, search).

Pass `cache: false` on any media tool for a fresh paid call, for example a new
take of the same prompt. `PLUGHIVE_PAID_CACHE=0` turns the cache off.

## Asking for approval

When a call needs approval:

1. The call fails with `APPROVAL_REQUIRED` and a link to the request on the
   Approvals page. A client that supports MCP URL elicitation is shown the link
   instead, with the reason and the expiry time.
   With `approve_in_chat` on, a client that supports form elicitation gets an
   approve/deny form instead, and an approval there runs the call right away.
2. A person approves or denies it on the dashboard (or in Telegram, below,
   or in the chat form). The tray app shows a system notification for each
   new request and its menu shows how many are waiting; the notification
   opens nothing by itself, the decision is still made on the dashboard.
3. The agent retries the same call. The retry runs and uses the approval up.

An approval covers one call: the same tool, provider, profile and arguments.
A call with different arguments asks again, and an approval is used at most
once, even by two retries at the same time. A denied or expired request fails
with `APPROVAL_DENIED` or `APPROVAL_EXPIRED`.

A background job does not fail: it waits with the status
`awaiting_approval` and goes on once approved, or fails when denied or
expired. Cancelling the job ends the wait.

Agents cannot approve their own requests. The approval routes are under
`/api`, which needs the admin token, and no MCP tool reaches them. The one
exception is the opt-in chat form above: only for requests the same profile
opened, and only when `approve_in_chat` is on for it.

## Workflows

A workflow's `dry_run` reports `estimated_cost_usd: {min, max, basis}`. `min`
is always 0 (a step may be skipped or fail). `max` adds up the
`max_cost_usd` of each paid step and is `null` when a paid step sets none.

A run that may go over an `ask` cap, or over the auto-approve amount, asks
once for the whole run; the paid steps inside it then do not ask again. A run
whose `max` goes over a `block` cap is refused. A blocking cap still applies
to each step while the run goes on. A run with no `max` asks up front only
when a cap is already used up or an auto-approve amount is set.

## When policy.json is broken

The dashboard never overwrites a `policy.json` that does not parse or
validate: it shows the error and saving fails with `POLICY_FILE_BROKEN`. Fix
or delete the file by hand.

While the file is broken the daemon fails closed: calls that may cost money
(a non-zero or unknown estimate, a `paid` tool) and destructive tools are
refused. Free calls go on.

## Admin API

All of these need the admin token (see [security.md](security.md)); the
`POST` and `PUT` routes also need the CSRF header.

| Route | What it does |
| --- | --- |
| `GET /api/approvals?status=&limit=` | Requests, newest first, and the number pending. |
| `GET /api/approvals/:id` | One request. |
| `POST /api/approvals/:id/approve` | Approve once. `409 NOT_PENDING` when already decided or expired. |
| `POST /api/approvals/:id/deny` | Deny. |
| `GET /api/policy` | The policy, whether the file is valid, and the spend so far for each cap. |
| `PUT /api/policy` | `{policy}`: validate and write. `400 POLICY_INVALID`, `409 POLICY_FILE_BROKEN`. |

`/api/events` sends an `approval` event (`{id, status, tool, pending}`) when a
request is created or decided.

A request keeps a short, redacted summary of the arguments, never the
arguments themselves.

## Telegram

Approvals over Telegram are off by default. To turn them on:

1. Save the bot token as the `TELEGRAM_BOT_TOKEN` key (the one the telegram
   pack uses).
2. In `policy.json`, set `telegram.enabled` to `true` and list the numeric
   chat ids that may decide in `telegram.allowed_chat_ids` (at most 20).

Each new request is sent to those chats with **Approve** and **Deny** buttons.
A button press counts only from an allowed chat; anything else is ignored
without a reply. A group chat lets any member press the button, so set
`telegram.allowed_user_ids` (at most 20 numeric user ids) to restrict who may
decide; when it is empty, any member of an allowed chat may decide. The daemon
polls Telegram (`getUpdates`) and opens no port.
What is sent: the tool and provider ids, the estimate, the reason and the
redacted argument summary. Changes to the policy take effect within one poll.

## Paying APIs per call (x402)

The `x402` pack pays [x402](https://docs.x402.org) paid endpoints in USDC. It
is off until you enable it, and it needs `X402_PRIVATE_KEY`, the private key of
a new wallet that holds only a few dollars. Never use your main wallet.

- `x402_quote` asks the server for its price and pays nothing.
- `x402_fetch` pays and returns the response. It is tagged `paid` and
  `approval`, so every call asks a person, even under auto-approve or inside an
  approved workflow run. The request shows the URL and the call's `max_usd`.
- `x402_wallet` shows the address, the limits and what was spent in the last
  24 hours. It never shows the key.

Limits, all set in the pack's settings:

| Setting | Default | Ceiling |
|---|---|---|
| `maxPerCallUsd` | $0.10 | $25 |
| `dailyCapUsd` (rolling 24 hours) | $1 | $250 |
| `allowedNetworks` | Base, Base Sepolia | Base, Base Sepolia, Ethereum, Arbitrum, Optimism, Polygon, Avalanche |
| `allowedHosts` | any https host | |

It only signs the `exact` scheme for the network's real USDC contract
(EIP-3009 `transferWithAuthorization`), picks the cheapest option within all
the limits, and refuses anything else with the reason. Each payment is
written to `payments.jsonl` in the pack's data folder before it is sent, and
counts toward the daily limit even when the server then refuses it. What was
paid is reported as `cost_usd`, so it appears in `usage_report` and counts
against the caps above. Payments on chain cannot be reversed. Start on Base
Sepolia with free testnet USDC.
