// Mounts: other MCP servers whose tools plughive passes through.
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/Dialog";
import { SecretEditor } from "../components/SecretEditor";
import { SmartMountsCard } from "../components/SmartMounts";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ExternalLink,
  FieldRow,
  InlineAlert,
  Loading,
  PageHeader,
  Segmented,
  Switch,
  TextInput,
} from "../components/ui";
import { t } from "../i18n";
import { ApiError, api, errorMessage } from "../lib/api";
import { useApp } from "../lib/app-context";
import { useDocumentTitle, useResource } from "../lib/hooks";
import {
  type AddDraft,
  EMPTY_MOUNT,
  NEEDS_SIGN_IN,
  mountBody,
  mountState,
  needsSignIn,
  slug,
} from "../lib/mounts";
import { useRouter } from "../lib/router";
import type { MountInfo, SecretRow } from "../lib/types";

/** How often the page asks whether a sign-in in the other tab has finished. */
const SIGN_IN_POLL_MS = 2000;
/** The daemon forgets a sign-in after ten minutes; stop asking a little later. */
const SIGN_IN_POLL_LIMIT_MS = 11 * 60_000;

interface OAuthStatus {
  signed_in: boolean;
  pending: boolean;
  connected: boolean;
  error: string | null;
}

/**
 * Sign in to an OAuth mount: the vendor's page opens in a new tab, the vendor
 * sends the browser back to the daemon, and this polls until that happened.
 */
function useSignIn(mount: MountInfo, onDone: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<"start" | "signout" | null>(null);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setWaiting(false);
  };
  // Leaving the page stops the polling (only the timer: no state to set on an unmounted row).
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const poll = (until: number) => {
    timer.current = window.setTimeout(async () => {
      try {
        const s = await api.get<OAuthStatus>(`/api/mounts/${mount.id}/oauth`);
        if (s.signed_in) {
          stop();
          toast.ok(t("mounts.signIn.signedInTo", { name: mount.name }));
          onDone();
          return;
        }
        if (!s.pending) {
          // Refused, cancelled or expired: the callback page said why.
          stop();
          onDone();
          return;
        }
      } catch {
        // The daemon may be restarting: keep asking until the time is up.
      }
      if (Date.now() < until) poll(until);
      else stop();
    }, SIGN_IN_POLL_MS);
  };

  const signIn = async () => {
    // Open the tab inside the click, so no popup blocker stops it; the address follows.
    const tab = window.open("about:blank", "_blank");
    // Cut the opener link before anything async runs, so the new page can
    // never reach back into this one.
    if (tab) tab.opener = null;
    setBusy("start");
    try {
      const r = await api.post<{ authorization_url: string }>(
        `/api/mounts/${mount.id}/oauth/start`,
        {},
      );
      // The daemon takes the address from the vendor's OAuth metadata, but
      // check the scheme anyway: only an http(s) url may be navigated to.
      let target: URL | null = null;
      try {
        const u = new URL(r.authorization_url);
        if (u.protocol === "https:" || u.protocol === "http:") target = u;
      } catch {
        target = null;
      }
      if (!target) {
        tab?.close();
        toast.error(t("mounts.signIn.badLink"));
        return;
      }
      if (tab) {
        tab.location.href = target.href;
      } else {
        // No tab: a popup blocker, or the desktop app, which hands the address to
        // the default browser and keeps this page. Keep watching either way, so
        // the row turns on by itself once the sign-in finishes.
        window.location.assign(target.href);
      }
      setWaiting(true);
      onDone();
      if (timer.current !== null) window.clearTimeout(timer.current);
      poll(Date.now() + SIGN_IN_POLL_LIMIT_MS);
    } catch (e) {
      tab?.close();
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setBusy("signout");
    stop();
    try {
      await api.del(`/api/mounts/${mount.id}/oauth`);
      toast.ok(t("mounts.signIn.signedOutOf", { name: mount.name }));
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return { busy, waiting, signIn, signOut };
}

/** The host of a remote server URL; the full URL (with any key reference) stays in the tooltip. */
function hostOf(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url.replace(/\$\{[^}]*\}/g, "x")).host || url;
  } catch {
    return url;
  }
}

