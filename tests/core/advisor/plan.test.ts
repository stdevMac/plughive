import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AdvisorSources,
  type Goal,
  SetupAdvisor,
  loadGoals,
  matchGoal,
} from "../../../src/core/advisor/plan.js";
import { loadCatalog } from "../../../src/core/installer/catalog.js";
import type { SoftwareView } from "../../../src/core/installer/installer.js";

const PACKS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packs");

const sw = (id: string, extra: Partial<SoftwareView> = {}): SoftwareView => ({
  id,
  name: id,
  summary: "",
  version: "1",
  license: "MIT",
  size_mb: 10,
  gated: false,
  homepage: `https://example.com/${id}`,
  tags: [],
  bins: [id],
  method: "archive",
  needs_approval: false,
  installed: false,
  managed: false,
  path: null,
  detected_version: null,
  ...extra,
});

function sources(
  over: Partial<{ [K in keyof AdvisorSources]: Awaited<ReturnType<AdvisorSources[K]>> }> = {},
): AdvisorSources {
  return {
    software: async () => over.software ?? [],
    packs: async () => over.packs ?? [],
    mounts: async () => over.mounts ?? [],
    capabilities: async () => over.capabilities ?? [],
  };
}

const keyPack = (id: string, secret: string, present = false, enabled = true) => ({
  id,
  name: id,
  enabled,
  state: "loaded",
  secrets: [{ name: secret, present }],
});

describe("goals.json", () => {
  const goals = loadGoals();
  it("has the goals, the original six first", () => {
    expect(goals.slice(0, 6).map((g) => g.id)).toEqual([
      "short-videos",
      "transcribe-meetings",
      "find-clients",
      "edit-images",
      "research-web",
      "automate-apps",
    ]);
    expect(goals.map((g) => g.id).sort()).toEqual([
      "automate-apps",
      "browse-sites",
      "edit-images",
      "find-clients",
      "maps-and-places",
      "market-data",
      "post-to-social",
      "research-web",
      "run-code-safely",
      "schedule-meetings",
      "send-emails-and-texts",
      "share-files",
      "short-videos",
      "transcribe-meetings",
      "use-ai-subscriptions",
    ]);
  });
  it("only names packs, keys and mounts that exist", () => {
    const pack = (id: string) =>
      JSON.parse(readFileSync(join(PACKS, id, "pack.json"), "utf8")) as {
        id: string;
        secrets?: { name: string }[];
        mounts?: { id: string }[];
      };
    const mounts = new Set((pack("mounts").mounts ?? []).map((m) => `mounts/${m.id}`));
    for (const g of goals)
      for (const s of g.steps)
        for (const o of s.options) {
          const where = `${g.id}: ${o.id}`;
          if (o.needs === "enable_pack") {
            expect(existsSync(join(PACKS, o.id, "pack.json")), where).toBe(true);
            expect(pack(o.id).id, where).toBe(o.id);
          } else if (o.needs === "key") {
            expect(existsSync(join(PACKS, o.pack as string, "pack.json")), where).toBe(true);
            const names = (pack(o.pack as string).secrets ?? []).map((x) => x.name);
            expect(names, where).toContain(o.id);
          } else if (o.needs === "login") {
            expect(mounts, where).toContain(o.id);
          }
        }
  });
  it("keeps match words unique across goals", () => {
    const seen = new Map<string, string>();
    for (const g of goals)
      for (const m of g.match) {
        expect(m, `${g.id}: "${m}" is lower case`).toBe(m.toLowerCase());
        expect(seen.get(m), `"${m}" in ${g.id} and ${seen.get(m)}`).toBeUndefined();
        seen.set(m, g.id);
      }
  });
  it("matches each goal by its id and title", () => {
    for (const g of goals) {
      expect(matchGoal(goals, g.id)?.id).toBe(g.id);
      expect(matchGoal(goals, g.title)?.id).toBe(g.id);
    }
  });
  it.each([
    ["send emails to my list", "send-emails-and-texts"],
    ["text message my customers by sms", "send-emails-and-texts"],
    ["find leads and send cold emails", "find-clients"],
    ["schedule posts on linkedin and instagram", "post-to-social"],
    ["book a meeting with a client", "schedule-meetings"],
    ["schedule meetings on my calendar", "schedule-meetings"],
    ["get stock prices and crypto", "market-data"],
    ["drive a web browser and take a screenshot", "browse-sites"],
    ["research the web", "research-web"],
    ["share files with a public link", "share-files"],
    ["run untrusted code in a sandbox", "run-code-safely"],
    ["directions between two addresses", "maps-and-places"],
    ["use my claude code and codex subscription", "use-ai-subscriptions"],
    ["automate my apps through zapier", "automate-apps"],
  ])("matches %j to %s", (text, id) => {
    expect(matchGoal(goals, text)?.id).toBe(id);
  });
  it("only names software the catalog has", () => {
    const ids = new Set(loadCatalog().items.map((e) => e.id));
    for (const g of goals)
      for (const s of g.steps)
        for (const o of s.options)
          if (o.needs === "install")
            for (const id of [o.id, ...(o.with ?? [])]) expect(ids, `${g.id}: ${id}`).toContain(id);
  });
  it("matches by id, title and words", () => {
    expect(matchGoal(goals, "transcribe-meetings")?.id).toBe("transcribe-meetings");
    expect(matchGoal(goals, "Edit images")?.id).toBe("edit-images");
    expect(matchGoal(goals, "I want subtitles for my meeting recordings")?.id).toBe(
      "transcribe-meetings",
    );
    expect(matchGoal(goals, "bake bread")).toBeNull();
    expect(matchGoal(goals, "   ")).toBeNull();
  });
});

