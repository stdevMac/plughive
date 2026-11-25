// The cli-bridge pack end to end with fake CLIs: real processes started
// through the pack kernel (permissions.spawn, child env allowlist, cwd rules,
// timeout with process-tree kill, output cap).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { CapabilityError, type PackContext } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIS, CLI_IDS, type CliId } from "../../../packs/cli-bridge/clis.js";
import cliBridge, {
  FORBIDDEN_ENV,
  askCli,
  childEnv,
  claudeConfigDir,
  transcriptPrompt,
} from "../../../packs/cli-bridge/index.js";
import { describePosix, fakeBinary, itPosix, itSymlink } from "../../support/platform.js";
import { SAMPLES } from "./samples.js";

const PACK_DIR = resolve(__dirname, "../../../packs/cli-bridge");
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

/** A fake CLI: records argv, cwd and env next to itself, then acts on ./mode. */
function fakeCli(dir: string, name: CliId, out: string, exit = 0) {
  fakeBinary(
    dir,
    name,
    `const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const mode = fs.existsSync(path.join(dir, "mode")) ? fs.readFileSync(path.join(dir, "mode"), "utf8").trim() : "ok";
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(name)} + " 9.8.7\\n");
} else if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write('{"loggedIn":true,"authMethod":"claude.ai"}\\n');
} else if (args[0] === "login" && args[1] === "status") {
  process.stderr.write("Logged in using ChatGPT\\n");
} else {
  fs.writeFileSync(path.join(dir, ${JSON.stringify(name)} + ".call.json"),
    JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
  if (mode === "hang") {
    const c = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(dir, "grandchild.pid"), String(c.pid));
    setInterval(() => {}, 1000);
  } else if (mode === "flood") {
    process.stdout.write("x".repeat(300000));
  } else {
    if (mode === "image") fs.writeFileSync("image.png", Buffer.from(${JSON.stringify(PNG.toString("hex"))}, "hex"));
    if (mode === "symlink") fs.symlinkSync(path.join(dir, "outside.png"), "image.png");
    process.stdout.write(${JSON.stringify(out)});
    process.exitCode = ${exit};
  }
}
`,
  );
}

