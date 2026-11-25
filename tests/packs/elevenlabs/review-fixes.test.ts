// Regression tests for the ElevenLabs review findings. They run the pack through
// createTestContext, so library visibility, the network allow-list and the
// per-call signal binding of ctx.fetch behave like in the daemon.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PackContext } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import elevenPack from "../../../packs/elevenlabs/index.js";
import { clearModelCache, dub, getDub } from "../../../packs/elevenlabs/ops.js";
import { dubSchema, getDubSchema } from "../../../packs/elevenlabs/schemas.js";
import { toolNames, toolOf } from "../support.js";

const packDir = fileURLToPath(new URL("../../../packs/elevenlabs", import.meta.url));
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const SIGNED =
  "https://storage.googleapis.com/eleven-dubbing/p1/es/output.flac?X-Goog-Signature=abc";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const harnesses: TestContext[] = [];
afterEach(async () => {
  clearModelCache();
  for (const t of harnesses.splice(0)) await t.dispose();
});

/** A fetch that honours its abort signal the way the real one does. */
function harness(handler: (c: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const t = createTestContext({
    packDir,
    secrets: { ELEVENLABS_API_KEY: "sk_test0123456789abcdef0123456789abcdef0123" },
    fetch: async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const c: Seen = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      seen.push(c);
      return handler(c);
    },
  });
  harnesses.push(t);
  t.library?.seed({
    id: "a_fal",
    kind: "audio",
    mime: "audio/mpeg",
    bytes: "ID3",
    tool: "fal/fal_run",
  });
  return { t, seen };
}

async function toolCtx(
  t: TestContext,
  name: string,
  signal?: AbortSignal,
  withServices = true,
): Promise<PackContext> {
  const services = withServices ? ((await elevenPack.setup?.(t.ctx)) ?? {}) : {};
  return { ...t.forTool(name, signal ? { signal } : {}), ...services } as PackContext;
}

const input = { artifact_id: "a_fal", target_language: "es" };

describe("manifest", () => {
  it("allows the signed dubbing bucket host and reads any library artifact", () => {
    const m = JSON.parse(readFileSync(`${packDir}/pack.json`, "utf8"));
    expect(m.permissions.network).toContain("storage.googleapis.com");
    expect(m.permissions.library).toBe("full");
  });

  it("registers elevenlabs_get_dub", () => {
    expect(toolNames(elevenPack)).toContain("elevenlabs_get_dub");
  });
});

