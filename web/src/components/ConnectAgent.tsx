import { useMemo, useState } from "react";
import { t } from "../i18n";
import { useAgents } from "../lib/agents";
import { endpointFor, useApp } from "../lib/app-context";
import { agentSummary } from "../lib/onboarding";
import { connectSnippets } from "../lib/snippets";
import { Icon } from "./Icon";
import { CodeBlock, CopyField, Tabs } from "./ui";

export function ConnectAgent({ profile = "default" }: { profile?: string }) {
  const { info } = useApp();
  const url = endpointFor(info, profile);
  const keyed = info?.auth_required === true;
  const snippets = useMemo(() => connectSnippets(url, keyed), [url, keyed]);
  const [tab, setTab] = useState(snippets[0]?.id ?? "claude-code");
  const s = snippets.find((x) => x.id === tab) ?? snippets[0];

  return (
    <div className="connect">
      <AgentStatus profile={profile} />
      {profile === "default" ? (
        <p className="small muted connect-tray">
          <Icon name="info" /> {t("connect.tray.before")}
          <strong>{t("connect.tray.strong")}</strong>
          {t("connect.tray.after")}
        </p>
      ) : null}
      <div className="connect-url">
        <span className="field-label">{t("connect.endpointLabel")}</span>
        <CopyField value={url} label={t("connect.endpointUrl")} />
      </div>
      <Tabs
        items={snippets.map((x) => ({ id: x.id, label: x.label }))}
        value={tab}
        onChange={setTab}
        label={t("connect.tabsLabel")}
        idPrefix="connect"
      />
      {s ? (
        <div
          role="tabpanel"
          id="connect-panel"
          aria-labelledby={`connect-tab-${s.id}`}
          className="connect-panel"
        >
          <p className="muted small">{s.where}</p>
          <CodeBlock
            code={s.code}
            label={t("connect.codeLabel", { label: s.label })}
            language={s.language}
          />
          {s.note ? <p className="muted small">{s.note}</p> : null}
          {keyed ? (
            <p className="muted small">
              {t("connect.keyHint.before")}
              <code>&lt;your access key&gt;</code>
              {t("connect.keyHint.after")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A live line: waiting for the first agent, then who connected. */
export function AgentStatus({
  profile,
  waiting = t("connect.statusWaiting"),
}: { profile?: string; waiting?: string }) {
  const names = useAgents(true, profile ? { profile } : {});
  const on = names.length > 0;
  return (
    <p
      // biome-ignore lint/a11y/useSemanticElements: live status line; output is for form results
      className={on ? "agent-status agent-status-on" : "agent-status"}
      role="status"
      aria-live="polite"
    >
      {on ? <Icon name="check" size={14} /> : <span className="live-dot" aria-hidden="true" />}
      <span>
        <strong>{t("connect.connectedCount", { count: names.length })}</strong>
        <span className="agent-status-text">{on ? agentSummary(names) : waiting}</span>
      </span>
    </p>
  );
}
