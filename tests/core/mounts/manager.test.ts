import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MountManager } from "../../../src/core/mounts/manager.js";
import { UserMountStore } from "../../../src/core/mounts/user-mounts.js";
import type { ResolvedMount } from "../../../src/core/packs/loader.js";
import type { ConnectableMount, PackMounts } from "../../../src/core/packs/mounts.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";

const ref = (name: string) => `\${secret:${name}}`;

describe("MountManager: user mounts", () => {
  let home: string;
  let user: UserMountStore;
  const warn = vi.fn();
  const connections = {
    sync: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    connection: () => ({ connected: false, tools: 0, error: null }),
  } as unknown as PackMounts;
  const loader = {
    listMounts: async () => [],
    setMountEnabled: async () => {},
    resolvedMounts: async (): Promise<ResolvedMount[]> => [],
  };

  // The environment has every name the mounts ask for; the store starts empty.
  const env = { NOTES_TOKEN: "from-the-environment", FILES_KEY: "env-files-key" };
  function manager() {
    const secrets = createSecretStore({
      home,
      env,
      backend: "memory",
      knownNames: ["NOTES_TOKEN", "FILES_KEY"],
    });
    const mgr = new MountManager({ loader, user, connections, secrets, logger: { warn } });
    return { secrets, mgr };
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mount-manager-"));
    user = new UserMountStore(home);
    warn.mockClear();
    user.add({
      id: "notes",
      transport: "http",
      prefix: "notes",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: `Bearer ${ref("NOTES_TOKEN")}` },
    });
    user.add({
      id: "files",
      transport: "stdio",
      prefix: "fs",
      command: "npx",
      args: [`--key=${ref("FILES_KEY")}`],
      env: { KEY: ref("FILES_KEY") },
    });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("fills a secret reference only from the store, never from the environment", async () => {
    const { secrets, mgr } = manager();
    // The layered store itself would hand the environment's value to a bundled pack.
    expect(await secrets.get("NOTES_TOKEN")).toBe("from-the-environment");

    // Nothing stored: neither mount is connected and both report the missing secret.
    expect(await mgr.resolvedMounts()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    const listed = await mgr.listMounts();
    expect(listed.map((m) => [m.id, m.secrets, m.note])).toEqual([
      [
        "user/notes",
        [{ name: "NOTES_TOKEN", present: false }],
        "the secret NOTES_TOKEN is not set",
      ],
      ["user/files", [{ name: "FILES_KEY", present: false }], "the secret FILES_KEY is not set"],
    ]);

    // Stored values are used, and the environment's never appear.
    await secrets.set("NOTES_TOKEN", "stored-notes-token");
    await secrets.set("FILES_KEY", "stored-files-key");
    const resolved = await mgr.resolvedMounts();
    const byId = new Map<string, ConnectableMount>(resolved.map((m) => [m.id, m]));
    expect(byId.get("user/notes")).toMatchObject({
      pack: "user",
      prefix: "notes",
      headers: { Authorization: "Bearer stored-notes-token" },
    });
    expect(byId.get("user/files")).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["--key=stored-files-key"],
      env: { KEY: "stored-files-key" },
    });
    expect(JSON.stringify(resolved)).not.toContain("environment");
    expect(JSON.stringify(resolved)).not.toContain("env-files-key");
    expect((await mgr.listMounts()).every((m) => m.secrets.every((s) => s.present))).toBe(true);

    // Deleting the stored value does not fall back to the environment.
    await secrets.delete("NOTES_TOKEN");
    expect((await mgr.resolvedMounts()).map((m) => m.id)).toEqual(["user/files"]);
  });

  it("I6: never connects a hand-written mount that sends a secret over plain http", async () => {
    const { secrets, mgr } = manager();
    await secrets.set("NOTES_TOKEN", "stored-notes-token");
    await secrets.set("FILES_KEY", "stored-files-key");
    const file = JSON.parse(readFileSync(user.path, "utf8"));
    file.mounts[0].url = "http://mcp.example.com/mcp";
    writeFileSync(user.path, JSON.stringify(file));
    expect((await mgr.resolvedMounts()).map((m) => m.id)).toEqual(["user/files"]);
    expect(warn).toHaveBeenCalledWith(
      { mount: "user/notes" },
      "mount skipped: it would send a secret over plain http",
    );
    const notes = (await mgr.listMounts()).find((m) => m.id === "user/notes");
    expect(notes).toMatchObject({ mountable: false });
    expect(notes?.note).toMatch(/^not connected: the header Authorization carries a secret/);
  });

  it("lists a mount's url without its query string, pack or user", async () => {
    const file = JSON.parse(readFileSync(user.path, "utf8"));
    file.mounts[0].url = "https://mcp.example.com/mcp?apiKey=literal-key-in-the-file#frag";
    writeFileSync(user.path, JSON.stringify(file));
    const { secrets } = manager();
    const mgr = new MountManager({
      loader: {
        ...loader,
        listMounts: async () =>
          [
            { id: "p/bb", url: `https://mcp.example.org/mcp?browserbaseApiKey=${ref("BB_KEY")}` },
          ] as never,
      },
      user,
      connections,
      secrets,
      logger: { warn },
    });
    const listed = await mgr.listMounts();
    expect(listed.map((m) => m.url)).toEqual([
      "https://mcp.example.org/mcp",
      "https://mcp.example.com/mcp",
      null,
    ]);
    expect(JSON.stringify(listed)).not.toContain("literal-key-in-the-file");
  });

  it("skips a switched-off mount and a prefix a pack mount already has", async () => {
    const { secrets, mgr } = manager();
    await secrets.set("NOTES_TOKEN", "stored-notes-token");
    await secrets.set("FILES_KEY", "stored-files-key");
    await mgr.setMountEnabled("user/files", false);
    expect(connections.sync).toHaveBeenCalled();
    expect((await mgr.resolvedMounts()).map((m) => m.id)).toEqual(["user/notes"]);
    await expect(mgr.setMountEnabled("user/nope", true)).rejects.toMatchObject({
      code: "UNKNOWN_MOUNT",
    });

    const taken = new MountManager({
      loader: {
        ...loader,
        resolvedMounts: async () => [
          {
            id: "p/notes",
            pack: "p",
            prefix: "notes",
            url: "https://p.example.com/mcp",
            headers: {},
          },
        ],
      },
      user,
      connections,
      secrets,
      logger: { warn },
    });
    expect((await taken.resolvedMounts()).map((m) => m.id)).toEqual(["p/notes"]);
  });
});
