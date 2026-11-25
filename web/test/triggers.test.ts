import { describe, expect, it } from "vitest";
import { EMPTY_TRIGGER, describeSchedule, lastRunState, triggerBody } from "../src/lib/triggers";

describe("triggerBody", () => {
  it("builds a cron trigger body", () => {
    const r = triggerBody({
      ...EMPTY_TRIGGER,
      name: " Morning ",
      workflow: "wf_digest",
      args: '{"topic":"news"}',
      catchUp: true,
    });
    expect(r).toEqual({
      body: {
        name: "Morning",
        kind: "cron",
        workflow: "wf_digest",
        args: { topic: "news" },
        schedule: "0 9 * * *",
        timezone: "local",
        catch_up: true,
      },
    });
  });

  it("builds a webhook trigger body with a callback", () => {
    const r = triggerBody({
      ...EMPTY_TRIGGER,
      kind: "webhook",
      name: "Hook",
      workflow: "wf_x",
      args: "",
      callback: "telegram",
      chatId: " 42 ",
    });
    expect(r).toEqual({
      body: {
        name: "Hook",
        kind: "webhook",
        workflow: "wf_x",
        args: {},
        use_body: true,
        callback: { type: "telegram", chat_id: "42" },
      },
    });
  });

  it("reports field problems", () => {
    const r = triggerBody({
      ...EMPTY_TRIGGER,
      schedule: "* * *",
      args: "[1]",
      callback: "webhook",
      callbackUrl: "ftp://x",
    });
    expect("issues" in r && Object.keys(r.issues).sort()).toEqual([
      "args",
      "callbackUrl",
      "name",
      "schedule",
      "workflow",
    ]);
    const bad = triggerBody({ ...EMPTY_TRIGGER, name: "a", workflow: "wf_a", args: "{" });
    expect("issues" in bad && bad.issues.args).toBe("This is not valid JSON.");
  });
});

describe("wording", () => {
  it("describes presets and raw expressions", () => {
    expect(describeSchedule({ schedule: "0 9 * * *", timezone: "local" })).toBe(
      "Every day at 09:00 (local time)",
    );
    expect(describeSchedule({ schedule: "5 4 * * sun", timezone: "UTC" })).toBe(
      "5 4 * * sun (UTC)",
    );
  });

  it("names the last run", () => {
    expect(lastRunState({ last_run: null })).toBeNull();
    expect(
      lastRunState({ last_run: { at: "", job_id: null, status: "skipped", error: null } })?.tone,
    ).toBe("warn");
    expect(
      lastRunState({ last_run: { at: "", job_id: "j", status: "started", error: null } })?.tone,
    ).toBe("ok");
  });
});
