// Keys & packs: what each pack does, what it may touch, its settings and keys.
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Icon } from "../components/Icon";
import { SchemaForm } from "../components/SchemaForm";
import { SecretEditor } from "../components/SecretEditor";
import { storageState } from "../components/StorageNote";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  InlineAlert,
  Loading,
  PageHeader,
  SearchInput,
  Switch,
} from "../components/ui";
import { t } from "../i18n";
import { ApiError, api, errorMessage } from "../lib/api";
import { useApp } from "../lib/app-context";
import { capabilityLabel } from "../lib/capabilities";
import { useEvent } from "../lib/events";
import { displayName } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import {
  describePermissions,
  initialConsentGrants,
  isBundled,
  packStateLabel,
  toggleConsentGrant,
} from "../lib/packs";
import { Link, useRouter } from "../lib/router";
import {
  type Draft,
  type FieldError,
  buildValue,
  draftFrom,
  formFor,
  normalizeSettingsSchema,
  settingsPayload,
} from "../lib/schemaForm";
import type { JsonSchema, PackConsent, PackSettings, PackStatus, SecretRow } from "../lib/types";

// ---- consent -------------------------------------------------------------------

function ConsentDialog({
  pack,
  open,
  onClose,
  onEnabled,
}: {
  pack: PackStatus;
  open: boolean;
  onClose: () => void;
  onEnabled: (p: PackStatus | null) => void;
}) {
  const consent = useResource(
    async (signal) =>
      open
        ? (
            await api.get<{ consent: PackConsent }>(
              `/api/packs/${encodeURIComponent(pack.id)}/consent`,
              undefined,
              signal,
            )
          ).consent
        : null,
    [open, pack.id],
  );
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = consent.data;

  useEffect(() => {
    if (c) setGrants(initialConsentGrants(c.secrets));
    setError(null);
  }, [c]);

  const enable = async () => {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ pack: PackStatus | null }>(
        `/api/packs/${encodeURIComponent(pack.id)}/enable`,
        {
          grants: [...grants],
          manifestHash: c.manifestHash,
          entryHash: c.entryHash,
        },
      );
      onEnabled(r.pack);
    } catch (e) {
      if (e instanceof ApiError && e.code === "PACK_CHANGED") {
        setError(t("packs.consent.errorChanged"));
        await consent.reload();
      } else if (e instanceof ApiError && e.code === "CONSENT_REQUIRED") {
        setError(t("packs.consent.errorConsentRequired"));
        await consent.reload();
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("packs.consent.title", { name: pack.name })}
      description={t("packs.consent.description")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("packs.consent.cancel")}
          </Button>
          <Button
            variant={c?.highRisk ? "danger" : "primary"}
            busy={busy}
            disabled={!c}
            onClick={enable}
          >
            {c?.highRisk ? t("packs.consent.confirmHighRisk") : t("packs.consent.confirm")}
          </Button>
        </>
      }
    >
      {consent.loading && !c ? (
        <Loading lines={4} label={t("packs.consent.loading")} />
      ) : consent.error ? (
        <ErrorState error={consent.error} onRetry={consent.reload} />
      ) : c ? (
        <div className="consent">
          {c.highRisk ? (
            <InlineAlert tone="danger" title={t("packs.consent.broadAccessTitle")}>
              {t("packs.consent.broadAccessBody")}
            </InlineAlert>
          ) : null}
          {c.runsCode !== false ? (
            <InlineAlert tone="warn" title={t("packs.consent.fullRightsTitle")}>
              {t("packs.consent.fullRightsBody")}
            </InlineAlert>
          ) : null}
          <p className="small muted">
            {t("packs.consent.meta", { name: c.name, version: c.version })}
          </p>
          <h3 className="h-sub">{t("packs.consent.mayTitle")}</h3>
          <ul className="perm-list">
            {c.items.length === 0 ? <li>{t("packs.consent.mayNothing")}</li> : null}
            {c.items.map((it) => (
              <li key={`${it.kind}:${it.text}`} className={it.risk === "high" ? "perm-risk" : ""}>
                <Icon name={it.risk === "high" ? "alert" : "check"} />
                <span>{it.text}</span>
              </li>
            ))}
          </ul>
          {c.secrets.length > 0 ? (
            <>
              <h3 className="h-sub">{t("packs.consent.keysTitle")}</h3>
              <p className="small muted">{t("packs.consent.keysHint")}</p>
              <ul className="grant-list">
                {c.secrets.map((s) => {
                  // The same notes the CLI and the daemon give; a bundled pack
                  // owns its keys, so sharing and stored values only matter for
                  // a user pack.
                  const grantable = s.grantable !== false;
                  const userPack = c.source === "user";
                  const declaredBy = userPack ? (s.declaredBy ?? []) : [];
                  return (
                    <li key={s.name}>
                      <label className="check">
                        <input
                          type="checkbox"
                          disabled={!grantable}
                          checked={grantable && grants.has(s.name)}
                          onChange={(e) =>
                            setGrants((g) => toggleConsentGrant(g, s, e.target.checked))
                          }
                        />
                        <span>
                          {s.label ?? s.name} <code className="small muted">{s.name}</code>
                          {s.required ? (
                            <span className="small muted">{t("packs.consent.requiredSuffix")}</span>
                          ) : null}
                        </span>
                      </label>
                      {!grantable ? (
                        <p className="small perm-risk">{t("packs.consent.notGrantable")}</p>
                      ) : null}
                      {declaredBy.length > 0 ? (
                        <p className="small perm-risk">
                          {t("packs.consent.declaredBy", { packs: declaredBy.join(", ") })}
                        </p>
                      ) : null}
                      {userPack && s.stored ? (
                        <p className="small muted">{t("packs.consent.stored")}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

// ---- settings ------------------------------------------------------------------

function SettingsForm({ pack }: { pack: PackStatus }) {
  const toast = useToast();
  const { catalogChanged } = useApp();
  const settings = useResource(
    (signal) =>
      api.get<PackSettings>(
        `/api/packs/${encodeURIComponent(pack.id)}/settings`,
        undefined,
        signal,
      ),
    [pack.id],
  );
  const field = useMemo(
    () =>
      settings.data?.schema
        ? formFor(normalizeSettingsSchema(settings.data.schema as unknown as JsonSchema))
        : null,
    [settings.data?.schema],
  );
  const [draft, setDraft] = useState<Draft>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (field && settings.data) {
      // Show saved values, and the defaults for anything not set.
      const merged: Record<string, unknown> = {};
      for (const f of field.fields ?? [])
        merged[f.key] = settings.data.values[f.key] ?? f.schema.default;
      setDraft(draftFrom(field, merged));
      setErrors([]);
    }
  }, [field, settings.data]);

  if (settings.loading && !settings.data) return <Loading lines={2} />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={settings.reload} />;
  if (!field || !(field.fields?.length ?? 0)) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const built = buildValue(field, draft);
    setErrors(built.errors);
    if (built.errors.length) return;
    const { values, errors: limitErrors } = settingsPayload(
      field,
      (built.value ?? {}) as Record<string, unknown>,
    );
    setErrors(limitErrors);
    if (limitErrors.length) return;
    setBusy(true);
    try {
      const r = await api.put<PackSettings>(`/api/packs/${encodeURIComponent(pack.id)}/settings`, {
        values,
      });
      settings.mutate(r);
      toast.ok(t("packs.settings.saved", { name: pack.name }));
      catalogChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="detail-section" aria-labelledby={`settings-${pack.id}`}>
      <h3 className="h-sub" id={`settings-${pack.id}`}>
        {t("packs.settings.title")}
      </h3>
      <form onSubmit={submit} noValidate className="settings-form">
        <SchemaForm
          field={{ ...field, required: true }}
          draft={draft}
          onChange={setDraft}
          errors={errors}
          idPrefix={`set-${pack.id}`}
        />
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={busy}>
            {t("packs.settings.save")}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---- detail --------------------------------------------------------------------

function PackDetail({
  pack,
  secrets,
  backend,
  openKey,
  onChanged,
  onSecretChanged,
}: {
  pack: PackStatus;
  secrets: SecretRow[];
  backend: string | undefined;
  /** Open the first missing key's field on arrival (?key=1 or ?missing=1). */
  openKey: boolean;
  onChanged: (p: PackStatus | null) => void;
  onSecretChanged: () => void;
}) {
  const toast = useToast();
  const { catalogChanged, info } = useApp();
  const [busy, setBusy] = useState(false);
  const keyOpen = openKey ? 1 : 0;
  const firstMissing =
    secrets.find((s) => s.required && !s.present) ??
    (secrets.every((s) => !s.present) ? secrets[0] : undefined);
  const storage = storageState(backend, info?.secrets_storage);
  const [consentOpen, setConsentOpen] = useState(false);
  const state = packStateLabel(pack);
  const perms = describePermissions(pack.permissions);

  const setEnabled = async (on: boolean, undo = false) => {
    if (on && !isBundled(pack)) {
      setConsentOpen(true);
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ pack: PackStatus | null }>(
        `/api/packs/${encodeURIComponent(pack.id)}/${on ? "enable" : "disable"}`,
        {},
      );
      onChanged(r.pack);
      catalogChanged();
      if (!on && !undo && isBundled(pack)) {
        // Turning a pack off removes its tools from every agent at once: offer a way back.
        toast.show({
          tone: "ok",
          text: t("packs.detail.turnedOffUndo", { name: pack.name }),
          action: { label: t("packs.detail.undo"), onClick: () => void setEnabled(true, true) },
          duration: 8000,
        });
      } else
        toast.ok(
          on
            ? t("packs.detail.turnedOn", { name: pack.name })
            : t("packs.detail.turnedOff", { name: pack.name }),
        );
    } catch (e) {
      if (e instanceof ApiError && e.code === "CONSENT_REQUIRED") setConsentOpen(true);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ pack: PackStatus | null }>(
        `/api/packs/${encodeURIComponent(pack.id)}/reload`,
        {},
      );
      onChanged(r.pack);
      catalogChanged();
      toast.ok(t("packs.detail.reloaded", { name: pack.name }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card pack-detail" aria-labelledby="pack-detail-title">
      <div className="pack-detail-head">
        <div>
          <h2 className="card-title" id="pack-detail-title">
            {pack.name}
          </h2>
          <p className="small muted pack-detail-meta">
            <span title={t("packs.detail.versionTitle", { version: pack.version })}>
              {isBundled(pack) ? t("packs.detail.builtin") : t("packs.detail.yourPack")}
            </span>{" "}
            · <code>{pack.id}</code>
            <CopyButton
              text={pack.id}
              what={t("packs.detail.packId")}
              iconOnly
              size="sm"
              variant="ghost"
            />
          </p>
        </div>
        <div className="pack-detail-actions">
          {/* The switch already says on or off; a badge only for what differs (needs review, failed). */}
          {pack.state === "loaded" || !pack.enabled ? null : (
            <Badge tone={state.tone} dot>
              {state.text}
            </Badge>
          )}
          <Switch
            checked={pack.enabled}
            onChange={setEnabled}
            label={
              pack.enabled
                ? t("packs.detail.turnOff", { name: pack.name })
                : t("packs.detail.turnOn", { name: pack.name })
            }
            disabled={busy}
          />
        </div>
      </div>
      {pack.description ? <p>{pack.description}</p> : null}
      {pack.notice ? (
        <InlineAlert tone="info" title={t("packs.detail.noticeTitle")}>
          <p className="small" style={{ whiteSpace: "pre-line" }}>
            {pack.notice}
          </p>
        </InlineAlert>
      ) : null}
      {pack.error ? (
        <InlineAlert tone="danger" title={t("packs.detail.loadErrorTitle")}>
          <p className="mono small">{pack.error}</p>
          <Button size="sm" icon="refresh" onClick={reload} busy={busy}>
            {t("packs.detail.loadAgain")}
          </Button>
        </InlineAlert>
      ) : null}
      {pack.state === "needs-review" ? (
        <InlineAlert tone="warn" title={t("packs.detail.reviewTitle")}>
          {t("packs.detail.reviewBody")}{" "}
          <Button size="sm" onClick={() => setConsentOpen(true)}>
            {t("packs.detail.review")}
          </Button>
        </InlineAlert>
      ) : null}

      <section className="detail-section" aria-labelledby={`perm-${pack.id}`}>
        <h3 className="h-sub" id={`perm-${pack.id}`}>
          {t("packs.detail.permsTitle")}
        </h3>
        <ul className="perm-list">
          {perms.map((p) => (
            <li key={p.text} className={p.risk ? "perm-risk" : ""}>
              <Icon name={p.icon} />
              <span>{p.text}</span>
            </li>
          ))}
        </ul>
      </section>

      {secrets.length > 0 ? (
        <section className="detail-section" aria-labelledby={`keys-${pack.id}`}>
          <h3 className="h-sub" id={`keys-${pack.id}`}>
            {t("packs.detail.keysTitle")}
          </h3>
          <div className="secret-list">
            {secrets.map((s) => (
              <SecretEditor
                key={s === firstMissing ? `${s.name}:${keyOpen}` : s.name}
                row={s}
                autoOpen={s === firstMissing && keyOpen > 0}
                focusOnOpen
                onChanged={() => {
                  onSecretChanged();
                  catalogChanged();
                }}
              />
            ))}
          </div>
          <p className="small muted">
            {storage === "memory" ? (
              <>
                {t("packs.storage.words.memory")}{" "}
                <Link to="/settings">{t("packs.detail.howToKeep")}</Link>
              </>
            ) : storage === "file-plain" ? (
              <>
                {t("packs.storage.plainAlertTitle")}{" "}
                <Link to="/settings">{t("packs.detail.howToFix")}</Link>
              </>
            ) : (
              t("packs.storage.savedKeyNeverShown")
            )}
          </p>
        </section>
      ) : null}

      {pack.enabled && pack.state === "loaded" ? <SettingsForm pack={pack} /> : null}

      {pack.providers.length > 0 ? (
        <section className="detail-section" aria-labelledby={`services-${pack.id}`}>
          <h3 className="h-sub" id={`services-${pack.id}`}>
            {t("packs.detail.servicesTitle", { count: pack.providers.length })}
          </h3>
          <p className="small muted">
            {t("packs.detail.servicesHintBefore")}
            <Link to="/capabilities">{t("packs.detail.servicesHintLink")}</Link>
            {t("packs.detail.servicesHintAfter")}
          </p>
          <ul className="chips">
            {[...new Set(pack.providers.map((p) => p.split(":")[0] ?? p))].map((cap) => (
              <li key={cap}>
                <Link className="chip" to="/capabilities" title={cap}>
                  {capabilityLabel(cap).title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="detail-section" aria-labelledby={`tools-${pack.id}`}>
        <h3 className="h-sub" id={`tools-${pack.id}`}>
          {t("packs.detail.toolsTitle", { count: pack.tools.length })}
        </h3>
        {pack.tools.length === 0 ? (
          <p className="small muted">
            {pack.enabled
              ? pack.providers.length > 0
                ? t("packs.detail.noToolsShared")
                : t("packs.detail.noTools")
              : t("packs.detail.noToolsOff")}
          </p>
        ) : (
          <ul className="chips">
            {pack.tools.map((tool) => (
              <li key={tool}>
                <Link
                  className="chip mono"
                  to={`/playground?tool=${encodeURIComponent(tool)}`}
                  aria-label={t("packs.detail.tryTool", { tool })}
                >
                  {tool}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!isBundled(pack) ? (
        <ConsentDialog
          pack={pack}
          open={consentOpen}
          onClose={() => setConsentOpen(false)}
          onEnabled={(p) => {
            setConsentOpen(false);
            onChanged(p);
            catalogChanged();
            toast.ok(t("packs.detail.turnedOn", { name: pack.name }));
          }}
        />
      ) : null}
    </article>
  );
}

// ---- page ----------------------------------------------------------------------

export function PacksPage() {
  useDocumentTitle(t("packs.page.title"));
  const { query, setQuery } = useRouter();
  const { catalogVersion } = useApp();
  const [search, setSearch] = useState("");
  const wantsMissing = query.get("missing") === "1";
  const wantsKey = query.get("key") === "1" || wantsMissing;
  const data = useResource(
    async (signal) => {
      const [p, s] = await Promise.all([
        api.get<{ packs: PackStatus[] }>("/api/packs", undefined, signal),
        api.get<{ backend: string; secrets: SecretRow[] }>("/api/secrets", undefined, signal),
      ]);
      return { packs: p.packs, secrets: s.secrets, backend: s.backend };
    },
    [catalogVersion],
  );

  useEvent("pack", (e) => {
    data.mutate((d) =>
      d
        ? {
            ...d,
            packs: d.packs.map((p) =>
              p.id === e.id
                ? {
                    ...p,
                    enabled: e.enabled,
                    state: e.state as PackStatus["state"],
                    error: e.error,
                  }
                : p,
            ),
          }
        : d,
    );
  });

  const onlyMissing = wantsMissing;
  const missingPacks = useMemo(
    () =>
      new Set(
        (data.data?.secrets ?? [])
          .filter(
            (s) =>
              s.required && !s.present && data.data?.packs.find((p) => p.id === s.pack)?.enabled,
          )
          .map((s) => s.pack),
      ),
    [data.data],
  );
  const packs = useMemo(() => {
    let list = [...(data.data?.packs ?? [])].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
    );
    if (onlyMissing && missingPacks.size > 0) list = list.filter((p) => missingPacks.has(p.id));
    const q = search.trim().toLowerCase();
    return q
      ? list.filter((p) =>
          `${p.name} ${p.id} ${p.description ?? ""} ${p.tools.join(" ")}`.toLowerCase().includes(q),
        )
      : list;
  }, [data.data, search, onlyMissing, missingPacks]);

  // ?missing=1 with nothing missing among the packs that are on: point at the first pack that takes a key.
  const firstKeyPack = (data.data?.packs ?? []).find((p) =>
    (data.data?.secrets ?? []).some((s) => s.pack === p.id),
  );
  const selectedId =
    query.get("pack") ??
    (wantsMissing && missingPacks.size === 0 ? firstKeyPack?.id : undefined) ??
    packs[0]?.id;
  const selected = data.data?.packs.find((p) => p.id === selectedId) ?? packs[0];

  return (
    <>
      <PageHeader title={t("packs.page.title")} description={t("packs.page.description")} />
      {data.loading && !data.data ? (
        <Loading lines={8} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : (
        <div className="master-detail">
          <div className="master">
            <SearchInput
              value={search}
              onChange={setSearch}
              label={t("packs.page.searchLabel")}
              placeholder={t("packs.page.searchPlaceholder")}
            />
            {missingPacks.size > 0 ? (
              <InlineAlert tone="warn">
                <span className="alert-row">
                  <span>
                    {t("packs.page.missingCount", { count: missingPacks.size })} that{" "}
                    {t("packs.page.missingVerb", { count: missingPacks.size })} on still{" "}
                    {t("packs.page.missingSuffix", { count: missingPacks.size })}.
                  </span>
                  <Button
                    size="sm"
                    aria-pressed={onlyMissing}
                    onClick={() => setQuery({ missing: onlyMissing ? null : "1", key: null })}
                  >
                    {onlyMissing ? t("packs.page.showAll") : t("packs.page.showThese")}
                  </Button>
                </span>
              </InlineAlert>
            ) : null}
            {packs.length === 0 ? (
              <EmptyState icon="package" title={t("packs.page.noMatch")}>
                {t("packs.page.noMatchHint")}
              </EmptyState>
            ) : (
              <ul className="pack-list" aria-label={t("packs.page.listLabel")}>
                {packs.map((p) => {
                  const st = packStateLabel(p);
                  const needsKey = (data.data?.secrets ?? []).some(
                    (s) => s.pack === p.id && s.required && !s.present,
                  );
                  const isSel = p.id === selected?.id;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        className={`pack-item ${isSel ? "pack-item-on" : ""}`}
                        aria-current={isSel ? "true" : undefined}
                        onClick={() => {
                          setQuery({ pack: p.id, key: null });
                          // Stacked layout on a phone: bring the details into view.
                          if (window.matchMedia("(max-width: 700px)").matches)
                            requestAnimationFrame(() => {
                              const top = document
                                .querySelector(".detail")
                                ?.getBoundingClientRect().top;
                              const bar =
                                document.querySelector(".topbar")?.getBoundingClientRect().height ??
                                0;
                              if (top !== undefined) window.scrollBy({ top: top - bar - 12 });
                            });
                        }}
                      >
                        <span className="pack-item-main">
                          <span className="pack-item-name" title={p.name || displayName(p.id)}>
                            {p.name || displayName(p.id)}
                          </span>
                          <span className="pack-item-meta">
                            {p.tools.length === 0 && p.providers.length > 0
                              ? t("packs.page.serviceCount", {
                                  count: new Set(p.providers.map((x) => x.split(":")[0])).size,
                                })
                              : t("packs.page.toolCount", { count: p.tools.length })}
                            {!isBundled(p) ? t("packs.page.yourPackSuffix") : ""}
                          </span>
                        </span>
                        <span className="pack-item-badges">
                          {p.enabled && needsKey ? (
                            <Badge tone="warn" dot>
                              {t("packs.page.needsKey")}
                            </Badge>
                          ) : null}
                          {/* "On" is the normal state and needs no badge; only show what differs. */}
                          {p.enabled && p.state === "loaded" ? null : (
                            <Badge tone={st.tone} dot>
                              {st.text}
                            </Badge>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="detail">
            {selected ? (
              <PackDetail
                key={selected.id}
                pack={selected}
                secrets={(data.data?.secrets ?? []).filter((s) => s.pack === selected.id)}
                backend={data.data?.backend}
                openKey={wantsKey}
                onChanged={(p) => {
                  if (p)
                    data.mutate((d) =>
                      d ? { ...d, packs: d.packs.map((x) => (x.id === p.id ? p : x)) } : d,
                    );
                  else void data.reload();
                }}
                onSecretChanged={() => void data.reload()}
              />
            ) : (
              <EmptyState icon="package" title={t("packs.page.chooseTitle")}>
                {t("packs.page.chooseHint")}
              </EmptyState>
            )}
          </div>
        </div>
      )}
    </>
  );
}
