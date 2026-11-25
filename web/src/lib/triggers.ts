// Triggers: types for /api/triggers, the create form's draft and its request
// body, and plain-language wording for schedules and runs.
import { t } from "../i18n";

export type TriggerKind = "cron" | "webhook";
export type TriggerCallback =
  | { type: "webhook"; url: string }
  | { type: "telegram"; chat_id?: string };

export interface TriggerInfo {
  id: string;
  name: string;
  kind: TriggerKind;
  workflow: string;
  args: Record<string, unknown>;
  schedule: string | null;
  timezone: "UTC" | "local";
  catch_up: boolean;
  use_body: boolean;
  enabled: boolean;
  profile: string | null;
  callback: TriggerCallback | null;
  webhook_url: string | null;
  next_run_at: string | null;
  last_run: { at: string; job_id: string | null; status: string; error: string | null } | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowInfo {
  name: string;
  description: string;
}

export interface TriggerDraft {
  name: string;
  kind: TriggerKind;
  workflow: string;
  schedule: string;
  timezone: "UTC" | "local";
  catchUp: boolean;
  useBody: boolean;
  /** The workflow input as JSON text. */
  args: string;
  callback: "none" | "webhook" | "telegram";
  callbackUrl: string;
  chatId: string;
}

export const EMPTY_TRIGGER: TriggerDraft = {
  name: "",
  kind: "cron",
  workflow: "",
  schedule: "0 9 * * *",
  timezone: "local",
  catchUp: false,
  useBody: true,
  args: "{}",
  callback: "none",
  callbackUrl: "",
  chatId: "",
};

const SCHEDULE_PRESETS: Array<{ value: string; key: string }> = [
  { value: "*/15 * * * *", key: "triggers.presets.every15Minutes" },
  { value: "0 * * * *", key: "triggers.presets.everyHour" },
  { value: "0 9 * * *", key: "triggers.presets.everyDayAt9" },
  { value: "0 9 * * 1-5", key: "triggers.presets.weekdaysAt9" },
  { value: "0 9 * * 1", key: "triggers.presets.mondaysAt9" },
  { value: "0 0 1 * *", key: "triggers.presets.firstOfMonth" },
];

/** The schedule presets with their labels in the current language. */
export function schedulePresets(): Array<{ value: string; label: string }> {
  return SCHEDULE_PRESETS.map((p) => ({ value: p.value, label: t(p.key) }));
}

/** The request body for POST /api/triggers, or the field errors that stop it. */
export function triggerBody(
  d: TriggerDraft,
): { body: Record<string, unknown> } | { issues: Record<string, string> } {
  const issues: Record<string, string> = {};
  if (!d.name.trim()) issues.name = t("triggers.form.nameRequired");
  if (!d.workflow) issues.workflow = t("triggers.form.workflowRequired");
  if (
    d.kind === "cron" &&
    d.schedule.trim().split(/\s+/).length !== 5 &&
    !d.schedule.trim().startsWith("@")
  )
    issues.schedule = t("triggers.form.scheduleInvalid");
  let args: unknown = {};
  if (d.args.trim()) {
    try {
      args = JSON.parse(d.args);
    } catch {
      issues.args = t("triggers.form.argsNotJson");
    }
    if (!issues.args && (args === null || typeof args !== "object" || Array.isArray(args)))
      issues.args = t("triggers.form.argsNotObject");
  }
  if (d.callback === "webhook" && !/^https?:\/\/\S+$/.test(d.callbackUrl.trim()))
    issues.callbackUrl = t("triggers.form.callbackUrlInvalid");
  if (Object.keys(issues).length) return { issues };
  const callback: TriggerCallback | null =
    d.callback === "webhook"
      ? { type: "webhook", url: d.callbackUrl.trim() }
      : d.callback === "telegram"
        ? { type: "telegram", ...(d.chatId.trim() ? { chat_id: d.chatId.trim() } : {}) }
        : null;
  return {
    body: {
      name: d.name.trim(),
      kind: d.kind,
      workflow: d.workflow,
      args,
      ...(d.kind === "cron"
        ? { schedule: d.schedule.trim(), timezone: d.timezone, catch_up: d.catchUp }
        : { use_body: d.useBody }),
      ...(callback ? { callback } : {}),
    },
  };
}

/** "Every day at 09:00 (local time)" for a preset, else the expression itself. */
export function describeSchedule(tr: Pick<TriggerInfo, "schedule" | "timezone">): string {
  if (!tr.schedule) return "";
  const preset = SCHEDULE_PRESETS.find((p) => p.value === tr.schedule);
  const zone = tr.timezone === "UTC" ? t("triggers.zone.utc") : t("triggers.zone.local");
  return `${preset ? t(preset.key) : tr.schedule} (${zone})`;
}

/** Badge text and tone for the last run. */
export function lastRunState(
  tr: Pick<TriggerInfo, "last_run">,
): { text: string; tone: "ok" | "warn" | "danger" | "neutral" } | null {
  const r = tr.last_run;
  if (!r) return null;
  if (r.status === "error") return { text: t("triggers.lastRun.error"), tone: "danger" };
  if (r.status === "skipped") return { text: t("triggers.lastRun.skipped"), tone: "warn" };
  return { text: t("triggers.lastRun.started"), tone: "ok" };
}

/** A workflow tool name without its wf_ prefix. */
export function workflowLabel(name: string): string {
  return name.replace(/^wf_/, "");
}
