// /api/software, /api/advisor and the approval link an install asks for over MCP.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SetupPlan } from "../../src/core/advisor/plan.js";
import {
  InstallError,
  type InstallStart,
  type SoftwareView,
} from "../../src/core/installer/installer.js";
import {
  type LiteHarness,
  adminFetch,
  bootLite,
  jsonBody,
  legacyClient,
  mockTool,
  rawModern,
} from "./harness.js";

const URL_CAPS = { elicitation: { url: {} } };

const view = (id: string, extra: Partial<SoftwareView> = {}): SoftwareView => ({
  id,
  name: id,
  summary: `${id} summary`,
  version: "1.0.0",
  license: "MIT",
  size_mb: 10,
  gated: false,
  homepage: "https://example.com",
  tags: ["video"],
  bins: [id],
  method: "archive",
  needs_approval: false,
  installed: false,
  managed: false,
  path: null,
  detected_version: null,
  ...extra,
});

function fakeInstaller() {
  const calls: { id: string; approved?: boolean; force?: boolean }[] = [];
  const items = [view("small"), view("big", { size_mb: 900, needs_approval: true })];
  return {
    calls,
    installer: {
      status: async () => items,
      statusOf: async (id: string) => {
        const item = items.find((i) => i.id === id);
        if (!item) throw new InstallError("not_found", `no software ${id}`);
        return item;
      },
      startInstall: async (
        id: string,
        opts: { approved?: boolean; force?: boolean } = {},
      ): Promise<InstallStart> => {
        calls.push({ id, ...opts });
        const item = items.find((i) => i.id === id);
        if (!item) throw new InstallError("not_found", `no software ${id}`);
        if (item.needs_approval && !opts.approved) {
          return {
            status: "approval_required",
            id,
            approval_path: `/software?install=${id}`,
            message: "big is 900 MB.",
            size_mb: 900,
            license: "MIT",
          };
        }
        return { status: "started", id, job_id: "job-1", wait_with: "wait_for_job" };
      },
      uninstall: async (id: string) => {
        if (id === "busy") throw new InstallError("busy", "an install is running");
        return { status: "removed" as const, id };
      },
    },
  };
}

const plan: SetupPlan = {
  goal: "edit-images",
  title: "Edit images",
  summary: "s",
  ready: false,
  steps: [],
  next: [],
};
const advisor = {
  list: () => [{ id: "edit-images", title: "Edit images", summary: "s" }],
  plan: async (goal: string) => (goal.includes("image") ? plan : null),
};

describe("software admin API", () => {
  let h: LiteHarness;
  let fake: ReturnType<typeof fakeInstaller>;
  beforeEach(async () => {
    fake = fakeInstaller();
    h = await bootLite({
      packs: {},
      software: { installer: fake.installer as never, advisor: advisor as never },
    });
  });
  afterEach(() => h.close());

  const post = (path: string, body: unknown = {}) =>
    adminFetch(`${h.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.base },
      body: JSON.stringify(body),
    });

  it("needs the admin token", async () => {
    expect((await fetch(`${h.base}/api/software`)).status).toBe(401);
  });

  it("lists and reads software", async () => {
    const list = await jsonBody(await adminFetch(`${h.base}/api/software`));
    expect(list.items.map((i: SoftwareView) => i.id)).toEqual(["small", "big"]);
    const one = await adminFetch(`${h.base}/api/software/big`);
    expect((await jsonBody(one)).item.size_mb).toBe(900);
    const missing = await adminFetch(`${h.base}/api/software/nope`);
    expect(missing.status).toBe(404);
    expect((await jsonBody(missing)).error.code).toBe("NOT_FOUND");
    expect((await adminFetch(`${h.base}/api/software/..%2Fetc`)).status).toBe(404);
  });

  it("approves a gated install only when asked to", async () => {
    const first = await jsonBody(await post("/api/software/big/install"));
    expect(first.result.status).toBe("approval_required");
    const approved = await jsonBody(await post("/api/software/big/install", { approve: true }));
    expect(approved.result).toMatchObject({ status: "started", job_id: "job-1" });
    expect(fake.calls).toEqual([{ id: "big" }, { id: "big", approved: true }]);
  });

  it("refuses unknown body fields and cross-site posts", async () => {
    expect((await post("/api/software/big/install", { approve: "yes" })).status).toBe(400);
    expect((await post("/api/software/big/install", { sudo: true })).status).toBe(400);
    const cross = await adminFetch(`${h.base}/api/software/big/install`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(cross.status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("uninstalls and maps installer errors", async () => {
    expect((await jsonBody(await post("/api/software/small/uninstall"))).result.status).toBe(
      "removed",
    );
    const busy = await post("/api/software/busy/uninstall");
    expect(busy.status).toBe(409);
    expect((await jsonBody(busy)).error.code).toBe("BUSY");
  });

  it("serves goals and plans", async () => {
    const goals = await jsonBody(await adminFetch(`${h.base}/api/advisor/goals`));
    expect(goals.goals[0].id).toBe("edit-images");
    const ok = await adminFetch(
      `${h.base}/api/advisor/plan?goal=${encodeURIComponent("edit my images")}`,
    );
    expect((await jsonBody(ok)).plan.goal).toBe("edit-images");
    const none = await adminFetch(`${h.base}/api/advisor/plan?goal=juggle`);
    expect(none.status).toBe(404);
    expect((await jsonBody(none)).error.code).toBe("UNKNOWN_GOAL");
    expect((await adminFetch(`${h.base}/api/advisor/plan`)).status).toBe(400);
  });
});

describe("install approval over MCP", () => {
  let h: LiteHarness;
  let answer: unknown;
  beforeEach(async () => {
    answer = {
      status: "approval_required",
      id: "big",
      approval_path: "/software?install=big",
      message: "big is 900 MB.",
      size_mb: 900,
      license: "MIT",
    };
    const tool = mockTool("install_software", async () => answer, {
      packId: "system",
      input: z.object({ id: z.string() }),
    });
    h = await bootLite({ packs: { system: [tool] } });
  });
  afterEach(() => h.close());

  const call = (capabilities: Record<string, unknown>) =>
    rawModern(
      h.base,
      "tools/call",
      { name: "install_software", arguments: { id: "big" } },
      { capabilities },
    );

  it("asks a URL-capable client to open the dashboard approval page", async () => {
    const reply = await call(URL_CAPS);
    expect(reply.result?.resultType).toBe("input_required");
    const request = reply.result?.inputRequests.install_approval;
    expect(request).toMatchObject({ method: "elicitation/create", params: { mode: "url" } });
    expect(request.params.url).toBe(`${h.base}/software?install=big`);
    expect(request.params.message).toContain("900 MB");
  });

  it("returns the plain result to a client without URL elicitation", async () => {
    const reply = await call({});
    expect(reply.result?.resultType).not.toBe("input_required");
    expect(JSON.stringify(reply.result)).toContain("approval_required");
  });

  it("never elicits a link that is not the dashboard approval page", async () => {
    answer = { ...(answer as object), approval_path: "https://evil.example/software?install=big" };
    const reply = await call(URL_CAPS);
    expect(reply.result?.resultType).not.toBe("input_required");
  });

  it("instructs agents to use setup_plan", async () => {
    const client = await legacyClient(h.base);
    try {
      expect(client.getInstructions()).toContain("setup_plan");
    } finally {
      await client.close();
    }
  });
});
