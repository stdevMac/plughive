# Workflows

A workflow is a JSON recipe that calls tools one after another. Each recipe
becomes a tool named `wf_<name>` that runs as a background job. The bundled
`workflows` pack has seven of them, in
[packs/workflows/workflows](../packs/workflows/workflows).

A recipe has no code. It can only call tools and capabilities, transform
values with a fixed set of helpers, and save JSON or text to the library.

## Run one

Every workflow tool takes the recipe's input plus `dry_run`. Call it with
`dry_run: true` first. Nothing runs; the answer is the plan:

- each step, and whether it will run (`yes`, `no` or `maybe`)
- what is missing: a tool, a disabled pack, a key, a provider
- `paid_calls_max`: the most calls to paid providers the run can make
- `blocking` and `warnings`

A real run checks the same plan first. If a step that will run cannot, the
call fails before anything starts and says what to fix.

A run returns `{workflow, ok, output, artifacts, steps, notes}`. Nothing is
retried. When a step fails, the run stops and the error lists the steps that
completed and their artifacts, so you can finish by hand. Cancelling the job
stops the step that is running.

## Where recipes live

A pack declares a folder in its manifest:

```json
{
  "id": "my-flows",
  "name": "My flows",
  "version": "0.1.0",
  "apiVersion": 1,
  "workflows": "workflows",
  "permissions": {
    "tools": ["generate_image", "generate_speech"],
    "library": "write"
  }
}
```

Every `<folder>/<name>.json` becomes `wf_<name>`. `permissions.tools` must
list every tool the steps call. A recipe that calls something not listed, or
does not validate, is left out with an error; the pack's other recipes still
load. A pack with only workflows needs no `entry`.

## The recipe

```json
{
  "name": "dub_localize",
  "title": "Dub into other languages",
  "description": "Localize a video or audio file into 1 to 5 languages. ...",
  "tags": ["dubbing", "translation", "audio", "video"],
  "input": {
    "type": "object",
    "properties": {
      "artifact_id": { "type": "string", "minLength": 5, "maxLength": 80 },
      "languages": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 5 }
    },
    "required": ["artifact_id", "languages"]
  },
  "limits": { "maxItems": 5, "maxConcurrency": 2, "timeoutSeconds": 7200 },
  "steps": [ ... ],
  "output": { ... }
}
```

