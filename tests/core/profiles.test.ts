import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PINNED_TOOLS,
  LIST_ALL_PROFILE,
  ProfileError,
  ProfileSchema,
  ProfileStore,
  estimateTokens,
  resolveExposure,
} from "../../src/core/profiles.js";
import type { RegisteredTool } from "../../src/core/tools/registry.js";
import { mockTool } from "../http/harness.js";
import { expectMode } from "../support/platform.js";

function tools(): RegisteredTool[] {
  return [
    mockTool("alpha_search", async () => 1, {
      packId: "alpha",
      tags: ["research"],
      capability: "web.search",
    }),
    mockTool("alpha_render", async () => 1, {
      packId: "alpha",
      longRunning: true,
      tags: ["workflow:video"],
    }),
    mockTool("beta_send", async () => 1, { packId: "beta" }),
    mockTool("up__remote", async () => 1, {
      packId: "gateway",
      origin: "mounted",
      tags: ["mount:up"],
    }),
  ];
}
const registry = { list: tools };
const profile = (input: Record<string, unknown>) =>
  ProfileSchema.parse({ id: "p1", name: "P1", ...input });
const names = (ts: Array<{ name: string }>) => ts.map((t) => t.name);

describe("resolveExposure", () => {
  it("list mode lists the selection; wait_for_job only with a job queue and a job producer", () => {
    const all = resolveExposure(profile({ mode: "list" }), registry, { jobs: true });
    expect(all.mode).toBe("list");
    expect(names(all.tools)).toEqual([
      "alpha_search",
      "alpha_render",
      "beta_send",
      "up__remote",
      "wait_for_job",
      "cancel_job",
    ]);
    expect(names(resolveExposure(profile({ mode: "list" }), registry).tools)).not.toContain(
      "wait_for_job",
    );
    const noJobs = resolveExposure(profile({ mode: "list", include: ["pack:beta"] }), registry, {
      jobs: true,
    });
    expect(names(noJobs.tools)).toEqual(["beta_send"]);
    const opted = resolveExposure(
      profile({ mode: "list", exclude: ["tool:wait_for_job"] }),
      registry,
      { jobs: true },
    );
    expect(names(opted.tools)).not.toContain("wait_for_job");
  });

  it("applies include minus exclude for every selector kind", () => {
    const pick = (include: string[], exclude: string[] = []) =>
      names(resolveExposure(profile({ mode: "list", include, exclude }), registry).exposed);
    expect(pick(["pack:alpha"])).toEqual(["alpha_search", "alpha_render"]);
    expect(pick(["tool:beta_send", "mount:up"])).toEqual(["beta_send", "up__remote"]);
    expect(pick(["mount:*"])).toEqual(["up__remote"]);
    expect(pick(["capability:web.search"])).toEqual(["alpha_search"]);
    expect(pick(["workflow:video"])).toEqual(["alpha_render"]);
    expect(pick(["tag:research"])).toEqual(["alpha_search"]);
    expect(pick(["*"], ["pack:alpha", "mount:*"])).toEqual(["beta_send"]);
    expect(pick([])).toEqual([]);
  });

  it("search mode lists the three meta tools, pinned exposed tools and wait_for_job", () => {
    const e = resolveExposure(
      profile({
        mode: "search",
        exclude: ["pack:beta"],
        pinned: ["alpha_render", "beta_send", "nope"],
      }),
      registry,
      { jobs: true },
    );
    expect(e.mode).toBe("search");
    expect(names(e.tools)).toEqual([
      "search_tools",
      "describe_tool",
      "execute_tool",
      "alpha_render",
      "wait_for_job",
      "cancel_job",
    ]);
    expect(names(e.exposed)).toEqual(["alpha_search", "alpha_render", "up__remote"]);
  });

  it("auto switches to search above the tool count or the token threshold", () => {
    expect(resolveExposure(profile({}), registry).mode).toBe("list");
    expect(resolveExposure(profile({ autoThresholdTools: 3 }), registry).mode).toBe("search");
    expect(resolveExposure(profile({ autoThresholdTools: 4 }), registry).mode).toBe("list");
    const e = resolveExposure(profile({ autoThresholdTokens: 10 }), registry);
    expect(e.mode).toBe("search");
    expect(e.directTokens).toBeGreaterThan(10);
  });

  it("estimates cost as characters / 4 per tool and in total", () => {
    const e = resolveExposure(profile({ mode: "list" }), registry);
    expect(e.cost.perTool).toHaveLength(e.tools.length);
    for (const [i, t] of e.tools.entries()) {
      expect(e.cost.perTool[i]).toEqual({
        name: t.name,
        tokens: Math.ceil(JSON.stringify(t).length / 4),
      });
      expect(estimateTokens(t)).toBe(e.cost.perTool[i]!.tokens);
    }
    expect(e.cost.totalTokens).toBe(e.cost.perTool.reduce((s, t) => s + t.tokens, 0));
    expect(e.directTokens).toBe(e.cost.totalTokens);
    expect(LIST_ALL_PROFILE.mode).toBe("list");
  });
});

describe("default pins", () => {
  it("pins that resolve to no exposed tool are ignored silently", () => {
    const pinned = profile({
      mode: "search",
      pinned: ["generate_image", "beta_send", "nope", "alpha_search"],
      exclude: ["tool:alpha_search"],
    });
    const exposure = resolveExposure(pinned, registry, { jobs: false });
    expect(names(exposure.tools)).toEqual([
      "search_tools",
      "describe_tool",
      "execute_tool",
      "beta_send",
    ]);
  });
});

