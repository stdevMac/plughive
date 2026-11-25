import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dockerRun } from "../../../packs/sandbox/docker.js";
import { connectFrame, parseFrames } from "../../../packs/sandbox/e2b.js";
import sandboxPack from "../../../packs/sandbox/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { fakeCtx, jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = { E2B_API_KEY: "e2b_secret_123", DAYTONA_API_KEY: "dtn_secret_456" };
const TOKEN = "envd_token_789";
const VALUES = [...Object.values(SECRETS), TOKEN];

const CONNECT = {
  match: /POST https:\/\/api\.e2b\.app\/v2\/sandboxes\/sb1\/connect$/,
  reply: () => jsonResponse({ sandboxID: "sb1", envdAccessToken: TOKEN, domain: "e2b.app" }, 201),
};

function stream(...messages: { flags?: number; message: unknown }[]): Response {
  const parts = messages.map((m) => {
    const f = connectFrame(m.message);
    f[0] = m.flags ?? 0;
    return f;
  });
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
  return new Response(body, { headers: { "content-type": "application/connect+json" } });
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("sandbox pack", () => {
  it("marks billable and code-running tools as destructive", () => {
    expect(toolNames(sandboxPack)).toEqual([
      "sandbox_create",
      "sandbox_run_command",
      "sandbox_run_code",
      "sandbox_write_file",
      "sandbox_read_file",
      "sandbox_destroy",
      "docker_run",
    ]);
    for (const n of [
      "sandbox_create",
      "sandbox_run_command",
      "sandbox_run_code",
      "sandbox_destroy",
      "docker_run",
    ]) {
      expect(toolOf(sandboxPack, n).annotations?.destructiveHint, n).toBe(true);
    }
  });

  it("round-trips Connect envelopes", () => {
    const frames = parseFrames(connectFrame({ a: 1 }));
    expect(frames).toEqual([{ flags: 0, message: { a: 1 } }]);
  });

  it("creates an E2B sandbox", async () => {
    const fetch = routerFetch([
      {
        match: /POST https:\/\/api\.e2b\.app\/v2\/sandboxes$/,
        reply: () => jsonResponse({ sandboxID: "sb1", templateID: "base" }, 201),
      },
    ]);
    const h = harness(sandboxPack, "sandbox", "sandbox_create", { secrets: SECRETS, fetch });
    const out = await h.call({ provider: "e2b", timeout_s: 300 });
    expect(out).toEqual({ provider: "e2b", sandbox_id: "sb1", template: "base", timeout_s: 300 });
    expect(fetch.calls[0]!.headers["x-api-key"]).toBe(SECRETS.E2B_API_KEY);
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({ templateID: "base", timeout: 300 });
    expectNoSecrets(out, VALUES);
  });

  it("runs an E2B command over the envd Connect stream", async () => {
    const fetch = routerFetch([
      CONNECT,
      {
        match: /POST https:\/\/49983-sb1\.e2b\.app\/process\.Process\/Start$/,
        reply: () =>
          stream(
            { message: { event: { start: { pid: 7 } } } },
            { message: { event: { data: { stdout: b64("hello\n") } } } },
            { message: { event: { data: { stderr: b64("warn\n") } } } },
            { message: { event: { end: { exitCode: 3, exited: true } } } },
            { flags: 2, message: {} },
          ),
      },
    ]);
    const h = harness(sandboxPack, "sandbox", "sandbox_run_command", {
      secrets: SECRETS,
      fetch,
    });
    const out = await h.call({ provider: "e2b", sandbox_id: "sb1", command: "echo hello" });
    expect(out).toEqual({ exit_code: 3, stdout: "hello\n", stderr: "warn\n" });
    const start = fetch.calls[1]!;
    expect(start.headers["x-access-token"]).toBe(TOKEN);
    expect(start.headers["content-type"]).toBe("application/connect+json");
    expectNoSecrets(out, VALUES);
  });

  it("scrubs the envd token from E2B stream errors", async () => {
    const fetch = routerFetch([
      CONNECT,
      {
        match: /process\.Process\/Start$/,
        reply: () =>
          stream({ flags: 2, message: { error: { code: "internal", message: `bad ${TOKEN}` } } }),
      },
    ]);
    const h = harness(sandboxPack, "sandbox", "sandbox_run_command", {
      secrets: SECRETS,
      fetch,
    });
    const err = await failure(h.call({ provider: "e2b", sandbox_id: "sb1", command: "x" }));
    expect((err as Error).message).toContain("E2B");
    expectNoSecrets(err, VALUES);
  });

  it("writes and reads E2B files with signed URLs", async () => {
    const fetch = routerFetch([
      { ...CONNECT, times: 2 },
      {
        method: "POST",
        match: /https:\/\/49983-sb1\.e2b\.app\/files\?/,
        reply: () => jsonResponse([{ path: "/home/user/a.txt" }]),
      },
      {
        method: "GET",
        match: /https:\/\/49983-sb1\.e2b\.app\/files\?/,
        reply: () => new Response("result text", { headers: { "content-type": "text/plain" } }),
      },
    ]);
    const w = harness(sandboxPack, "sandbox", "sandbox_write_file", { secrets: SECRETS, fetch });
    const wrote = await w.call({
      provider: "e2b",
      sandbox_id: "sb1",
      path: "/home/user/a.txt",
      content: "hi",
    });
    expect(wrote).toEqual({ path: "/home/user/a.txt", bytes: 2 });
    const url = new URL(fetch.calls[1]!.url);
    expect(url.searchParams.get("signature")).toMatch(/^v1_/);
    expect(url.searchParams.get("username")).toBe("user");
    expect(fetch.calls[1]!.url).not.toContain(TOKEN);

    const r = harness(sandboxPack, "sandbox", "sandbox_read_file", { secrets: SECRETS, fetch });
    const out = await r.call({
      provider: "e2b",
      sandbox_id: "sb1",
      path: "/home/user/a.txt",
      save_to_library: true,
    });
    expect(out).toMatchObject({ path: "/home/user/a.txt", bytes: 11, text: "result text" });
    expect(r.t.library?.all()).toHaveLength(1);
    expectNoSecrets(out, VALUES);
  });

  it("refuses an E2B domain outside e2b.app", async () => {
    const fetch = routerFetch([
      {
        match: /connect$/,
        reply: () => jsonResponse({ envdAccessToken: TOKEN, domain: "evil.example.com" }),
      },
    ]);
    const h = harness(sandboxPack, "sandbox", "sandbox_run_command", {
      secrets: SECRETS,
      fetch,
    });
    const err = await failure(h.call({ provider: "e2b", sandbox_id: "sb1", command: "x" }));
    expect((err as Error).message).toContain("unexpected sandbox domain");
  });

  it("destroys an E2B sandbox, treating 404 as already gone", async () => {
    const fetch = routerFetch([
      {
        match: /DELETE https:\/\/api\.e2b\.app\/sandboxes\/sb1$/,
        reply: () => new Response(null, { status: 404 }),
      },
    ]);
    const h = harness(sandboxPack, "sandbox", "sandbox_destroy", { secrets: SECRETS, fetch });
    expect(await h.call({ provider: "e2b", sandbox_id: "sb1" })).toEqual({
      provider: "e2b",
      sandbox_id: "sb1",
      destroyed: false,
    });
  });

  it("creates a Daytona sandbox and runs a command through the toolbox", async () => {
    const started = {
      id: "dt1",
      state: "started",
      autoStopInterval: 15,
      toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox",
    };
    const fetch = routerFetch([
      {
        match: /POST https:\/\/app\.daytona\.io\/api\/sandbox$/,
        reply: () => jsonResponse(started),
      },
      {
        match: /GET https:\/\/app\.daytona\.io\/api\/sandbox\/dt1$/,
        reply: () => jsonResponse(started),
      },
      {
        match: /POST https:\/\/proxy\.app\.daytona\.io\/toolbox\/dt1\/process\/execute$/,
        reply: () => jsonResponse({ exitCode: 0, result: "ok\n" }),
      },
    ]);
    const c = harness(sandboxPack, "sandbox", "sandbox_create", { secrets: SECRETS, fetch });
    const created = await c.call({ provider: "daytona" });
    expect(created).toMatchObject({ provider: "daytona", sandbox_id: "dt1", ready: true });
    expect(JSON.parse(fetch.calls[0]!.body!)).toMatchObject({ autoStopInterval: 15 });
    expect(fetch.calls[0]!.headers.authorization).toBe(`Bearer ${SECRETS.DAYTONA_API_KEY}`);

    const r = harness(sandboxPack, "sandbox", "sandbox_run_command", { secrets: SECRETS, fetch });
    const out = await r.call({
      provider: "daytona",
      sandbox_id: "dt1",
      command: "echo 'ok' | cat",
    });
    expect(out).toEqual({ exit_code: 0, stdout: "ok\n" });
    const sent = JSON.parse(fetch.calls[2]!.body!) as { command: string };
    const encoded = /echo (\S+) \|/.exec(sent.command)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString()).toBe("echo 'ok' | cat");
    expectNoSecrets(out, VALUES);
  });

  it("keeps Daytona toolbox calls on the proxy host", async () => {
    const fetch = routerFetch([
      {
        match: /GET https:\/\/app\.daytona\.io\/api\/sandbox\/dt1$/,
        reply: () =>
          jsonResponse({
            id: "dt1",
            state: "started",
            toolboxProxyUrl: "https://evil.example.com",
          }),
      },
      {
        match: /POST https:\/\/proxy\.app\.daytona\.io\/toolbox\/dt1\/process\/code-run$/,
        reply: () => jsonResponse({ exitCode: 0, result: "2\n" }),
      },
    ]);
    const h = harness(sandboxPack, "sandbox", "sandbox_run_code", { secrets: SECRETS, fetch });
    const out = await h.call({
      provider: "daytona",
      sandbox_id: "dt1",
      language: "python",
      code: "print(1+1)",
    });
    expect(out).toEqual({ exit_code: 0, stdout: "2\n" });
  });

  it("scrubs the Daytona key from API errors", async () => {
    const fetch = routerFetch([
      {
        match: /app\.daytona\.io\/api\/sandbox$/,
        reply: () => jsonResponse({ message: `invalid key ${SECRETS.DAYTONA_API_KEY}` }, 401),
      },
    ]);
    const h = harness(sandboxPack, "sandbox", "sandbox_create", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ provider: "daytona" }));
    expectNoSecrets(err, VALUES);
  });

  it("runs docker with no network, dropped capabilities and only a temp /work mount", async () => {
    let seen: readonly string[] = [];
    let workDir = "";
    const h = harness(sandboxPack, "sandbox", "docker_run", {
      spawn: async (bin, args) => {
        expect(bin).toBe("docker");
        seen = args;
        const mount = args[args.indexOf("-v") + 1]!;
        workDir = mount.slice(0, mount.lastIndexOf(":/work"));
        await writeFile(join(workDir, "out.txt"), "done");
        return { stdout: "ran\n", stderr: "", exitCode: 0, timedOut: false, truncated: false };
      },
    });
    const out = (await h.call({
      image: "python:3.12-slim",
      command: "python main.py > out.txt",
      files: { "main.py": "print('x')" },
      collect: ["out.txt"],
    })) as { exit_code: number; artifacts: { path: string }[] };
    expect(seen.slice(seen.indexOf("--network"), seen.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    expect(seen.join(" ")).toContain("--cap-drop ALL");
    expect(seen.join(" ")).toContain("--security-opt no-new-privileges");
    expect(seen.filter((a) => a === "-v")).toHaveLength(1);
    expect(workDir.startsWith(join(h.t.dataDir, "runs"))).toBe(true);
    expect(existsSync(workDir)).toBe(false);
    expect(out.exit_code).toBe(0);
    expect(out.artifacts.map((a) => a.path)).toEqual(["out.txt"]);
    expect(h.t.library?.all()).toHaveLength(1);
  });

  it("refuses images outside the allowlist and network unless allowed", async () => {
    const spawn = () => ({ stdout: "", stderr: "", exitCode: 0 });
    const h = harness(sandboxPack, "sandbox", "docker_run", { spawn });
    const bad = await failure(h.call({ image: "ubuntu:latest", command: "true" }));
    expect((bad as Error).message).toContain("allowedImages");
    const net = await failure(h.call({ image: "alpine:3.20", command: "true", network: true }));
    expect((net as Error).message).toContain("allowNetwork");
    expect(() =>
      h.tool.input.parse({ image: "alpine:3.20", command: "x", collect: ["../etc"] }),
    ).toThrow();
  });

  it("explains when docker is not installed", async () => {
    const h = harness(sandboxPack, "sandbox", "docker_run", {
      spawn: () => {
        throw Object.assign(new Error("not found"), { code: "not_installed" });
      },
    });
    const err = await failure(h.call({ image: "alpine:3.20", command: "true" }));
    expect((err as Error).message).toContain("docker is not installed");
  });

  it("runs the container as the daemon's own user, not root", async () => {
    let seen: readonly string[] = [];
    const h = harness(sandboxPack, "sandbox", "docker_run", {
      spawn: async (_bin, args) => {
        seen = args;
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
      },
    });
    await h.call({ image: "alpine:3.20", command: "id" });
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      const i = seen.indexOf("--user");
      expect(i).toBeGreaterThanOrEqual(0);
      expect(seen[i + 1]).toBe(`${process.getuid()}:${process.getgid()}`);
      expect(seen[seen.indexOf("--env") + 1]).toBe("HOME=/tmp");
    } else {
      expect(seen).not.toContain("--user");
    }
  });

  describe("collecting files the command left in /work", () => {
    // dockerRun is unit-tested directly (no docker): the fake spawn plays the
    // container and plants what the command would have left behind.
    let dataDir: string;
    let outside: string;
    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });
    const ctxWith = (plant: (work: string) => void) => {
      dataDir = mkdtempSync(join(tmpdir(), "docker-run-"));
      outside = mkdtempSync(join(tmpdir(), "host-"));
      writeFileSync(join(outside, "secret.txt"), "host secret");
      return fakeCtx({
        packId: "sandbox",
        dataDir,
        spawn: async (_bin, args) => {
          const mount = args[args.indexOf("-v") + 1]!;
          const work = mount.slice(0, mount.lastIndexOf(":/work"));
          plant(work);
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
        },
      });
    };
    const runCollect = (ctx: ReturnType<typeof fakeCtx>, collect: string[]) =>
      dockerRun(ctx, {
        image: "alpine:3.20",
        command: "whatever",
        network: false,
        timeoutS: 5,
        collect,
      });

    it("collects a regular file", async () => {
      const ctx = ctxWith((work) => writeFileSync(join(work, "out.txt"), "done"));
      const out = await runCollect(ctx, ["out.txt"]);
      expect(out.files).toEqual([{ path: "out.txt", bytes: new TextEncoder().encode("done") }]);
    });

    it("refuses a directory symlink inside /work that leads to host files", async () => {
      const ctx = ctxWith((work) => symlinkSync(outside, join(work, "root"), "dir"));
      await expect(runCollect(ctx, ["root/secret.txt"])).rejects.toThrow(
        /refusing to collect root\/secret\.txt/,
      );
    });

    it("refuses a leaf symlink pointing at a host file", async () => {
      const ctx = ctxWith((work) =>
        symlinkSync(join(outside, "secret.txt"), join(work, "out.txt")),
      );
      await expect(runCollect(ctx, ["out.txt"])).rejects.toThrow(/refusing to collect out\.txt/);
    });

    it("refuses a symlink planted in a subfolder on the way to the file", async () => {
      const ctx = ctxWith((work) => {
        mkdirSync(join(work, "sub"));
        symlinkSync(outside, join(work, "sub", "esc"));
      });
      await expect(runCollect(ctx, ["sub/esc/secret.txt"])).rejects.toThrow(
        /refusing to collect sub\/esc\/secret\.txt/,
      );
    });

    it("still reports a missing file and a directory plainly", async () => {
      const ctx = ctxWith((work) => {
        writeFileSync(join(work, "a.txt"), "a");
        mkdirSync(join(work, "dir"));
      });
      await expect(runCollect(ctx, ["nope.txt"])).rejects.toThrow(
        /no file nope\.txt in \/work after the run/,
      );
      await expect(runCollect(ctx, ["dir"])).rejects.toThrow(/no file dir in \/work after the run/);
      const ok = await runCollect(ctx, ["a.txt"]);
      expect(ok.files[0]?.path).toBe("a.txt");
    });
  });

  it("restricts the network to E2B and Daytona hosts", async () => {
    const h = harness(sandboxPack, "sandbox", "sandbox_create", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://e2b.app.evil.example.com/x");
  });

  it("reports MISSING_SECRET per provider", async () => {
    await expectMissingSecret([
      {
        tool: "sandbox_create",
        args: { provider: "e2b" },
        pack: "sandbox",
        secret: "E2B_API_KEY",
      },
      {
        tool: "sandbox_create",
        args: { provider: "daytona" },
        pack: "sandbox",
        secret: "DAYTONA_API_KEY",
      },
    ]);
  });
});
