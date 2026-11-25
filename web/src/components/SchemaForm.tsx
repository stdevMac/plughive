// Renders a form model from lib/schemaForm. The parent owns the draft.
import { useId } from "react";
import { t } from "../i18n";
import {
  type Draft,
  type Field,
  type FieldError,
  draftFrom,
  enumKey,
  initialDraft,
} from "../lib/schemaForm";
import { Icon } from "./Icon";
import { Button, IconButton } from "./ui";

interface Props {
  field: Field;
  draft: Draft;
  onChange: (d: Draft) => void;
  errors: FieldError[];
  idPrefix: string;
}

const optionLabel = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function errorFor(errors: FieldError[], path: string): string | null {
  return errors.find((e) => e.path === path)?.message ?? null;
}

function Label({ field, id }: { field: Field; id: string }) {
  return (
    <label htmlFor={id} className="field-label">
      {field.label}
      {field.required ? <span className="field-req">{t("schemaForm.required")}</span> : null}
      <code className="field-key">{field.key}</code>
    </label>
  );
}

function Description({ field, id }: { field: Field; id: string }) {
  if (!field.description) return null;
  return (
    <p className="field-hint" id={`${id}-hint`}>
      {field.description}
    </p>
  );
}

function Leaf({ field, draft, onChange, errors, idPrefix }: Props) {
  const id = `${idPrefix}-${field.path || "root"}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const error = errorFor(errors, field.path);
  const describedBy =
    [field.description ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") ||
    undefined;
  const common = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
  };

  let control: JSX.Element;
  switch (field.kind) {
    case "string": {
      const v = typeof draft === "string" ? draft : "";
      const ph =
        Array.isArray(field.schema.examples) && typeof field.schema.examples[0] === "string"
          ? t("schemaForm.example", { example: field.schema.examples[0] })
          : undefined;
      control = field.multiline ? (
        <textarea
          className="input textarea"
          rows={3}
          value={v}
          placeholder={ph}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        />
      ) : (
        <input
          className="input"
          type={field.inputType ?? "text"}
          value={v}
          placeholder={ph}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        />
      );
      break;
    }
    case "number":
    case "integer": {
      const v = typeof draft === "string" ? draft : "";
      const { minimum, maximum } = field.schema;
      control = (
        <input
          className="input input-num"
          type="number"
          inputMode={field.kind === "integer" ? "numeric" : "decimal"}
          step={field.kind === "integer" ? 1 : "any"}
          min={typeof minimum === "number" ? minimum : undefined}
          max={typeof maximum === "number" ? maximum : undefined}
          value={v}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        />
      );
      break;
    }
    case "boolean": {
      const checked = draft === true;
      return (
        <div className={`field field-check ${error ? "field-invalid" : ""}`}>
          <label className="check" htmlFor={id}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onChange(e.target.checked)}
              {...common}
            />
            <span>
              {field.label}
              <code className="field-key">{field.key}</code>
            </span>
          </label>
          <Description field={field} id={id} />
        </div>
      );
    }
    case "enum": {
      const v = typeof draft === "string" ? draft : "";
      control = (
        <select
          className="input select"
          value={v}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        >
          {field.required && v !== "" ? null : (
            <option value="">
              {field.required ? t("schemaForm.choose") : t("schemaForm.notSet")}
            </option>
          )}
          {(field.options ?? []).map((o) => (
            <option key={enumKey(o)} value={enumKey(o)}>
              {optionLabel(o)}
            </option>
          ))}
        </select>
      );
      break;
    }
    case "json": {
      const v = typeof draft === "string" ? draft : "";
      control = (
        <textarea
          className="input textarea input-mono"
          rows={4}
          spellCheck={false}
          value={v}
          placeholder={t("schemaForm.jsonPlaceholder")}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        />
      );
      break;
    }
    default:
      return null;
  }

  return (
    <div className={`field ${error ? "field-invalid" : ""}`}>
      <Label field={field} id={id} />
      {control}
      <Description field={field} id={id} />
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ArrayField({ field, draft, onChange, errors, idPrefix }: Props) {
  const list = Array.isArray(draft) ? draft : [];
  const item = field.item as Field;
  const gid = useId();
  const error = errorFor(errors, field.path);

  // An array of enum values: one checkbox per option.
  if (item.kind === "enum") {
    const chosen = new Set(list as string[]);
    return (
      <fieldset
        className="field fieldset"
        aria-describedby={field.description ? `${gid}-hint` : undefined}
      >
        <legend className="field-label">
          {field.label}
          {field.required ? <span className="field-req">{t("schemaForm.required")}</span> : null}
          <code className="field-key">{field.key}</code>
        </legend>
        <div className="check-grid">
          {(item.options ?? []).map((o) => {
            const k = enumKey(o);
            return (
              <label key={k} className="check">
                <input
                  type="checkbox"
                  checked={chosen.has(k)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(k);
                    else next.delete(k);
                    onChange((item.options ?? []).map(enumKey).filter((x) => next.has(x)));
                  }}
                />
                <span>{optionLabel(o)}</span>
              </label>
            );
          })}
        </div>
        {field.description ? (
          <p className="field-hint" id={`${gid}-hint`}>
            {field.description}
          </p>
        ) : null}
        {error ? <p className="field-error">{error}</p> : null}
      </fieldset>
    );
  }

  return (
    <fieldset className="field fieldset">
      <legend className="field-label">
        {field.label}
        {field.required ? <span className="field-req">{t("schemaForm.required")}</span> : null}
        <code className="field-key">{field.key}</code>
      </legend>
      {field.description ? <p className="field-hint">{field.description}</p> : null}
      <ol className="array-items">
        {list.map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond their position
          <li key={i} className="array-item">
            <div className="array-item-body">
              <FieldView
                field={{
                  ...item,
                  key: `${i + 1}`,
                  label: t("schemaForm.item", { index: i + 1 }),
                  path: `${field.path}.${i}`,
                  required: false,
                }}
                draft={d}
                onChange={(v) => onChange(list.map((x, j) => (j === i ? v : x)))}
                errors={errors}
                idPrefix={idPrefix}
              />
            </div>
            <IconButton
              icon="trash"
              size="sm"
              label={t("schemaForm.removeItem", { index: i + 1, label: field.label })}
              onClick={() => onChange(list.filter((_, j) => j !== i))}
            />
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        icon="plus"
        onClick={() =>
          onChange([
            ...list,
            item.kind === "object" ? initialDraft(item) : draftFrom(item, undefined),
          ])
        }
      >
        {list.length ? t("schemaForm.addAnother") : t("schemaForm.addFirst")}
      </Button>
      {error ? <p className="field-error">{error}</p> : null}
    </fieldset>
  );
}

function ObjectField({ field, draft, onChange, errors, idPrefix }: Props) {
  const src =
    draft && typeof draft === "object" && !Array.isArray(draft)
      ? (draft as Record<string, Draft>)
      : {};
  const fields = field.fields ?? [];
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);
  const render = (f: Field) => (
    <FieldView
      key={f.key}
      field={f}
      draft={src[f.key]}
      onChange={(v) => onChange({ ...src, [f.key]: v })}
      errors={errors}
      idPrefix={idPrefix}
    />
  );
  if (field.path === "") {
    if (fields.length === 0) return <p className="muted">{t("schemaForm.noArguments")}</p>;
    return (
      <div className="form-fields">
        {required.map(render)}
        {optional.length > 0 && required.length > 0 ? (
          <details className="optional-fields" open={optional.length <= 4}>
            <summary>
              <Icon name="chevronRight" className="details-chevron" />
              {t("schemaForm.optional", { count: optional.length })}
            </summary>
            <div className="form-fields">{optional.map(render)}</div>
          </details>
        ) : (
          optional.map(render)
        )}
      </div>
    );
  }
  return (
    <fieldset className="field fieldset">
      <legend className="field-label">
        {field.label}
        {field.required ? <span className="field-req">{t("schemaForm.required")}</span> : null}
        <code className="field-key">{field.key}</code>
      </legend>
      {field.description ? <p className="field-hint">{field.description}</p> : null}
      <div className="form-fields">{fields.map(render)}</div>
    </fieldset>
  );
}

export function FieldView(props: Props) {
  if (props.field.kind === "object") return <ObjectField {...props} />;
  if (props.field.kind === "array") return <ArrayField {...props} />;
  return <Leaf {...props} />;
}

export function SchemaForm(props: Props) {
  return <FieldView {...props} />;
}