describe("ProfileStore", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "profiles-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("starts with the default profile (auto, everything) and writes nothing until changed", () => {
    const store = new ProfileStore({ home });
    expect(store.list()).toEqual([
      {
        id: "default",
        name: "Default",
        mode: "auto",
        include: ["*"],
        exclude: [],
        pinned: [...DEFAULT_PINNED_TOOLS],
        autoThresholdTokens: 8000,
        autoThresholdTools: 40,
      },
    ]);
    expect(readdirSync(home)).toEqual([]);
  });

  it("persists atomically with mode 0600 and reloads", () => {
    const store = new ProfileStore({ home });
    store.put({ id: "media", name: "Media", mode: "list", include: ["pack:media"] });
    store.put({ id: "default", name: "Default", mode: "search", pinned: ["get_job_status"] });
    expect(readdirSync(home)).toEqual(["profiles.json"]);
    expectMode(join(home, "profiles.json"), 0o600);

    const again = new ProfileStore({ home });
    expect(again.get("media")).toMatchObject({
      mode: "list",
      include: ["pack:media"],
      exclude: [],
    });
    expect(again.get("default")).toMatchObject({ mode: "search", pinned: ["get_job_status"] });
    expect(again.delete("media")).toBe(true);
    expect(again.delete("media")).toBe(false);
    expect(new ProfileStore({ home }).get("media")).toBeUndefined();
  });

  it("L8: a corrupt entry is skipped with a warning and the file is backed up before any save", () => {
    const original = JSON.stringify({
      version: 1,
      profiles: [
        { id: "good", name: "Good", mode: "list", include: ["pack:media"] },
        { id: "bad", name: "Bad", mode: "sideways" },
        "not an object",
      ],
    });
    writeFileSync(join(home, "profiles.json"), original);
    const warn = vi.fn();
    const store = new ProfileStore({ home, logger: { warn } as never });
    expect(
      store
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["default", "good"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({
      backup: join(home, "profiles.json.corrupt"),
      skipped: [
        { index: 1, id: "bad" },
        { index: 2, id: null },
      ],
    });
    expect(readFileSync(join(home, "profiles.json.corrupt"), "utf8")).toBe(original);
    expectMode(join(home, "profiles.json.corrupt"), 0o600);
    // A save writes only what loaded; the original survives in the backup.
    store.put({ id: "next", name: "Next" });
    expect(readFileSync(join(home, "profiles.json"), "utf8")).not.toContain("sideways");
    expect(readFileSync(join(home, "profiles.json.corrupt"), "utf8")).toBe(original);
    expect(readdirSync(home).sort()).toEqual(["profiles.json", "profiles.json.corrupt"]);
  });

  it("L8: a file that is not JSON falls back to the default profile, backed up and logged", () => {
    writeFileSync(join(home, "profiles.json"), "{ half a file");
    const warn = vi.fn();
    const store = new ProfileStore({ home, logger: { warn } as never });
    expect(store.list().map((p) => p.id)).toEqual(["default"]);
    expect(warn.mock.calls[0]![0]).toMatchObject({ reason: "it is not valid JSON" });
    expect(readFileSync(join(home, "profiles.json.corrupt"), "utf8")).toBe("{ half a file");
  });

  it("rejects invalid profiles and leaves the file untouched", () => {
    const store = new ProfileStore({ home });
    const bad: unknown[] = [
      { id: "Bad", name: "x" },
      { id: "a", name: "x" },
      { id: "ok-id", name: "" },
      { id: "ok-id", name: "x", mode: "everything" },
      { id: "ok-id", name: "x", include: ["packs:media"] },
      { id: "ok-id", name: "x", include: ["pack:../../etc"] },
      { id: "ok-id", name: "x", pinned: ["a b"] },
      { id: "ok-id", name: "x", autoThresholdTools: 0 },
      { id: "ok-id", name: "x", surprise: true },
      "nope",
      null,
    ];
    for (const input of bad) {
      const err = (() => {
        try {
          store.put(input);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ProfileError);
      expect((err as ProfileError).code).toBe("INVALID_PROFILE");
    }
    expect(readdirSync(home)).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it("protects the default profile and caps the number of profiles", () => {
    const store = new ProfileStore({ home });
    expect(() => store.delete("default")).toThrowError(ProfileError);
    for (let i = 0; i < 63; i++) store.put({ id: `p-${i}`, name: `P ${i}` });
    expect(() => store.put({ id: "one-too-many", name: "x" })).toThrowError(/at most 64/);
    expect(store.put({ id: "p-0", name: "renamed" }).name).toBe("renamed");
  });

  it.each([
    ["not json", "{ nope"],
    ["wrong schema", JSON.stringify({ version: 1, profiles: [{ id: "BAD" }] })],
    ["wrong version", JSON.stringify({ version: 9, profiles: [] })],
  ])(
    "falls back to the default profile on a corrupt file (%s) and keeps a copy",
    (_label, body) => {
      writeFileSync(join(home, "profiles.json"), body);
      const warn = vi.fn();
      const store = new ProfileStore({ home, logger: { warn } });
      expect(store.list().map((p) => p.id)).toEqual(["default"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain("nope");
      expect(readFileSync(join(home, "profiles.json.corrupt"), "utf8")).toBe(body);
      // The next write replaces the corrupt file with a valid one.
      store.put({ id: "fresh", name: "Fresh" });
      expect(new ProfileStore({ home }).get("fresh")).toBeDefined();
    },
  );

  it("works in memory without a home", () => {
    const store = new ProfileStore();
    store.put({ id: "mem", name: "Mem" });
    expect(store.get("mem")?.mode).toBe("auto");
  });
});
