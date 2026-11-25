import { describe, expect, it } from "vitest";
import { consentItems } from "../../../src/core/packs/loader.js";
import {
  ManifestError,
  parseManifest,
  parseManifestText,
  toolNameProblem,
} from "../../../src/core/packs/manifest.js";

const base = { id: "demo", name: "Demo", version: "0.1.0", apiVersion: 1 };

function issuesOf(raw: unknown, opts?: { folderName?: string }): string[] {
  try {
    parseManifest(raw, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(ManifestError);
    return (e as ManifestError).issues;
  }
  throw new Error("expected the manifest to be rejected");
}

describe("pack manifest", () => {
  it("accepts a minimal manifest and fills defaults", () => {
    const m = parseManifest(base);
    expect(m.secrets).toEqual([]);
    expect(m.mounts).toEqual([]);
    expect(m.permissions).toEqual({
      network: [],
      localNetwork: [],
      spawn: [],
      library: "none",
      llm: false,
      userHome: false,
      tools: [],
    });
  });

  it("accepts a full manifest", () => {
    const m = parseManifest({
      ...base,
      entry: "./index.js",
      description: "Full example",
      secrets: [{ name: "DEMO_API_KEY", label: "Demo key", helpUrl: "https://example.com/keys" }],
      permissions: {
        network: ["api.example.com", "*.cdn.example.com"],
        localNetwork: ["127.0.0.1:11434"],
        spawn: ["ffmpeg"],
        library: "write",
        llm: true,
        tools: ["list_artifacts", "pack:telegram", "cap:notify_telegram"],
      },
      settings: {
        type: "object",
        properties: { region: { type: "string", enum: ["eu", "us"] } },
        required: ["region"],
      },
      mounts: [
        {
          id: "upstream",
          name: "Upstream",
          transport: "http",
          url: "https://mcp.example.com/mcp",
          headers: { authorization: "Bearer ${secret:DEMO_API_KEY}" },
          prefix: "up",
        },
      ],
      skills: "skills",
      workflows: "workflows",
    });
    expect(m.secrets[0]).toMatchObject({ name: "DEMO_API_KEY", required: true });
    expect(m.permissions.library).toBe("write");
  });

  // U2: "gateway" owns every tool of every mounted server, "core" the daemon's own.
  it.each(["pack:gateway", "pack:core", "pack:builtin", "pack:constructor"])(
    "refuses %s in permissions.tools",
    (ref) => {
      expect(() => parseManifest({ ...base, permissions: { tools: [ref] } })).toThrow(
        /cannot name a reserved pack id/,
      );
    },
  );

  it("still accepts a real pack, a capability and a mounted tool by name", () => {
    const m = parseManifest({
      ...base,
      permissions: { tools: ["pack:telegram", "cap:notify", "notes__search", "list_artifacts"] },
    });
    expect(m.permissions.tools).toHaveLength(4);
  });

  it.each([
    ["Demo", "uppercase"],
    ["1demo", "leading digit"],
    ["d", "too short"],
    ["a".repeat(33), "too long"],
    ["demo_pack", "underscore"],
  ])("rejects pack id %s (%s)", (id) => {
    expect(issuesOf({ ...base, id }).join("\n")).toMatch(/^id: /m);
  });

  it("rejects unknown fields, including inside permissions", () => {
    expect(issuesOf({ ...base, extra: 1 }).join("\n")).toContain('unknown field(s) "extra"');
    expect(issuesOf({ ...base, permissions: { netwrok: ["x.com"] } }).join("\n")).toContain(
      '"netwrok"',
    );
  });

  it("rejects a wrong apiVersion", () => {
    expect(issuesOf({ ...base, apiVersion: 2 }).join("\n")).toContain(
      "apiVersion must be at most 1",
    );
    expect(issuesOf({ ...base, apiVersion: 0 }).join("\n")).toMatch(/apiVersion/);
    expect(parseManifest({ ...base, apiVersion: 1 }).apiVersion).toBe(1);
  });

  it("rejects entry paths that leave the pack folder", () => {
    expect(issuesOf({ ...base, entry: "../evil.js" }).join("\n")).toContain('".."');
    expect(issuesOf({ ...base, entry: "/abs/evil.js" }).join("\n")).toContain("relative path");
  });

  it("rejects bad secret names, duplicate secrets and undeclared secret references", () => {
    expect(issuesOf({ ...base, secrets: [{ name: "lower" }] }).join("\n")).toContain(
      "secret name must match",
    );
    expect(
      issuesOf({ ...base, secrets: [{ name: "AB_KEY" }, { name: "AB_KEY" }] }).join("\n"),
    ).toContain("declared twice");
    const mount = {
      id: "up",
      name: "Up",
      transport: "http",
      url: "https://x.example.com",
      prefix: "up",
      headers: { a: "${secret:OTHER_KEY}" },
    };
    expect(issuesOf({ ...base, mounts: [mount] }).join("\n")).toContain("${secret:OTHER_KEY}");
  });

  it("rejects bad permission entries", () => {
    expect(issuesOf({ ...base, permissions: { spawn: ["/bin/sh"] } }).join("\n")).toContain(
      "bare binary names",
    );
    expect(
      issuesOf({ ...base, permissions: { localNetwork: ["localhost"] } }).join("\n"),
    ).toContain("host:port");
    expect(issuesOf({ ...base, permissions: { network: ["http://x.com"] } }).join("\n")).toContain(
      "host patterns",
    );
    expect(issuesOf({ ...base, permissions: { library: "admin" } }).join("\n")).toContain(
      "library must be",
    );
  });

  it("rejects a required setting without a property", () => {
    expect(
      issuesOf({ ...base, settings: { type: "object", properties: {}, required: ["x"] } }).join(
        "\n",
      ),
    ).toContain('required setting "x"');
  });

  it("accepts a list-of-strings setting and nothing else as a list", () => {
    const settings = (prop: unknown) => ({
      ...base,
      settings: { type: "object", properties: { ids: prop } },
    });
    const m = parseManifest(
      settings({ type: "array", items: { type: "string" }, default: ["a", "b"] }),
    );
    expect(m.settings?.properties.ids).toEqual({
      type: "array",
      items: { type: "string" },
      default: ["a", "b"],
    });
    expect(
      parseManifest(settings({ type: "array", items: { type: "string" } })).settings?.properties.ids
        ?.type,
    ).toBe("array");

    const bad: Array<[unknown, string]> = [
      [{ type: "array" }, 'needs items: {"type": "string"}'],
      [{ type: "array", items: { type: "number" } }, 'items.type must be "string"'],
      [{ type: "array", items: { type: "string", minLength: 1 } }, "minLength"],
      [{ type: "array", items: { type: "string" }, enum: ["a"] }, "cannot have an enum"],
      [{ type: "array", items: { type: "string" }, default: "a,b" }, "must be a list of strings"],
      [
        { type: "array", items: { type: "string" }, format: "local-endpoint" },
        'must have type "string"',
      ],
      [{ type: "string", items: { type: "string" } }, 'items is only for type "array"'],
      [{ type: "string", default: ["a"] }, 'a list default is only for type "array"'],
      [{ type: "object" }, "setting type must be"],
    ];
    for (const [prop, message] of bad) {
      expect(issuesOf(settings(prop)).join("\n"), JSON.stringify(prop)).toContain(message);
    }
    expect(
      issuesOf(settings({ type: "array", items: { type: "string" }, default: [1] })).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf(settings({ type: "array", items: { type: "string" }, default: [""] })).length,
    ).toBeGreaterThan(0);
  });

  it("requires the id to match the folder name when given", () => {
    expect(issuesOf(base, { folderName: "other" }).join("\n")).toContain(
      'must equal the pack folder name "other"',
    );
  });

  it("turns JSON syntax errors into ManifestError", () => {
    expect(() => parseManifestText("{ nope")).toThrow(ManifestError);
  });

  it("validates tool names", () => {
    expect(toolNameProblem("send_telegram")).toBeNull();
    expect(toolNameProblem("has space")).toContain("not a valid MCP tool name");
    expect(toolNameProblem("up__shadow")).toContain("reserved for mounted tools");
  });
});

describe("M-14: a pack mount never sends a secret over plain http to a remote host", () => {
  const mount = (over: Record<string, unknown>) => ({
    id: "up",
    name: "Up",
    transport: "http",
    url: "http://mcp.example.com/mcp",
    prefix: "up",
    ...over,
  });

  it("refuses a secret header, a secret in the url and an oauth mount over plain http", () => {
    const withKey = { ...base, secrets: [{ name: "DEMO_KEY" }], mounts: [mount({})] };
    // No secret anywhere: plain http to a remote host is (still) allowed.
    expect(() => parseManifest(withKey)).not.toThrow();
    expect(
      issuesOf({
        ...base,
        secrets: [{ name: "DEMO_KEY" }],
        mounts: [mount({ headers: { Authorization: "Bearer ${secret:DEMO_KEY}" } })],
      }).join("\n"),
    ).toContain("carries a secret and would be sent over plain http:// to mcp.example.com");
    expect(
      issuesOf({
        ...base,
        secrets: [{ name: "DEMO_KEY" }],
        mounts: [mount({ url: "http://mcp.example.com/mcp?key=${secret:DEMO_KEY}" })],
      }).join("\n"),
    ).toContain("the url carries a secret");
    expect(issuesOf({ ...base, mounts: [mount({ auth: "oauth" })] }).join("\n")).toContain(
      "OAuth mount signs in over plain http://",
    );
    // A literal credential header is refused too, secret reference or not.
    expect(
      issuesOf({ ...base, mounts: [mount({ headers: { Authorization: "Bearer literal" } })] }).join(
        "\n",
      ),
    ).toContain("the header Authorization carries a secret");
  });

  it("still allows plain http to loopback and https to a remote host", () => {
    expect(() =>
      parseManifest({
        ...base,
        secrets: [{ name: "DEMO_KEY" }],
        mounts: [
          mount({
            url: "http://127.0.0.1:9000/mcp",
            headers: { Authorization: "Bearer ${secret:DEMO_KEY}" },
          }),
        ],
      }),
    ).not.toThrow();
    expect(() =>
      parseManifest({
        ...base,
        secrets: [{ name: "DEMO_KEY" }],
        mounts: [
          mount({
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer ${secret:DEMO_KEY}" },
          }),
        ],
      }),
    ).not.toThrow();
  });
});

describe("M-14: mount headers show up in the consent items (names only)", () => {
  it("names the headers a mount sends, never their values", () => {
    const m = parseManifest({
      ...base,
      secrets: [{ name: "DEMO_KEY" }],
      mounts: [
        {
          id: "up",
          name: "Up",
          transport: "http",
          url: "https://mcp.example.com/mcp",
          prefix: "up",
          headers: { Authorization: "Bearer ${secret:DEMO_KEY}", "X-Other": "v" },
        },
      ],
    });
    const item = consentItems(m).find((i) => i.kind === "mount");
    expect(item?.text).toContain("https://mcp.example.com/mcp");
    expect(item?.text).toContain("Authorization");
    expect(item?.text).toContain("X-Other");
    expect(item?.text).not.toContain("Bearer");
    expect(item?.text).not.toContain("DEMO_KEY");
  });
});
