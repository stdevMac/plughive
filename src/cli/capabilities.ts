// src/cli/capabilities.ts
//
//   plughive capabilities [list|show|prefer]
//
// The Capabilities page: which provider serves image, speech, search, ...
// first, and the user's preference order.
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE } from "./args.js";
import { COMMON_HELP, enc, printTable, runGroup, sub } from "./common.js";

interface ProviderInfo {
  capability: string;
  id: string;
  pack: string;
  priority: number;
  configured: boolean;
  models: string[] | null;
  coolingDownUntil: string | null;
  preferred: number | null;
  autoRoute: boolean;
  cost: string;
  setupHint: string | null;
}

interface CapabilityView {
  name: string;
  preference: string[];
  wouldUse: string | null;
  providers: ProviderInfo[];
}

export const CAPABILITIES_HELP = `Usage: plughive capabilities <command> [options]

A capability (image, speech, transcription, search, ...) is served by one of
several providers. A call without a provider runs the first ready one in
routing order: your preference first, then the built-in priority.

Commands:
  list                      each capability and the provider it would use (the default)
  show <capability>         its providers in routing order: ready or not,
                            local/account/paid, what to set up
  prefer <capability> <provider> [<provider> ...]
                            set the preference order (the first one is tried first)
  prefer <capability> --clear
                            back to the built-in order

${COMMON_HELP}`;

const state = (p: ProviderInfo) =>
  !p.configured
    ? "needs setup"
    : p.coolingDownUntil && Date.parse(p.coolingDownUntil) > Date.now()
      ? "cooling down"
      : !p.autoRoute
        ? "only when asked"
        : "ready";

function printProviders(io: CliIo, c: CapabilityView): void {
  io.out(`${c.name}: would use ${c.wouldUse ?? "nothing (no provider is ready)"}`);
  if (c.preference.length) io.out(`preference: ${c.preference.join(" > ")}`);
  if (!c.providers.length) return;
  printTable(
    io,
    ["PROVIDER", "PACK", "STATE", "COST", "SETUP"],
    c.providers.map((p) => [
      p.id,
      p.pack,
      state(p),
      p.cost,
      p.configured ? "" : (p.setupHint ?? ""),
    ]),
  );
}

export async function runCapabilities(argv: string[], io: CliIo): Promise<number> {
  const load = async (ctx: { api(): import("./api.js").ApiClient }) =>
    (await ctx.api().get<{ capabilities: CapabilityView[] }>("/api/capabilities")).capabilities;
  return runGroup(
    "capabilities",
    CAPABILITIES_HELP,
    argv,
    io,
    {
      list: async (args) => {
        const { ctx } = sub("capabilities list", args, io, {});
        const caps = await load(ctx);
        if (ctx.json) {
          ctx.printJson(caps);
          return EXIT_OK;
        }
        printTable(
          io,
          ["CAPABILITY", "WOULD USE", "READY", "PROVIDERS", "PREFERENCE"],
          caps.map((c) => [
            c.name,
            c.wouldUse ?? "-",
            c.providers.filter((p) => state(p) === "ready").length,
            c.providers.length,
            c.preference.join(" > "),
          ]),
        );
        return EXIT_OK;
      },
      show: async (args) => {
        const { positionals, ctx } = sub(
          "capabilities show",
          args,
          io,
          {},
          { min: 1, max: 1, usage: "<capability>" },
        );
        const name = positionals[0] ?? "";
        const c = (await load(ctx)).find((x) => x.name === name);
        if (!c)
          throw new CliError(`no capability "${name}"; "plughive capabilities list" shows them`);
        if (ctx.json) ctx.printJson(c);
        else printProviders(io, c);
        return EXIT_OK;
      },
      prefer: async (args) => {
        const { values, positionals, ctx } = sub(
          "capabilities prefer",
          args,
          io,
          { clear: { type: "boolean" } },
          { min: 1, max: 100, usage: "<capability> <provider> [...] | --clear" },
        );
        const [name = "", ...order] = positionals;
        if (values.clear && order.length)
          throw new CliError("give providers or --clear, not both", EXIT_USAGE);
        if (!values.clear && !order.length)
          throw new CliError("name at least one provider, or pass --clear", EXIT_USAGE);
        const { capability } = await ctx
          .api()
          .put<{ capability: CapabilityView }>(`/api/capabilities/${enc(name)}/preference`, {
            order,
          });
        // The daemon only checks the id's shape; a provider of a pack that is
        // off is not listed either, so this warns instead of refusing.
        const known = new Set(capability.providers.map((p) => p.id));
        const unknown = order.filter((id) => !known.has(id));
        if (unknown.length)
          io.err(
            `Not a provider of ${name} right now: ${unknown.join(", ")} (a typo, or its pack is off). Saved anyway.`,
          );
        if (ctx.json) ctx.printJson(capability);
        else printProviders(io, capability);
        return EXIT_OK;
      },
    },
    "list",
  );
}
