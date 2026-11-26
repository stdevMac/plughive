// src/cli/mounts.ts
//
//   plughive mounts [list|show|add|enable|disable|remove|login|logout|smart]
//
// The Mounts page: other MCP servers the daemon connects to and serves
// through itself (from packs, or your own in mounts.json), their OAuth
// sign-in, and smart mount (parking idle mounts to save tokens).
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK, EXIT_USAGE } from "./args.js";
import {
  COMMON_HELP,
  type Ctx,
  ago,
  confirm,
  enc,
  printFields,
  printTable,
  readJsonObject,
  runGroup,
  sleep,
  sub,
  truncate,
} from "./common.js";
import { openInBrowser } from "./open.js";

interface MountInfo {
  id: string;
  pack: string;
  mountId: string;
  name: string;
  description: string | null;
  url: string | null;
  transport: string;
  prefix: string;
  auth: string;
  docsUrl: string | null;
  enabled: boolean;
  mountable: boolean;
  note: string | null;
  secrets: { name: string; present: boolean }[];
  source: "pack" | "user";
  command: string | null;
  connected: boolean;
  tools: number;
  error: string | null;
  oauth: { signedIn: boolean; pending: boolean } | null;
}

export const MOUNTS_HELP = `Usage: plughive mounts <command> [options]

Other MCP servers plughive connects to and serves through itself.

Commands:
  list                    every mount: on/off, connected, tools (the default)
  show <owner/id>         one mount: transport, URL or program, secrets, sign-in
  add <JSON|@file|->      add your own mount (to mounts.json), for example
                          '{"id":"docs","transport":"http","prefix":"docs",
                            "url":"https://example.com/mcp"}'
                          or '{"id":"fs","transport":"stdio","prefix":"fs",
                            "command":"npx","args":["-y","some-mcp-server"]}'
                          A secret goes in as \${secret:NAME}; set it with
                          "plughive secrets set user NAME".
  enable <owner/id>       switch a mount on
  disable <owner/id>      switch it off
  remove <id>             delete one of your own mounts (user/<id>); asks first
                          (-y to skip)
  login <owner/id>        OAuth sign-in: opens the vendor's page and waits
      --no-open           print the link instead of opening a browser
      --timeout SEC       how long to wait for the sign-in (default 300)
  logout <owner/id>       forget the sign-in; asks first (-y to skip)
  smart                   smart mount: idle mounts, suggestions, token savings
  smart set [mode=off|suggest|auto] [idleDays=N] [wake=auto|ask]
            [--keep owner/id ...] [--no-keep]
                          change its settings
  smart park [owner/id ...]
                          park these mounts (or, after asking, every park
                          suggestion; -y to skip the question)
  smart apply [KEY ...]   apply these suggestions (or, after asking, every one)
  smart undo KEY ...      undo applied profile changes

<owner> is the pack that declares the mount, or "user" for your own.

${COMMON_HELP}`;

const mountPath = (full: string) => {
  const m = /^([a-z][a-z0-9-]{1,31})\/([a-z][a-z0-9-]{1,31})$/.exec(full);
  if (!m) throw new CliError(`"${full}" is not <owner>/<id> (for example user/docs)`, EXIT_USAGE);
  return `/api/mounts/${m[1]}/${m[2]}`;
};

const status = (m: MountInfo) =>
  !m.enabled
    ? "off"
    : m.connected
      ? "connected"
      : m.oauth && !m.oauth.signedIn
        ? "needs sign-in"
        : m.secrets.some((s) => !s.present)
          ? "needs a key"
          : m.error
            ? "failing"
            : "connecting";

async function listMounts(ctx: Ctx) {
  return ctx.api().get<{ mounts: MountInfo[]; mounts_file_error: string | null }>("/api/mounts");
}

async function findMount(ctx: Ctx, id: string): Promise<MountInfo> {
  const { mounts } = await listMounts(ctx);
  const m = mounts.find((x) => x.id === id);
  if (!m) throw new CliError(`no mount "${id}"; "plughive mounts list" shows them`);
  return m;
}

