// Shared preferences: the dashboard's language choice is kept by the daemon so
// the browser, the desktop window and the tray menu agree on it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPreferences } from "../../src/core/preferences.js";
import { type LiteHarness, adminFetch, bootLite } from "./harness.js";

const HEADERS = { "content-type": "application/json", "x-plughive-csrf": "1" };

describe("/api/preferences", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ policy: {}, packs: {} });
  });
  afterEach(async () => {
    await h.close();
  });

  const put = (body: unknown, headers: Record<string, string> = HEADERS) =>
    adminFetch(`${h.base}/api/preferences`, { method: "PUT", headers, body: JSON.stringify(body) });

  it("starts with no language chosen", async () => {
    const res = await adminFetch(`${h.base}/api/preferences`);
    expect(await res.json()).toEqual({ ok: true, preferences: { locale: null } });
  });

  it("saves the language to preferences.json, owner-only", async () => {
    const res = await put({ locale: "es" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, preferences: { locale: "es" } });
    expect(JSON.parse(readFileSync(join(h.home, "preferences.json"), "utf8"))).toEqual({
      locale: "es",
    });
    const again = (await (await adminFetch(`${h.base}/api/preferences`)).json()) as {
      preferences: { locale: string | null };
    };
    expect(again.preferences.locale).toBe("es");
    await put({ locale: null });
    expect(readPreferences(h.home).locale).toBeNull();
  });

  it("refuses a bad tag, unknown fields and a missing CSRF header", async () => {
    expect((await put({ locale: "../etc" })).status).toBe(400);
    expect((await put({ locale: "es", theme: "dark" })).status).toBe(400);
    expect((await put({ locale: "es" }, { "content-type": "application/json" })).status).toBe(403);
    expect(readPreferences(h.home).locale).toBeNull();
  });

  it("reads a broken or hand-edited file as defaults", async () => {
    writeFileSync(join(h.home, "preferences.json"), "{nope");
    expect(readPreferences(h.home)).toEqual({ locale: null });
    writeFileSync(join(h.home, "preferences.json"), JSON.stringify({ locale: 42, extra: 1 }));
    expect(readPreferences(h.home)).toEqual({ locale: null });
    writeFileSync(join(h.home, "preferences.json"), JSON.stringify({ locale: "pt-BR" }));
    expect(readPreferences(h.home)).toEqual({ locale: "pt-BR" });
  });
});
