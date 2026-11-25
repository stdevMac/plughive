import { describe, expect, it } from "vitest";
import { describePermissions } from "../src/lib/packs";
import {
  LIST_SETTING_MAX_CHARS,
  buildValue,
  draftFrom,
  formFor,
  normalizeSettingsSchema,
  sameSettingValue,
  settingsPayload,
} from "../src/lib/schemaForm";
import type { JsonSchema } from "../src/lib/types";

const schema = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
});

describe("normalizeSettingsSchema", () => {
  it("gives a list setting an add/remove list of text items", () => {
    const f = formFor(
      normalizeSettingsSchema(schema({ hosts: { type: "array", items: { type: "string" } } })),
    );
    const hosts = f.fields?.[0];
    expect(hosts?.kind).toBe("array");
    expect(hosts?.item?.kind).toBe("string");
  });

  it("treats a list with missing or odd items as a list of text", () => {
    const f = formFor(
      normalizeSettingsSchema(
        schema({ a: { type: "array" }, b: { type: "array", items: { type: "object" } } }),
      ),
    );
    expect(f.fields?.map((x) => [x.kind, x.item?.kind])).toEqual([
      ["array", "string"],
      ["array", "string"],
    ]);
  });

  it("falls back to a text field for a type the form does not know", () => {
    const f = formFor(
      normalizeSettingsSchema(schema({ odd: { type: "map" as JsonSchema["type"] }, none: {} })),
    );
    expect(f.fields?.map((x) => x.kind)).toEqual(["string", "string"]);
  });

  it("keeps scalar and enum settings as they are", () => {
    const f = formFor(
      normalizeSettingsSchema(schema({ n: { type: "integer" }, e: { enum: ["a", "b"] } })),
    );
    expect(f.fields?.map((x) => x.kind)).toEqual(["integer", "enum"]);
  });
});

describe("list setting round trip", () => {
  const root = formFor(
    normalizeSettingsSchema(
      schema({ hosts: { type: "array", items: { type: "string" }, default: ["a"] } }),
    ),
  );

  it("sends a JSON array of strings", () => {
    const built = buildValue(root, draftFrom(root, { hosts: ["x", "y"] }));
    expect(built.errors).toEqual([]);
    expect(settingsPayload(root, built.value as Record<string, unknown>)).toEqual({
      values: { hosts: ["x", "y"] },
      errors: [],
    });
  });

  it("drops blank items and trims the rest", () => {
    const built = buildValue(root, { hosts: [" x ", "", "  "] });
    expect(settingsPayload(root, built.value as Record<string, unknown>).values).toEqual({
      hosts: ["x"],
    });
  });

  it("clears the value (null) when it equals the default", () => {
    const built = buildValue(root, { hosts: ["a"] });
    expect(settingsPayload(root, built.value as Record<string, unknown>).values).toEqual({
      hosts: null,
    });
  });

  it("sends [] when a list with a default is emptied", () => {
    const built = buildValue(root, { hosts: [] });
    expect(settingsPayload(root, (built.value ?? {}) as Record<string, unknown>).values).toEqual({
      hosts: [],
    });
  });

  it("clears an emptied list with no default", () => {
    const noDefault = formFor(
      normalizeSettingsSchema(schema({ hosts: { type: "array", items: { type: "string" } } })),
    );
    expect(settingsPayload(noDefault, {}).values).toEqual({ hosts: null });
  });

  it("checks the daemon's limits before saving", () => {
    const tooMany = settingsPayload(root, {
      hosts: Array.from({ length: 257 }, (_, i) => `h${i}`),
    });
    expect(tooMany.errors[0]?.path).toBe("hosts");
    const tooLong = settingsPayload(root, {
      hosts: ["ok", "x".repeat(LIST_SETTING_MAX_CHARS + 1)],
    });
    expect(tooLong.errors).toEqual([
      { path: "hosts.1", message: expect.stringContaining("characters") },
    ]);
  });
});

describe("sameSettingValue", () => {
  it("compares lists by content", () => {
    expect(sameSettingValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameSettingValue(["a"], ["a", "b"])).toBe(false);
    expect(sameSettingValue(3, 3)).toBe(true);
    expect(sameSettingValue([], undefined)).toBe(false);
  });
});

describe("describePermissions", () => {
  it("flags access to the real home folder as sensitive", () => {
    const lines = describePermissions({ spawn: ["ssh"], userHome: true });
    const home = lines.find((l) => l.text.includes("home folder"));
    expect(home).toEqual({
      icon: "file",
      text: "Programs it runs can read and write your home folder",
      risk: true,
    });
  });

  it("says nothing about the home folder without the permission", () => {
    expect(
      describePermissions({ spawn: ["ssh"] }).some((l) => l.text.includes("home folder")),
    ).toBe(false);
  });
});
