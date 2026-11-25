// JSON Schema -> form model, and the form's draft back to tool arguments.
// Pure, no React. Handles what tool schemas use in practice: strings, numbers,
// integers, booleans, enums, arrays, nested objects, nullable unions
// (anyOf/oneOf with null, or type arrays). Anything else becomes a JSON field.
import { t } from "../i18n";
import type { JsonSchema } from "./types";

export type FieldKind =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "array"
  | "object"
  | "json";

export interface Field {
  key: string;
  /** Dotted path from the root, for errors and element ids. */
  path: string;
  kind: FieldKind;
  label: string;
  description: string | null;
  required: boolean;
  nullable: boolean;
  schema: JsonSchema;
  /** enum fields */
  options?: unknown[];
  /** array fields */
  item?: Field;
  /** object fields */
  fields?: Field[];
  /** string fields: a long text box */
  multiline?: boolean;
  /** string fields: input type hint */
  inputType?: "text" | "url" | "email" | "date" | "datetime-local";
}

export interface FieldError {
  path: string;
  message: string;
}

/** Draft values: strings for text and numbers (what the input holds), booleans, arrays, records. */
export type Draft = unknown;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function humanize(key: string): string {
  const s = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/** Strip null from unions and type arrays; merge a single allOf. */
export function resolveSchema(input: JsonSchema): {
  schema: JsonSchema;
  nullable: boolean;
  ambiguous: boolean;
} {
  let schema: JsonSchema = { ...input };
  let nullable = false;
  let ambiguous = false;

  if (Array.isArray(schema.allOf) && schema.allOf.length === 1 && schema.allOf[0]) {
    const { allOf, ...rest } = schema;
    schema = { ...(allOf[0] as JsonSchema), ...rest };
  }

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const isNull = (s: JsonSchema) =>
      s.type === "null" || (s.const === null && s.type === undefined);
    const rest = union.filter((s) => !isNull(s));
    nullable = rest.length < union.length;
    const { anyOf: _a, oneOf: _o, ...outer } = schema;
    if (rest.length === 1 && rest[0]) {
      schema = { ...rest[0], ...outer };
    } else if (rest.length > 1 && rest.every((s) => s.const !== undefined)) {
      schema = { ...outer, enum: rest.map((s) => s.const) };
    } else {
      schema = outer;
      ambiguous = true;
    }
  }

  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t) => t !== "null");
    if (types.length < schema.type.length) nullable = true;
    if (types.length === 1) schema = { ...schema, type: types[0] };
    else {
      schema = { ...schema, type: undefined };
      ambiguous = true;
    }
  }

  if (schema.const !== undefined && schema.enum === undefined)
    schema = { ...schema, enum: [schema.const] };
  if (Array.isArray(schema.enum)) {
    const opts = schema.enum.filter((v) => v !== null);
    if (opts.length < schema.enum.length) nullable = true;
    schema = { ...schema, enum: opts };
  }
  return { schema, nullable, ambiguous };
}

export function fieldFor(key: string, input: JsonSchema, required: boolean, parent = ""): Field {
  const { schema, nullable, ambiguous } = resolveSchema(input ?? {});
  const path = parent ? `${parent}.${key}` : key;
  const base = {
    key,
    path,
    label: typeof schema.title === "string" && schema.title ? schema.title : humanize(key),
    description: typeof schema.description === "string" ? schema.description : null,
    required,
    nullable,
    schema,
  };

  if (ambiguous) return { ...base, kind: "json" };
  if (Array.isArray(schema.enum) && schema.enum.length > 0)
    return { ...base, kind: "enum", options: schema.enum };

  const type = schema.type ?? (schema.properties ? "object" : undefined);
  switch (type) {
    case "string": {
      const fmt = schema.format;
      const inputType =
        fmt === "uri" || fmt === "url"
          ? "url"
          : fmt === "email"
            ? "email"
            : fmt === "date"
              ? "date"
              : "text";
      const name = key.toLowerCase();
      const multiline =
        (typeof schema.maxLength === "number" && schema.maxLength > 300) ||
        /prompt|text|description|content|body|message|script|markdown|html/.test(name);
      return { ...base, kind: "string", inputType, multiline: multiline && inputType === "text" };
    }
    case "number":
      return { ...base, kind: "number" };
    case "integer":
      return { ...base, kind: "integer" };
    case "boolean":
      return { ...base, kind: "boolean" };
    case "array": {
      const items = schema.items;
      if (!items || Array.isArray(items)) return { ...base, kind: "json" };
      const item = fieldFor("item", items, true, path);
      if (item.kind === "json" || item.kind === "array") return { ...base, kind: "json" };
      return { ...base, kind: "array", item };
    }
    case "object": {
      const props = schema.properties;
      if (!props || Object.keys(props).length === 0) return { ...base, kind: "json" };
      const req = new Set(schema.required ?? []);
      return {
        ...base,
        kind: "object",
        fields: Object.entries(props).map(([k, s]) => fieldFor(k, s, req.has(k), path)),
      };
    }
    default:
      return { ...base, kind: "json" };
  }
}

