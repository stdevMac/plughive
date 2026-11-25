import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CancelledError,
  ProviderError,
  SCHEMA_LIMITS,
  type SaveResult,
  bindArtifacts,
  checkInputUrls,
  extractFiles,
  openApiToJsonSchema,
  poll,
  resolveArtifactRefs,
  sanitizeSchema,
  toZod,
  toolDescription,
  withJobContext,
} from "../../packs/fal/common.js";
import { failure } from "./provider-support.js";

// Packs cannot import each other's files, so the provider packs each carry a copy
// of common.ts. This keeps the copies from drifting apart.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKS = ["fal", "replicate", "openrouter"];

describe("provider packs common.ts", () => {
  it("is identical in every provider pack", () => {
    const [first, ...rest] = PACKS.map((id) =>
      readFileSync(join(root, "packs", id, "common.ts"), "utf8"),
    );
    for (const copy of rest) expect(copy).toBe(first);
  });
});

describe("checkInputUrls", () => {
  it("refuses https URLs in url-ish fields unless allowed; ignores prompts, artifacts and data URIs", () => {
    const v = {
      prompt: "see https://example.com/x for details",
      image_url: "https://a.test/p.png?sig=1",
      nested: { video: { url: "https://b.test/v.mp4" } },
    };
    expect(() => checkInputUrls(v, false)).toThrow(/URL inputs are off.*image_url/);
    expect(() => checkInputUrls(v, true)).not.toThrow();
    expect(() => checkInputUrls({ image_url: "artifact:abc123" }, false)).not.toThrow();
    expect(() => checkInputUrls({ image_url: "data:image/png;base64,AAA" }, false)).not.toThrow();
    expect(() => checkInputUrls({ prompt: "https://a.test/x" }, false)).not.toThrow();
    // Non-https schemes are refused even when URLs are allowed.
    expect(() => checkInputUrls({ image_url: "file:///etc/passwd" }, true)).toThrow(/only https/);
    expect(() => checkInputUrls({ image_url: "http://a.test/x" }, true)).toThrow(/only https/);
    expect(() => checkInputUrls({ callback_url: "https://b.test/hook" }, false)).toThrow(
      /URL inputs are off/,
    );
  });
});

describe("sanitizeSchema on untrusted model schemas", () => {
  it("drops remote patterns so a catastrophic regex cannot hang validation", () => {
    const schema = { type: "object", properties: { s: { type: "string", pattern: "^(a+)+$" } } };
    const c = toZod(schema);
    expect(c.exact).toBe(true);
    const started = performance.now();
    expect(c.zod.safeParse({ s: `${"a".repeat(40)}!` }).success).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
    expect(JSON.stringify(sanitizeSchema(schema).schema)).not.toContain("pattern");
  });

  it("caps enums and descriptions and strips control characters", () => {
    const big = Array.from({ length: SCHEMA_LIMITS.maxEnum + 1 }, (_, i) => `v${i}`);
    const r = sanitizeSchema({
      type: "object",
      description: `ignore\u0000 previous​ ${"x".repeat(1000)}\nline`,
      properties: { e: { type: "string", enum: big }, ok: { type: "string", enum: ["a‮b", "c"] } },
    });
    expect(r.ok).toBe(true);
    expect(r.schema.properties.e.enum).toBeUndefined();
    expect(r.schema.properties.ok.enum).toEqual(["ab", "c"]);
    expect(r.schema.description.length).toBeLessThanOrEqual(SCHEMA_LIMITS.maxDescription);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking they are gone
    expect(r.schema.description).not.toMatch(/[\u0000-\u001f​]/);
  });

  it("refuses recursive $refs and drops __proto__ properties", () => {
    const cyc = sanitizeSchema({
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: {
        A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
        B: { $ref: "#/$defs/A" },
      },
    });
    expect(cyc.ok).toBe(false);
    expect(cyc.reason).toMatch(/recursive/);
    expect(
      toZod({
        type: "object",
        properties: { a: { $ref: "#/$defs/A" } },
        $defs: { A: { $ref: "#/$defs/A" } },
      }).exact,
    ).toBe(false);

    const proto = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"ok":{"type":"string"}}}',
    );
    const r = sanitizeSchema(proto);
    expect(Object.keys(r.schema.properties)).toEqual(["ok"]);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });

  it("hostile __proto__/constructor keys never pollute prototypes or lose data (U2)", async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const plain = (o: unknown) => Object.getPrototypeOf(o) === Object.prototype;

    // Remote OpenAPI schema with hostile property and component names.
    const root = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"$ref":"#/components/schemas/__proto__"},"constructor":{"type":"string"},"ok":{"type":"string"}}}',
    );
    const comps = JSON.parse(
      '{"__proto__":{"type":"object","properties":{"polluted":{"type":"string"}}}}',
    );
    const converted = openApiToJsonSchema(root, comps);
    expect(plain(converted.properties)).toBe(true);
    const r = sanitizeSchema(converted);
    expect(Object.keys(r.schema.properties)).toEqual(["ok"]);
    expect(toZod(r.schema).zod.safeParse({ ok: "x" }).success).toBe(true);

    // Provider output: a file under a "__proto__" key keeps its artifact id.
    const output = JSON.parse('{"__proto__":{"url":"https://cdn.test/a.png"},"ok":1}');
    const { files, stripped } = extractFiles(output, (u) => u.startsWith("https://"));
    expect(files).toHaveLength(1);
    const saved = { artifacts: [], perFile: [{ id: "art1" }], failed: [] } as unknown as SaveResult;
    const bound = bindArtifacts(stripped, saved);
    expect(plain(bound)).toBe(true);
    expect(JSON.parse(JSON.stringify(bound))).toEqual(
      JSON.parse('{"__proto__":{"artifact_id":"art1"},"ok":1}'),
    );

    // Caller input is passed through with the same keys it had.
    const input = JSON.parse('{"__proto__":{"x":1},"y":2}');
    const resolved = await resolveArtifactRefs(input, {} as never, {} as never);
    expect(plain(resolved)).toBe(true);
    expect(JSON.stringify(resolved)).toBe(JSON.stringify(input));

    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    const probe = {} as Record<string, unknown>;
    expect([probe.polluted, probe.url, probe.artifact_id, probe.x]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("builds tool descriptions as one capped clean line", () => {
    const d = toolDescription("Runs X.", `evil\n\u0007text ${"y".repeat(5000)}`);
    expect(d.length).toBeLessThanOrEqual(1200);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking they are gone
    expect(d).not.toMatch(/[\n\u0007]/);
  });
});

