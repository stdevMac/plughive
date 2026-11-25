import { describe, expect, it } from "vitest";
import {
  type Field,
  buildValue,
  draftFrom,
  enumKey,
  formFor,
  initialDraft,
  isSimple,
  resolveSchema,
} from "../src/lib/schemaForm";

const child = (root: Field, key: string): Field => {
  const f = root.fields?.find((x) => x.key === key);
  if (!f) throw new Error(`no field ${key}`);
  return f;
};

describe("resolveSchema", () => {
  it("strips null from anyOf and marks the field nullable", () => {
    const r = resolveSchema({ anyOf: [{ type: "string" }, { type: "null" }], description: "d" });
    expect(r.schema.type).toBe("string");
    expect(r.schema.description).toBe("d");
    expect(r.nullable).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  it("turns a union of consts into an enum", () => {
    const r = resolveSchema({ oneOf: [{ const: "a" }, { const: "b" }] });
    expect(r.schema.enum).toEqual(["a", "b"]);
  });

  it("handles type arrays with null", () => {
    const r = resolveSchema({ type: ["integer", "null"] });
    expect(r.schema.type).toBe("integer");
    expect(r.nullable).toBe(true);
  });

  it("flags real unions as ambiguous", () => {
    expect(resolveSchema({ anyOf: [{ type: "string" }, { type: "number" }] }).ambiguous).toBe(true);
    expect(resolveSchema({ type: ["string", "number"] }).ambiguous).toBe(true);
  });
});

describe("formFor", () => {
  const schema = {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to draw" },
      num_images: { type: "integer", minimum: 1, maximum: 4, default: 1 },
      seed: { type: ["number", "null"] },
      enhance: { type: "boolean" },
      size: { type: "string", enum: ["square", "portrait"] },
      urls: { type: "array", items: { type: "string", format: "uri" } },
      extra: { type: "object", properties: { strength: { type: "number" } } },
      anything: { anyOf: [{ type: "string" }, { type: "object" }] },
    },
    required: ["prompt"],
  };
  const form = formFor(schema);

  it("maps each property to a control kind", () => {
    expect(form.kind).toBe("object");
    expect(form.label).toBe("Arguments");
    const kinds = Object.fromEntries((form.fields ?? []).map((f) => [f.key, f.kind]));
    expect(kinds).toEqual({
      prompt: "string",
      num_images: "integer",
      seed: "number",
      enhance: "boolean",
      size: "enum",
      urls: "array",
      extra: "object",
      anything: "json",
    });
  });

  it("labels, requirement, multiline and input type", () => {
    const prompt = child(form, "prompt");
    expect(prompt.required).toBe(true);
    expect(prompt.multiline).toBe(true);
    expect(child(form, "num_images").label).toBe("Num images");
    expect(child(form, "num_images").required).toBe(false);
    expect(child(form, "urls").item?.inputType).toBe("url");
    expect(child(form, "seed").nullable).toBe(true);
    expect(isSimple(form)).toBe(false);
    expect(isSimple(formFor({ type: "object", properties: { a: { type: "string" } } }))).toBe(true);
  });

  it("fills defaults into the initial draft", () => {
    const d = initialDraft(form) as Record<string, unknown>;
    expect(d.num_images).toBe("1");
    expect(d.prompt).toBe("");
    expect(d.enhance).toBeUndefined();
  });

  it("builds arguments, leaving empty optional values out", () => {
    const d = initialDraft(form) as Record<string, unknown>;
    d.prompt = "a cat";
    d.size = enumKey("portrait");
    d.urls = ["https://example.com/a.png", ""];
    d.anything = '{"x": 1}';
    const b = buildValue(form, d);
    expect(b.errors).toEqual([]);
    expect(b.value).toEqual({
      prompt: "a cat",
      num_images: 1,
      size: "portrait",
      urls: ["https://example.com/a.png"],
      anything: { x: 1 },
    });
  });

  it("reports required, range, integer and JSON errors by path", () => {
    const d = initialDraft(form) as Record<string, unknown>;
    d.num_images = "9";
    d.anything = "{nope";
    const b = buildValue(form, d);
    const byPath = Object.fromEntries(b.errors.map((e) => [e.path, e.message]));
    expect(byPath.prompt).toBe("This field is required.");
    expect(byPath.num_images).toBe("The largest allowed value is 4.");
    expect(byPath.anything).toBe("This is not valid JSON.");
    d.num_images = "1.5";
    expect(buildValue(child(form, "num_images"), d.num_images).errors[0]?.message).toBe(
      "Enter a whole number.",
    );
  });

  it("round-trips values through draftFrom", () => {
    const value = {
      prompt: "x",
      num_images: 2,
      enhance: true,
      size: "square",
      extra: { strength: 0.5 },
    };
    const b = buildValue(form, draftFrom(form, value));
    expect(b.errors).toEqual([]);
    expect(b.value).toEqual(value);
  });

  it("always sends the root object, even empty", () => {
    expect(buildValue(formFor({ type: "object", properties: {} }), {}).value).toEqual({});
  });
});

describe("L-14: untrusted schemas cannot pollute drafts", () => {
  // JSON.parse keeps "__proto__" an own key; an object literal would not.
  const evilSchema = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"name":{"type":"string"}}}',
  ) as never;

  it("a __proto__ property stays an own key of the draft and the built value", () => {
    const root = formFor(evilSchema);
    const draft = initialDraft(root) as Record<string, unknown>;
    expect(Object.hasOwn(draft, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(draft)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    draft.__proto__ = "not a prototype" as never;
    draft.name = "x";
    const built = buildValue(root, draft);
    expect(built.errors).toEqual([]);
    expect(Object.hasOwn(built.value as object, "__proto__")).toBe(true);
    expect((built.value as Record<string, unknown>).__proto__).toBe("not a prototype");
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("draftFrom keeps a __proto__ key of a default value as an own key", () => {
    const root = formFor(evilSchema);
    const f = child(root, "__proto__");
    const d = draftFrom(f, "v") as unknown;
    expect(d).toBe("v");
    const obj = draftFrom(root, JSON.parse('{"__proto__": {"polluted": true}}')) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(obj, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