/** The root field of a tool's input schema (always an object). */
export function formFor(schema: JsonSchema): Field {
  const f = fieldFor("", { type: "object", ...schema }, true);
  if (f.kind === "object") return { ...f, label: t("schemaForm.arguments") };
  return { ...f, kind: "object", fields: [], label: t("schemaForm.arguments") };
}

export const enumKey = (v: unknown): string => JSON.stringify(v);

/** Draft for a value (a default, or arguments typed as JSON). */
export function draftFrom(field: Field, value: unknown): Draft {
  switch (field.kind) {
    case "string":
      return typeof value === "string"
        ? value
        : value === undefined || value === null
          ? ""
          : String(value);
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : typeof value === "string"
          ? value
          : "";
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "enum":
      return value === undefined || value === null ? "" : enumKey(value);
    case "array": {
      const item = field.item as Field;
      if (!Array.isArray(value)) return [];
      return value.map((v) => draftFrom(item, v));
    }
    case "object": {
      const src = isObj(value) ? value : {};
      // Null-prototype: a schema property named "__proto__" stays an own key.
      const out: Record<string, Draft> = Object.create(null) as Record<string, Draft>;
      for (const f of field.fields ?? []) out[f.key] = draftFrom(f, src[f.key]);
      return out;
    }
    case "json":
      return value === undefined ? "" : JSON.stringify(value, null, 2);
  }
}

/** The starting draft: every declared default filled in. */
export function initialDraft(field: Field): Draft {
  if (field.kind === "object") {
    // Null-prototype: a schema property named "__proto__" stays an own key.
    const out: Record<string, Draft> = Object.create(null) as Record<string, Draft>;
    const defaults = isObj(field.schema.default) ? field.schema.default : {};
    for (const f of field.fields ?? []) {
      out[f.key] =
        f.kind === "object" ? initialDraft(f) : draftFrom(f, f.schema.default ?? defaults[f.key]);
    }
    return out;
  }
  return draftFrom(field, field.schema.default);
}

export interface Built {
  /** undefined: left out of the arguments. */
  value: unknown;
  errors: FieldError[];
}

/** Draft -> arguments. Empty optional values are left out, so the tool's own defaults apply. */
export function buildValue(field: Field, draft: Draft): Built {
  const err = (message: string): Built => ({
    value: undefined,
    errors: [{ path: field.path, message }],
  });
  const empty = (): Built =>
    field.required ? err(t("schemaForm.errors.required")) : { value: undefined, errors: [] };

  switch (field.kind) {
    case "string": {
      const s = typeof draft === "string" ? draft : "";
      if (s === "") return empty();
      return { value: s, errors: [] };
    }
    case "number":
    case "integer": {
      const s = typeof draft === "string" ? draft.trim() : "";
      if (s === "") return empty();
      const n = Number(s);
      if (!Number.isFinite(n)) return err(t("schemaForm.errors.enterNumber"));
      if (field.kind === "integer" && !Number.isInteger(n))
        return err(t("schemaForm.errors.wholeNumber"));
      const { minimum, maximum } = field.schema;
      if (typeof minimum === "number" && n < minimum)
        return err(t("schemaForm.errors.min", { min: minimum }));
      if (typeof maximum === "number" && n > maximum)
        return err(t("schemaForm.errors.max", { max: maximum }));
      return { value: n, errors: [] };
    }
    case "boolean":
      if (typeof draft !== "boolean")
        return field.required ? { value: false, errors: [] } : { value: undefined, errors: [] };
      return { value: draft, errors: [] };
    case "enum": {
      const s = typeof draft === "string" ? draft : "";
      if (s === "") return empty();
      const found = (field.options ?? []).find((o) => enumKey(o) === s);
      if (found === undefined) return err(t("schemaForm.errors.chooseOption"));
      return { value: found, errors: [] };
    }
    case "array": {
      const list = Array.isArray(draft) ? draft : [];
      const item = field.item as Field;
      const values: unknown[] = [];
      const errors: FieldError[] = [];
      list.forEach((d, i) => {
        const b = buildValue({ ...item, path: `${field.path}.${i}`, required: false }, d);
        errors.push(...b.errors);
        if (b.value !== undefined) values.push(b.value);
      });
      if (values.length === 0 && errors.length === 0) return empty();
      return { value: values, errors };
    }
    case "object": {
      const src = isObj(draft) ? draft : {};
      // Null-prototype: a schema property named "__proto__" stays an own key.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const errors: FieldError[] = [];
      for (const f of field.fields ?? []) {
        const b = buildValue(f, src[f.key]);
        errors.push(...b.errors);
        if (b.value !== undefined) out[f.key] = b.value;
      }
      // The root (path "") is always sent, even empty.
      if (field.path !== "" && Object.keys(out).length === 0 && errors.length === 0) return empty();
      return { value: out, errors };
    }
    case "json": {
      const s = typeof draft === "string" ? draft.trim() : "";
      if (s === "") return empty();
      try {
        return { value: JSON.parse(s), errors: [] };
      } catch {
        return err(t("schemaForm.errors.invalidJson"));
      }
    }
  }
}

