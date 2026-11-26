import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_USER_MOUNTS,
  UserMountSchema,
  UserMountStore,
  UserMountsError,
  plainHttpSecretProblem,
  userMountSecretRefs,
} from "../../../src/core/mounts/user-mounts.js";
import { expectMode } from "../../support/platform.js";

const ref = (name: string) => `\${secret:${name}}`;

const http = (over: Record<string, unknown> = {}) => ({
  id: "notes",
  transport: "http",
  prefix: "notes",
  url: "https://mcp.example.com/mcp",
  ...over,
});
const stdio = (over: Record<string, unknown> = {}) => ({
  id: "files",
  transport: "stdio",
  prefix: "fs",
  command: "npx",
  args: ["-y", "some-server"],
  ...over,
});

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof UserMountsError) return e.code;
    throw e;
  }
  return undefined;
}

describe("UserMountSchema", () => {
  it("accepts an http mount and a stdio mount, enabled by default", () => {
    expect(UserMountSchema.parse(http()).enabled).toBe(true);
    expect(UserMountSchema.parse(stdio()).command).toBe("npx");
    expect(UserMountSchema.parse(stdio({ command: "/usr/local/bin/server" })).command).toBe(
      "/usr/local/bin/server",
    );
  });

  it.each([
    ["an unknown key", http({ shell: true })],
    ["an http mount without a url", http({ url: undefined })],
    ["an http mount with a command", http({ command: "npx" })],
    ["an http mount with env", http({ env: { A: "b" } })],
    ["a stdio mount without a command", stdio({ command: undefined })],
    ["a stdio mount with a url", stdio({ url: "https://mcp.example.com/mcp" })],
    ["a stdio mount with headers", stdio({ headers: { A: "b" } })],
    ["credentials in the url", http({ url: "https://user:pw@mcp.example.com/mcp" })],
    ["a non-http url", http({ url: "file:///etc/passwd" })],
    ["shell syntax in the command", stdio({ command: "sh -c id" })],
    ["a relative path as the command", stdio({ command: "./server" })],
    ["a command with a pipe", stdio({ command: "a|b" })],
    ["an uppercase id", http({ id: "Notes" })],
    ["a bad prefix", http({ prefix: "9x" })],
    ["a bad header name", http({ headers: { "X Bad": "v" } })],
    ["a CR/LF in a header value", http({ headers: { "X-Key": "v\r\nX-Injected: 1" } })],
    ["a LF in a header value", http({ headers: { "X-Key": "v\nw" } })],
    ["a bad env name", stdio({ env: { "1A": "v" } })],
    ["a NUL in an argument", stdio({ args: ["a\0b"] })],
    ["a transport it does not know", http({ transport: "sse" })],
  ])("refuses %s", (_label, input) => {
    expect(UserMountSchema.safeParse(input).success).toBe(false);
  });

  it("refuses a secret reference to a name mounts may not use", () => {
    for (const name of ["PLUGHIVE_ACCESS_KEY", "PLUGHIVE_ADMIN_TOKEN"]) {
      const r = UserMountSchema.safeParse(
        http({ headers: { Authorization: `Bearer ${ref(name)}` } }),
      );
      expect(r.success, name).toBe(false);
    }
    expect(
      UserMountSchema.safeParse(
        http({ headers: { Authorization: `Bearer ${ref("NOTES_TOKEN")}` } }),
      ).success,
    ).toBe(true);
  });

  it("lists secret references from the url, headers, args and env, once each", () => {
    expect(
      userMountSecretRefs({
        url: `https://mcp.example.com/${ref("A_KEY")}/mcp`,
        headers: { Authorization: `Bearer ${ref("B_KEY")}`, "X-Again": ref("A_KEY") },
        args: [`--token=${ref("C_KEY")}`],
        env: { TOKEN: ref("D_KEY") },
      }),
    ).toEqual(["A_KEY", "B_KEY", "C_KEY", "D_KEY"]);
    expect(userMountSecretRefs({})).toEqual([]);
  });
});

