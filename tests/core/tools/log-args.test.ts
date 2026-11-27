// M5, L10: what the registry writes to the log about a call.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Redactor } from "../../../src/core/secrets/index.js";
import {
  type RegisteredTool,
  ToolRegistry,
  describeArgs,
  maskUrlCredentials,
  redactArgs,
} from "../../../src/core/tools/registry.js";

const CALLER_SECRET = "caller-supplied-value-9f3a";

const args = {
  prompt: `please use ${CALLER_SECRET}`,
  url: `https://bob:${CALLER_SECRET}@api.example.com/v1?page=2&api_key=${CALLER_SECRET}&X-Amz-Signature=${CALLER_SECRET}`,
  options: {
    headers: { Authorization: `Bearer ${CALLER_SECRET}`, accept: "json" },
    items: [{ password: CALLER_SECRET, name: "a" }],
  },
  token: CALLER_SECRET,
};

function capture() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg: string) =>
    lines.push({ level, obj, msg });
  return { lines, logger: { info: at("info"), warn: at("warn"), error: at("error") } };
}

const echo: RegisteredTool = {
  name: "echo",
  packId: "p",
  origin: "native",
  description: "echo",
  inputSchema: {},
  tags: [],
  requiresSecrets: [],
  longRunning: false,
  input: z.any(),
  run: async () => "done",
};

describe("logged tool arguments", () => {
  it("logs only names and sizes by default", async () => {
    const { lines, logger } = capture();
    const registry = new ToolRegistry({ logger, logArgs: false });
    registry.registerPack("p", [echo]);
    await registry.call("echo", args);
    const line = lines.find((l) => l.msg === "→ tool call");
    expect(JSON.stringify(lines)).not.toContain(CALLER_SECRET);
    expect(JSON.stringify(lines)).not.toContain("api.example.com");
    expect(line?.obj.args).toEqual({
      prompt: `string(${args.prompt.length})`,
      url: `string(${args.url.length})`,
      options: { headers: "object(2)", items: "array(1)" },
      token: `string(${CALLER_SECRET.length})`,
    });
  });

  it("follows PLUGHIVE_LOG_ARGS when the option is not given", async () => {
    const before = process.env.PLUGHIVE_LOG_ARGS;
    try {
      for (const [value, shown] of [
        [undefined, false],
        ["0", false],
        ["1", true],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, "PLUGHIVE_LOG_ARGS");
        else process.env.PLUGHIVE_LOG_ARGS = value;
        const { lines, logger } = capture();
        const registry = new ToolRegistry({ logger });
        registry.registerPack("p", [echo]);
        await registry.call("echo", { q: "visible words" });
        expect(JSON.stringify(lines).includes("visible words"), String(value)).toBe(shown);
      }
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "PLUGHIVE_LOG_ARGS");
      else process.env.PLUGHIVE_LOG_ARGS = before;
    }
  });

  it("with values on, masks secret-looking keys at every depth and URL credentials", async () => {
    const { lines, logger } = capture();
    const registry = new ToolRegistry({ logger, logArgs: true });
    registry.registerPack("p", [echo]);
    await registry.call("echo", { ...args, prompt: "a plain prompt" });
    const logged = lines.find((l) => l.msg === "→ tool call")?.obj.args as typeof args;
    expect(JSON.stringify(logged)).not.toContain(CALLER_SECRET);
    expect(logged.prompt).toBe("a plain prompt");
    expect(logged.url).toBe(
      "https://[redacted]@api.example.com/v1?page=2&api_key=[redacted]&X-Amz-Signature=[redacted]",
    );
    expect(logged.options).toEqual({
      headers: { Authorization: "[redacted]", accept: "json" },
      items: [{ password: "[redacted]", name: "a" }],
    });
    expect(logged.token).toBe("[redacted]");
  });

  it("redactArgs bounds depth, lists and long strings", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactArgs(deep))).toContain("[nested]");
    expect(redactArgs({ list: new Array(11).fill("x") })).toEqual({ list: "[array of 11]" });
    expect(redactArgs({ text: "y".repeat(300) })).toEqual({
      text: `${"y".repeat(200)}…(300 chars)`,
    });
    expect(describeArgs("a string")).toBe("string(8)");
    expect(describeArgs(undefined)).toBe("undefined");
  });

  it("redactArgs keeps a __proto__ key as a plain key, never as the copy's prototype", () => {
    const args = JSON.parse('{"__proto__":{"polluted":true,"apiKey":"k"},"a":1}');
    const out = redactArgs(args) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":true,"apiKey":"[redacted]"},"a":1}');
  });

  it("maskUrlCredentials leaves ordinary URLs and text alone", () => {
    expect(maskUrlCredentials("see https://example.com/a?b=1&page=2#x")).toBe(
      "see https://example.com/a?b=1&page=2#x",
    );
    expect(maskUrlCredentials("mail me at bob@example.com")).toBe("mail me at bob@example.com");
    expect(maskUrlCredentials("postgres://u:p@db.internal/x?sslmode=require&token=abc")).toBe(
      "postgres://[redacted]@db.internal/x?sslmode=require&token=[redacted]",
    );
  });
});

describe("tool results", () => {
  it("R2-L4: private paths are hidden in a success result, as in errors", async () => {
    const registry = new ToolRegistry({
      logger: capture().logger,
      logArgs: false,
      scrubPaths: (t) => t.split("/Users/someone").join("~"),
    });
    registry.registerPack("p", [
      {
        ...echo,
        name: "where",
        run: async () => ({
          path: "/Users/someone/.plughive/tools/ffmpeg",
          list: ["/Users/someone/a", 3, null],
          "/Users/someone/key": true,
        }),
      },
    ]);
    const out = await registry.call("where", {});
    expect(out).toEqual({
      ok: true,
      result: { path: "~/.plughive/tools/ffmpeg", list: ["~/a", 3, null], "~/key": true },
    });
  });
});

describe("logged errors", () => {
  it("a failing usage sink is logged with secrets redacted and paths hidden", async () => {
    const { lines, logger } = capture();
    const redactor = new Redactor();
    redactor.register("stored-secret-value-123");
    const registry = new ToolRegistry({
      logger,
      redactor,
      logArgs: false,
      scrubPaths: (t) => t.split("/Users/someone").join("~"),
      usage: {
        record() {
          throw new Error(
            "disk full at /Users/someone/.plughive/usage.db (stored-secret-value-123)",
          );
        },
      },
    });
    registry.registerPack("p", [echo]);
    await registry.call("echo", {});
    const line = lines.find((l) => l.msg === "usage record failed");
    expect(line?.obj.err).toBe("disk full at ~/.plughive/usage.db ([redacted])");
    expect(registry.safeMessage("x".repeat(2000))).toHaveLength(500);
  });
});