function printMount(io: CliIo, m: MountInfo): void {
  printFields(io, [
    ["mount", m.id],
    ["name", m.name],
    ["status", status(m)],
    ["source", m.source === "user" ? "your mounts.json" : `pack ${m.pack}`],
    ["transport", m.transport],
    ["url", m.url],
    ["command", m.command],
    ["prefix", m.prefix],
    ["auth", m.auth],
    ["tools", m.tools],
    [
      "sign-in",
      m.oauth
        ? m.oauth.signedIn
          ? "signed in"
          : m.oauth.pending
            ? "waiting for the vendor"
            : "not signed in"
        : null,
    ],
    [
      "secrets",
      m.secrets.map((s) => `${s.name} (${s.present ? "set" : "not set"})`).join(", ") || null,
    ],
    ["error", m.error],
    ["note", m.note],
    ["docs", m.docsUrl],
    ["about", m.description],
  ]);
}

interface SmartReport {
  settings: { mode: string; idleDays: number; keep: string[]; wake: string };
  mounts: {
    id: string;
    name: string;
    enabled: boolean;
    connected: boolean;
    tools: number;
    est_tokens: number;
    last_used_at: string | null;
    calls_30d: number;
    idle_days: number | null;
    parked: { at: string } | null;
    kept: boolean;
  }[];
  suggestions: { kind: string; key: string; id: string; message: string; tokens?: number }[];
  changes: { key: string; kind: string; profile: string; tokens: number; at: string }[];
  summary: {
    days: number;
    parked: number;
    woken: number;
    hidden: number;
    undone: number;
    saved_tokens: number;
  };
  enabled_tokens: number;
  reclaimable_tokens: number;
}

function printSmart(io: CliIo, r: SmartReport): void {
  const s = r.settings;
  io.out(
    `Smart mount: ${s.mode} (idle after ${s.idleDays} days, wake ${s.wake}${s.keep.length ? `, keeps ${s.keep.join(", ")}` : ""})`,
  );
  io.out(
    `Tools of switched-on mounts: ~${r.enabled_tokens} tokens; parking the suggestions saves ~${r.reclaimable_tokens}; saved now ~${r.summary.saved_tokens}.`,
  );
  if (r.mounts.length) {
    io.out("");
    printTable(
      io,
      ["MOUNT", "STATE", "TOOLS", "TOKENS", "CALLS 30D", "LAST USED", "IDLE"],
      r.mounts.map((m) => [
        m.id,
        m.parked
          ? "parked"
          : m.kept
            ? "kept"
            : m.enabled
              ? m.connected
                ? "on"
                : "on, not connected"
              : "off",
        m.tools,
        m.est_tokens,
        m.calls_30d,
        m.last_used_at ? ago(m.last_used_at) : "never",
        m.idle_days === null ? "" : `${m.idle_days}d`,
      ]),
    );
  }
  if (r.suggestions.length) {
    io.out("\nSuggestions");
    printTable(
      io,
      ["KEY", "KIND", "SAVES", "WHAT"],
      r.suggestions.map((x) => [
        x.key,
        x.kind,
        x.tokens ? `~${x.tokens}` : "",
        truncate(x.message, 80),
      ]),
    );
    io.out('\nApply with "plughive mounts smart apply KEY" (or park with "smart park").');
  }
  if (r.changes.length) {
    io.out('\nApplied changes (undo with "plughive mounts smart undo KEY")');
    printTable(
      io,
      ["KEY", "KIND", "PROFILE", "SAVES", "WHEN"],
      r.changes.map((c) => [c.key, c.kind, c.profile, `~${c.tokens}`, ago(c.at)]),
    );
  }
}

