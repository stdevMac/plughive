# plughive plugin for Claude Code

This plugin registers a running plughive daemon as an MCP server in Claude
Code and adds a skill that explains how to find and run its tools.

## Install from this folder

Start the daemon first (`plughive start`). Then, in a terminal:

```sh
claude plugin marketplace add ./plugin
claude plugin install plughive@plughive-local
```

Run the first command from the repository root, or give the path to this
folder.

## Settings

The plugin reads two environment variables when Claude Code starts:

- `PLUGHIVE_URL`: the daemon origin. Default `http://127.0.0.1:7777`.
- `PLUGHIVE_ACCESS_KEY`: sent as `Authorization: Bearer <key>`. Needed only
  when the daemon was started with an access key.

## Privacy

The plugin connects only to the daemon URL above. It sends no data anywhere
else. The daemon calls a provider only when you run a tool that uses one,
with the key you saved for it.
