// L8: the setup page checks the secret name again when the form comes back.
import { createHmac, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { declaredByLoadedPack, mountSecretSetup } from "../../src/core/http/secret-setup.js";
import {
  SetupTokens,
  PACK_ID_PATTERN as TOKEN_PACK_ID_PATTERN,
} from "../../src/core/mcp/setup-token.js";
import { PACK_ID_PATTERN } from "../../src/core/packs/manifest.js";

const VALUE = "pasted-key-value-7788";
const TOKEN_KEY = randomBytes(32);

/** A token signed with the instance key, as one minted before a rule change would be. */
function forge(claim: { pack: string; secret: string }): string {
  const payload = { ...claim, n: randomBytes(16).toString("base64url"), e: Date.now() + 600_000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", TOKEN_KEY)
    .update(`plughive.setup.v1:${body}`)
    .digest("base64url");
  return `${body}.${sig}`;
}

describe("secret setup: the name is checked again at submit time", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((r) => (server ? server.close(r) : r(undefined)));
    server = undefined;
  });

  async function boot(
    declared?: (pack: string, secret: string) => boolean | Promise<boolean>,
    present?: (secret: string) => boolean | Promise<boolean>,
  ) {
    const stored = new Map<string, string>();
    const logs: unknown[] = [];
    const tokens = new SetupTokens({ key: TOKEN_KEY, pruneEveryMs: 0 });
    const app = express();
    mountSecretSetup(app, {
      tokens,
      secrets: { set: async (name, value) => void stored.set(name, value) },
      logger: { info: (o, m) => void logs.push([o, m]), warn: (o, m) => void logs.push([o, m]) },
      origin: { isOwn: () => true, base: () => "http://127.0.0.1" } as never,
      ...(declared ? { declared } : {}),
      ...(present ? { present } : {}),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as { port: number };
    // As a browser does it: render the page, then post the form with its cookie.
    // `host` picks the origin: two origins means two connections, so two
    // submissions really run at the same time.
    const submit = async (token: string, host = "127.0.0.1") => {
      const page = await fetch(
        `http://${host}:${port}/setup/secret?token=${encodeURIComponent(token)}`,
      );
      await page.arrayBuffer();
      const cookie = (page.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
      return fetch(`http://${host}:${port}/setup/secret`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          ...(cookie ? { cookie } : {}),
        },
        body: new URLSearchParams({ token, value: VALUE }).toString(),
      });
    };
    return { tokens, stored, logs, submit };
  }

  it("stores nothing when no enabled pack declares the name any more", async () => {
    let enabled = true;
    const t = await boot((pack, secret) => enabled && pack === "demo" && secret === "DEMO_API_KEY");
    const first = t.tokens.mint({ pack: "demo", secret: "DEMO_API_KEY" });
    const second = t.tokens.mint({ pack: "demo", secret: "DEMO_API_KEY" });

    expect((await t.submit(first)).status).toBe(200);
    expect(t.stored.get("DEMO_API_KEY")).toBe(VALUE);
    t.stored.clear();

    // The pack was disabled after the link was handed out.
    enabled = false;
    const refused = await t.submit(second);
    expect(refused.status).toBe(409);
    const page = await refused.text();
    expect(page).toContain("Key not saved");
    expect(page).not.toContain(VALUE);
    expect(t.stored.size).toBe(0);
    expect(JSON.stringify(t.logs)).not.toContain(VALUE);
    // The link is spent either way.
    expect((await t.submit(second)).status).toBe(400);
    expect(t.stored.size).toBe(0);
  });

  it("stores nothing under a name on the deny list, whatever the token says", async () => {
    const t = await boot(() => true);
    for (const secret of ["NODE_OPTIONS", "PLUGHIVE_ADMIN_TOKEN", "LD_PRELOAD"]) {
      // Minting refuses the denied name outright.
      expect(t.tokens.tryMint({ pack: "demo", secret }), secret).toBeNull();
      // A token that carries one anyway (minted before the rule, forged here
      // with the key) is invalid at verify, and the page refuses it.
      const forged = forge({ pack: "demo", secret });
      expect(t.tokens.verify(forged)).toEqual({ ok: false, reason: "invalid" });
      expect((await t.submit(forged)).status).toBe(400);
    }
    expect(t.stored.size).toBe(0);
  });

  it("two live links for the same key cannot both store: one wins, the other gets 409", async () => {
    // The presence check is slow, so concurrent submissions all reach it
    // before any of them has stored anything.
    const t = await boot(
      () => true,
      async (secret) => {
        await new Promise((r) => setTimeout(r, 300));
        return t.stored.has(secret);
      },
    );
    const first = t.tokens.mint({ pack: "demo", secret: "DEMO_API_KEY" });
    const second = t.tokens.mint({ pack: "demo", secret: "DEMO_API_KEY" });
    // Different loopback origins, so the submissions run in parallel instead
    // of queueing on one connection.
    const [a, b] = await Promise.all([t.submit(first, "127.0.0.1"), t.submit(second, "localhost")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(t.stored.size).toBe(1);
    expect(t.stored.get("DEMO_API_KEY")).toBe(VALUE);
  });

  it("a failing check stores nothing", async () => {
    const t = await boot(() => {
      throw new Error("loader unavailable");
    });
    expect((await t.submit(t.tokens.mint({ pack: "demo", secret: "DEMO_API_KEY" }))).status).toBe(
      409,
    );
    expect(t.stored.size).toBe(0);
  });

  it("declaredByLoadedPack: the pack is enabled, loaded, and granted the secret", async () => {
    const pack = (state: string, enabled: boolean, granted = true) => ({
      id: "demo",
      enabled,
      state,
      secrets: [{ name: "DEMO_API_KEY", granted }],
    });
    const ask = (packs: ReturnType<typeof pack>[], id = "demo", secret = "DEMO_API_KEY") =>
      declaredByLoadedPack({ listPacks: async () => packs })(id, secret);
    expect(await ask([pack("loaded", true)])).toBe(true);
    expect(await ask([pack("disabled", false)])).toBe(false);
    expect(await ask([pack("needs-review", true)])).toBe(false);
    expect(await ask([pack("failed", true)])).toBe(false);
    // Declared but not granted (a user pack that never got the consent): no link.
    expect(await ask([pack("loaded", true, false)])).toBe(false);
    expect(await ask([pack("loaded", true)], "demo", "OTHER_KEY")).toBe(false);
    expect(await ask([pack("loaded", true)], "other")).toBe(false);
    expect(await ask([])).toBe(false);
  });

  it("tokens use the one pack id pattern", () => {
    expect(TOKEN_PACK_ID_PATTERN).toBe(PACK_ID_PATTERN);
    const tokens = new SetupTokens({ pruneEveryMs: 0 });
    // Accepted by the old, separate pattern; never a real pack id.
    for (const pack of ["0day", "has.dot", "under_score", "x", "a".repeat(40)]) {
      expect(tokens.tryMint({ pack, secret: "OK_NAME" }), pack).toBeNull();
    }
    expect(tokens.tryMint({ pack: "demo", secret: "OK_NAME" })).toEqual(expect.any(String));
  });
});