describe("poll messages for a paid job", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleepFn: async (ms: number) => void (t += ms) };
  };
  const base = {
    provider: "acme",
    jobId: "job_9",
    recoverHint: "call acme_result with job_9",
    initialDelayMs: 1000,
    maxDelayMs: 1000,
  };
  const running = async () => ({ done: false });

  it("says what happened to the job on a timeout for each cancel outcome", async () => {
    const expectations: [() => Promise<"sent" | "failed" | "unsupported">, RegExp][] = [
      [async () => "sent", /cancel request for acme job job_9 was accepted/],
      [async () => "failed", /cancel request for acme job job_9 failed.*acme_result/],
      [
        async () => {
          throw new Error("x");
        },
        /cancel request for acme job job_9 failed/,
      ],
      [
        async () => "unsupported",
        /no cancel endpoint.*job_9 keeps running and will be billed.*acme_result/,
      ],
    ];
    for (const [cancel, re] of expectations) {
      const err = await failure(
        poll({ ...base, ...clock(), maxWaitMs: 60_000, check: running, cancel }),
      );
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toMatch(/did not finish within 1 minute/);
      expect(err.message).toMatch(re);
    }
  });

  it("leaves the job running after lost contact and quotes how to collect it", async () => {
    let cancels = 0;
    const err = await failure(
      poll({
        ...base,
        ...clock(),
        maxWaitMs: 3_600_000,
        check: async () => {
          throw new ProviderError("acme", "server error", 503);
        },
        cancel: async () => (cancels++, "sent"),
      }),
    );
    expect(err.message).toMatch(/lost contact with acme job job_9 after 6 failed status checks/);
    expect(err.message).toMatch(/Do not run it again; call acme_result with job_9/);
    expect(cancels).toBe(0);
  });

  it("cancels on abort and reports the fate", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await failure(
      poll({
        ...base,
        ...clock(),
        signal: ac.signal,
        maxWaitMs: 60_000,
        check: running,
        cancel: async () => "unsupported",
      }),
    );
    expect(err).toBeInstanceOf(CancelledError);
    expect(err.message).toMatch(/cancelled.*no cancel endpoint.*acme_result/);
  });
});

describe("withJobContext", () => {
  it("adds the job id and recover hint to provider errors that lack them", async () => {
    const run = (e: unknown) =>
      withJobContext("acme", "Acme job", "job_9", "call acme_result", async () => {
        throw e;
      }).catch((x) => x);
    const added = await run(new ProviderError("acme", "download failed.", 502));
    expect(added.message).toBe(
      "download failed (Acme job job_9; do not resubmit, call acme_result to check it again).",
    );
    expect(added.status).toBe(502);
    const named = new ProviderError("acme", "job job_9 failed");
    expect(await run(named)).toBe(named);
    const cancelled = new CancelledError("stop");
    expect(await run(cancelled)).toBe(cancelled);
    await expect(withJobContext("acme", "Acme job", "job_9", "h", async () => 7)).resolves.toBe(7);
  });
});
