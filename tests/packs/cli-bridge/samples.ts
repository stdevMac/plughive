// Output shapes the real CLIs printed (claude 2.1.331, codex 0.171.0, gemini 0.66.0,
// agy 1.5.15, opencode 2.3.0, copilot 1.0.92), trimmed to the fields that matter.
export const SAMPLES = {
  claude: JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    session_id: "7d663a6c-fb8c-4c6b-8a55-614021014f66",
    total_cost_usd: 0.2355596,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 28910,
      cache_read_input_tokens: 20958,
      output_tokens: 4,
    },
    modelUsage: { "claude-opus-5-5": { inputTokens: 2, outputTokens: 4 } },
  }),
  codex: [
    { type: "thread.started", thread_id: "01a20f14-405d-7100-9e06-b34c586837c6" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 25306,
        cached_input_tokens: 13952,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
  gemini: JSON.stringify(
    {
      session_id: "a59aa727-71b3-4c93-b03e-e0d5f6a96732",
      response: "ok",
      stats: {
        models: {
          "gemini-3.5-flash-lite": {
            tokens: {
              input: 873,
              prompt: 873,
              candidates: 25,
              total: 1437,
              cached: 0,
              thoughts: 539,
            },
            roles: { utility_router: {} },
          },
          "gemini-3.8-flash": {
            tokens: {
              input: 24241,
              prompt: 24241,
              candidates: 1,
              total: 24471,
              cached: 0,
              thoughts: 229,
            },
            roles: { main: {} },
          },
        },
        tools: { totalCalls: 0 },
      },
    },
    null,
    2,
  ),
  agy: JSON.stringify({
    conversation_id: "c0ffee00-0000-4000-8000-000000000001",
    status: "SUCCESS",
    response: "ok\n",
    duration_seconds: 3.69,
    num_turns: 1,
    usage: {
      input_tokens: 17399,
      output_tokens: 34,
      thinking_tokens: 29,
      cache_read_tokens: 0,
      total_tokens: 17433,
    },
  }),
  opencode: [
    { type: "step_start", sessionID: "ses_1", part: { sessionID: "ses_1", type: "step-start" } },
    { type: "text", sessionID: "ses_1", part: { type: "text", text: "ok" } },
    {
      type: "step_finish",
      sessionID: "ses_1",
      part: {
        type: "step-finish",
        cost: 0.0012,
        tokens: { input: 900, output: 3, reasoning: 0, cache: { read: 100, write: 0 } },
      },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
  copilot: [
    { type: "session.tools_updated", data: { model: "claude-sonnet-5" }, ephemeral: true },
    { type: "user.message", data: { content: "reply with the word ok" } },
    { type: "assistant.message", data: { model: "claude-sonnet-5", content: "ok" } },
    { type: "result", sessionId: "s-123", exitCode: 0, usage: { premiumRequests: 1 } },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n"),
};
