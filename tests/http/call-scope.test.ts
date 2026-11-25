// L6: one scope builder. A tool reached from inside another tool is allowed or
// refused the same way whether the outer call ran inline from /api/tools,
// inline from /mcp, or waited on the job queue.
// L7: the profile routes check the id on every method and scrub what they return.
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountProfilesApi } from "../../src/core/http/profiles-api.js";
import { createScopeBuilder } from "../../src/core/mcp/scope-for.js";
import { currentScope, currentScopeAllows } from "../../src/core/mcp/scope.js";
import { ProfileError, type ProfileStore } from "../../src/core/profiles.js";
import {
  type LiteHarness,
  adminFetch,
  bootLite,
  mockTool,
  modernClient,
  toolJson,
} from "./harness.js";

const HEADERS = { "x-plughive-csrf": "1", "content-type": "application/json" };

const probe = async () => ({
  profile: currentScope()?.profileId ?? null,
  base: currentScope()?.baseUrl ?? null,
  alpha: currentScopeAllows("alpha_probe"),
  beta: currentScopeAllows("beta_send"),
});

describe("the scope of a tool call", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({
      packs: {
        alpha: [
          mockTool("alpha_probe", probe),
          mockTool("alpha_probe_slow", probe, { longRunning: true }),
        ],
        beta: [mockTool("beta_send", async () => "sent")],
      },
    });
    // The default profile no longer exposes the beta pack.
    const res = await adminFetch(`${h.base}/api/profiles/default`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({
        name: "Default",
        mode: "list",
        include: ["*"],
        exclude: ["pack:beta"],
      }),
    });
    expect(res.status).toBeLessThan(300);
  });
  afterEach(async () => {
    await h.close();
  });

  const call = async (name: string, body: unknown = {}) => {
    const res = await adminFetch(`${h.base}/api/tools/${name}/call`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, any>;
  };
  const jobResult = async (jobId: string) => {
    for (let i = 0; i < 200; i++) {
      const { job } = (await (await adminFetch(`${h.base}/api/jobs/${jobId}`)).json()) as Record<
        string,
        any
      >;
      if (job.status === "succeeded" || job.status === "failed") return job.result;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the job did not finish");
  };

  it("is the same inline from /api/tools, queued from /api/tools and inline from /mcp", async () => {
    const expected = { profile: "default", base: h.base, alpha: true, beta: false };

    const inline = await call("alpha_probe");
    expect(inline.result).toEqual(expected);

    const queued = await call("alpha_probe", { background: true });
    expect(await jobResult(queued.job_id)).toEqual(expected);
    const slow = await call("alpha_probe_slow");
    expect(await jobResult(slow.job_id)).toEqual(expected);

    const client = await modernClient(h.base);
    try {
      expect(
        toolJson(await client.callTool({ name: "alpha_probe", arguments: {} })).result,
      ).toEqual(expected);
    } finally {
      await client.close();
    }
  });

  it("follows the profile as it is at the time of the nested call", () => {
    const profiles = new Map<string, any>([
      ["p", { id: "p", name: "P", mode: "list", include: ["pack:alpha"], exclude: [], pinned: [] }],
    ]);
    const scopeFor = createScopeBuilder({
      registry: h.registry,
      profile: (id) => profiles.get(id),
      baseUrl: () => "http://daemon.test",
    });
    const scope = scopeFor("p");
    expect(scope).toMatchObject({ profileId: "p", baseUrl: "http://daemon.test" });
    expect([scope.allows?.("alpha_probe"), scope.allows?.("beta_send")]).toEqual([true, false]);
    profiles.set("p", { ...profiles.get("p"), include: ["pack:beta"] });
    expect([scope.allows?.("alpha_probe"), scope.allows?.("beta_send")]).toEqual([false, true]);
    // Deleted while the call runs: it reaches nothing.
    profiles.delete("p");
    expect([scope.allows?.("alpha_probe"), scope.allows?.("beta_send")]).toEqual([false, false]);
    // No profile store: nothing is restricted.
    expect(createScopeBuilder({ registry: h.registry })(undefined)).toEqual({
      profileId: "default",
    });
  });

  it("GET and DELETE refuse a malformed profile id before the store sees it", async () => {
    for (const id of ["Bad_ID", "a", "UPPER", "x".repeat(40), "has.dot"]) {
      for (const [method, path] of [
        ["GET", `/api/profiles/${id}`],
        ["GET", `/api/profiles/${id}/preview`],
        ["DELETE", `/api/profiles/${id}`],
      ] as const) {
        const res = await adminFetch(`${h.base}${path}`, { method, headers: HEADERS });
        expect(res.status, `${method} ${path}`).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "INVALID_PROFILE" } });
      }
    }
    // A well-formed id nobody created is still "no such profile".
    expect((await adminFetch(`${h.base}/api/profiles/nobody-here`)).status).toBe(404);
  });
});

describe("profile refusals", () => {
  it("pass through scrub, message and issues alike", async () => {
    const SECRET = "stored-secret-value-4411";
    const store = {
      list: () => [],
      get: () => undefined,
      put: () => {
        throw new ProfileError("INVALID_PROFILE", `invalid profile: saw ${SECRET}`, [
          {
            code: "custom",
            path: ["include", 0],
            message: `bad selector ${SECRET}`,
            input: SECRET,
          },
        ]);
      },
      delete: () => {
        throw new ProfileError("PROFILE_PROTECTED", `cannot delete near ${SECRET}`);
      },
    } as unknown as ProfileStore;
    const app = express();
    mountProfilesApi(app, {
      profiles: store,
      registry: { list: () => [] } as never,
      jobs: false,
      origin: { base: () => "http://127.0.0.1", allows: () => true } as never,
      scrub: (text) => text.split(SECRET).join("[redacted]"),
    });
    const server = await new Promise<import("node:http").Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const { port } = server.address() as { port: number };
      const put = await fetch(`http://127.0.0.1:${port}/api/profiles/some-id`, {
        method: "PUT",
        headers: HEADERS,
        body: JSON.stringify({ name: "x" }),
      });
      const putText = await put.text();
      expect(put.status).toBe(400);
      expect(putText).not.toContain(SECRET);
      expect(JSON.parse(putText).error).toEqual({
        code: "INVALID_PROFILE",
        message: "invalid profile: saw [redacted]",
        issues: [{ code: "custom", path: ["include", 0], message: "bad selector [redacted]" }],
      });
      const del = await fetch(`http://127.0.0.1:${port}/api/profiles/some-id`, {
        method: "DELETE",
        headers: HEADERS,
      });
      const delText = await del.text();
      expect(del.status).toBe(409);
      expect(delText).not.toContain(SECRET);
      expect(delText).toContain("[redacted]");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
