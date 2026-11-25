// One secret: present or not, where it comes from, set / replace / remove.
// The value is sent once on save and never shown again.
import { type FormEvent, useId, useState } from "react";
import { t } from "../i18n";
import { api, errorMessage } from "../lib/api";
import type { SecretRow } from "../lib/types";
import { Dialog } from "./Dialog";
import { useToast } from "./Toast";
import { Badge, Button, ExternalLink, PasswordInput } from "./ui";

/** The source value ("keychain", "file", ...) -> its message key. */
const SOURCE_KEY: Record<string, string> = {
  keychain: "packs.secret.source.keychain",
  file: "packs.secret.source.file",
  memory: "packs.secret.source.memory",
  env: "packs.secret.source.env",
};

export function sourceLabel(source: string | null): string {
  if (!source) return "";
  const key = SOURCE_KEY[source];
  return key ? t(key) : source;
}

export async function saveSecret(pack: string, name: string, value: string): Promise<void> {
  await api.put(`/api/secrets/${encodeURIComponent(pack)}/${encodeURIComponent(name)}`, { value });
}

export function SecretEditor({
  row,
  onChanged,
  compact,
  autoOpen,
  focusOnOpen,
}: {
  row: SecretRow;
  onChanged: (row: SecretRow, action: "set" | "removed") => void;
  compact?: boolean;
  autoOpen?: boolean;
  /** Focus the key field when it opens on its own (autoOpen). */
  focusOnOpen?: boolean;
}) {
  const toast = useToast();
  const id = useId();
  const [editing, setEditing] = useState(!!autoOpen && !row.present);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const label = row.label ?? row.name;
  const fromEnv = row.source === "env";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) {
      setError(t("packs.secret.errorPasteFirst"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveSecret(row.pack, row.name, v);
      setValue("");
      setEditing(false);
      toast.ok(t("packs.secret.saved", { label }));
      onChanged(
        { ...row, present: true, source: row.source && row.source !== "env" ? row.source : null },
        "set",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/secrets/${encodeURIComponent(row.pack)}/${encodeURIComponent(row.name)}`);
      toast.ok(t("packs.secret.removed", { label }));
      setConfirmDelete(false);
      onChanged({ ...row, present: false, source: null }, "removed");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`secret ${compact ? "secret-compact" : ""}`}>
      <div className="secret-head">
        <div className="secret-name">
          <span className="secret-label">{label}</span>
          <code className="muted small">{row.name}</code>
        </div>
        <div className="secret-status">
          {row.present ? (
            <Badge tone="ok" dot>
              {t("packs.secret.set")}
              {row.source ? t("packs.secret.setIn", { source: sourceLabel(row.source) }) : ""}
            </Badge>
          ) : compact ? null : row.required ? (
            <Badge tone="warn" dot>
              {t("packs.secret.notSet")}
            </Badge>
          ) : (
            <Badge dot>{t("packs.secret.notSetOptional")}</Badge>
          )}
          {!row.granted ? <Badge tone="warn">{t("packs.secret.notGranted")}</Badge> : null}
        </div>
      </div>
      {editing ? (
        <form className="secret-form" onSubmit={submit} noValidate>
          <label htmlFor={id} className="visually-hidden">
            {label}
          </label>
          <PasswordInput
            id={id}
            label={label}
            value={value}
            onChange={(v) => {
              setValue(v);
              setError(null);
            }}
            placeholder={
              row.present ? t("packs.secret.placeholderNew") : t("packs.secret.placeholderFirst")
            }
            autoFocus={!autoOpen || focusOnOpen}
            invalid={!!error}
            describedBy={error ? `${id}-error` : undefined}
          />
          <Button type="submit" variant="primary" busy={busy}>
            {t("packs.secret.save")}
          </Button>
          {row.present || !autoOpen ? (
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue("");
                setError(null);
              }}
            >
              {t("packs.secret.cancel")}
            </Button>
          ) : null}
          {row.help_url ? (
            <span className="secret-help">
              <ExternalLink href={row.help_url}>{t("packs.secret.getKey")}</ExternalLink>
            </span>
          ) : null}
          {error ? (
            <p className="field-error secret-error" id={`${id}-error`} role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <div className="secret-actions">
          <Button
            size="sm"
            variant={row.present ? "secondary" : "primary"}
            icon="key"
            onClick={() => setEditing(true)}
            aria-label={
              row.present
                ? t("packs.secret.replaceAria", { label })
                : t("packs.secret.setAria", { label })
            }
          >
            {row.present ? t("packs.secret.replace") : t("packs.secret.setKey")}
          </Button>
          {row.present && !fromEnv ? (
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={() => setConfirmDelete(true)}
              aria-label={t("packs.secret.removeAria", { label })}
            >
              {t("packs.secret.remove")}
            </Button>
          ) : null}
          {row.help_url ? (
            <ExternalLink href={row.help_url}>{t("packs.secret.getKey")}</ExternalLink>
          ) : null}
        </div>
      )}
      {fromEnv ? <p className="muted small">{t("packs.secret.envNote")}</p> : null}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t("packs.secret.removeTitle", { label })}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} data-autofocus>
              {t("packs.secret.keepIt")}
            </Button>
            <Button variant="danger" busy={busy} onClick={remove}>
              {t("packs.secret.removeKey")}
            </Button>
          </>
        }
      >
        <p>{t("packs.secret.removeBody")}</p>
      </Dialog>
    </div>
  );
}
