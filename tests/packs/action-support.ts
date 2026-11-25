// Shared helpers for the action-pack tests (email, phone, sandbox, ...): the
// real scoped context from createTestContext, so the manifest's network,
// secret, library and spawn rules apply exactly as in the daemon.
import { fileURLToPath } from "node:url";
import type { AnyToolDefinition, PackContext, PackDefinition } from "plughive/pack";
import {
  type CreateTestContextOptions,
  type TestContext,
  createTestContext,
} from "plughive/pack/testing";
import { afterEach, expect } from "vitest";
import { failure } from "./provider-support.js";
import { loadBuiltinPacks, toolOf } from "./support.js";

const harnesses: TestContext[] = [];

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.dispose();
});

export function packDir(packId: string): string {
  return fileURLToPath(new URL(`../../packs/${packId}`, import.meta.url));
}

export interface Harness {
  t: TestContext;
  ctx: PackContext;
  tool: AnyToolDefinition;
  /** Validate `args` with the tool's schema and run it. */
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** A tool of `pack` bound to the real scoped context of `packId`. */
export function harness(
  pack: PackDefinition,
  packId: string,
  toolName: string,
  opts: Omit<CreateTestContextOptions, "packDir" | "manifest"> = {},
): Harness {
  const t = createTestContext({ packDir: packDir(packId), ...opts });
  harnesses.push(t);
  const ctx = t.forTool(toolName);
  const tool = toolOf(pack, toolName);
  return { t, ctx, tool, call: async (args) => tool.run(tool.input.parse(args), ctx) };
}

/** Fails when any secret value (or its URL-encoded or base64 form) shows up in `value`. */
export function expectNoSecrets(value: unknown, secrets: readonly string[]): void {
  const text =
    value instanceof Error
      ? `${value.name} ${value.message} ${String(value.stack)}`
      : JSON.stringify(value);
  for (const s of secrets) {
    expect(text).not.toContain(s);
    expect(text).not.toContain(encodeURIComponent(s));
    expect(text).not.toContain(Buffer.from(s).toString("base64"));
  }
}

/** A fetch to a host the manifest does not declare is refused before it reaches the network. */
export async function expectHostDenied(
  ctx: PackContext,
  url = "https://evil.example.com/x",
): Promise<void> {
  const err = (await failure(ctx.fetch(url))) as Error & { code?: string };
  expect(err.code).toBe("PACK_PERMISSION_DENIED");
}

/** Each named tool loads with the real loader and reports MISSING_SECRET without its key. */
export async function expectMissingSecret(
  calls: { tool: string; args: Record<string, unknown>; pack: string; secret: string }[],
): Promise<void> {
  const h = await loadBuiltinPacks();
  try {
    for (const c of calls) {
      if (!h.registry.get(c.tool)) await h.loader.enable(c.pack);
      expect(h.registry.get(c.tool), c.tool).toBeDefined();
      const res = await h.registry.call(c.tool, c.args);
      expect(res, c.tool).toMatchObject({
        ok: false,
        error: { code: "MISSING_SECRET", pack: c.pack, secret: c.secret },
      });
    }
  } finally {
    await h.close();
  }
}
