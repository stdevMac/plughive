// src/cli/profiles.ts
//
//   plughive profiles [list|show|preview|put|delete]
//   plughive prefs [show|set]
//
// The Exposure page (which tools each agent profile lists, and what that
// costs in context) and the dashboard's language preference.
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE } from "./args.js";
import {
  COMMON_HELP,
  type Ctx,
  confirm,
  enc,
  printFields,
  printTable,
  readJsonObject,
  runGroup,
  sub,
} from "./common.js";

interface Profile {
  id: string;
  name: string;
  mode: "list" | "search" | "auto";
  include: string[];
  exclude: string[];
  pinned: string[];
  autoThresholdTokens: number;
  autoThresholdTools: number;
}

interface Preview {
  profile: string;
  mode: string;
  tools: { name: string }[];
  cost: { perTool: { name: string; tokens: number }[]; totalTokens: number };
  direct_tokens: number;
  exposed_tools: number;
  exposed?: string[];
}

export const PROFILES_HELP = `Usage: plughive profiles <command> [options]

A profile decides which tools an agent sees in tools/list (list mode), or a
small search toolset in their place (search mode), and so how much context
the tools cost. Agents use one through its own endpoint, /p/<id>/mcp.

Commands:
  list                    every profile (the default)
  show <id>               the profile and what it exposes now
  preview <id>            what tools/list holds for it and its token cost
      --file JSON|@file|- preview a draft that is not saved instead
      --tools             list each tool with its tokens
  put <id> <JSON|@file|-> create or replace a profile, for example
                          '{"name":"Images","mode":"list","include":["capability:image"]}'
                          (selectors: *, pack:<id>, tool:<name>, mount:<id>,
                          capability:<name>, workflow:<name>, tag:<tag>)
  delete <id>             delete a profile (-y to skip the question)

${COMMON_HELP}`;

function printPreview(ctx: Ctx, p: Preview, tools: boolean): void {
  const io = ctx.io;
  printFields(io, [
    ["mode", p.mode],
    ["matching tools", p.exposed_tools],
    ["tools/list", `${p.tools.length} tools, ~${p.cost.totalTokens} tokens`],
    ["listing all directly", `~${p.direct_tokens} tokens`],
  ]);
  if (tools) {
    io.out("");
    printTable(
      io,
      ["TOOL", "TOKENS"],
      [...p.cost.perTool].sort((a, b) => b.tokens - a.tokens).map((t) => [t.name, t.tokens]),
    );
  }
}

export async function runProfiles(argv: string[], io: CliIo): Promise<number> {
  const preview = async (ctx: Ctx, id: string) =>
    ctx.api().get<Preview>(`/api/profiles/${enc(id)}/preview`);
  return runGroup(
    "profiles",
    PROFILES_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { ctx } = sub("profiles list", args, io, {});
        const { profiles } = await ctx.api().get<{ profiles: Profile[] }>("/api/profiles");
        if (ctx.json) {
          ctx.printJson(profiles);
          return EXIT_OK;
        }
        printTable(
          io,
          ["ID", "NAME", "MODE", "INCLUDE", "EXCLUDE"],
          profiles.map((p) => [p.id, p.name, p.mode, p.include.join(" "), p.exclude.join(" ")]),
        );
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "profiles show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<id>" },
        );
        const id = positionals[0] ?? "";
        const { profile } = await ctx.api().get<{ profile: Profile }>(`/api/profiles/${enc(id)}`);
        const p = await preview(ctx, id);
        if (ctx.json) {
          ctx.printJson({ profile, preview: p });
          return EXIT_OK;
        }
        printFields(io, [
          ["id", profile.id],
          ["name", profile.name],
          [
            "mode",
            `${profile.mode}${profile.mode === "auto" ? ` (search above ${profile.autoThresholdTools} tools or ${profile.autoThresholdTokens} tokens)` : ""}`,
          ],
          ["include", profile.include.join(" ") || "nothing"],
          ["exclude", profile.exclude.join(" ") || null],
          ["pinned", profile.pinned.join(" ") || null],
        ]);
        io.out("");
        printPreview(ctx, p, false);
        return EXIT_OK;
      },
      preview: async (args) => {
        const { values, positionals, ctx } = sub(
          "profiles preview",
          args,
          io,
          { file: { type: "string" }, tools: { type: "boolean" } },
          { max: 1, usage: "<id> | --file JSON" },
        );
        if (!!values.file === !!positionals[0])
          throw new CliError("give a profile id or --file", EXIT_USAGE);
        const p = values.file
          ? await ctx
              .api()
              .post<Preview>("/api/profiles/preview", readJsonObject(values.file, "--file"))
          : await preview(ctx, positionals[0] ?? "");
        if (ctx.json) ctx.printJson(p);
        else printPreview(ctx, p, values.tools === true);
        return EXIT_OK;
      },
      put: async (args) => {
        const { positionals, ctx } = sub(
          "profiles put",
          args,
          io,
          {},
          { min: 2, max: 2, usage: "<id> <JSON|@file|->" },
        );
        const [id = "", spec = ""] = positionals;
        const { profile } = await ctx
          .api()
          .put<{ profile: Profile }>(`/api/profiles/${enc(id)}`, readJsonObject(spec, "profile"));
        if (ctx.json) ctx.printJson(profile);
        else {
          io.out(`Saved profile ${profile.id}.\n`);
          printPreview(ctx, await preview(ctx, profile.id), false);
        }
        return EXIT_OK;
      },
      delete: async (args) => {
        const { values, positionals, ctx } = sub(
          "profiles delete",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 1, max: 1, usage: "<id>" },
        );
        const id = positionals[0] ?? "";
        await confirm(
          io,
          `Delete profile ${id}? Agents that use /p/${id}/mcp will get an error.`,
          values.yes === true,
        );
        await ctx.api().delete(`/api/profiles/${enc(id)}`);
        if (ctx.json) ctx.printJson({ deleted: id });
        else io.out(`Deleted profile ${id}.`);
        return EXIT_OK;
      },
    },
    "list",
  );
}

// ---- preferences ------------------------------------------------------------

export const PREFS_HELP = `Usage: plughive prefs <command> [options]

Preferences shared by the dashboard and the desktop app.

Commands:
  show                    the preferences (the default)
  set locale=<tag>        the dashboard's language (en, fr, ...); locale= clears it

${COMMON_HELP}`;

export async function runPrefs(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "prefs",
    PREFS_HELP,
    argv,
    io,
    {
      show: async (args) => {
        const { ctx } = sub("prefs show", args, io, {});
        const { preferences } = await ctx
          .api()
          .get<{ preferences: { locale: string | null } }>("/api/preferences");
        if (ctx.json) ctx.printJson(preferences);
        else
          printFields(io, [["locale", preferences.locale ?? "not chosen (follows the browser)"]]);
        return EXIT_OK;
      },
      set: async (args) => {
        const { positionals, ctx } = sub(
          "prefs set",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "locale=<tag>" },
        );
        const m = /^locale=(.*)$/.exec(positionals[0] ?? "");
        if (!m) throw new CliError("only locale=<tag> can be set", EXIT_USAGE);
        const { preferences } = await ctx
          .api()
          .put<{ preferences: { locale: string | null } }>("/api/preferences", {
            locale: m[1] || null,
          });
        if (ctx.json) ctx.printJson(preferences);
        else io.out(`locale: ${preferences.locale ?? "not chosen"}`);
        return EXIT_OK;
      },
    },
    "show",
  );
}
