// H6: the daemon's own HTTP surface refuses requests made through ctx.fetch.
import { createTestContext } from "plughive/pack/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PACK_MARKER_HEADER } from "../../../src/core/packs/context.js";
import { ADMIN_AUTH, type LiteHarness, bootLite, mockTool } from "../../http/harness.js";

const CSRF = { "x-plughive-csrf": "1" };

describe("pack marker header on the daemon's HTTP surface", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ packs: { demo: [mockTool("demo_echo", async (input) => input)] } });
  });
  afterEach(() => h.close());

  const marked = { [PACK_MARKER_HEADER]: "evil" };
  const refused = async (res: Response) => {
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "PACK_REQUEST_REFUSED" } });
  };

  it("refuses /mcp, /p/<id>/mcp, /api/profiles and /setup when the marker is present", async () => {
    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const post = { method: "POST", body: rpc } as const;
    const json = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    await refused(await fetch(`${h.base}/mcp`, { ...post, headers: { ...json, ...marked } }));
    await refused(
      await fetch(`${h.base}/p/default/mcp`, { ...post, headers: { ...json, ...marked } }),
    );
    await refused(await fetch(`${h.base}/api/profiles`, { headers: marked }));
    await refused(
      await fetch(`${h.base}/api/profiles/x`, {
        method: "PUT",
        headers: { ...CSRF, "content-type": "application/json", ...marked },
        body: JSON.stringify({ name: "X", mode: "list", include: [] }),
      }),
    );
    await refused(await fetch(`${h.base}/setup/secret?token=nope`, { headers: marked }));
    await refused(
      await fetch(`${h.base}/setup/secret`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...marked },
        body: "token=nope&value=v",
      }),
    );
    expect(h.profiles.get("x")).toBeFalsy();
    expect(h.secrets.size).toBe(0);
  });

  it("does not affect ordinary clients", async () => {
    const res = await fetch(`${h.base}/api/profiles`, { headers: ADMIN_AUTH });
    expect(res.status).toBe(200);
  });

  it("a pack with a localNetwork grant for the port is still refused by the daemon", async () => {
    // No daemonPorts on this host, so the context's self-port deny does not
    // apply: the request really goes out, carrying the marker, and the daemon
    // answers 403. The pack cannot strip or replace the marker.
    const t = createTestContext({
      manifest: {
        id: "sneaky",
        name: "Sneaky",
        version: "0.1.0",
        apiVersion: 1,
        entry: "./index.js",
        permissions: { localNetwork: [`127.0.0.1:${h.port}`] },
      },
    });
    try {
      await refused(await t.ctx.fetch(`${h.base}/api/profiles`));
      await refused(
        await t.ctx.fetch(`${h.base}/api/profiles`, { headers: { [PACK_MARKER_HEADER]: "" } }),
      );
      const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      await refused(
        await t.ctx.fetch(`${h.base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rpc,
        }),
      );
    } finally {
      await t.dispose();
    }
  });
});
