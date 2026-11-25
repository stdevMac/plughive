// tests/packs/training.test.ts
//
// LoRA training on fal and Replicate: the request each tool sends, what it
// returns, its failures, and that the policy gate asks before every call
// whatever the spend policy says. All network calls are mocked.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { PackContext } from "plughive/pack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import falPack, { LORA_TRAINER } from "../../packs/fal/index.js";
import replicatePack, { DEFAULT_TRAINER } from "../../packs/replicate/index.js";
import { ApprovalStore } from "../../src/core/policy/approvals.js";
import { PolicyGate } from "../../src/core/policy/gate.js";
import { writePolicy } from "../../src/core/policy/policy.js";
import { runPreApproved } from "../../src/core/policy/run-context.js";
import { type RegisteredTool, ToolRegistry } from "../../src/core/tools/registry.js";
import { UsageLedger } from "../../src/lib/usage.js";
import {
  boundFetch,
  bytesResponse,
  findTool,
  memLibrary,
  packTools,
  routerFetch,
  tempDir,
} from "./provider-support.js";
import { fakeCtx, jsonResponse } from "./support.js";

const FAL_KEY = "fal-test-key-not-real";
const R8 = "r8_test_token_not_real";
const API = "https://api.replicate.com/v1";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const WEIGHTS = new Uint8Array([8, 0, 0, 0, 0, 0, 0, 0, 0x7b, 0x7d]);
const falCatalog = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fal", "fixtures", "model_flux_lora_fast_training.json"),
    "utf8",
  ),
);
const [TRAINER_ID, TRAINER_VERSION] = DEFAULT_TRAINER.split(":") as [string, string];

async function falSetup(fetch: PackContext["fetch"]) {
  const lib = memLibrary({ packId: "fal" });
  lib.put("zip1", "application/zip", ZIP);
  const base = fakeCtx({
    packId: "fal",
    dataDir: tempDir("plughive-fal-train-"),
    secrets: { FAL_KEY },
    settings: { models: "", allow_url_inputs: true },
    fetch,
    library: lib.library,
  });
  const { tools, ctx } = await packTools(falPack, base);
  (ctx as PackContext & { fal: { pollInitialMs: number } }).fal.pollInitialMs = 1;
  return { tools, lib, ctx: { ...ctx, fetch: boundFetch(fetch, ctx.signal) } as PackContext };
}

async function replicateSetup(fetch: PackContext["fetch"]) {
  const lib = memLibrary({ packId: "replicate" });
  lib.put("zip1", "application/zip", ZIP);
  const base = fakeCtx({
    packId: "replicate",
    dataDir: tempDir("plughive-replicate-train-"),
    secrets: { REPLICATE_API_TOKEN: R8 },
    settings: { models: "", allow_url_inputs: true },
    fetch,
    library: lib.library,
  });
  const { tools, ctx } = await packTools(replicatePack, base);
  (ctx as PackContext & { replicate: { pollInitialMs: number } }).replicate.pollInitialMs = 1;
  return { tools, ctx: { ...ctx, fetch: boundFetch(fetch, ctx.signal) } as PackContext };
}

const training = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "t1",
  model: TRAINER_ID,
  version: TRAINER_VERSION,
  status,
  output: null,
  error: null,
  logs: "",
  // Replicate's own links are ignored: the client uses the documented ones.
  urls: { get: "https://evil.example/t1", cancel: "https://evil.example/t1/cancel" },
  ...extra,
});

