// src/cli/secrets.ts
//
//   plughive secrets [list|set|unset]
//
// The keys on the Settings and Packs pages. A value is read from a hidden
// prompt or from stdin, never from the command line (where it would land in
// the shell history and the process list), and it is never printed.
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE } from "./args.js";
import { COMMON_HELP, confirm, enc, printTable, readStdin, runGroup, sub } from "./common.js";

interface SecretRow {
  pack: string;
  name: string;
  label: string | null;
  help_url: string | null;
  required: boolean;
  granted: boolean;
  stored_only: boolean;
  present: boolean;
  source: string | null;
}

export const SECRETS_HELP = `Usage: plughive secrets <command> [options]

API keys and tokens the packs and mounts use. Values are never shown.

Commands:
  list                  every secret something asks for: set or not, and where
                        the value comes from (the default)
      --missing         only the ones not set
  set <pack> <NAME>     store a value; you type it at a hidden prompt, or pipe
                        it: printf %s "$KEY" | plughive secrets set <pack> <NAME>
  unset <pack> <NAME>   delete the stored value; asks first (-y to skip)

<pack> is the pack that asks for it ("plughive secrets list" shows it), or
"user" for a secret a mount of yours uses.

${COMMON_HELP}`;

export async function runSecrets(argv: string[], io: CliIo): Promise<number> {
  return runGroup(
    "secrets",
    SECRETS_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { values, ctx } = sub("secrets list", args, io, { missing: { type: "boolean" } });
        const body = await ctx.api().get<{ backend: string; secrets: SecretRow[] }>("/api/secrets");
        let rows = body.secrets;
        if (values.missing) rows = rows.filter((r) => !r.present);
        if (ctx.json) {
          ctx.printJson({ ...body, secrets: rows });
          return EXIT_OK;
        }
        if (!rows.length)
          io.out(values.missing ? "Every secret is set." : "Nothing asks for a secret.");
        else
          printTable(
            io,
            ["PACK", "NAME", "STATE", "FROM", "NEEDED", "ABOUT"],
            rows.map((r) => [
              r.pack,
              r.name,
              r.present ? "set" : "not set",
              r.source ?? "",
              `${r.required ? "required" : "optional"}${r.granted ? "" : ", not granted"}`,
              r.label ?? r.help_url ?? "",
            ]),
          );
        io.out(`\nStored in: ${body.backend}`);
        return EXIT_OK;
      },
      set: async (args) => {
        const { positionals, ctx } = sub(
          "secrets set",
          args,
          io,
          {},
          { min: 2, max: 2, usage: "<pack> <NAME>" },
        );
        const [pack = "", name = ""] = positionals;
        let value: string;
        if (process.stdin.isTTY) {
          if (!io.prompt) throw new CliError("no terminal to type the value in; pipe it on stdin");
          value = await io.prompt(`Value of ${name} (hidden): `, { hidden: true });
        } else {
          value = readStdin().replace(/\r?\n$/, "");
        }
        if (!value) throw new CliError("the value is empty; nothing was stored", EXIT_USAGE);
        const body = await ctx
          .api()
          .put<{ pack: string; name: string; present: boolean }>(
            `/api/secrets/${enc(pack)}/${enc(name)}`,
            { value },
          );
        if (ctx.json) ctx.printJson(body);
        else io.out(`Stored ${body.name} for ${body.pack}.`);
        return EXIT_OK;
      },
      unset: async (args) => {
        const { values, positionals, ctx } = sub(
          "secrets unset",
          args,
          io,
          { yes: { type: "boolean", short: "y" } },
          { min: 2, max: 2, usage: "<pack> <NAME> [--yes]" },
        );
        const [pack = "", name = ""] = positionals;
        await confirm(
          io,
          `Delete the stored ${name} of ${pack}? It cannot be recovered.`,
          values.yes === true,
        );
        const body = await ctx
          .api()
          .delete<{ pack: string; name: string; present: boolean }>(
            `/api/secrets/${enc(pack)}/${enc(name)}`,
          );
        if (ctx.json) ctx.printJson(body);
        else
          io.out(
            `Removed the stored ${body.name}.${
              body.present ? " An environment variable of that name still provides a value." : ""
            }`,
          );
        return EXIT_OK;
      },
    },
    "list",
  );
}
