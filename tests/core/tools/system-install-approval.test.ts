// install_software opens its approval in the shared approvals queue (the
// Approvals page and Telegram decide it) and starts the install on the next
// call once it is approved.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetupAdvisor } from "../../../src/core/advisor/plan.js";
import type { InstallStart, Installer } from "../../../src/core/installer/installer.js";
import { ApprovalStore } from "../../../src/core/policy/approvals.js";
import { PolicyGate } from "../../../src/core/policy/gate.js";
import { systemTools } from "../../../src/core/tools/builtin/system.js";
import type { CallContext, RegisteredTool } from "../../../src/core/tools/registry.js";

const TTL = 30 * 60_000;

describe("install_software approvals", () => {
  let home: string;
  let db: Database.Database;
  let approvals: ApprovalStore;
  let calls: { id: string; approved?: boolean }[];
  let tool: RegisteredTool;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plughive-install-approval-"));
    db = new Database(":memory:");
    approvals = new ApprovalStore({ db });
    const gate = new PolicyGate({
      home,
      approvals,
      spend: { spent: () => 0 },
      baseUrl: "http://127.0.0.1:7777",
    });
    calls = [];
    const installer = {
      startInstall: async (
        id: string,
        opts: { approved?: boolean } = {},
      ): Promise<InstallStart> => {
        calls.push({ id, ...(opts.approved ? { approved: true } : {}) });
        if (!opts.approved) {
          return {
            status: "approval_required",
            id,
            approval_path: `/software?install=${id}`,
            message: `${id} is about 900 MB.`,
            size_mb: 900,
            license: "MIT",
          };
        }
        return { status: "started", id, job_id: "job-1", wait_with: "wait_for_job" };
      },
    } as unknown as Installer;
    const tools = systemTools({ installer, advisor: {} as SetupAdvisor, gate });
    tool = tools.find((t) => t.name === "install_software") as RegisteredTool;
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const install = (id = "ollama") =>
    tool.run({ id }, {} as CallContext) as Promise<Record<string, unknown>>;

  it("opens one approval, then installs once it is approved", async () => {
    const first = await install();
    expect(first).toMatchObject({
      status: "approval_required",
      approval_path: "/software?install=ollama",
      size_mb: 900,
    });
    const id = first.approval_id as string;
    expect(first.approval_url).toBe(`http://127.0.0.1:7777/approvals?id=${encodeURIComponent(id)}`);
    expect(approvals.get(id)).toMatchObject({
      status: "pending",
      tool: "system/install_software",
      kind: "tool",
    });
    expect(approvals.get(id)?.reason).toMatch(/install ollama \(900 MB, MIT\)/);
    // Asking again reuses the open request.
    expect((await install()).approval_id).toBe(id);
    expect(approvals.pendingCount()).toBe(1);

    approvals.decide(id, "approved", "dashboard", TTL);
    expect(await install()).toMatchObject({ status: "started", job_id: "job-1" });
    expect(calls.at(-1)).toEqual({ id: "ollama", approved: true });
    expect(approvals.get(id)?.status).toBe("consumed");
  });

  it("reports a denial once", async () => {
    const first = await install();
    approvals.decide(first.approval_id as string, "denied", "telegram", TTL);
    const denied = await install();
    expect(denied.status).toBe("approval_denied");
    expect(denied.message).toMatch(/denied/);
    expect(calls.some((c) => c.approved)).toBe(false);
    expect((await install()).status).toBe("approval_required");
  });

  it("an approval for one program does not install another", async () => {
    const first = await install("ollama");
    approvals.decide(first.approval_id as string, "approved", "dashboard", TTL);
    expect((await install("comfyui")).status).toBe("approval_required");
    expect(calls.some((c) => c.approved)).toBe(false);
  });
});
