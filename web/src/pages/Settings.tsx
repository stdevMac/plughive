// Settings: what this server is, the theme, and signing out.
import { useState } from "react";
import { LanguagePicker } from "../components/LanguagePicker";
import { StorageNote, storageLabel, storageState } from "../components/StorageNote";
import { useToast } from "../components/Toast";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  CopyField,
  ExternalLink,
  KeyValues,
  Loading,
  PageHeader,
  Segmented,
} from "../components/ui";
import { t } from "../i18n";
import { errorMessage } from "../lib/api";
import { endpointFor, useApp } from "../lib/app-context";
import { formatDuration } from "../lib/format";
import { useDocumentTitle } from "../lib/hooks";
import { Link } from "../lib/router";
import { type ThemeChoice, readTheme, saveTheme } from "../lib/theme";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function SettingsPage() {
  useDocumentTitle(t("settings.title"));
  const { info, reloadInfo, sessionSupported, signOut, openConnect } = useApp();
  const toast = useToast();
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [leaving, setLeaving] = useState(false);

  const chooseTheme = (t: ThemeChoice) => {
    setTheme(t);
    saveTheme(t);
  };

  const doSignOut = async () => {
    setLeaving(true);
    try {
      await signOut();
    } catch (e) {
      toast.error(errorMessage(e));
      setLeaving(false);
    }
  };

  const local = info ? LOOPBACK.has(info.bind_host) : true;

  return (
    <>
      <PageHeader title={t("settings.title")} description={t("settings.description")} />
      <div className="stack-lg">
        <Card
          title={t("settings.endpoint.title")}
          actions={
            <Button size="sm" variant="primary" icon="plug" onClick={openConnect}>
              {t("settings.endpoint.connect")}
            </Button>
          }
        >
          <CopyField label={t("settings.endpoint.label")} value={endpointFor(info)} />
          <p className="small muted">
            {t("settings.endpoint.hintBefore")}
            <Link to="/exposure">{t("settings.endpoint.hintLink")}</Link>
            {t("settings.endpoint.hintAfter")}
          </p>
        </Card>
        <Card title={t("settings.appearance.title")}>
          <div className="setting-row">
            <div>
              <div className="cap-name" id="theme-label">
                {t("settings.theme.label")}
              </div>
              <p className="small muted">{t("settings.theme.help")}</p>
            </div>
            <Segmented<ThemeChoice>
              label={t("settings.theme.label")}
              value={theme}
              onChange={chooseTheme}
              options={[
                { value: "system", label: t("settings.theme.system") },
                { value: "light", label: t("settings.theme.light") },
                { value: "dark", label: t("settings.theme.dark") },
              ]}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="cap-name" id="language-label">
                {t("settings.language.label")}
              </div>
              <p className="small muted">{t("settings.language.help")}</p>
            </div>
            <LanguagePicker variant="select" labelledBy="language-label" />
          </div>
        </Card>

        <Card
          title={t("settings.server.title")}
          actions={
            <Button size="sm" variant="ghost" icon="refresh" onClick={reloadInfo}>
              {t("settings.server.refresh")}
            </Button>
          }
        >
          {!info ? (
            <Loading lines={4} />
          ) : (
            <>
              <KeyValues
                rows={[
                  [t("settings.server.version"), <code key="v">{info.version}</code>],
                  [
                    t("settings.server.listeningOn"),
                    <span key="b" className="row-gap">
                      <code>
                        {info.bind_host}:{info.port}
                      </code>
                      {local ? (
                        <Badge tone="ok">{t("settings.server.localOnly")}</Badge>
                      ) : (
                        <Badge tone="warn">{t("settings.server.network")}</Badge>
                      )}
                    </span>,
                  ],
                  [
                    t("settings.server.accessKey"),
                    info.auth_required ? (
                      <Badge key="a" tone="ok" dot>
                        {t("settings.server.keySet")}
                      </Badge>
                    ) : local ? (
                      <span key="a">{t("settings.server.keyNotNeeded")}</span>
                    ) : (
                      <Badge key="a" tone="danger" dot>
                        {t("settings.server.keyNotSet")}
                      </Badge>
                    ),
                  ],
                  [
                    t("settings.server.dataFolder"),
                    info.data_dir ? (
                      <span key="d" className="row-gap">
                        <code>{info.data_dir}</code>
                        <CopyButton
                          text={info.data_dir}
                          what={t("settings.server.dataFolderPath")}
                          iconOnly
                          size="sm"
                        />
                      </span>
                    ) : (
                      t("settings.server.notReported")
                    ),
                  ],
                  [
                    t("settings.server.providerKeys"),
                    (() => {
                      const state = storageState(info.secrets_backend, info.secrets_storage);
                      const label = storageLabel(info.secrets_backend, info.secrets_storage);
                      const file = (
                        <code>
                          {info.data_dir ? `${info.data_dir}/secrets.json` : "secrets.json"}
                        </code>
                      );
                      if (state === "memory" || state === "file-plain") {
                        return (
                          <span key="k">
                            <Badge tone="warn" dot>
                              {label}
                            </Badge>
                            {state === "file-plain" ? <> {file}</> : null}
                          </span>
                        );
                      }
                      if (state === "file-encrypted") {
                        return (
                          <span key="k">
                            {label} {file}
                          </span>
                        );
                      }
                      if (state === "keychain") {
                        const svc = info.secrets_keychain_service;
                        return svc && svc !== "plughive" ? (
                          <span key="k">
                            {label} (service <code>{svc}</code>)
                          </span>
                        ) : (
                          label
                        );
                      }
                      return info.secrets_backend === "file" ? (
                        <span key="k">{file}</span>
                      ) : (
                        (info.secrets_backend ?? t("settings.server.notReported"))
                      );
                    })(),
                  ],
                  [t("settings.server.runningFor"), formatDuration(info.uptime_s * 1000)],
                  ...(info.node_version
                    ? ([[t("settings.server.nodejs"), info.node_version]] as Array<
                        [string, string]
                      >)
                    : []),
                ]}
              />
              {!local && !info.auth_required ? (
                <p className="small danger-text">{t("settings.server.danger")}</p>
              ) : null}
              <StorageNote backend={info.secrets_backend} />
            </>
          )}
        </Card>

        <Card title={t("settings.help.title")}>
          <ul className="link-list">
            <li>
              <ExternalLink href="https://modelcontextprotocol.io/docs/getting-started/intro">
                {t("settings.help.mcp")}
              </ExternalLink>
            </li>
            <li>
              <ExternalLink href="https://modelcontextprotocol.io/docs/develop/connect-local-servers">
                {t("settings.help.connectClaude")}
              </ExternalLink>
            </li>
            <li>
              <a href="/health" target="_blank" rel="noreferrer noopener">
                {t("settings.help.health")}
              </a>{" "}
              <span className="small muted">{t("settings.help.healthNote")}</span>
            </li>
          </ul>
        </Card>

        {sessionSupported ? (
          <Card title={t("settings.session.title")}>
            <div className="setting-row">
              <p className="small muted">{t("settings.session.hint")}</p>
              <Button variant="secondary" icon="signOut" onClick={doSignOut} busy={leaving}>
                {t("settings.session.signOut")}
              </Button>
            </div>
          </Card>
        ) : null}
      </div>
    </>
  );
}
