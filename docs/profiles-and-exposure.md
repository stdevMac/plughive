# Profiles and exposure

The daemon can serve over a hundred tools. Listing all of them costs an agent
many tokens on every request. A profile decides which tools an endpoint offers
and how.

## Endpoints

| Endpoint | Profile |
| --- | --- |
| `/mcp` | `default` |
| `/p/<id>/mcp` | the profile `<id>`. `404` when it does not exist. |

Give each agent the endpoint of the profile it needs, for example
`http://127.0.0.1:7777/p/video/mcp` for one that only edits video.

## Modes

| Mode | `tools/list` holds |
| --- | --- |
| `list` | Every selected tool. |
| `search` | `search_tools`, `describe_tool`, `execute_tool`, the pinned tools and, when something selected runs as a job, `wait_for_job` and `cancel_job`. The rest is reached with `execute_tool`. |
| `auto` | `list` while the selection is small, `search` once it has more than `autoThresholdTools` tools (default 40) or its `tools/list` would cost more than `autoThresholdTokens` (default 8000, estimated as characters / 4). |

The default profile is `auto`, selects everything and pins
`generate_image`, `generate_video`, `generate_speech`, `generate_music`,
`list_artifacts` and `get_job_status`. With the bundled packs it is in search
mode, so a client sees 11 tools.

In search mode an agent works like this:

1. `search_tools {"query": "remove background", "limit": 8}` returns ranked
   matches.
2. `describe_tool {"name": "..."}` (or a list of up to 20 names) returns the
   input schemas.
3. `execute_tool {"name": "...", "arguments": {...}}` runs one.

`execute_tool` and `search_tools` only reach tools the profile selects.

Search ranks by the words of the query: an exact name match scores 100, a
word of the name 10, part of the name 6, the capability 5, a tag 4, the pack 3,
the description 2. Tools that match nothing are left out.

## Selectors

`include` and `exclude` are lists of selectors. A tool is selected when it
matches one `include` and no `exclude`.

| Selector | Matches |
| --- | --- |
| `*` | every tool |
| `pack:<id>` | the tools of a pack |
| `tool:<name>` | one tool |
| `mount:<id>` | the tools of a mounted MCP server |
| `capability:<name>` | tools that provide a capability, such as `capability:image.generate` |
| `workflow:<name>` | one workflow tool (`wf_<name>`) |
| `tag:<tag>` | tools with that tag |

Each kind also takes `*`: `pack:*`, `mount:*`, `workflow:*` and so on.
`wait_for_job` and `cancel_job` stay callable even when excluded; excluding
them only takes them out of `tools/list`.

## The profile

```json
{
  "id": "video",
  "name": "Video",
  "mode": "auto",
  "include": ["pack:local", "capability:video.generate", "workflow:*"],
  "exclude": ["tool:local_transcribe"],
  "pinned": ["generate_video"],
  "autoThresholdTools": 40,
  "autoThresholdTokens": 8000
}
```

| Field | Rules |
| --- | --- |
| `id` | `^[a-z][a-z0-9-]{1,31}$`. |
| `name` | 1 to 64 characters. |
| `mode` | `list`, `search` or `auto` (default). |
| `include` | Up to 256 selectors. Default `["*"]`. |
| `exclude` | Up to 256 selectors. |
| `pinned` | Up to 64 tool names listed next to the search tools in search mode. A name no pack provides is skipped. |
| `autoThresholdTools`, `autoThresholdTokens` | When `auto` switches to search. |

At most 64 profiles. They are kept in `<home>/profiles.json`. The `default`
profile can be changed but not deleted.

## Edit profiles

The dashboard's **Exposure** page edits profiles and shows, as you change
them, the exact `tools/list` a client will get and its estimated token cost.

