// A bundled workflow end to end over MCP: the real app with the media pack
// (copied from packs/media), the bundled workflows pack (packs/workflows) and a
// local chat provider pack that answers without a network. The client finds
// wf_issue_triage, dry-runs it (answered inline, nothing runs), then runs it as
// a task and reads the result through tasks/get. No paid provider is reached.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FullHarness, apiHeaders, bootFull } from "./full-harness.js";
import { TASK_CAPS, modernClient, rawModern, toolJson, until } from "./harness.js";

const KEY = "workflows-e2e-access-key-0123456789";
const AUTH = { authorization: `Bearer ${KEY}` };
const MEDIA_DIR = fileURLToPath(new URL("../../packs/media", import.meta.url));
const WORKFLOWS_DIR = fileURLToPath(new URL("../../packs/workflows", import.meta.url));

const VERDICT = {
  summary: "Saving a file crashes the editor",
  type: "bug",
  severity: "high",
  labels: ["bug"],
  components: ["editor"],
  missing_info: ["version"],
  reproducible: true,
  next_steps: ["reproduce on main"],
  reply_draft: "Thanks for the report. Which version are you on?",
};

// A chat provider that records what it was asked and answers with the verdict.
const TALKER = `export default (api) => api.definePack({
  providers: [
    api.defineProvider({
      capability: "chat",
      id: "talker",
      priority: 99,
      setupHint: "nothing to set up",
      isConfigured: async () => true,
      models: () => ["talker-1"],
      run: async (input) => {
        (globalThis.__talkerSeen ??= []).push(input);
        return { text: ${JSON.stringify(JSON.stringify(VERDICT))}, model: "talker-1", provider: "talker" };
      },
    }),
  ],
  tools: [],
});
`;

const seen = () =>
  ((globalThis as Record<string, unknown>).__talkerSeen ?? []) as Array<{
    messages: { role: string; content: string }[];
  }>;

describe("workflows end to end over MCP", () => {
  let h: FullHarness;

  beforeAll(async () => {
    let builtinDir = "";
    h = await bootFull({
      accessKey: KEY,
      // Every tool in tools/list; the default profile turns to search mode at this size.
      profiles: false,
      get builtinDir() {
        return builtinDir;
      },
      seed: (home) => {
        builtinDir = join(home, "..", "builtin");
        mkdirSync(join(builtinDir, "talker"), { recursive: true });
        cpSync(MEDIA_DIR, join(builtinDir, "media"), { recursive: true });
        cpSync(WORKFLOWS_DIR, join(builtinDir, "workflows"), { recursive: true });
        writeFileSync(
          join(builtinDir, "talker", "pack.json"),
          JSON.stringify({
            id: "talker",
            name: "Talker",
            version: "0.1.0",
            apiVersion: 1,
            entry: "./index.mjs",
            permissions: {},
          }),
        );
        writeFileSync(join(builtinDir, "talker", "index.mjs"), TALKER);
      },
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  it("the packs API lists the bundled workflows", async () => {
    const res = await fetch(`${h.base}/api/packs`, { headers: apiHeaders() });
    const body = JSON.stringify(await res.json());
    for (const name of ["issue_triage", "podcast_produce", "dub_localize", "brand_kit_from_url"]) {
      expect(body).toContain(name);
    }
  });

  it("finds wf_issue_triage, dry-runs it inline, then runs it as a task", async () => {
    const c = await modernClient(h.base, { headers: AUTH });
    try {
      const tools = (await c.listTools()).tools;
      const triage = tools.find((t) => t.name === "wf_issue_triage");
      expect(triage).toBeDefined();
      expect(tools.filter((t) => t.name.startsWith("wf_")).length).toBe(7);
      expect((triage?.inputSchema.properties as Record<string, unknown>).dry_run).toBeDefined();

      const plan = toolJson(
        await c.callTool({
          name: "wf_issue_triage",
          arguments: { title: "Save crashes", body: "It crashes.", dry_run: true },
        }),
      );
      expect(plan.ok).toBe(true);
      expect(plan.result).toMatchObject({
        dry_run: true,
        ok: true,
        workflow: "wf_issue_triage",
        paid_calls_max: 1,
      });
      const steps = plan.result.steps as Array<{ id: string; runs: string }>;
      expect(steps.map((s) => [s.id, s.runs])).toEqual([
        ["fetch", "no"],
        ["triage", "yes"],
        ["report", "yes"],
      ]);
      expect(seen()).toEqual([]);
    } finally {
      await c.close();
    }

    const created = await rawModern(
      h.base,
      "tools/call",
      {
        name: "wf_issue_triage",
        arguments: {
          title: "Save crashes",
          body: "It crashes when I save.",
          labels: ["bug", "docs"],
        },
      },
      { capabilities: TASK_CAPS, headers: AUTH },
    );
    expect(created.status).toBe(200);
    expect(created.result).toMatchObject({ resultType: "task" });
    const taskId: string = created.result?.taskId;
    const done = await until(async () => {
      const reply = await rawModern(
        h.base,
        "tasks/get",
        { taskId },
        { capabilities: TASK_CAPS, headers: AUTH },
      );
      const status = reply.result?.status;
      if (status === "failed") throw new Error(JSON.stringify(reply.result));
      return status === "completed" ? reply.result : undefined;
    }, 10_000);
    const payload = JSON.parse(done.result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.result).toMatchObject({
      workflow: "wf_issue_triage",
      ok: true,
      paid_calls_max: 1,
      output: { triage: VERDICT, source: "pasted text" },
    });
    expect(payload.result.output.markdown).toContain("## Save crashes");
    expect(payload.result.output.markdown).toContain("- Severity: high");
    const statuses = (payload.result.steps as Array<{ id: string; status: string }>).map((s) => [
      s.id,
      s.status,
    ]);
    expect(statuses).toEqual([
      ["fetch", "skipped"],
      ["triage", "ok"],
      ["report", "ok"],
    ]);
    // The chat call went through the media pack's router to the local provider.
    expect(seen()).toHaveLength(1);
    const user = seen()[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(user).toContain("Allowed labels: bug, docs");
    expect(user).toContain("It crashes when I save.");
  });
});
