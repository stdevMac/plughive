# Triggers

A trigger starts a [workflow](workflows.md) without an agent asking for it:

- a **cron trigger** runs it on a schedule;
- a **webhook trigger** runs it when another service sends a signed `POST` to
  `/hooks/<id>`.

Either way, the workflow runs as an ordinary background job, which shows up on
the Jobs page and in `get_job_status`. A trigger can also report the end of
that job, through a signed webhook or a Telegram message.

Manage triggers on the dashboard's **Triggers** page, or through
`/api/triggers` (see [Admin API](#admin-api)). They are stored in `jobs.db` in
the home folder, so they survive restarts. Set `PLUGHIVE_TRIGGERS=0` to turn
the whole feature off: the scheduler, `/hooks` and `/api/triggers`.

## What a trigger can run

Only workflow tools, the ones named `wf_<name>`. A trigger cannot call a single
provider tool directly; wrap it in a one-step workflow to do that. The
workflow's input is the trigger's saved `args`, checked against the workflow's
input schema when you create the trigger and again on every run. A trigger
runs with the tools of the profile it was created for (`profile`, `default`
when not given).

When the workflow is unloaded (its file removed, its pack off), runs fail with
`UNKNOWN_WORKFLOW`. The failure is recorded on the trigger, and the trigger
stays on.

## Cron schedules

Five fields, in this order: `minute hour day-of-month month day-of-week`.

| Field | Values |
| --- | --- |
| minute | 0-59 |
| hour | 0-23 |
| day of month | 1-31 |
| month | 1-12 or `jan`-`dec` |
| day of week | 0-7 or `sun`-`sat` (0 and 7 are both Sunday) |

Each field takes `*`, a number, a list (`1,15`), a range (`9-17`) and a step
(`*/15`, `9-17/2`, and `5/20`, which means from 5 to the end of the range in
steps of 20). The macros `@hourly`, `@daily` (also `@midnight`), `@weekly`,
`@monthly` and `@yearly` (also `@annually`) are accepted. There is no seconds
field, no `L`, `W`, `#` or `?`, and no `@reboot`.

When both day of month and day of week are restricted, a day matches if
**either** matches, the same rule classic cron uses. `0 0 13 * fri` runs on
the 13th of every month and on every Friday.

Times are in `UTC` or in the daemon's `local` time zone; you choose one per
trigger. In local time, a time that does not exist because the clocks went
forward is skipped that day. A time that happens twice when the clocks go back
runs once. A schedule that can never match, such as `0 0 31 2 *`, is refused
when the trigger is created.

### Missed runs and restarts

The scheduler checks for due triggers every 15 seconds. Each trigger stores
its next run time. A run is claimed with a conditional database update before
it starts, so each scheduled time starts at most once: restarting the daemon
does not repeat it, and two daemons sharing one home folder do not both run
it.

Runs whose time passed more than 2 minutes ago, typically because the daemon
was not running or the computer was asleep, are **skipped**. A skipped run is
recorded with the status `skipped` so you can see it. With `catch_up` on, the
trigger instead runs **once**, when the daemon is back, however many times it
missed. It never replays every missed time.

Turning a trigger off clears its next run time. When you turn it on again, it
schedules the next time from then and does not catch up on the time it was
off. Editing the schedule or the time zone also reschedules from the time of
the edit.

## Webhooks

Each webhook trigger has an address, `<public url>/hooks/<id>`, and a signing
secret (`whsec_…`). The secret is shown **once**, when the trigger is created
or when you make a new one. The daemon keeps it in `jobs.db`, which is
readable by your user only. Making a new secret invalidates the old one at
once.

`/hooks` does not take the access key or the admin token; the signature is
the credential. The daemon's other guards still apply: a request with a
browser `Origin` that is not allowed is refused. To receive webhooks from the
internet, the daemon has to be reachable from it, for example behind a tunnel
or a reverse proxy with `PLUGHIVE_PUBLIC_URL` set.

### Signing a request

Send two headers:

```
X-PlugHive-Timestamp: <Unix time in seconds>
X-PlugHive-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the secret>
```

For example, in a shell:

```sh
body='{"topic":"news"}'
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$URL" -H 'content-type: application/json' \
  -H "x-plughive-timestamp: $ts" -H "x-plughive-signature: sha256=$sig" -d "$body"
```

And in Node:

```js
import { createHmac } from "node:crypto";
const ts = String(Math.floor(Date.now() / 1000));
const sig = "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
```

The signature covers the exact bytes of the body, so sign the string you
send, not an object that is serialized again later.

### What the daemon checks

In this order:

| Check | Refusal |
| --- | --- |
| At most 300 requests per minute per hook id before the signature is checked; requests for ids that are not webhook triggers share a separate budget of the same size | `429` with `Retry-After: 60` |
| The body is at most 256 KB | `413` |
| The hook exists and is a webhook trigger | `404` |
| The timestamp is a whole number of seconds | `401 BAD_TIMESTAMP` |
| The timestamp is within 5 minutes of the daemon's clock | `401 STALE_TIMESTAMP` |
| The signature matches (compared in constant time) | `401 BAD_SIGNATURE` |
| The trigger is on | `409 DISABLED` |
| At most 30 signed requests per minute per hook (`PLUGHIVE_HOOK_RATE_LIMIT`, the 300 above is 10 times this), and 10 times that for all hooks together | `429` with `Retry-After: 60` |
| The same signature has not been accepted in the last 24 hours | `409 REPLAYED` |
| With `use_body`, a non-empty body is a JSON object | `400 INVALID_REQUEST` |
| The trigger has fewer than 5 runs that have not finished | `429 BUSY` |
| The input fits the workflow | `400 INVALID_INPUT` |
| The workflow is loaded | `409 UNKNOWN_WORKFLOW` |

A request that passes answers `202` with `{"ok": true, "job_id": "...",
"run_id": ...}`. The job runs in the background; poll it with the admin API or
ask for a callback.

Because a signature is remembered, every request needs its own timestamp or
body. A sender that retries the exact same request gets `409 REPLAYED`, which
means the first one was accepted.

### The body as input

With `use_body` on (the dashboard turns it on for new webhook triggers; the
API default is off), the request's JSON object fills in the workflow input
the saved `args` leave open: a key in the saved `args` always wins, and a
`dry_run` key in the body is ignored. With it off, the body is only signed
and checked, and the workflow gets the saved `args`.

## Job-done callbacks

A trigger can report when the job it started ends: succeeded, failed,
cancelled or expired. Runs that were skipped, or that could not start, send
nothing.

**Webhook.** A `POST` of JSON, signed with the trigger's secret in the same
way as inbound hooks (`X-PlugHive-Timestamp`, `X-PlugHive-Signature`), so
the receiver can check it came from your daemon:

```json
{
  "event": "job.finished",
  "trigger_id": "trg_…",
  "trigger_name": "Morning digest",
  "workflow": "wf_digest",
  "run_id": 12,
  "job_id": "…",
  "status": "succeeded",
  "finished_at": "2026-11-24T09:00:41.000Z",
  "result": { "...": "..." }
}
```

A failed job carries `error` instead of `result`. A result over 64 KB is left
out and `result_truncated: true` is sent instead; fetch it through the admin
API. The address must be a public `http` or `https` one: the request goes
through the same guard as every outbound request, which refuses private,
loopback and metadata addresses, and does not follow redirects. The receiver
has 15 seconds to answer.

**Telegram.** A short message with the trigger, the workflow, the status and
the start of the result or the error, sent with the Telegram pack's
`send_telegram` tool. The pack must be on and have its bot token; its own
settings decide which chats are allowed and which is the default. Give a
`chat_id` to send somewhere other than the default chat.

**Delivery is at most once.** Each callback is sent once and never retried. A
receiver that is down, answers with an error or times out loses that
callback; its state and the error are kept with the run (`GET
/api/triggers/<id>`). A callback that was being sent when the daemon stopped
is marked failed on the next start rather than sent twice. Starting a run is
at most once as well: if the daemon stops between claiming a scheduled time
and creating the job, that run is lost, not repeated.

## Admin API

All under `/api/triggers`, with the admin token (`Authorization: Bearer
<token>`, or the dashboard's session) and, on every request that changes
something, the `X-PlugHive-CSRF: 1` header.

| Request | Does |
| --- | --- |
| `GET /api/triggers` | List triggers. Secrets are never listed. |
| `GET /api/triggers/workflows` | The workflows a trigger can run. |
| `POST /api/triggers` | Create one. Answers `201` with `{trigger, secret}`. |
| `GET /api/triggers/<id>` | One trigger and its last 50 runs. |
| `PATCH /api/triggers/<id>` | Change `name`, `args`, `schedule`, `timezone`, `catch_up`, `use_body`, `enabled` or `callback` (`null` removes it). |
| `DELETE /api/triggers/<id>` | Delete it with its runs. Jobs it started are kept. |
| `POST /api/triggers/<id>/run` | Run it now, whatever its kind. Answers `202` with `job_id`. |
| `POST /api/triggers/<id>/rotate-secret` | New secret, returned once; the old one stops working. |

A create body:

```json
{
  "name": "Morning digest",
  "kind": "cron",
  "workflow": "wf_digest",
  "args": { "topic": "news" },
  "schedule": "0 9 * * 1-5",
  "timezone": "local",
  "catch_up": false,
  "callback": { "type": "telegram" }
}
```

For a webhook, `kind` is `"webhook"`, `schedule`, `timezone` and `catch_up`
are left out, and `use_body` may be given. `profile` picks the exposure
profile the workflow runs under. There can be at most 200 triggers.

## Limits

- Triggers run inside the daemon. Nothing runs while it is stopped or the
  computer sleeps; see [Missed runs](#missed-runs-and-restarts).
- The scheduler's resolution is its 15-second tick: a run starts up to about
  15 seconds after its time.
- No retries, for runs or callbacks. A workflow that should retry has to do
  it itself.
- Every trigger belongs to the single user of the daemon. There are no
  per-trigger permissions beyond the profile it runs under.