| Field | Rules |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{0,40}$`. The tool is `wf_<name>`. |
| `title`, `description` | Shown in `tools/list` and the dashboard. |
| `input` | A JSON Schema subset: an object whose properties are `string`, `number`, `integer`, `boolean`, `array` or `object`, with `enum`, `default`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `format: "uri"`, `items`, `properties`, `required`. Property names are snake_case. `dry_run` is reserved. |
| `steps` | The steps, in order. |
| `output` | Any JSON value with templates. It is the run's `output`. |
| `tags` | Up to 12. Profiles can select them as `tag:<tag>`. |
| `limits` | `maxItems`, `maxConcurrency`, `timeoutSeconds` (10 to 10800). They can lower the limits below, never raise them. |

## Steps

Every step has an `id` (`^[a-z][a-z0-9_]{0,39}$`) and exactly one of:

| Kind | Example | Does |
| --- | --- | --- |
| `tool` | `{"id": "img", "tool": "generate_image", "args": {...}}` | Calls a tool. |
| `capability` | `{"id": "img", "capability": "image.generate", "args": {...}}` | Calls whichever provider the capability routes to. |
| `set` | `{"id": "shots", "set": "${slice(steps.plan.shots, 0, 6)}"}` | Computes a value. No call. |
| `save` | `{"id": "brief", "save": {"kind": "document", "mime": "text/markdown", "content": "..."}}` | Saves a library artifact. `kind` is `data` or `document`; `mime` is `application/json`, `text/markdown` or `text/plain`; `name` is optional. |
| `parallel` | `{"id": "both", "parallel": [step, step]}` | Runs its member steps side by side. Its output is an object keyed by member id. |

Shared fields:

| Field | Does |
| --- | --- |
| `title` | Label in progress messages. |
| `when` | A condition. The step is skipped when it is false. |
| `forEach`, `as` | Runs the step once per item of a list. The item is `${<as>}` (default `item`) and its position `${index}`. The output is a list. |
| `concurrency` | Items or members running at once. |
| `maxItems` | Items to run; the rest are dropped with a note. |
| `onError` | `"fail"` (default), `"continue"` or `{"fallback": <step>}`. |
| `parse` | `"json"`: parse the tool's text answer as JSON. |
| `paid` | `true` counts the step's calls in `paid_calls_max`. |
| `pack` | The pack that usually provides the tool, for clearer pre-flight messages. |

A step can read only the steps before it. Members of a `parallel` group do
not see each other.

## Templates

A string value may hold `${...}`:

- `"${input.topic}"`: the whole string is the value, with its type kept. If
  the path is missing, the key (or list element) is dropped.
- `"A film about ${input.topic}"`: the value is put into the text. A missing
  path here is an error; use `default(...)`.
- `"$${"`: a literal `${`.

Paths start at `input`, `steps`, `index` or the `forEach` variable, for
example `steps.voice.artifacts.0.id`. Text that comes back from a tool is
never parsed as a template again.

Helpers: `default(a, b)`, `json(v)`, `join(list, sep?)`, `length(v)`,
`pluck(list, path)`, `truncate(text, n)`, `slice(v, start, end?)`,
`at(list, i)`, `compact(list)`, `concat(a, b, ...)` (2 to 6 lists),
`number(v)`, `string(v)`, `pick(obj, keys)`.

## Conditions

`when` takes `==`, `!=`, `&&`, `||`, `!`, parentheses, paths and literals,
and `available("tool_name")`, which is true when the tool can run now (loaded,
keyed, allowed in this profile). The dubbing recipe uses it to pick a path:

```json
{
  "id": "dubs",
  "when": "available(\"elevenlabs_dub\")",
  "forEach": "${input.languages}",
  "as": "lang",
  "concurrency": 2,
  "tool": "elevenlabs_dub",
  "pack": "elevenlabs",
  "paid": true,
  "args": {
    "artifact_id": "${input.artifact_id}",
    "target_language": "${lang}",
    "source_language": "${input.source_language}"
  }
},
{
  "id": "transcript",
  "when": "!available(\"elevenlabs_dub\")",
  "tool": "transcribe_audio",
  "args": { "artifact_id": "${input.artifact_id}" }
}
```

A condition that reads only `input` and `available()` is decided in the
pre-flight. One that reads step outputs is decided when the step comes up.

## Limits

| Limit | Value |
| --- | --- |
| Steps per recipe, counting group members and fallbacks | 40 |
| Items per `forEach` | 20 |
| Calls at once in a `forEach` or group | 4 |
| Members of one `parallel` group | 8 |
| Run time | 1 h by default, 3 h at most |
| One template's text | 64 KiB |
| One call's resolved arguments | 256 KiB |
| One step's kept output | 256 KiB (a larger one keeps its artifact ids and the start of its text) |
| Recipe file | 256 KiB |
| Workflows calling workflows | 2 deep |

## Permissions

A workflow runs with its pack's context. Every call goes through
`ctx.tools.call` or `ctx.capabilities.run`, so the pack's `permissions.tools`,
the caller's profile, metering, redaction and the nested-call depth apply as
they do to a code pack. A workflow cannot call a tool the client's profile
hides.

## Check a recipe

Add the pack (`plughive pack add <folder>`) and enable it in the dashboard.
A recipe that fails to load is logged as a `workflow not loaded` warning with
the reason, in the daemon's output and in `<home>/logs/server.jsonl`. When
`wf_<name>` shows up in `plughive status` counts or in the Playground, call it
with `dry_run: true`.

The source of the format is [src/core/workflows/schema.ts](../src/core/workflows/schema.ts).