The same is available over the admin API (admin token or dashboard session;
see [protocol.md](protocol.md#admin-api)):

| Request | Does |
| --- | --- |
| `GET /api/profiles` | List profiles. |
| `GET /api/profiles/<id>` | One profile. |
| `PUT /api/profiles/<id>` | Create or replace. |
| `DELETE /api/profiles/<id>` | Delete. Not `default`. |
| `GET /api/profiles/<id>/preview` | The `tools/list` payload and its cost. |
| `POST /api/profiles/preview` | The same for a profile that is not saved. |

A request that changes something and has no `Origin` header (curl, scripts)
must also send `X-PlugHive-CSRF: 1`.

## Profiles and workflows

A workflow's calls go through the caller's profile. A workflow run from a
profile that hides one of its tools cannot call that tool, and its dry run
says so.

## Smart mount

Every mounted server that is on adds its tool definitions to what agents
read, whether or not anyone calls it. Smart mount finds what is not worth its
tokens and takes it out of the way, without losing it: parked and hidden tools
stay findable through `search_tools`, and asking for one brings it back.
Every change can be undone.

It reads each mount's last call and its calls in the last 30 days, each
tool's calls and errors per profile (both from the usage ledger), and the
estimated tokens of the tool definitions (the same estimate as the profile
preview).

### Suggestions

Each suggestion has a `key` that names it for applying or undoing.

Park kinds switch a mount off:

| Kind | When |
| --- | --- |
| idle | Not called for `idleDays` days (default 14). |
| heavy | About 3000 tokens of definitions or more and fewer than 5 calls in 30 days. |
| overlap | Does the same job (web search, fetching and scraping pages, app automation, library docs, or the same service twice, such as two Linear mounts) as another mount or a built-in capability that gets at least 4 times its calls, and at least 5. |

Profile kinds change one profile and leave the mount on for everyone else:

| Kind | When |
| --- | --- |
| profile_unused | Other profiles call the mount, this list-mode profile never does: hide it (`mount:<id>` added to `exclude`). |
| unused_tools | The profile calls some tools of a mount and never at least 2 others worth 500 tokens or more: hide those (`tool:<name>` excludes). |
| search_mode | A list-mode profile lists over 15000 tokens of definitions: switch it to `auto`, which serves them through `search_tools` above its threshold. |

Health kinds say what to fix and are never applied:

| Kind | When |
| --- | --- |
| sign_in | An OAuth mount is on but signed out. |
| missing_key | A mount is on but a key it needs is not set. The user types it on the Mounts page, never in chat. |
| failing | On, but cannot connect, for another reason. |
| failing_tool | A mounted tool failed at least 80% of its 5 or more calls in the last 7 days. |

A mount gets a full `idleDays` after smart mount first sees it on (or after it
is switched back on) before any park or profile suggestion about it, so a new
mount has a chance to be used. A call made outside any profile counts as used
by every profile.

### Bringing tools back

`search_tools` also searches the tools of parked mounts and the tools hidden
from the current profile, and marks parked hits `parked: true` with their
mount. When an agent describes or calls one:

- `wake: "auto"` (the default): a parked mount is switched back on, a hidden
  tool's profile change is undone, and the call goes through.
- `wake: "ask"`: the call answers `TOOL_PARKED` with how to switch it on
  (`enable_mount`, which asks for approval for a local server of your own),
  and nothing changes. An agent can choose `ask` but not switch it back to
  `auto`.

A profile that would not see a mount's tools anyway does not find them this
way. An unknown tool is still an error.

### Settings

Kept in `<home>/smart-mounts.json`, with the parked mounts, the applied
profile changes and 90 days of events:

| Setting | Values | Default |
| --- | --- | --- |
| `mode` | `off` (nothing is checked), `suggest` (list only), `auto` (park idle mounts once an hour) | `suggest` |
| `idleDays` | 1 to 365 | 14 |
| `keep` | Mount ids that are never suggested or parked | `[]` |
| `wake` | `auto` or `ask`, see above | `auto` |

Automatic mode parks idle mounts only. Heavy and overlap mounts and profile
changes are always applied by a person or on their say-so.

The report also has a 7-day summary: mounts parked, tools brought back,
profile changes made and undone, and the tokens a turn that parked mounts and
applied changes save now.

### Where to use it

- The Smart mount card on the Mounts page: the mode, the number of days and
  the wake setting, each suggestion with its reason and a Park, Hide or
  Switch to auto button (and Always keep), the applied changes with Undo, and
  the week's summary.
- The `optimize_mounts` tool. Without arguments it reports. `apply: true`
  parks the park kinds (or the `ids` given, if they are suggested).
  `apply_keys` applies profile suggestions by key; `undo` takes keys from
  `changes`. `settings: { mode, idle_days, keep, wake }` changes the
  settings. The tool tells the agent to ask the user before it applies
  anything or turns on `auto`.
- The admin API:

| Route | Does |
| --- | --- |
| `GET /api/mounts/smart` | The report: settings, each mount's use, token cost and category, suggestions, `changes`, `summary`, `enabled_tokens`, `reclaimable_tokens`. |
| `PUT /api/mounts/smart` | Change settings: `{ "mode", "idleDays", "keep", "wake" }`, any of them. |
| `POST /api/mounts/smart/park` | Park the suggested mounts, or `{ "ids": [...] }` among them. |
| `POST /api/mounts/smart/apply` | Apply the profile suggestions, or `{ "keys": [...] }` among them. |
| `POST /api/mounts/smart/undo` | Undo applied changes: `{ "keys": [...] }`. |