describe("setup_plan", () => {
  it("returns null for an unknown goal", async () => {
    expect(await new SetupAdvisor(sources()).plan("bake bread")).toBeNull();
  });

  it("orders free and local options first, then free tier, then paid", async () => {
    const advisor = new SetupAdvisor(
      sources({
        software: [
          sw("ffmpeg"),
          sw("whisper.cpp"),
          sw("whisper-model-base", { size_mb: 148 }),
          sw("whisperx", { size_mb: 2500, needs_approval: true }),
        ],
        packs: [
          keyPack("openrouter", "OPENROUTER_API_KEY"),
          keyPack("gemini", "GEMINI_API_KEY"),
          keyPack("elevenlabs", "ELEVENLABS_API_KEY"),
        ],
      }),
    );
    const plan = await advisor.plan("transcribe meetings");
    expect(plan?.goal).toBe("transcribe-meetings");
    const speech = plan?.steps.find((s) => s.need === "Turn speech into text");
    // parakeet-mlx is not offered here (no software row), so it is dropped.
    expect(speech?.options.map((o) => o.id)).toEqual([
      "whisper.cpp",
      "whisperx",
      "GEMINI_API_KEY",
      "ELEVENLABS_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    expect(speech?.options.map((o) => o.cost_hint)).toEqual([
      "free, runs on this computer",
      "free, runs on this computer",
      "free tier, then paid",
      "free tier, then paid",
      "paid",
    ]);
    expect(speech?.options[0]?.how).toMatchObject({
      tool: "install_software",
      args: { id: "whisper.cpp" },
    });
    expect(speech?.options[1]?.needs_approval).toBe(true);
    expect(plan?.ready).toBe(false);
    // One pick per unmet required step, then the optional ones.
    expect(plan?.next.map((o) => o.id)).toEqual(["ffmpeg", "whisper.cpp", "GEMINI_API_KEY"]);
  });

  it("an install that needs a model too is done only when both are there", async () => {
    const plan = async (software: SoftwareView[]) =>
      (await new SetupAdvisor(sources({ software })).plan("transcribe meetings"))?.steps.find(
        (s) => s.need === "Turn speech into text",
      );
    const model = (installed: boolean) =>
      sw("whisper-model-base", { name: "Whisper base model", size_mb: 148, installed });
    // Neither: install whisper.cpp first, and say both are needed.
    let step = await plan([sw("whisper.cpp", { name: "whisper.cpp" }), model(false)]);
    expect(step?.done).toBe(false);
    expect(step?.options[0]).toMatchObject({
      id: "whisper.cpp",
      name: "whisper.cpp + Whisper base model",
      size_mb: 158,
      how: { tool: "install_software", args: { id: "whisper.cpp" } },
    });
    expect(step?.options[0]?.how.text).toContain("whisper.cpp and Whisper base model");
    // The program is there, the model is not: the model is next.
    step = await plan([sw("whisper.cpp", { installed: true }), model(false)]);
    expect(step?.done).toBe(false);
    expect(step?.options[0]).toMatchObject({
      size_mb: 148,
      how: { args: { id: "whisper-model-base" } },
    });
    // Both: the step is met.
    step = await plan([sw("whisper.cpp", { installed: true }), model(true)]);
    expect(step?.done).toBe(true);
    // No model entry offered here: the option is dropped rather than half shown.
    step = await plan([sw("whisper.cpp")]);
    expect(step?.options.map((o) => o.id)).not.toContain("whisper.cpp");
  });

  it("marks steps done by installed software, set keys or a configured provider", async () => {
    const advisor = new SetupAdvisor(
      sources({
        software: [sw("ffmpeg", { installed: true }), sw("whisper.cpp")],
        packs: [keyPack("gemini", "GEMINI_API_KEY", false)],
        capabilities: [
          { capability: "audio.transcribe", configured: true, pack: "elevenlabs", id: "scribe" },
        ],
      }),
    );
    const plan = await advisor.plan("transcribe-meetings");
    expect(plan?.steps[0]).toMatchObject({ done: true, done_by: "ffmpeg", options: [] });
    expect(plan?.steps[1]).toMatchObject({ done: true, done_by: "elevenlabs (scribe)" });
    expect(plan?.ready).toBe(true);
    expect(plan?.next.map((o) => o.id)).toEqual(["GEMINI_API_KEY"]);
  });

  it("does not count a key in a switched-off pack", async () => {
    const goals: Goal[] = [
      {
        id: "g",
        title: "G",
        summary: "s",
        match: ["g"],
        steps: [
          {
            need: "key",
            options: [
              { needs: "key", id: "K", pack: "p", cost: "free_tier", local: false, why: "w" },
            ],
          },
        ],
      },
    ];
    const off = await new SetupAdvisor(
      sources({ packs: [keyPack("p", "K", true, false)] }),
      goals,
    ).plan("g");
    expect(off?.steps[0]?.done).toBe(false);
    expect(off?.steps[0]?.options[0]?.how.text).toContain("Switch on");
    const on = await new SetupAdvisor(
      sources({ packs: [keyPack("p", "K", true, true)] }),
      goals,
    ).plan("g");
    expect(on?.ready).toBe(true);
  });

  it("points detect-only software at its official page", async () => {
    const advisor = new SetupAdvisor(
      sources({
        software: [
          sw("ffmpeg", { method: "link", install_url: "https://ffmpeg.org/download.html" }),
        ],
      }),
    );
    const plan = await advisor.plan("short videos");
    const ffmpeg = plan?.steps.flatMap((s) => s.options).find((o) => o.id === "ffmpeg");
    expect(ffmpeg?.how.tool).toBeUndefined();
    expect(ffmpeg?.how.url).toBe("https://ffmpeg.org/download.html");
  });

  it("plans every goal, offering every option when everything is available", async () => {
    const goals = loadGoals();
    const ids = (needs: string) =>
      new Set(
        goals.flatMap((g) => g.steps.flatMap((s) => s.options.filter((o) => o.needs === needs))),
      );
    const packIds = new Set<string>();
    const secrets = new Map<string, string[]>();
    for (const o of ids("key")) {
      packIds.add(o.pack as string);
      secrets.set(o.pack as string, [...(secrets.get(o.pack as string) ?? []), o.id]);
    }
    for (const o of ids("enable_pack")) packIds.add(o.id);
    const advisor = new SetupAdvisor(
      sources({
        software: [...new Set([...ids("install")].flatMap((o) => [o.id, ...(o.with ?? [])]))].map(
          (id) => sw(id),
        ),
        packs: [...packIds].map((id) => ({
          id,
          name: id,
          enabled: false,
          state: "disabled",
          secrets: (secrets.get(id) ?? []).map((name) => ({ name, present: false })),
        })),
        mounts: [...ids("login")].map((o) => ({
          id: o.id,
          name: o.id,
          enabled: false,
          connected: false,
          auth: "oauth",
          secrets: [],
        })),
      }),
    );
    for (const g of goals) {
      const plan = await advisor.plan(g.id);
      expect(plan?.goal).toBe(g.id);
      expect(plan?.ready, g.id).toBe(false);
      for (const [i, s] of g.steps.entries())
        expect(plan?.steps[i]?.options.length, `${g.id}: ${s.need}`).toBe(s.options.length);
      expect(plan?.next.length, g.id).toBe(g.steps.length);
    }
  });

  it("offers the app gateways for automate-apps and cli-bridge for subscriptions", async () => {
    const advisor = new SetupAdvisor(
      sources({
        software: [sw("claude", { installed: true })],
        packs: [
          { id: "cli-bridge", name: "Agent CLIs", enabled: false, state: "disabled", secrets: [] },
        ],
        mounts: ["composio", "pipedream", "zapier"].map((id) => ({
          id: `mounts/${id}`,
          name: id,
          enabled: false,
          connected: false,
          auth: "oauth",
          secrets: [],
        })),
      }),
    );
    const apps = await advisor.plan("automate my apps");
    const connect = apps?.steps.find((s) => s.need === "Connect the apps you use");
    expect(connect?.options.map((o) => o.id)).toEqual([
      "mounts/composio",
      "mounts/pipedream",
      "mounts/zapier",
    ]);
    expect(connect?.options[0]?.how.text).toMatch(/sign in/);
    const subs = await advisor.plan("use my AI subscriptions");
    expect(subs?.steps[0]).toMatchObject({ done: true, done_by: "claude" });
    expect(subs?.next.map((o) => o.id)).toEqual(["cli-bridge"]);
    expect(subs?.next[0]?.how.text).toBe("Switch on the Agent CLIs pack.");
  });

  it("still plans when a source fails", async () => {
    const advisor = new SetupAdvisor({
      ...sources(),
      software: async () => {
        throw new Error("probe failed");
      },
    });
    const plan = await advisor.plan("edit images");
    expect(plan?.goal).toBe("edit-images");
  });
});