async function smart(args: string[], io: CliIo): Promise<number> {
  const [action, ...rest] = args[0] && !args[0].startsWith("-") ? args : ["show", ...args];
  switch (action) {
    case "show": {
      const { ctx } = sub("mounts smart", rest, io, {});
      const r = await ctx.api().get<SmartReport>("/api/mounts/smart");
      if (ctx.json) ctx.printJson(r);
      else printSmart(io, r);
      return EXIT_OK;
    }
    case "set": {
      const { values, positionals, ctx } = sub(
        "mounts smart set",
        rest,
        io,
        { keep: { type: "string", multiple: true }, "no-keep": { type: "boolean" } },
        {
          max: 3,
          usage: "[mode=off|suggest|auto] [idleDays=N] [wake=auto|ask] [--keep owner/id ...]",
        },
      );
      const patch: Record<string, unknown> = {};
      for (const p of positionals) {
        const m = /^(mode|idleDays|wake)=(.+)$/.exec(p);
        if (!m) throw new CliError(`"${p}" is not mode=, idleDays= or wake=`, EXIT_USAGE);
        patch[m[1] ?? ""] = m[1] === "idleDays" ? Number(m[2]) : m[2];
      }
      if (values.keep?.length) patch.keep = values.keep;
      if (values["no-keep"]) patch.keep = [];
      if (!Object.keys(patch).length) throw new CliError("nothing to change", EXIT_USAGE);
      const body = await ctx
        .api()
        .put<{ settings: SmartReport["settings"] }>("/api/mounts/smart", patch);
      if (ctx.json) ctx.printJson(body.settings);
      else
        io.out(
          `Smart mount: ${body.settings.mode}, idle after ${body.settings.idleDays} days, wake ${body.settings.wake}.`,
        );
      return EXIT_OK;
    }
    case "park": {
      const { values, positionals, ctx } = sub(
        "mounts smart park",
        rest,
        io,
        { yes: { type: "boolean", short: "y" } },
        { max: 64 },
      );
      if (!positionals.length)
        await confirm(io, "Park every mount smart mount suggests?", values.yes === true);
      const body = await ctx
        .api()
        .post<{ parked?: string[]; skipped?: string[] }>(
          "/api/mounts/smart/park",
          positionals.length ? { ids: positionals } : {},
        );
      if (ctx.json) ctx.printJson(body);
      else {
        io.out(body.parked?.length ? `Parked ${body.parked.join(", ")}.` : "Nothing to park.");
        if (body.skipped?.length)
          io.err(`Not parked (unknown, off, or already parked): ${body.skipped.join(", ")}`);
      }
      // Asked for named mounts and none of them could be parked.
      return positionals.length && !body.parked?.length ? EXIT_FAIL : EXIT_OK;
    }
    case "apply": {
      const { values, positionals, ctx } = sub(
        "mounts smart apply",
        rest,
        io,
        { yes: { type: "boolean", short: "y" } },
        { max: 64 },
      );
      if (!positionals.length)
        await confirm(io, "Apply every smart mount suggestion?", values.yes === true);
      const body = await ctx
        .api()
        .post<Record<string, unknown>>(
          "/api/mounts/smart/apply",
          positionals.length ? { keys: positionals } : {},
        );
      if (ctx.json) ctx.printJson(body);
      else {
        const { ok: _ok, ...result } = body;
        io.out(`Applied: ${JSON.stringify(result)}`);
      }
      return EXIT_OK;
    }
    case "undo": {
      const { positionals, ctx } = sub(
        "mounts smart undo",
        rest,
        io,
        {},
        { min: 1, max: 64, usage: "KEY ..." },
      );
      const body = await ctx
        .api()
        .post<{ undone: unknown }>("/api/mounts/smart/undo", { keys: positionals });
      if (ctx.json) ctx.printJson(body);
      else io.out(`Undone: ${JSON.stringify(body.undone)}`);
      return EXIT_OK;
    }
    default:
      throw new CliError(`unknown mounts smart command "${action}"`, EXIT_USAGE);
  }
}

