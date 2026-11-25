// POST /api/admin/shutdown: how a supervisor stops the daemon where there is
// no SIGTERM (Windows). It needs the admin token and passes the CSRF rule.
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_AUTH, type LiteHarness, bootLite } from "./harness.js";

describe("POST /api/admin/shutdown", () => {
  let h: LiteHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("answers 202 and then calls onShutdown", async () => {
    let calls = 0;
    h = await bootLite({ packs: {}, onShutdown: () => void calls++ });
    const res = await fetch(`${h.base}/api/admin/shutdown`, {
      method: "POST",
      headers: { ...ADMIN_AUTH, "x-plughive-csrf": "1" },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  it("refuses without the admin token or without the CSRF header", async () => {
    let calls = 0;
    h = await bootLite({ packs: {}, onShutdown: () => void calls++ });
    const noAuth = await fetch(`${h.base}/api/admin/shutdown`, {
      method: "POST",
      headers: { "x-plughive-csrf": "1" },
    });
    expect(noAuth.status).toBe(401);
    const noCsrf = await fetch(`${h.base}/api/admin/shutdown`, {
      method: "POST",
      headers: ADMIN_AUTH,
    });
    expect(noCsrf.status).toBe(403);
    const crossSite = await fetch(`${h.base}/api/admin/shutdown`, {
      method: "POST",
      headers: { ...ADMIN_AUTH, origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });

  it("is not served when the app has no onShutdown", async () => {
    h = await bootLite({ packs: {} });
    const res = await fetch(`${h.base}/api/admin/shutdown`, {
      method: "POST",
      headers: { ...ADMIN_AUTH, "x-plughive-csrf": "1" },
    });
    expect(res.status).toBe(404);
  });
});
