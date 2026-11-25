// Parsers of each CLI's JSON output, fed the shapes the real CLIs printed
// (claude 2.1.331, codex 0.171.0, gemini 0.66.0, agy 1.5.15, opencode 2.3.0,
// copilot 1.0.92), trimmed to the fields that matter.
import { describe, expect, it } from "vitest";
import {
  CLIS,
  CliReportedError,
  MODEL_RE,
  parseAgy,
  parseClaude,
  parseCodex,
  parseCopilot,
  parseGemini,
  parseOpencode,
  readClaudeLogin,
  readCodexLogin,
  readVersion,
} from "../../../packs/cli-bridge/clis.js";
import { SAMPLES } from "./samples.js";

describe("CLI output parsers", () => {
  it("claude: result, session, cost and usage", () => {
    expect(parseClaude(SAMPLES.claude)).toEqual({
      text: "ok",
      session_id: "7d663a6c-fb8c-4c6b-8a55-614021014f66",
      cost_usd: 0.2355596,
      usage: { input_tokens: 2, output_tokens: 4, cached_input_tokens: 20958 },
    });
  });

  it("claude: an event array (--verbose) and reported errors", () => {
    const arr = JSON.stringify([{ type: "system" }, JSON.parse(SAMPLES.claude)]);
    expect(parseClaude(arr).text).toBe("ok");
    const err = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    expect(() => parseClaude(err)).toThrow(CliReportedError);
    expect(() => parseClaude(err)).toThrow("claude reported an error: Not logged in");
    expect(() =>
      parseClaude(JSON.stringify({ type: "result", subtype: "error_max_turns" })),
    ).toThrow(/error_max_turns/);
  });

  it("codex: last agent message, thread id and usage; turn.failed throws", () => {
    expect(parseCodex(SAMPLES.codex)).toEqual({
      text: "ok",
      session_id: "01a20f14-405d-7100-9e06-b34c586837c6",
      usage: {
        input_tokens: 25306,
        output_tokens: 5,
        cached_input_tokens: 13952,
        reasoning_tokens: 0,
      },
    });
    const failed = `${JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } })}\n`;
    expect(() => parseCodex(failed)).toThrow(/usage limit reached/);
    expect(() => parseCodex("")).toThrow(CliReportedError);
  });

  it("gemini: response, main-role model and summed usage; error throws", () => {
    expect(parseGemini(SAMPLES.gemini)).toEqual({
      text: "ok",
      session_id: "a59aa727-71b3-4c93-b03e-e0d5f6a96732",
      model: "gemini-3.8-flash",
      usage: {
        input_tokens: 25114,
        output_tokens: 26,
        cached_input_tokens: 0,
        reasoning_tokens: 768,
        total_tokens: 25908,
      },
    });
    const err = JSON.stringify({ error: { type: "Error", message: "quota exceeded", code: 1 } });
    expect(() => parseGemini(err)).toThrow(/quota exceeded/);
  });

  it("agy: response without the trailing newline, conversation id, usage; non-SUCCESS throws", () => {
    expect(parseAgy(SAMPLES.agy)).toEqual({
      text: "ok",
      session_id: "c0ffee00-0000-4000-8000-000000000001",
      usage: {
        input_tokens: 17399,
        output_tokens: 34,
        cached_input_tokens: 0,
        reasoning_tokens: 29,
        total_tokens: 17433,
      },
    });
    expect(() =>
      parseAgy(JSON.stringify({ status: "FAILED", response: "upstream error" })),
    ).toThrow(/FAILED: upstream error/);
  });

  it("opencode: text parts, session, tokens and cost; the error event throws", () => {
    expect(parseOpencode(SAMPLES.opencode)).toEqual({
      text: "ok",
      session_id: "ses_1",
      cost_usd: 0.0012,
      usage: { input_tokens: 900, output_tokens: 3, reasoning_tokens: 0, cached_input_tokens: 100 },
    });
    const err = [
      { type: "step_start", sessionID: "ses_2", part: {} },
      {
        type: "error",
        sessionID: "ses_2",
        error: { type: "provider.auth", message: "This API key has expired.", status: 401 },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    expect(() => parseOpencode(err)).toThrow(/API key has expired/);
  });

  it("copilot: assistant message, model, session and premium requests; a failed result throws", () => {
    expect(parseCopilot(SAMPLES.copilot)).toEqual({
      text: "ok",
      session_id: "s-123",
      model: "claude-sonnet-5",
      usage: { premium_requests: 1 },
    });
    expect(() => parseCopilot(JSON.stringify({ type: "result", exitCode: 1 }))).toThrow(
      /exit code 1/,
    );
  });

  it("garbage is a CliReportedError, not a crash", () => {
    for (const cli of Object.values(CLIS)) {
      expect(() => cli.parse("not json at all"), cli.id).toThrow(CliReportedError);
    }
  });
});

describe("sign-in and version readers", () => {
  it("claude auth status: only the loggedIn boolean counts", () => {
    expect(readClaudeLogin('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true);
    expect(readClaudeLogin('{"loggedIn":false}')).toBe(false);
    expect(readClaudeLogin("Logged in")).toBeNull();
  });

  it("codex login status", () => {
    expect(readCodexLogin("", "Logged in using ChatGPT\n", 0)).toBe(true);
    expect(readCodexLogin("Not logged in\n", "", 1)).toBe(false);
    expect(readCodexLogin("", "boom", 2)).toBeNull();
  });

  it("versions", () => {
    expect(readVersion("2.1.331 (Claude Code)\n")).toBe("2.1.331");
    expect(readVersion("codex-cli 0.171.0\n")).toBe("0.171.0");
    expect(readVersion("", "v1.5.15")).toBe("1.5.15");
    expect(readVersion("nothing")).toBeNull();
  });
});

describe("argv", () => {
  it("keeps a prompt that starts with - one token, in every CLI", () => {
    const p = "--dangerously-skip-permissions";
    for (const cli of Object.values(CLIS)) {
      const args = cli.askArgs(p, "m-1");
      const i = args.indexOf(p);
      if (i >= 0) expect(args[i - 1], cli.id).toBe("--");
      else
        expect(
          args.some((a) => a.endsWith(`=${p}`)),
          cli.id,
        ).toBe(true);
    }
  });

  it("glues the model to --model= and refuses one that could be a flag", () => {
    for (const cli of Object.values(CLIS)) {
      expect(cli.askArgs("hi", "gpt-5.5/x:y_z"), cli.id).toContain("--model=gpt-5.5/x:y_z");
      for (const bad of ["-x", "--dangerously-skip-permissions", "-c", "a b", "a=b", "x\n-y"]) {
        expect(() => cli.askArgs("hi", bad), `${cli.id} ${bad}`).toThrow(/model must start/);
      }
      expect(
        cli.askArgs("hi").some((a) => a.startsWith("--model")),
        cli.id,
      ).toBe(false);
    }
    expect(MODEL_RE.test("a".repeat(121))).toBe(false);
  });

  it("adds trust-skipping flags only in the pack's scratch folder", () => {
    const skip = ["--skip-trust", "--skip-git-repo-check", "--trust", "--yolo"];
    for (const cli of Object.values(CLIS)) {
      const user = cli.askArgs("hi", undefined, { scratch: false });
      expect(
        user.filter((a) => skip.includes(a)),
        cli.id,
      ).toEqual([]);
      expect(
        cli.askArgs("hi").filter((a) => skip.includes(a)),
        cli.id,
      ).toEqual([]);
    }
    expect(CLIS.gemini.askArgs("hi", undefined, { scratch: true })).toContain("--skip-trust");
    expect(CLIS.codex.askArgs("hi", undefined, { scratch: true })).toContain(
      "--skip-git-repo-check",
    );
  });
});