export async function runMounts(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "mounts",
    MOUNTS_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { ctx } = sub("mounts list", args, io, {});
        const body = await listMounts(ctx);
        if (ctx.json) {
          ctx.printJson(body);
          return EXIT_OK;
        }
        if (body.mounts_file_error) io.out(`mounts.json is not valid: ${body.mounts_file_error}\n`);
        if (!body.mounts.length) {
          io.out('No mounts. Add one with "plughive mounts add".');
          return EXIT_OK;
        }
        printTable(
          io,
          ["MOUNT", "STATUS", "TRANSPORT", "TOOLS", "NAME"],
          body.mounts.map((m) => [m.id, status(m), m.transport, m.tools, truncate(m.name, 40)]),
        );
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "mounts show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<owner/id>" },
        );
        const m = await findMount(ctx, positionals[0] ?? "");
        if (ctx.json) ctx.printJson(m);
        else printMount(io, m);
        return EXIT_OK;
      },
      add: async (args) => {
        const { positionals, ctx } = sub(
          "mounts add",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<JSON|@file|->" },
        );
        const mount = readJsonObject(positionals[0] ?? "", "mount");
        const body = await ctx
          .api()
          .post<{ id: string; mount: MountInfo | undefined }>("/api/mounts", mount);
        if (ctx.json) ctx.printJson(body);
        else {
          io.out(`Added ${body.id}.`);
          if (body.mount) printMount(io, body.mount);
        }
        return EXIT_OK;
      },
      enable: async (args) => toggle("enable", args, io),
      disable: async (args) => toggle("disable", args, io),
      remove: async (args) => {
        const { values, positionals, ctx } = sub(
          "mounts remove",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 1, max: 1, usage: "<id> [--yes]" },
        );
        const id = (positionals[0] ?? "").replace(/^user\//, "");
        await confirm(io, `Delete the mount user/${id}?`, values.yes === true);
        const body = await ctx.api().delete<{ removed: string }>(`/api/mounts/user/${enc(id)}`);
        if (ctx.json) ctx.printJson(body);
        else io.out(`Removed ${body.removed}.`);
        return EXIT_OK;
      },
      login: async (args) => {
        const { values, positionals, ctx } = sub(
          "mounts login",
          args,
          io,
          { "no-open": { type: "boolean" }, timeout: { type: "string" } },
          { min: 1, max: 1, usage: "<owner/id>" },
        );
        const path = mountPath(positionals[0] ?? "");
        const { authorization_url: url } = await ctx
          .api()
          .post<{ authorization_url: string }>(`${path}/oauth/start`);
        const opened = !values["no-open"] && (await openInBrowser(url));
        io.err(opened ? "Opened the sign-in page in your browser." : "Open this link to sign in:");
        if (!opened) io.out(url);
        const deadline =
          Date.now() + (Number(values.timeout) > 0 ? Number(values.timeout) : 300) * 1000;
        io.err("Waiting for the sign-in to finish...");
        while (Date.now() < deadline) {
          await sleep(2000);
          const s = await ctx.api().get<{
            signed_in: boolean;
            pending: boolean;
            connected: boolean;
            error: string | null;
          }>(`${path}/oauth`);
          if (s.signed_in) {
            if (ctx.json) ctx.printJson(s);
            else io.out(`Signed in to ${positionals[0]}${s.connected ? "; connected" : ""}.`);
            return EXIT_OK;
          }
          if (!s.pending) {
            throw new CliError(`the sign-in did not complete${s.error ? `: ${s.error}` : ""}`);
          }
        }
        io.err(
          'Timed out waiting; the sign-in link stays valid for a while. Check with "plughive mounts show".',
        );
        return EXIT_FAIL;
      },
      logout: async (args) => {
        const { values, positionals, ctx } = sub(
          "mounts logout",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 1, max: 1, usage: "<owner/id> [--yes]" },
        );
        await confirm(
          io,
          `Forget the sign-in for ${positionals[0]}? You will have to sign in again.`,
          values.yes === true,
        );
        const body = await ctx
          .api()
          .delete<{ mount: MountInfo | null }>(`${mountPath(positionals[0] ?? "")}/oauth`);
        if (ctx.json) ctx.printJson(body.mount);
        else io.out(`Signed out of ${positionals[0]}.`);
        return EXIT_OK;
      },
      smart: (args) => smart(args, io),
    },
    "list",
  );
}

async function toggle(action: "enable" | "disable", args: string[], io: CliIo): Promise<number> {
  const { positionals, ctx } = sub(
    `mounts ${action}`,
    args,
    io,
    {},
    { min: 1, max: 1, usage: "<owner/id>" },
  );
  const body = await ctx
    .api()
    .post<{ mount: MountInfo | null }>(`${mountPath(positionals[0] ?? "")}/${action}`);
  if (ctx.json) ctx.printJson(body.mount);
  else if (body.mount) io.out(`${body.mount.id} is ${status(body.mount)}.`);
  else io.out(`${action === "enable" ? "Enabled" : "Disabled"} ${positionals[0]}.`);
  return EXIT_OK;
}
