// packs/growth/providers/index.ts
import type { PackContext } from "plughive/pack";
import { apolloDescriptor } from "./apollo.js";
import type { LeadProvider, ProviderDescriptor } from "./types.js";

/** Registered providers, in default-preference order. */
export const PROVIDERS: readonly ProviderDescriptor[] = [apolloDescriptor];

export interface ProviderStatusRow {
  id: string;
  label: string;
  secret: string;
  configured: boolean;
  capabilities: readonly string[];
}

export async function listProviders(
  ctx: Pick<PackContext, "secrets">,
): Promise<ProviderStatusRow[]> {
  const rows: ProviderStatusRow[] = [];
  for (const d of PROVIDERS) {
    rows.push({
      id: d.id,
      label: d.label,
      secret: d.secret,
      configured: await ctx.secrets.has(d.secret),
      capabilities: d.capabilities,
    });
  }
  return rows;
}

export interface ResolvedProvider {
  provider: LeadProvider;
  descriptor: ProviderDescriptor;
}

/**
 * Pick a provider: the named one, else the first that has a key set. When none
 * is configured this reads the first provider's secret, which throws the
 * standard MissingSecretError (with the label and help link) for the user.
 */
export async function resolveProvider(
  ctx: Pick<PackContext, "secrets" | "fetch"> & { signal?: AbortSignal },
  name?: string,
  hooks: { retryBaseMs?: number } = {},
): Promise<ResolvedProvider> {
  let descriptor: ProviderDescriptor | undefined;
  if (name !== undefined) {
    descriptor = PROVIDERS.find((d) => d.id === name);
    if (!descriptor) {
      throw new Error(
        `unknown provider "${name}" (available: ${PROVIDERS.map((d) => d.id).join(", ")})`,
      );
    }
  } else {
    for (const d of PROVIDERS) {
      if (await ctx.secrets.has(d.secret)) {
        descriptor = d;
        break;
      }
    }
    descriptor ??= PROVIDERS[0];
  }
  if (!descriptor) throw new Error("no lead providers are registered");
  const apiKey = await ctx.secrets.get(descriptor.secret);
  const provider = descriptor.create({
    fetch: ctx.fetch,
    apiKey,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(hooks.retryBaseMs !== undefined ? { retryBaseMs: hooks.retryBaseMs } : {}),
  });
  return { provider, descriptor };
}
