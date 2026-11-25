# Writing a pack

A pack adds tools to the daemon. It is a folder with a `pack.json` manifest
and, for tools, a JavaScript entry file. This page walks through
[examples/hello-pack](../examples/hello-pack), which has two tools and a test
in [tests/examples/hello-pack.test.ts](../tests/examples/hello-pack.test.ts).

## Trust first

A pack you add runs inside the daemon process, with your user's rights. The
permissions in `pack.json` limit what the pack API (`ctx.fetch`, `ctx.spawn`,
`ctx.secrets`, `ctx.library`, ...) lets it do. They are not an operating
system sandbox: code in a pack could import `node:fs` itself. Only add packs
whose code you have read or whose author you trust.

The daemon makes that review explicit:

- A pack you add is found **disabled**.
- To enable it you open the dashboard, read what it asks for (hosts,
  programs, keys, library access, other tools) and pick which keys it may
  read.
- Your consent is tied to a hash of the manifest and of every file in the
  folder. If a file changes, the pack does not load ("needs review") until
  you enable it again.
- The daemon imports a copy of the folder, made when it checked the hash, so
  the code that runs is the code that was hashed. A symbolic link anywhere in
  the folder refuses the pack.

## The folder

```
examples/hello-pack/
  pack.json
  index.js
  skills/hello/SKILL.md
```

## pack.json

```json
{
  "id": "hello-pack",
  "name": "Hello pack",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "./index.js",
  "description": "Example pack: greets someone and saves a note to the artifact library.",
  "secrets": [
    { "name": "HELLO_SIGNATURE", "label": "Signature added to notes", "required": false }
  ],
  "permissions": { "library": "write" },
  "skills": "skills"
}
```

| Field | Rules |
| --- | --- |
| `id` | `^[a-z][a-z0-9-]{1,31}$`. Unique across all packs. |
| `name` | 1 to 80 characters. |
| `version` | Semver, for example `0.1.0`. |
| `apiVersion` | `1`. |
| `entry` | Relative path to the JavaScript module. Optional for a pack that only ships workflows or mounts. |
| `description` | Up to 500 characters. Shown on the consent screen. |
| `secrets` | Keys the pack may read. `name` matches `^[A-Z][A-Z0-9_]{1,63}$`; `label`, `helpUrl` and `required` (default `true`) are optional. Names such as `PLUGHIVE_*`, `PATH`, `HOME`, `NODE_OPTIONS`, `AWS_*`, `SSH_*`, `GITHUB_TOKEN` and `NPM_TOKEN` are refused. |
| `permissions` | See below. Everything defaults to nothing. |
| `settings` | A JSON Schema object of plain settings the user edits in the dashboard. The pack reads them as `ctx.settings`. |
| `mounts` | Remote MCP servers the pack brings. |
| `skills` | A folder of agent skills (`<name>/SKILL.md`). |
| `workflows` | A folder of workflow recipes. See [workflows.md](workflows.md). |

`permissions`:

| Key | Value | Grants |
| --- | --- | --- |
| `network` | host patterns: `api.example.com`, `*.example.com`, `host:port` | `ctx.fetch` to those public hosts |
| `localNetwork` | `host:port`, for example `127.0.0.1:11434` | `ctx.fetch` to those local services |
| `spawn` | bare program names, for example `ffmpeg` | `ctx.spawn` of those programs |
| `library` | `none`, `read`, `read-all`, `write` or `full` | `ctx.library` |
| `llm` | `true` or `false` | `ctx.llm` |
| `tools` | tool names, `pack:<id>` or `cap:<capability>` | `ctx.tools` and `ctx.capabilities` |

The manifest is strict: an unknown field is an error.

## index.js

A pack outside the plughive package cannot import `plughive/pack`, so the
entry's default export is a factory. The daemon calls it with the pack API:

```js
/** @param {import("plughive/pack").PackApi} api */
export default (api) => {
  const { z, definePack, defineTool } = api;

  const greet = defineTool({
    name: "hello_greet",
    description: "Return a greeting for a name. Needs no key and saves nothing.",
    annotations: { readOnlyHint: true },
    input: z.object({
      name: z.string().trim().min(1).max(80).describe("Who to greet."),
    }),
    run({ name }) {
      return { greeting: `Hello, ${name}!` };
    },
  });
```

- `name` must be unique across all packs and must not contain `__`. Prefix
  your tools with something of your own. The daemon keeps `search_tools`,
  `describe_tool`, `execute_tool`, `wait_for_job`, `cancel_job`,
  `get_job_status`, `list_packs` and every name starting with `plughive_`.
- `input` is a zod 4 schema. The daemon validates arguments with it before
  `run` and advertises it as JSON Schema in `tools/list`.