describe("elevenlabs_dub", () => {
  it("dubs an artifact another pack saved and downloads from the signed bucket", async () => {
    const { t, seen } = harness((c) => {
      if (c.method === "POST") return json({ project_id: "p1", language_ids: ["es"] });
      if (c.url === SIGNED) return new Response(new Uint8Array([7, 7]));
      return json({ status: "completed", outputs: { lossless_audio: SIGNED } });
    });
    const ctx = await toolCtx(t, "elevenlabs_dub");
    const out = await dub(dubSchema.parse(input), ctx, "elevenlabs_dub", { pollMs: 1 });
    expect(out.project_id).toBe("p1");
    const dl = seen.at(-1)!;
    expect(dl.url).toBe(SIGNED);
    expect(dl.headers["xi-api-key"]).toBeUndefined();
  });

  it("refuses a download link outside the pinned bucket path before fetching", async () => {
    const other = "https://storage.googleapis.com/someone-else/out.flac";
    const { t, seen } = harness((c) => {
      if (c.method === "POST") return json({ project_id: "p1", language_ids: ["es"] });
      return json({ status: "completed", outputs: { lossless_audio: other } });
    });
    const ctx = await toolCtx(t, "elevenlabs_dub");
    await expect(dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 })).rejects.toThrow(
      /outside storage\.googleapis\.com\/eleven-dubbing\/.*not fetched/,
    );
    expect(seen.some((c) => c.url === other)).toBe(false);
  });

  it("stops on a stale language and names the project", async () => {
    const { t } = harness((c) =>
      c.method === "POST"
        ? json({ project_id: "p9", language_ids: ["es"] })
        : json({ status: "stale" }),
    );
    const ctx = await toolCtx(t, "elevenlabs_dub");
    await expect(dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 })).rejects.toThrow(
      /p9.*stale.*Nothing new was started/,
    );
  });

  it("keeps polling through queued", async () => {
    let n = 0;
    const { t } = harness((c) => {
      if (c.method === "POST") return json({ project_id: "p1", language_ids: ["es"] });
      if (c.url === SIGNED) return new Response(new Uint8Array([1]));
      return json(
        n++ < 2
          ? { status: "queued" }
          : { status: "completed", outputs: { lossless_audio: SIGNED } },
      );
    });
    const ctx = await toolCtx(t, "elevenlabs_dub");
    await dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 });
    expect(n).toBe(3);
  });

  it("a timeout names the project and points at get_dub, not at a billed retry", async () => {
    const { t } = harness((c) =>
      c.method === "POST"
        ? json({ project_id: "p6", language_ids: ["es"] })
        : json({ status: "processing" }),
    );
    const ctx = await toolCtx(t, "elevenlabs_dub");
    const real = Date.now;
    let calls = 0;
    Date.now = () => (calls++ ? real() + 3_600_000 : real());
    try {
      const err = await dub(dubSchema.parse({ ...input, max_wait_seconds: 30 }), ctx, "t", {
        pollMs: 1,
      }).catch((e: Error) => e);
      expect(String(err)).toMatch(/p6.*still running.*billed.*elevenlabs_get_dub/);
      expect(String(err)).not.toMatch(/longer max_wait_seconds/);
    } finally {
      Date.now = real;
    }
  });

  it("sends the cleanup DELETE through the lifetime fetch after a cancel", async () => {
    const ac = new AbortController();
    const { t, seen } = harness((c) => {
      if (c.method === "DELETE") return json({});
      if (c.method === "POST") return json({ project_id: "p7", language_ids: ["es"] });
      ac.abort();
      return json({ status: "processing" });
    });
    const ctx = await toolCtx(t, "elevenlabs_dub", ac.signal);
    await expect(dub(dubSchema.parse(input), ctx, "t", { pollMs: 20 })).rejects.toThrow(
      /delete request for dubbing project p7 was sent.*still bills/,
    );
    expect(seen.find((c) => c.method === "DELETE")?.url).toBe(
      "https://api.elevenlabs.io/v1/dubbing/project/p7",
    );
  });

  it("says truthfully when the cleanup DELETE could not be sent", async () => {
    const ac = new AbortController();
    const { t, seen } = harness((c) => {
      if (c.method === "POST") return json({ project_id: "p8", language_ids: ["es"] });
      ac.abort();
      return json({ status: "processing" });
    });
    // No setup() services: only the per-call fetch, which refuses after the abort.
    const ctx = await toolCtx(t, "elevenlabs_dub", ac.signal, false);
    await expect(dub(dubSchema.parse(input), ctx, "t", { pollMs: 20 })).rejects.toThrow(
      /p8 could not be sent.*may finish and be billed/,
    );
    expect(seen.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("elevenlabs_dub survives a flaky status endpoint (M3)", () => {
  it("tolerates transient poll failures and finishes with one submission", async () => {
    let polls = 0;
    const { t, seen } = harness((c) => {
      if (c.method === "POST") return json({ project_id: "p1", language_ids: ["es"] });
      if (c.url === SIGNED) return new Response(new Uint8Array([1]));
      polls++;
      if (polls === 1) throw new TypeError("fetch failed");
      if (polls === 2) return json({ detail: "boom" }, 503);
      if (polls === 3) return new Response("<html>", { status: 200 });
      if (polls === 4) return json({}, 429);
      return json({ status: "completed", outputs: { lossless_audio: SIGNED } });
    });
    const ctx = await toolCtx(t, "elevenlabs_dub");
    const out = await dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 });
    expect(out.project_id).toBe("p1");
    expect(seen.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("on giving up, names the project and points at elevenlabs_get_dub", async () => {
    const { t, seen } = harness((c) => {
      if (c.method === "POST") return json({ project_id: "p5", language_ids: ["es"] });
      return json({}, 502);
    });
    const ctx = await toolCtx(t, "elevenlabs_dub");
    const err = await dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/p5.*5 status checks in a row failed.*elevenlabs_get_dub/);
    expect(String(err)).not.toMatch(/Retry shortly/);
    expect(seen.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(seen.filter((c) => c.method === "GET")).toHaveLength(5);
  });

  it("a final poll error (401) still names the project and get_dub", async () => {
    const { t } = harness((c) =>
      c.method === "POST" ? json({ project_id: "p4", language_ids: ["es"] }) : json({}, 401),
    );
    const ctx = await toolCtx(t, "elevenlabs_dub");
    await expect(dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 })).rejects.toThrow(
      /refused the API key.*p4.*elevenlabs_get_dub/,
    );
  });

  it("an odd language id at creation is re-read, not thrown away with the project", async () => {
    const { t } = harness((c) => {
      if (c.method === "POST") return json({ project_id: "p3", language_ids: ["../x"] });
      if (c.url.endsWith("/project/p3")) return json({ status: "dubbed", language_ids: ["es"] });
      if (c.url === SIGNED) return new Response(new Uint8Array([1]));
      return json({ status: "completed", outputs: { lossless_audio: SIGNED } });
    });
    const ctx = await toolCtx(t, "elevenlabs_dub");
    const out = await dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 });
    expect(out.project_id).toBe("p3");
  });

  it("a 5xx on submission warns that a project may exist instead of inviting a retry", async () => {
    const { t } = harness(() => json({}, 500));
    const ctx = await toolCtx(t, "elevenlabs_dub");
    const err = await dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/may have been created anyway.*elevenlabs_get_dub/);
    expect(String(err)).not.toMatch(/Retry shortly/);
  });

  it("a reply without a project id says to look for the project, not to retry", async () => {
    const { t } = harness(() => json({ language_ids: ["es"] }));
    const ctx = await toolCtx(t, "elevenlabs_dub");
    const err = await dub(dubSchema.parse(input), ctx, "t", { pollMs: 1 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/no usable project id.*instead of dubbing again/);
    expect(String(err)).not.toMatch(/Retry shortly/);
  });
});