let bin: string;
let project: string;
let open: TestContext[];

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), "cli-bridge-bin-"));
  project = realpathSync(mkdtempSync(join(tmpdir(), "cli-bridge-project-")));
  open = [];
});
afterEach(async () => {
  for (const t of open) await t.dispose();
  rmSync(bin, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function harness(settings: Record<string, unknown> = {}) {
  const t = createTestContext({ packDir: PACK_DIR, settings, spawnPath: bin });
  open.push(t);
  return t;
}

// The pack lists its tools and providers as plain arrays.
function list<T>(v: readonly T[] | unknown): readonly T[] {
  if (!Array.isArray(v)) throw new Error("expected a static list");
  return v as readonly T[];
}
type Tools = typeof cliBridge.tools extends infer U ? Extract<U, readonly unknown[]> : never;
type Providers = typeof cliBridge.providers extends infer U
  ? Extract<U, readonly unknown[]>
  : never;
const TOOLS = list<Tools[number]>(cliBridge.tools);
const PROVIDERS = list<Providers[number]>(cliBridge.providers);

const toolNamed = (name: string) => {
  const tool = TOOLS.find((x) => x.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
};

async function callTool(t: TestContext, name: string, args: unknown) {
  const tool = toolNamed(name);
  const ctx = t.forTool(name, {});
  return tool.run(tool.input.parse(args), ctx as PackContext) as Promise<Record<string, unknown>>;
}

const lastCall = (name: CliId) =>
  JSON.parse(readFileSync(join(bin, `${name}.call.json`), "utf8")) as {
    args: string[];
    cwd: string;
    env: Record<string, string>;
  };

describe("pack manifest", () => {
  it("is opt-in, declares the CLIs and node, and shows a terms notice", () => {
    const t = harness();
    expect(t.manifest.enabledByDefault).toBe(false);
    expect([...(t.manifest.permissions.spawn ?? [])].sort()).toEqual([...CLI_IDS, "node"].sort());
    expect(t.manifest.notice).toMatch(/Anthropic/);
    expect(t.manifest.notice).toMatch(/OpenAI/);
    expect(t.manifest.notice).toMatch(/Google/);
    expect(t.manifest.notice).toMatch(/GitHub/);
    expect(t.manifest.notice).toMatch(/API key/i);
    expect(TOOLS.map((x) => x.name).sort()).toEqual([
      "ask_agent_cli",
      "generate_image_via_agy",
      "list_agent_clis",
    ]);
  });
});

describePosix("ask_agent_cli with fake CLIs", () => {
  for (const cli of CLI_IDS) {
    itPosix(`${cli}: parses its JSON output`, async () => {
      fakeCli(bin, cli, SAMPLES[cli]);
      const r = await callTool(harness(), "ask_agent_cli", { cli, prompt: "--foo", model: "m-1" });
      const { cli: id, duration_ms, ...answer } = r;
      expect(id).toBe(cli);
      expect(typeof duration_ms).toBe("number");
      expect(answer).toEqual(CLIS[cli].parse(SAMPLES[cli]));
      expect(answer.text).toBe("ok");
      const call = lastCall(cli);
      expect(call.args).toEqual(CLIS[cli].askArgs("--foo", "m-1", { scratch: true }));
      // The prompt is one token: after "--" or glued to its flag.
      const i = call.args.indexOf("--foo");
      if (i >= 0) expect(call.args[i - 1]).toBe("--");
      else expect(call.args.filter((a) => a.endsWith("=--foo"))).toHaveLength(1);
      expect(call.args).toContain("--model=m-1");
    });
  }

  itPosix("refuses a model that could be read as a flag, before running anything", async () => {
    fakeCli(bin, "claude", SAMPLES.claude);
    const t = harness();
    for (const model of ["-x", "--dangerously-skip-permissions"]) {
      await expect(
        callTool(t, "ask_agent_cli", { cli: "claude", prompt: "hi", model }),
      ).rejects.toThrow();
      await expect(
        askCli(t.forTool("ask_agent_cli") as PackContext, { cli: "claude", prompt: "hi", model }),
      ).rejects.toThrow(/model must start/);
    }
    expect(existsSync(join(bin, "claude.call.json"))).toBe(false);
  });

  itPosix("a CLI that reports an error fails with its message", async () => {
    const err = [
      { type: "step_start", sessionID: "s", part: {} },
      {
        type: "error",
        sessionID: "s",
        error: { type: "provider.auth", message: "This API key has expired." },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    fakeCli(bin, "opencode", err, 1);
    await expect(
      callTool(harness(), "ask_agent_cli", { cli: "opencode", prompt: "hi" }),
    ).rejects.toThrow(/API key has expired.*exit 1/);
  });

  itPosix("a CLI that is not installed says so", async () => {
    await expect(
      callTool(harness(), "ask_agent_cli", { cli: "gemini", prompt: "hi" }),
    ).rejects.toThrow(/Gemini CLI \(gemini\) was not found/);
  });

  itPosix("runs in a fresh scratch folder inside the data folder, removed afterwards", async () => {
    fakeCli(bin, "codex", SAMPLES.codex);
    const t = harness();
    await callTool(t, "ask_agent_cli", { cli: "codex", prompt: "hi" });
    const { cwd } = lastCall("codex");
    expect(cwd.startsWith(join(realpathSync(t.dataDir), "work"))).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });
});

describePosix("working folder rules", () => {
  itPosix("refuses an absolute cwd when no folder is allowed", async () => {
    fakeCli(bin, "claude", SAMPLES.claude);
    await expect(
      callTool(harness(), "ask_agent_cli", { cli: "claude", prompt: "hi", cwd: project }),
    ).rejects.toThrow();
    expect(existsSync(join(bin, "claude.call.json"))).toBe(false);
  });

  itPosix("refuses a cwd outside the allowed folders, and a relative one", async () => {
    fakeCli(bin, "claude", SAMPLES.claude);
    const t = harness({ allowedFolders: [join(project, "allowed")] });
    mkdirSync(join(project, "allowed"));
    await expect(
      callTool(t, "ask_agent_cli", { cli: "claude", prompt: "hi", cwd: project }),
    ).rejects.toThrow();
    await expect(
      callTool(t, "ask_agent_cli", { cli: "claude", prompt: "hi", cwd: "../.." }),
    ).rejects.toThrow(/absolute path/);
    expect(existsSync(join(bin, "claude.call.json"))).toBe(false);
  });

  itPosix("runs inside an allowed folder without any trust-skipping flag", async () => {
    fakeCli(bin, "gemini", SAMPLES.gemini);
    fakeCli(bin, "codex", SAMPLES.codex);
    const sub = join(project, "repo");
    mkdirSync(sub);
    const t = harness({ allowedFolders: [project] });
    for (const cli of ["gemini", "codex"] as const) {
      await callTool(t, "ask_agent_cli", { cli, prompt: "hi", cwd: sub });
      const call = lastCall(cli);
      expect(call.cwd).toBe(sub);
      expect(call.args).not.toContain("--skip-trust");
      expect(call.args).not.toContain("--skip-git-repo-check");
    }
    // ...while the scratch folder gets them.
    await callTool(t, "ask_agent_cli", { cli: "gemini", prompt: "hi" });
    expect(lastCall("gemini").args).toContain("--skip-trust");
    await callTool(t, "ask_agent_cli", { cli: "codex", prompt: "hi" });
    expect(lastCall("codex").args).toContain("--skip-git-repo-check");
  });
});

describePosix("child environment", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of FORBIDDEN_ENV) {
      saved[k] = process.env[k];
      process.env[k] = `secret-${k}`;
    }
  });
  afterEach(() => {
    for (const k of FORBIDDEN_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  itPosix("never carries the provider keys, even when the daemon has them", async () => {
    fakeCli(bin, "claude", SAMPLES.claude);
    fakeCli(bin, "codex", SAMPLES.codex);
    const t = harness({ claudeConfigDir: "~/.claude-other" });
    await callTool(t, "ask_agent_cli", { cli: "claude", prompt: "hi" });
    await callTool(t, "ask_agent_cli", { cli: "codex", prompt: "hi" });
    for (const cli of ["claude", "codex"] as const) {
      const { env } = lastCall(cli);
      for (const k of FORBIDDEN_ENV) expect(env[k], `${cli} ${k}`).toBeUndefined();
      expect(
        Object.values(env).some((v) => v.startsWith("secret-")),
        cli,
      ).toBe(false);
    }
    expect(lastCall("claude").env.CLAUDE_CONFIG_DIR).toMatch(/\.claude-other$/);
    expect(lastCall("codex").env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(lastCall("claude").env.USER).toBe(userInfo().username);
  });

  it("childEnv sets only the login name, and CLAUDE_CONFIG_DIR for claude", () => {
    expect(childEnv("claude", { claudeConfigDir: "/x/conf" }, "")).toEqual({
      CLAUDE_CONFIG_DIR: "/x/conf",
    });
    expect(childEnv("gemini", { claudeConfigDir: "/x/conf" }, "")).toEqual({});
    expect(childEnv("claude", {}, "")).toEqual({});
    expect(childEnv("codex", {}, "ann")).toEqual({ USER: "ann", LOGNAME: "ann" });
    expect(childEnv("codex", {}, "a b;rm")).toEqual({});
    expect(claudeConfigDir("~/c", "/home/u")).toBe("/home/u/c");
    expect(() => claudeConfigDir("relative/dir")).toThrow(/absolute/);
  });
});

describePosix("limits", () => {
  itPosix(
    "a timeout kills the CLI and the processes it started",
    async () => {
      fakeCli(bin, "claude", SAMPLES.claude);
      writeFileSync(join(bin, "mode"), "hang");
      const t = harness();
      await expect(
        askCli(t.forTool("ask_agent_cli") as PackContext, {
          cli: "claude",
          prompt: "hi",
          // Long enough for a busy machine to start node and the grandchild.
          timeout_s: 5,
        }),
      ).rejects.toThrow(/did not finish within 5 s/);
      const pid = Number(readFileSync(join(bin, "grandchild.pid"), "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive()).toBe(false);
    },
    30_000,
  );

  itPosix("output over the cap stops the CLI", async () => {
    fakeCli(bin, "codex", SAMPLES.codex);
    writeFileSync(join(bin, "mode"), "flood");
    await expect(
      callTool(harness({ maxOutputBytes: 65536 }), "ask_agent_cli", { cli: "codex", prompt: "hi" }),
    ).rejects.toThrow(/more than 65536 bytes/);
  });
});

describePosix("list_agent_clis", () => {
  itPosix("reports installed CLIs, versions and what the CLI says about sign-in", async () => {
    fakeCli(bin, "claude", SAMPLES.claude);
    fakeCli(bin, "codex", SAMPLES.codex);
    fakeCli(bin, "agy", SAMPLES.agy);
    const r = (await callTool(harness(), "list_agent_clis", {})) as {
      clis: {
        cli: string;
        installed: boolean;
        version: string | null;
        logged_in: boolean | null;
      }[];
    };
    const by = Object.fromEntries(r.clis.map((c) => [c.cli, c]));
    expect(by.claude).toMatchObject({ installed: true, version: "9.8.7", logged_in: true });
    expect(by.codex).toMatchObject({ installed: true, version: "9.8.7", logged_in: true });
    expect(by.agy).toMatchObject({ installed: true, version: "9.8.7", logged_in: null });
    expect(by.gemini).toMatchObject({ installed: false, version: null, logged_in: null });
    expect(r.clis).toHaveLength(CLI_IDS.length);
  });
});

describePosix("generate_image_via_agy", () => {
  const agyOut = JSON.stringify({
    conversation_id: "conv-1",
    status: "SUCCESS",
    response: "image.png\n",
  });

  itPosix("saves the image agy wrote, without edit-approving modes, and cleans up", async () => {
    fakeCli(bin, "agy", agyOut);
    writeFileSync(join(bin, "mode"), "image");
    const t = harness();
    const r = await callTool(t, "generate_image_via_agy", { prompt: "a red dot" });
    expect(r.session_id).toBe("conv-1");
    const items = t.library?.all() ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.mime).toBe("image/png");
    const call = lastCall("agy");
    expect(call.args).not.toContain("--mode");
    expect(call.args.some((a) => /accept-edits|auto|dangerously/.test(a))).toBe(false);
    expect(call.args).toContain("--sandbox");
    // The prompt text is interpolated into the agy prompt: it must never
    // expand as a /slash-command in print mode.
    expect(call.args).toContain("--disable-slash-commands");
    expect(call.cwd.startsWith(join(realpathSync(t.dataDir), "agy-images"))).toBe(true);
    expect(existsSync(call.cwd)).toBe(false);
  });

  itPosix("ignores a symlink and says what agy answered when no image was saved", async () => {
    fakeCli(bin, "agy", agyOut);
    writeFileSync(join(bin, "outside.png"), PNG);
    writeFileSync(join(bin, "mode"), "symlink");
    const t = harness();
    await expect(callTool(t, "generate_image_via_agy", { prompt: "x" })).rejects.toThrow(
      /agy saved no image\. agy answered: image\.png/,
    );
    expect(t.library?.all()).toHaveLength(0);
  });

  itSymlink("symlinks are possible here (sanity for the test above)", () => {
    const d = mkdtempSync(join(tmpdir(), "cli-bridge-ln-"));
    symlinkSync(join(d, "a"), join(d, "b"));
    rmSync(d, { recursive: true, force: true });
  });
});

describePosix("opt-in chat provider", () => {
  const provider = () => {
    const p = PROVIDERS[0];
    if (!p) throw new Error("no provider");
    return p;
  };

  it("is opt-in and unconfigured until chatCli is set", () => {
    expect(provider().optIn).toBe(true);
    expect(provider().capability).toBe("chat");
    expect(provider().isConfigured?.(harness().ctx)).toBe(false);
    expect(provider().isConfigured?.(harness({ chatCli: "codex" }).ctx)).toBe(true);
  });

  itPosix("answers through the chosen CLI", async () => {
    fakeCli(bin, "codex", SAMPLES.codex);
    const t = harness({ chatCli: "codex" });
    const out = (await provider().run(
      { messages: [{ role: "user", content: "hi" }] } as never,
      t.forTool("chat"),
    )) as Record<string, unknown>;
    expect(out).toMatchObject({
      text: "ok",
      provider: "cli-bridge",
      usage: { input_tokens: 25306 },
    });
  });

  itPosix("refuses a flag-like model without running the CLI", async () => {
    fakeCli(bin, "codex", SAMPLES.codex);
    const t = harness({ chatCli: "codex" });
    for (const model of ["-c", "--dangerously-bypass-approvals-and-sandbox"]) {
      const p = provider().run(
        { messages: [{ role: "user", content: "hi" }], model } as never,
        t.forTool("chat"),
      );
      await expect(p).rejects.toBeInstanceOf(CapabilityError);
      await expect(p).rejects.toMatchObject({ code: "BAD_INPUT", mayHaveCharged: false });
    }
    expect(existsSync(join(bin, "codex.call.json"))).toBe(false);
  });

  it("flattens a transcript into one prompt", () => {
    const p = transcriptPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect(p).toMatch(/Instructions:\nbe brief/);
    expect(p).toMatch(/User: a\n\nAssistant: b\n\nUser: c/);
  });

  // The chat provider's prompt carries untrusted text, so each CLI gets its
  // hard no-tools / read-only flags (verified against each CLI's --help).
  const NO_TOOLS_FLAGS: Record<CliId, string[]> = {
    claude: ["--restricted", "--tools", "", "--strict-mcp-config"],
    codex: ["--sandbox", "read-only"],
    gemini: ["--approval-mode", "plan"],
    agy: ["--mode", "plan", "--disable-slash-commands"],
    opencode: ["--agent", "plan"],
    copilot: ["--disable-builtin-mcps"],
  };

  it("chat-mode argv carries each CLI's hard no-tools flags", () => {
    for (const cli of CLI_IDS) {
      const args = CLIS[cli].askArgs("summarize this page", undefined, { noTools: true });
      for (const flag of NO_TOOLS_FLAGS[cli]) expect(args).toContain(flag);
      // The plain ask argv (ask_agent_cli) is unchanged: no restricting flags.
      const plain = CLIS[cli].askArgs("summarize this page", undefined, { scratch: true });
      for (const flag of NO_TOOLS_FLAGS[cli]) {
        if (flag === "") continue;
        expect(plain).not.toContain(flag);
      }
    }
  });

  itPosix("the chat provider runs the CLI with the restricting flags", async () => {
    for (const cli of CLI_IDS) {
      fakeCli(bin, cli, SAMPLES[cli]);
      const t = harness({ chatCli: cli });
      const p = PROVIDERS[0];
      if (!p) throw new Error("no provider");
      const out = (await p.run(
        { messages: [{ role: "user", content: "hi" }] } as never,
        t.forTool("chat"),
      )) as Record<string, unknown>;
      expect(out.provider).toBe("cli-bridge");
      const call = lastCall(cli);
      for (const flag of NO_TOOLS_FLAGS[cli]) expect(call.args).toContain(flag);
    }
  });
});