describe("fal_train_lora", () => {
  const base = `https://queue.fal.run/${LORA_TRAINER}/requests/req-9`;
  const routes = () => [
    {
      method: "GET",
      match: /^GET https:\/\/api\.fal\.ai\/v1\/models\?.*flux-lora-fast-training/,
      reply: () => jsonResponse(falCatalog),
    },
    { match: /^GET https:\/\/api\.fal\.ai\/v1\/models\/pricing/, reply: () => jsonResponse({}) },
    {
      method: "POST",
      match: /^POST https:\/\/queue\.fal\.run\/fal-ai\/flux-lora-fast-training$/,
      reply: () =>
        jsonResponse({
          request_id: "req-9",
          status_url: `${base}/status`,
          response_url: base,
          cancel_url: `${base}/cancel`,
        }),
    },
    { match: /\/status$/, reply: () => jsonResponse({ status: "COMPLETED" }) },
    {
      method: "GET",
      match: /requests\/req-9$/,
      reply: () =>
        jsonResponse({
          diffusers_lora_file: {
            url: "https://v3.fal.media/files/lora.safetensors",
            content_type: "application/octet-stream",
            file_name: "pytorch_lora_weights.safetensors",
          },
          config_file: {
            url: "https://v3.fal.media/files/config.json",
            content_type: "application/json",
          },
        }),
    },
    {
      match: /^GET https:\/\/v3\.fal\.media\/files\/lora/,
      reply: () => bytesResponse(WEIGHTS, "application/octet-stream"),
    },
    {
      match: /^GET https:\/\/v3\.fal\.media\/files\/config/,
      reply: () => bytesResponse(new TextEncoder().encode("{}"), "application/json"),
    },
  ];

  it("is paid and tagged to always ask", async () => {
    const { tools } = await falSetup(routerFetch([]));
    const t = findTool(tools, "fal_train_lora");
    expect(t.tags).toEqual(expect.arrayContaining(["paid", "approval"]));
    expect(t.longRunning).toBe(true);
  });

  it("submits the zip to the trainer and returns the LoRA link and files", async () => {
    const fetch = routerFetch(routes());
    const { tools, ctx } = await falSetup(fetch);
    const t = findTool(tools, "fal_train_lora");
    const input = t.input.parse({ images: "artifact:zip1", trigger_word: "MYDOG", steps: 800 });
    const out = (await t.run(input, ctx)) as any;

    const submit = fetch.calls.find((c) => c.method === "POST")!;
    expect(submit.headers.authorization).toBe(`Key ${FAL_KEY}`);
    const body = JSON.parse(submit.body!);
    expect(body.trigger_word).toBe("MYDOG");
    expect(body.steps).toBe(800);
    expect(body.images_data_url).toMatch(/^data:application\/zip;base64,/);
    expect(body.create_masks).toBeUndefined();

    expect(out.lora_url).toBe("https://v3.fal.media/files/lora.safetensors");
    expect(out.config_url).toBe("https://v3.fal.media/files/config.json");
    expect(out.trigger_word).toBe("MYDOG");
    expect(out.model).toBe(LORA_TRAINER);
    expect(out.artifacts).toHaveLength(2);
  });

  it("refuses images that are not an artifact or an https link", async () => {
    const { tools } = await falSetup(routerFetch([]));
    const t = findTool(tools, "fal_train_lora");
    for (const images of ["file:///etc/passwd", "http://example.com/a.zip", "artifact:../x"]) {
      expect(t.input.safeParse({ images }).success).toBe(false);
    }
  });
});