/** Whether every field of a form renders as a real control (no JSON fallback). */
export function isSimple(field: Field): boolean {
  if (field.kind === "json") return false;
  if (field.kind === "object") return (field.fields ?? []).every(isSimple);
  if (field.kind === "array") return field.item ? isSimple(field.item) : false;
  return true;
}

const SETTING_TYPES = new Set(["string", "number", "integer", "boolean"]);

/**
 * A pack's settings schema made safe for the form: a list setting (a list of
 * strings, or of another plain type) gets an add/remove list, and a setting
 * whose type the form does not know becomes a plain text field instead of a
 * JSON box or a crash.
 */
export function normalizeSettingsSchema(schema: JsonSchema): JsonSchema {
  const props = schema.properties ?? {};
  // Null-prototype: a setting named "__proto__" stays an own key.
  const out: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>;
  for (const [key, raw] of Object.entries(props)) {
    const p: JsonSchema = raw && typeof raw === "object" ? { ...raw } : {};
    const type = typeof p.type === "string" ? p.type : undefined;
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      out[key] = p;
    } else if (type === "array") {
      const items =
        p.items && typeof p.items === "object" && !Array.isArray(p.items) ? p.items : null;
      const itemType = items && typeof items.type === "string" ? items.type : undefined;
      const plainItems =
        items &&
        ((itemType && SETTING_TYPES.has(itemType)) ||
          (Array.isArray(items.enum) && items.enum.length > 0));
      out[key] = { ...p, items: plainItems && items ? items : { type: "string" } };
    } else if (!type || !SETTING_TYPES.has(type)) {
      const { type: _drop, items: _items, properties: _props, ...rest } = p;
      out[key] = { ...rest, type: "string" };
    } else {
      out[key] = p;
    }
  }
  return { ...schema, type: "object", properties: out };
}

/** The daemon's limits for a list setting. */
export const LIST_SETTING_MAX_ITEMS = 256;
export const LIST_SETTING_MAX_CHARS = 1024;

/**
 * The PUT /api/packs/:id/settings body from a built settings form. A value
 * equal to its default (or an empty list with no default) is sent as null,
 * which clears it; an emptied list with a non-empty default is sent as [].
 * List items are trimmed, blank ones dropped, and the daemon's limits checked
 * here so the person sees the problem next to the field.
 */
export function settingsPayload(
  root: Field,
  built: Record<string, unknown>,
): { values: Record<string, unknown>; errors: FieldError[] } {
  // Null-prototype: a setting named "__proto__" stays an own key.
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const f of root.fields ?? []) {
    let v = built[f.key];
    if (f.kind === "array") {
      const list = Array.isArray(v) ? v : [];
      v = list.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "");
      const items = v as unknown[];
      if (items.length > LIST_SETTING_MAX_ITEMS)
        errors.push({
          path: f.path,
          message: t("schemaForm.errors.maxItems", { max: LIST_SETTING_MAX_ITEMS }),
        });
      const long = items.findIndex(
        (x) => typeof x === "string" && x.length > LIST_SETTING_MAX_CHARS,
      );
      if (long >= 0)
        errors.push({
          path: `${f.path}.${long}`,
          message: t("schemaForm.errors.maxChars", { max: LIST_SETTING_MAX_CHARS }),
        });
    }
    const def = f.schema.default;
    const unset =
      v === undefined ||
      sameSettingValue(v, def) ||
      (def === undefined && Array.isArray(v) && v.length === 0);
    values[f.key] = unset ? null : v;
  }
  return { values, errors };
}

/** Equality for setting values: lists and objects compare by content. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a !== null && typeof a === "object") || (b !== null && typeof b === "object"))
    return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