describe("no 'Retry shortly' wording in the elevenlabs pack", () => {
  it("is gone from every source file", () => {
    for (const f of ["ops.ts", "util.ts", "capabilities.ts", "index.ts"]) {
      expect(readFileSync(`${packDir}/${f}`, "utf8")).not.toMatch(/Retry shortly/);
    }
  });
});

describe("elevenlabs_get_dub", () => {
  it("reports a running dub without submitting anything", async () => {
    const { t, seen } = harness((c) =>
      c.url.endsWith("/project/p1")
        ? json({ status: "dubbing", language_ids: ["es"] })
        : json({ status: "processing" }),
    );
    const ctx = await toolCtx(t, "elevenlabs_get_dub");
    const out = await getDub(getDubSchema.parse({ dubbing_id: "p1" }), ctx);
    expect(out).toMatchObject({ status: "processing", project_id: "p1" });
    expect(seen.every((c) => c.method === "GET")).toBe(true);
  });

  it("collects a completed dub into the library", async () => {
    const { t } = harness((c) => {
      if (c.url.endsWith("/project/p1"))
        return json({ status: "ready", language_ids: ["fr", "es"] });
      if (c.url.endsWith("/project/p1/language/es"))
        return json({ status: "completed", outputs: { lossless_audio: SIGNED } });
      if (c.url === SIGNED) return new Response(new Uint8Array([3]));
      throw new Error(`unexpected ${c.url}`);
    });
    const ctx = await toolCtx(t, "elevenlabs_get_dub");
    const out = await toolOf(elevenPack, "elevenlabs_get_dub").run(
      { dubbing_id: "p1", target_language: "es" },
      ctx,
    );
    expect(out).toMatchObject({ status: "completed", project_id: "p1" });
    expect(t.library?.all().some((a) => a.mime === "audio/flac")).toBe(true);
  });

  it("rejects an unsafe id", () => {
    expect(() => getDubSchema.parse({ dubbing_id: "../x" })).toThrow();
  });
});