function MountRow({
  mount,
  onChanged,
  onRemove,
}: { mount: MountInfo; onChanged: (m: MountInfo | null) => void; onRemove: () => void }) {
  const toast = useToast();
  const { catalogChanged } = useApp();
  const [busy, setBusy] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const oauth = mount.oauth ?? null;
  const signIn = useSignIn(mount, () => {
    onChanged(null);
    catalogChanged();
  });
  const view = oauth && signIn.waiting ? { ...mount, oauth: { ...oauth, pending: true } } : mount;
  const state = mountState(view);
  const signInNeeded = needsSignIn(mount);
  const missing = mount.secrets.filter((s) => !s.present);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      const r = await api.post<{ mount: MountInfo | null }>(
        `/api/mounts/${mount.id}/${on ? "enable" : "disable"}`,
        {},
      );
      onChanged(r.mount);
      catalogChanged();
      toast.ok(
        on
          ? t("mounts.toggled.on", { name: mount.name })
          : t("mounts.toggled.off", { name: mount.name }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rows: SecretRow[] = mount.secrets.map((s) => ({
    pack: mount.pack,
    name: s.name,
    label: null,
    help_url: mount.docsUrl ?? null,
    required: true,
    granted: true,
    present: s.present,
    source: null,
  }));

  return (
    <li className="mount">
      <div className="mount-main">
        <div className="mount-text">
          <div className="mount-title">
            <span className="mount-name">{mount.name}</span>
            {state ? (
              <Badge tone={state.tone} dot>
                {state.text}
              </Badge>
            ) : null}
          </div>
          {mount.description ? <p className="small muted">{mount.description}</p> : null}
          <p className="small muted mount-meta">
            <span>
              {mount.transport === "stdio"
                ? t("mounts.transport.local")
                : t("mounts.transport.remote")}
            </span>
            <span
              className="mono mount-target"
              title={mount.transport === "stdio" ? mount.command : mount.url}
            >
              {mount.transport === "stdio" ? mount.command : hostOf(mount.url)}
            </span>
            <span>
              {t("mounts.toolNames.before")}
              <code>{mount.prefix}_</code>
            </span>
            {mount.enabled && mount.connected ? (
              <span>{t("mounts.toolCount", { count: mount.tools })}</span>
            ) : null}
          </p>
          {mount.note ? <p className="small muted">{mount.note}</p> : null}
          {mount.error && mount.enabled && mount.error !== NEEDS_SIGN_IN ? (
            <p className="small mount-error mono">{mount.error}</p>
          ) : null}
          {oauth && signIn.waiting ? (
            <p className="small muted">{t("mounts.signIn.finish")}</p>
          ) : null}
          {oauth && signInNeeded && mount.enabled && !signIn.waiting ? (
            <p className="small warn-text">
              {oauth.signedIn ? t("mounts.signIn.refreshNeeded") : t("mounts.signIn.connectHint")}
            </p>
          ) : null}
          {!mount.mountable && !mount.enabled ? (
            <p className="small warn-text">
              {missing.length
                ? t("mounts.notMountable.setKey")
                : t("mounts.notMountable.cannotEnable")}
            </p>
          ) : null}
        </div>
        <div className="mount-actions">
          {oauth && signInNeeded ? (
            <Button
              size="sm"
              variant={mount.enabled ? "primary" : "secondary"}
              icon="link"
              onClick={signIn.signIn}
              busy={signIn.busy === "start"}
              disabled={signIn.busy !== null}
              aria-label={t("mounts.signIn.connectAria", { name: mount.name })}
            >
              {signIn.waiting ? t("mounts.signIn.openAgain") : t("mounts.signIn.connect")}
            </Button>
          ) : null}
          {oauth?.signedIn ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={signIn.signOut}
              busy={signIn.busy === "signout"}
              disabled={signIn.busy !== null}
              aria-label={t("mounts.signIn.signOutAria", { name: mount.name })}
            >
              {t("mounts.signIn.signOut")}
            </Button>
          ) : null}
          {rows.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              icon="key"
              onClick={() => setShowKeys((v) => !v)}
              aria-expanded={showKeys}
            >
              {t("mounts.keys.label")}
            </Button>
          ) : null}
          {mount.docsUrl ? (
            <ExternalLink href={mount.docsUrl}>{t("mounts.docs")}</ExternalLink>
          ) : null}
          {mount.source === "user" ? (
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={onRemove}
              aria-label={t("mounts.remove.aria", { name: mount.name })}
            >
              {t("mounts.remove.label")}
            </Button>
          ) : null}
          <Switch
            checked={mount.enabled}
            onChange={toggle}
            label={
              mount.enabled
                ? t("mounts.toggle.off", { name: mount.name })
                : t("mounts.toggle.on", { name: mount.name })
            }
            disabled={busy || (!mount.mountable && !mount.enabled)}
          />
        </div>
      </div>
      {showKeys ? (
        <div className="secret-list mount-keys">
          {rows.map((r) => (
            <SecretEditor key={r.name} row={r} compact onChanged={() => catalogChanged()} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

// ---- add form ------------------------------------------------------------------

function AddMountDialog({
  open,
  onClose,
  onAdded,
}: { open: boolean; onClose: () => void; onAdded: (m: MountInfo | undefined) => void }) {
  const [d, setD] = useState<AddDraft>(EMPTY_MOUNT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const set = (k: keyof AddDraft) => (v: string) => setD((x) => ({ ...x, [k]: v }));
  const body = mountBody(d);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    if (!d.name.trim()) local.name = t("mounts.add.errors.name");
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(String(body.id))) local.id = t("mounts.add.errors.id");
    if (d.transport === "http" && !/^https?:\/\//.test(d.url.trim()))
      local.url = t("mounts.add.errors.url");
    if (d.transport === "stdio" && !d.command.trim())
      local.command = t("mounts.add.errors.command");
    setIssues(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ id: string; mount?: MountInfo }>("/api/mounts", body);
      setD(EMPTY_MOUNT);
      onAdded(r.mount);
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        const map: Record<string, string> = {};
        for (const i of err.issues)
          map[String(i.path || "form").split(".")[0] as string] = i.message;
        setIssues(map);
      }
      setError(
        err instanceof ApiError && err.code === "MOUNT_EXISTS"
          ? t("mounts.add.errors.exists")
          : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("mounts.add.title")}
      description={t("mounts.add.description")}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("mounts.add.cancel")}
          </Button>
          <Button type="submit" variant="primary" busy={busy} form="add-mount-form">
            {t("mounts.add.submit")}
          </Button>
        </>
      }
    >
      <form id="add-mount-form" className="stack" onSubmit={submit} noValidate>
        <Segmented
          label={t("mounts.add.reach.label")}
          value={d.transport}
          onChange={(v) => setD((x) => ({ ...x, transport: v as AddDraft["transport"] }))}
          options={[
            { value: "http", label: t("mounts.add.reach.http") },
            { value: "stdio", label: t("mounts.transport.local") },
          ]}
        />
        <FieldRow label={t("mounts.add.fields.name")} htmlFor="m-name" error={issues.name} required>
          <TextInput
            id="m-name"
            value={d.name}
            onChange={(e) => set("name")(e.target.value)}
            placeholder={t("mounts.add.placeholders.name")}
          />
        </FieldRow>
        <div className="grid-2">
          <FieldRow
            label={t("mounts.add.fields.id")}
            htmlFor="m-id"
            hint={t("mounts.add.hints.id")}
            error={issues.id}
          >
            <TextInput
              id="m-id"
              value={d.id}
              onChange={(e) => set("id")(slug(e.target.value))}
              placeholder={slug(d.name) || t("mounts.add.placeholders.id")}
            />
          </FieldRow>
          <FieldRow
            label={t("mounts.add.fields.prefix")}
            htmlFor="m-prefix"
            hint={t("mounts.add.hints.prefix", {
              prefix: String(body.prefix) || t("mounts.add.examplePrefix"),
            })}
            error={issues.prefix}
          >
            <TextInput
              id="m-prefix"
              value={d.prefix}
              onChange={(e) => set("prefix")(e.target.value.toLowerCase())}
              placeholder={String(body.prefix) || t("mounts.add.placeholders.prefix")}
            />
          </FieldRow>
        </div>
        {d.transport === "http" ? (
          <>
            <FieldRow
              label={t("mounts.add.fields.url")}
              htmlFor="m-url"
              error={issues.url}
              required
              hint={t("mounts.add.hints.url")}
            >
              <TextInput
                id="m-url"
                value={d.url}
                onChange={(e) => set("url")(e.target.value)}
                placeholder="https://example.com/mcp"
                inputMode="url"
              />
            </FieldRow>
            <div className="grid-2">
              <FieldRow
                label={t("mounts.add.fields.header")}
                htmlFor="m-header"
                error={issues.headers}
              >
                <TextInput
                  id="m-header"
                  value={d.header}
                  onChange={(e) => set("header")(e.target.value)}
                  placeholder="Authorization"
                />
              </FieldRow>
              <FieldRow label={t("mounts.add.fields.headerValue")} htmlFor="m-header-value">
                <TextInput
                  id="m-header-value"
                  value={d.headerValue}
                  onChange={(e) => set("headerValue")(e.target.value)}
                  placeholder="Bearer ${secret:NOTES_KEY}"
                />
              </FieldRow>
            </div>
          </>
        ) : (
          <>
            <InlineAlert tone="warn" title={t("mounts.add.stdioWarning.title")}>
              {t("mounts.add.stdioWarning.body")}
            </InlineAlert>
            <FieldRow
              label={t("mounts.add.fields.command")}
              htmlFor="m-command"
              error={issues.command}
              required
              hint={t("mounts.add.hints.command")}
            >
              <TextInput
                id="m-command"
                value={d.command}
                onChange={(e) => set("command")(e.target.value)}
                placeholder="npx"
                className="mono"
              />
            </FieldRow>
            <FieldRow
              label={t("mounts.add.fields.args")}
              htmlFor="m-args"
              error={issues.args}
              hint={t("mounts.add.hints.args")}
            >
              <TextInput
                id="m-args"
                value={d.args}
                onChange={(e) => set("args")(e.target.value)}
                placeholder="-y @example/notes-mcp"
                className="mono"
              />
            </FieldRow>
          </>
        )}
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      </form>
    </Dialog>
  );
}

// ---- page ----------------------------------------------------------------------

export function MountsPage() {
  useDocumentTitle(t("mounts.page.title"));
  const toast = useToast();
  const { catalogVersion, catalogChanged } = useApp();
  const data = useResource(
    (signal) =>
      api.get<{ mounts: MountInfo[]; mounts_file_error: string | null }>(
        "/api/mounts",
        undefined,
        signal,
      ),
    [catalogVersion],
  );
  const { query, setQuery } = useRouter();
  // ?add=1 (from the command palette or a link) opens the add dialog on arrival.
  const adding = query.get("add") === "1";
  const setAdding = (on: boolean) => setQuery({ add: on ? "1" : null });
  const [removing, setRemoving] = useState<MountInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const { packMounts, userMounts } = useMemo(() => {
    const all = data.data?.mounts ?? [];
    return {
      packMounts: all.filter((m) => m.source !== "user"),
      userMounts: all.filter((m) => m.source === "user"),
    };
  }, [data.data]);

  const update = (m: MountInfo | null) => {
    if (m)
      data.mutate((d) => (d ? { ...d, mounts: d.mounts.map((x) => (x.id === m.id ? m : x)) } : d));
    else void data.reload();
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.del(`/api/mounts/${removing.id}`);
      toast.ok(t("mounts.removed", { name: removing.name }));
      setRemoving(null);
      catalogChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const addButton = (
    <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
      {t("mounts.addServer.button")}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t("mounts.page.title")}
        description={t("mounts.page.description")}
        actions={addButton}
      />
      {data.loading && !data.data ? (
        <Loading lines={6} />
      ) : data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : (
        <div className="stack-lg">
          {data.data?.mounts_file_error ? (
            <InlineAlert tone="danger" title={t("mounts.fileError.title")}>
              {t("mounts.fileError.before")}
              <span className="mono">{data.data.mounts_file_error}</span>
            </InlineAlert>
          ) : null}
          <SmartMountsCard version={catalogVersion} onChanged={catalogChanged} />
          <Card title={t("mounts.packsCard.title")}>
            {packMounts.length === 0 ? (
              <EmptyState icon="plug" title={t("mounts.packsEmpty.title")}>
                {t("mounts.packsEmpty.body")}
              </EmptyState>
            ) : (
              <ul className="mount-list" aria-label={t("mounts.packsList.aria")}>
                {packMounts.map((m) => (
                  <MountRow key={m.id} mount={m} onChanged={update} onRemove={() => undefined} />
                ))}
              </ul>
            )}
          </Card>
          <Card title={t("mounts.userCard.title")}>
            {userMounts.length === 0 ? (
              <EmptyState icon="plug" title={t("mounts.userEmpty.title")}>
                {t("mounts.userEmpty.before")}
                <strong>{t("mounts.userEmpty.link")}</strong>
                {t("mounts.userEmpty.after")}
              </EmptyState>
            ) : (
              <ul className="mount-list" aria-label={t("mounts.userList.aria")}>
                {userMounts.map((m) => (
                  <MountRow
                    key={m.id}
                    mount={m}
                    onChanged={update}
                    onRemove={() => setRemoving(m)}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
      <AddMountDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(m) => {
          setAdding(false);
          toast.ok(t("mounts.added", { name: m?.name ?? t("mounts.addedDefault") }));
          catalogChanged();
        }}
      />
      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t("mounts.removeDialog.title", {
          name: removing?.name ?? t("mounts.removeDialog.unnamed"),
        })}
        size="sm"
        role="alertdialog"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)} data-autofocus>
              {t("mounts.removeDialog.keep")}
            </Button>
            <Button variant="danger" busy={busy} onClick={remove}>
              {t("mounts.removeDialog.confirm")}
            </Button>
          </>
        }
      >
        <p>{t("mounts.removeDialog.body")}</p>
      </Dialog>
    </>
  );
}