- `run` returns any JSON value. The daemon wraps it as `{ok: true, result}`.
- `annotations` are the MCP tool hints (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`, `title`).

The second tool reads an optional key and saves a file:

```js
  const saveNote = defineTool({
    name: "hello_save_note",
    description: "Save a short markdown note to the artifact library and return its link.",
    input: z.object({
      title: z.string().trim().min(1).max(120),
      body: z.string().max(10_000),
    }),
    async run({ title, body }, ctx) {
      const signature = await optionalSecret(ctx, "HELLO_SIGNATURE");
      const text = `# ${title}\n\n${body}${signature ? `\n\n-- ${signature}` : ""}\n`;
      const ref = await ctx.library.save({
        kind: "document",
        mime: "text/markdown",
        bytes: new TextEncoder().encode(text),
        prompt: title,
      });
      ctx.logger.info("saved note", { id: ref.id });
      return { id: ref.id, url: ref.url };
    },
  });

  return definePack({ tools: [greet, saveNote] });
};
```

`optionalSecret` is a helper in the same file:

```js
async function optionalSecret(ctx, name) {
  try {
    return (await ctx.secrets.has(name)) ? await ctx.secrets.get(name) : null;
  } catch {
    return null;
  }
}
```

`ctx.secrets.has()` is `false` when the key is granted but not saved.
Both `has()` and `get()` throw when the user did not grant the key when
enabling the pack. `get()` also throws when the key is not saved; the daemon
turns that into a `MISSING_SECRET` error that tells the user where to add it.
For a key the tool cannot work without, call `get()` and let it throw, or list
the key in the tool's `secrets` field so the daemon checks it before `run`.

A user pack reads only keys saved in the dashboard, never the environment.

## The context

`run(input, ctx)` gets:

| Member | What it does |
| --- | --- |
| `ctx.secrets` | `get(name)`, `has(name)` for declared, granted keys. |
| `ctx.settings` | The pack's settings. |
| `ctx.fetch` | `fetch` limited to `permissions.network` and `localNetwork`, with an SSRF guard. `timeoutMs` in the init sets a total budget (default 60 s, at most 15 min). |
| `ctx.spawn(binary, args, opts)` | Runs a program from `permissions.spawn`: argument array, no shell, working folder inside the pack's data folder, timeout and output cap. |
| `ctx.library` | `save`, `get`, `list`, `read`, `importFile` and more, as `permissions.library` allows. |
| `ctx.llm` | A chat call through the user's configured provider, when `llm` is `true`. |
| `ctx.tools`, `ctx.capabilities` | Call other tools, or a capability such as `image.generate`, as `permissions.tools` allows. |
| `ctx.logger` | `debug`, `info`, `warn`, `error(msg, data?)`. Secret values are masked. |
| `ctx.signal` | Aborted when the call is cancelled or the pack unloads. |
| `ctx.progress(fraction, message?)` | Reports progress to the client or the job. |

A tool that can take more than a few seconds sets `longRunning: true`. The
daemon then runs it as a background job and the client waits with
`wait_for_job`. Honor `ctx.signal` in such tools.

The full API, with types, is in [src/core/pack-api.ts](../src/core/pack-api.ts).

## Skills

`skills/hello/SKILL.md` tells agents how to use the tools:

```markdown
---
name: hello
description: Greet someone or save a short note with the hello pack.
---

Use `hello_greet` with `{"name": "..."}` for a greeting.

Use `hello_save_note` with `{"title": "...", "body": "..."}` to keep a note.
It returns the artifact id and URL. Give the user the URL.
```

## Test it

`plughive/pack/testing` gives a context with an in-memory library and secret
store. From the hello-pack test:

```ts
t = createTestContext({ packDir, source: "user" });
const pack = await loadPack();
const out = (await call(t, tool(pack, "hello_save_note"), {
  title: "Groceries",
  body: "Milk",
})) as { id: string; url: string };
expect(out.url).toBe(`http://127.0.0.1:7777/artifacts/${out.id}`);
const rows = t.library?.all() ?? [];
expect(rows).toHaveLength(1);
expect(rows[0]?.mime).toBe("text/markdown");
expect(rows[0]?.tool).toBe("hello-pack/hello_save_note");
```

`loadPack` imports `index.js` and calls the factory with `packApi` from
`plughive/pack`. `call` parses the arguments with the tool's schema, then runs
it with `t.forTool(name)`.

`createTestContext` options include `grants`, `settings`, and fakes for
`fetch`, `spawn`, `llm` and `tools`. Its `secrets` option does not reach a
pack tested with `source: "user"`, because user packs never read the
environment. To test a user pack with a saved key, load it through the real
loader as the test's second block does:

```ts
const store = createSecretStore({ home, env: {}, backend: "memory" });
await store.set("HELLO_SIGNATURE", "Ada");
// ...
await loader.enable("hello-pack", { grants: ["HELLO_SIGNATURE"] });
await loader.settled();
const out = await registry.invoke("hello_save_note", { title: "Hi", body: "Text" });
```

That block imports the loader from the plughive source, so it only runs
inside this repository. Run the example's test with:

```sh
PLUGHIVE_NO_DOTENV=1 pnpm exec vitest run tests/examples/hello-pack.test.ts
```

## Install it

```sh
plughive pack add examples/hello-pack
```

`pack add` takes a folder or an `https://`, `ssh://` or `git@` git URL. It
copies the pack into `<home>/packs/<id>` (without `.git`, `node_modules` or
symbolic links) and asks a running daemon to look again. Then:

1. Run `plughive dashboard` and open **Packs & keys**.
2. Read what the pack asks for.
3. Enable it, granting the keys you choose.

`plughive pack list` shows every pack and its state.
`plughive pack remove hello-pack` removes it.

If the daemon is not running, the pack is found the next time it starts.