describe("UserMountStore", () => {
  let home: string;
  let store: UserMountStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "user-mounts-"));
    store = new UserMountStore(home);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reads no mounts when the file does not exist", () => {
    expect(store.read()).toEqual({ mounts: [], error: null });
  });

  it("adds, lists, switches and removes mounts, in an owner-only file", () => {
    expect(store.add(http()).id).toBe("notes");
    store.add(stdio());
    expect(store.read().mounts.map((m) => m.id)).toEqual(["notes", "files"]);
    if (process.platform !== "win32") {
      expectMode(store.path, 0o600);
    }
    expect(JSON.parse(readFileSync(store.path, "utf8")).version).toBe(1);

    expect(store.setEnabled("notes", false)).toBe(true);
    expect(store.read().mounts.find((m) => m.id === "notes")?.enabled).toBe(false);
    expect(store.setEnabled("notes", true)).toBe(true);
    expect(store.read().mounts.find((m) => m.id === "notes")?.enabled).toBe(true);
    expect(store.setEnabled("nope", true)).toBe(false);

    expect(store.remove("notes")).toBe(true);
    expect(store.remove("notes")).toBe(false);
    expect(store.read().mounts.map((m) => m.id)).toEqual(["files"]);
  });

  it("refuses an invalid mount, a duplicate id and a duplicate prefix", () => {
    store.add(http());
    expect(code(() => store.add(http({ id: "Bad Id" })))).toBe("INVALID_MOUNT");
    expect(code(() => store.add(http({ prefix: "other" })))).toBe("MOUNT_EXISTS");
    expect(code(() => store.add(http({ id: "other" })))).toBe("MOUNT_EXISTS");
    expect(store.read().mounts).toHaveLength(1);
  });

  it("I6: refuses a secret over plain http to another machine, nowhere else", () => {
    const plain = "http://mcp.example.com/mcp";
    expect(
      code(() => store.add(http({ url: plain, headers: { Authorization: `Bearer ${ref("T")}` } }))),
    ).toBe("INVALID_MOUNT");
    expect(code(() => store.add(http({ url: plain, headers: { "X-Api-Key": "literal" } })))).toBe(
      "INVALID_MOUNT",
    );
    expect(code(() => store.add(http({ url: `${plain}?key=${ref("T")}` })))).toBe("INVALID_MOUNT");
    expect(
      plainHttpSecretProblem(http({ url: plain, headers: { "X-Plain": "v" } }) as never),
    ).toBeNull();
    expect(
      plainHttpSecretProblem(
        http({ url: "http://localhost:3000/mcp", headers: { Authorization: ref("T") } }) as never,
      ),
    ).toBeNull();
    expect(
      plainHttpSecretProblem(
        http({ url: "http://[::1]:3000/mcp", headers: { Authorization: ref("T") } }) as never,
      ),
    ).toBeNull();
    expect(
      plainHttpSecretProblem(http({ headers: { Authorization: ref("T") } }) as never),
    ).toBeNull();
    expect(store.read().mounts).toHaveLength(0);
  });

  it("stops at the mount limit", () => {
    const mounts = Array.from({ length: MAX_USER_MOUNTS }, (_, i) =>
      http({ id: `m${String(i).padStart(2, "0")}`, prefix: `p${i}` }),
    );
    writeFileSync(store.path, JSON.stringify({ version: 1, mounts }));
    expect(store.read().mounts).toHaveLength(MAX_USER_MOUNTS);
    expect(code(() => store.add(http()))).toBe("MOUNT_LIMIT");
  });

  it.each([
    ["not JSON", "{ nope", /not valid JSON/],
    ["an unknown top-level key", JSON.stringify({ version: 1, mounts: [], extra: 1 }), /invalid/],
    [
      "two mounts with one prefix",
      JSON.stringify({ version: 1, mounts: [http(), http({ id: "other" })] }),
      /duplicate mount prefix/,
    ],
    [
      "one bad mount among good ones",
      JSON.stringify({ version: 1, mounts: [http(), stdio({ command: "sh -c id" })] }),
      /invalid/,
    ],
  ])("uses nothing from a file with %s, and never overwrites it", (_label, body, message) => {
    writeFileSync(store.path, body);
    const state = store.read();
    expect(state.mounts).toEqual([]);
    expect(state.error).toMatch(message);
    expect(code(() => store.add(stdio()))).toBe("MOUNTS_FILE_INVALID");
    expect(code(() => store.remove("notes"))).toBe("MOUNTS_FILE_INVALID");
    expect(code(() => store.setEnabled("notes", false))).toBe("MOUNTS_FILE_INVALID");
    expect(readFileSync(store.path, "utf8")).toBe(body);
  });
});