describe("replicate_train_lora", () => {
  const create = new RegExp(
    `^POST ${API.replace(/[./]/g, "\\$&")}/models/ostris/flux-dev-lora-trainer/versions/${TRAINER_VERSION}/trainings$`,
  );

  it("is paid and tagged to always ask", async () => {
    const { tools } = await replicateSetup(routerFetch([]));
    for (const name of ["replicate_train_lora"]) {
      expect(findTool(tools, name).tags).toEqual(expect.arrayContaining(["paid", "approval"]));
    }
    expect(findTool(tools, "replicate_get_training").tags ?? []).not.toContain("paid");
  });

  it("starts a training on the pinned trainer and returns the new version", async () => {
    let polls = 0;
    const fetch = routerFetch([
      { method: "POST", match: create, reply: () => jsonResponse(training("starting"), 201) },
      {
        method: "GET",
        match: /^GET https:\/\/api\.replicate\.com\/v1\/trainings\/t1$/,
        reply: () => {
          polls += 1;
          return jsonResponse(
            polls < 2
              ? training("processing", { logs: "flux_train:  40%|####" })
              : training("succeeded", {
                  output: {
                    version: `me/my-dog:${"a".repeat(64)}`,
                    weights: "https://replicate.delivery/xezq/abc/trained_model.tar",
                  },
                }),
          );
        },
      },
    ]);
    const { tools, ctx } = await replicateSetup(fetch);
    const t = findTool(tools, "replicate_train_lora");
    const input = t.input.parse({
      images: "artifact:zip1",
      destination: "me/my-dog",
      trigger_word: "MYDOG",
      steps: 1200,
      options: { lora_rank: 32, input_images: "https://ignored.example/x.zip" },
    });
    const out = (await t.run(input, ctx)) as any;

    const post = fetch.calls[0]!;
    expect(post.headers.authorization).toBe(`Bearer ${R8}`);
    const body = JSON.parse(post.body!);
    expect(body.destination).toBe("me/my-dog");
    expect(body.input.trigger_word).toBe("MYDOG");
    expect(body.input.steps).toBe(1200);
    expect(body.input.lora_rank).toBe(32);
    // The images argument wins over options, and a small zip goes inline.
    expect(body.input.input_images).toMatch(/^data:application\/zip;base64,/);

    expect(out.version).toBe(`me/my-dog:${"a".repeat(64)}`);
    expect(out.weights_url).toBe("https://replicate.delivery/xezq/abc/trained_model.tar");
    expect(out.training_id).toBe("t1");
    expect(out.destination).toBe("me/my-dog");
    expect(out.message).toContain("replicate_run");
    // Never polls the links Replicate returned, never downloads the weights.
    expect(fetch.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
    expect(fetch.calls.some((c) => c.url.includes("replicate.delivery"))).toBe(false);
  });

  it("explains a missing destination model", async () => {
    const fetch = routerFetch([
      { method: "POST", match: create, reply: () => jsonResponse({ detail: "Not found" }, 404) },
    ]);
    const { tools, ctx } = await replicateSetup(fetch);
    const t = findTool(tools, "replicate_train_lora");
    await expect(
      t.run(t.input.parse({ images: "https://example.com/d.zip", destination: "me/nope" }), ctx),
    ).rejects.toThrow(/me\/nope.*replicate\.com\/create/s);
  });

  it("reports a failed training with its id", async () => {
    const fetch = routerFetch([
      { method: "POST", match: create, reply: () => jsonResponse(training("starting"), 201) },
      {
        method: "GET",
        match: /\/v1\/trainings\/t1$/,
        reply: () => jsonResponse(training("failed", { error: "CUDA out of memory" })),
      },
    ]);
    const { tools, ctx } = await replicateSetup(fetch);
    const t = findTool(tools, "replicate_train_lora");
    await expect(
      t.run(t.input.parse({ images: "https://example.com/d.zip", destination: "me/dog" }), ctx),
    ).rejects.toThrow(/training t1 failed.*CUDA out of memory/s);
  });

  it("refuses an https training zip unless allow_url_inputs is on", async () => {
    const fetch = routerFetch([]);
    const base = fakeCtx({
      packId: "replicate",
      dataDir: tempDir("plughive-replicate-train-"),
      secrets: { REPLICATE_API_TOKEN: R8 },
      settings: { models: "" },
      fetch,
      library: memLibrary({ packId: "replicate" }).library,
    });
    const { tools, ctx } = await packTools(replicatePack, base);
    (ctx as PackContext & { replicate: { pollInitialMs: number } }).replicate.pollInitialMs = 1;
    const t = findTool(tools, "replicate_train_lora");
    await expect(
      t.run(
        t.input.parse({ images: "https://example.com/d.zip?sig=1", destination: "me/dog" }),
        ctx,
      ),
    ).rejects.toThrow(/URL inputs are off/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses an unpinned trainer before any network call", async () => {
    const fetch = routerFetch([]);
    const { tools, ctx } = await replicateSetup(fetch);
    const t = findTool(tools, "replicate_train_lora");
    const input = t.input.parse({
      images: "https://example.com/d.zip",
      destination: "me/dog",
      trainer: "ostris/flux-dev-lora-trainer",
    });
    await expect(t.run(input, ctx)).rejects.toThrow(/pinned/);
    expect(fetch.calls).toHaveLength(0);
    expect(
      t.input.safeParse({ images: "https://example.com/d.zip", destination: "me/dog:abc" }).success,
    ).toBe(false);
  });

  it("replicate_get_training checks one training without starting one", async () => {
    const fetch = routerFetch([
      {
        method: "GET",
        match: /\/v1\/trainings\/t1$/,
        reply: () => jsonResponse(training("processing")),
      },
    ]);
    const { tools, ctx } = await replicateSetup(fetch);
    const t = findTool(tools, "replicate_get_training");
    const out = (await t.run(t.input.parse({ training_id: "t1" }), ctx)) as any;
    expect(out.status).toBe("processing");
    expect(out.version).toBeNull();
    expect(fetch.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("training always asks first", () => {
  let home: string;
  let db: Database.Database;
  let ledger: UsageLedger;
  let approvals: ApprovalStore;
  let registry: ToolRegistry;
  let ran: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "plughive-train-policy-"));
    db = new Database(":memory:");
    ledger = new UsageLedger({ root: home });
    approvals = new ApprovalStore({ db });
    const gate = new PolicyGate({
      home,
      approvals,
      spend: ledger,
      baseUrl: "http://127.0.0.1:7777",
    });
    registry = new ToolRegistry({ gate });
    ran = 0;
    // The real tool definitions (tags, schema), with run replaced so nothing is called.
    const { tools } = await falSetup(routerFetch([]));
    const real = findTool(tools, "fal_train_lora");
    registry.registerPack("fal", [
      {
        ...real,
        packId: "fal",
        origin: "native",
        inputSchema: {},
        run: async () => {
          ran += 1;
          return { ok: true };
        },
      } as unknown as RegisteredTool,
    ]);
  });
  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const args = { images: "https://example.com/d.zip", trigger_word: "TOK" };

  it("asks under the default policy, then runs once approved", async () => {
    const out = await registry.call("fal_train_lora", args);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("APPROVAL_REQUIRED");
    expect(out.error.message).toMatch(/always needs approval/);
    expect(ran).toBe(0);
    approvals.decide(out.error.approval?.id as string, "approved", "test", 30 * 60_000);
    expect((await registry.call("fal_train_lora", args)).ok).toBe(true);
    expect(ran).toBe(1);
  });

  it("asks even with auto-approve and no caps", async () => {
    writePolicy(home, { version: 1, rules: { auto_approve_under_usd: 1000 } });
    const out = await registry.call("fal_train_lora", args);
    expect(out.ok ? null : out.error.code).toBe("APPROVAL_REQUIRED");
    expect(ran).toBe(0);
  });

  it("asks even inside an approved workflow run", async () => {
    const out = await runPreApproved(() => registry.call("fal_train_lora", args));
    expect(out.ok ? null : out.error.code).toBe("APPROVAL_REQUIRED");
    expect(ran).toBe(0);
  });

  it("a denied approval never runs it", async () => {
    const first = await registry.call("fal_train_lora", args);
    if (first.ok) throw new Error("expected an approval request");
    approvals.decide(first.error.approval?.id as string, "denied", "test", 30 * 60_000);
    const again = await registry.call("fal_train_lora", args);
    expect(again.ok).toBe(false);
    expect(ran).toBe(0);
  });
});
