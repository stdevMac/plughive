// "What do you want to do?": pick a goal, see what this computer still needs
// for it (free and local options first), with a link to do each step.
import { useId, useState } from "react";
import { t } from "../i18n";
import { api } from "../lib/api";
import { useResource } from "../lib/hooks";
import { Link } from "../lib/router";
import { optionAction, optionTarget, sizeLabel, visibleGoals } from "../lib/software";
import type { GoalInfo, PlanOption, SetupPlan } from "../lib/types";
import { Icon } from "./Icon";
import { Badge, Button, ErrorState, ExternalLink, Loading } from "./ui";

export function GoalPicker({
  value,
  onPick,
}: { value: string | null; onPick: (goal: GoalInfo) => void }) {
  const goals = useResource(
    (signal) =>
      api.get<{ goals: GoalInfo[] }>("/api/advisor/goals", undefined, signal).then((r) => r.goals),
    [],
  );
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (goals.loading && !goals.data) return <Loading lines={2} />;
  if (goals.error && !goals.data) return <ErrorState error={goals.error} onRetry={goals.reload} />;
  const { shown, hidden } = visibleGoals(goals.data ?? [], value, expanded);
  return (
    <>
      <ul className="goal-list" id={listId} aria-label={t("home.plan.listLabel")}>
        {shown.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              className={`goal-card${value === g.id ? " goal-on" : ""}`}
              aria-pressed={value === g.id}
              onClick={() => {
                // Fold the list back so the plan shows right under the cards;
                // the picked goal stays visible either way.
                setExpanded(false);
                onPick(g);
              }}
            >
              <span className="goal-title">{g.title}</span>
              <span className="small muted">{g.summary}</span>
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 || expanded ? (
        <Button
          size="sm"
          variant="ghost"
          icon={expanded ? "chevronUp" : "chevronDown"}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t("home.plan.fewer") : t("home.plan.more", { count: hidden })}
        </Button>
      ) : null}
    </>
  );
}

function OptionLink({ option, primary }: { option: PlanOption; primary?: boolean }) {
  const target = optionTarget(option);
  if (!target) return null;
  if ("to" in target)
    return (
      <Link className={`btn btn-sm ${primary ? "btn-primary" : "btn-secondary"}`} to={target.to}>
        {optionAction(option)}
      </Link>
    );
  return <ExternalLink href={target.href}>{t("home.plan.officialPage")}</ExternalLink>;
}

/** The plan for one goal: a row per step, the cheapest, most local option first. */
export function GoalPlan({ goal, version = 0 }: { goal: string; version?: number }) {
  const plan = useResource(
    (signal) =>
      api.get<{ plan: SetupPlan }>("/api/advisor/plan", { goal }, signal).then((r) => r.plan),
    [goal, version],
  );
  if (plan.loading && !plan.data) return <Loading lines={3} />;
  if (plan.error && !plan.data) return <ErrorState error={plan.error} onRetry={plan.reload} />;
  const p = plan.data;
  if (!p) return null;
  return (
    <div className="plan">
      <output className="small muted plan-summary">
        {p.ready
          ? t("home.plan.ready", { title: p.title.toLowerCase() })
          : t("home.plan.stepsLeft", {
              count: p.steps.filter((s) => !s.done && !s.optional).length,
            })}
      </output>
      <ol className="plan-steps">
        {p.steps.map((s) => {
          const first = s.options[0];
          return (
            <li key={s.need} className={`plan-step${s.done ? " plan-done" : ""}`}>
              <span className="plan-mark" aria-hidden="true">
                {s.done ? (
                  <Icon name="check" size={14} />
                ) : (
                  <Icon name={s.optional ? "plus" : "alert"} size={14} />
                )}
              </span>
              <span className="plan-text">
                <span className="plan-need">
                  {s.need}
                  {s.optional ? <Badge>{t("home.plan.optional")}</Badge> : null}
                  <span className="visually-hidden">
                    {s.done ? t("home.check.done") : t("home.check.todo")}
                  </span>
                </span>
                {s.done ? (
                  <span className="small muted">
                    {t("home.plan.doneWith", { name: s.done_by })}
                  </span>
                ) : first ? (
                  <span className="small muted">
                    <strong>{first.name}</strong>
                    {t("home.plan.optionWhy", { why: first.why })}{" "}
                    <span className="plan-cost">{first.cost_hint}</span>
                    {first.size_mb
                      ? t("home.plan.sizeSep", { size: sizeLabel(first.size_mb) })
                      : ""}
                    {s.options.length > 1
                      ? t("home.plan.orAlternatives", {
                          names: s.options
                            .slice(1, 3)
                            .map((o) => o.name)
                            .join(", "),
                        })
                      : ""}
                    {s.options.length > 3 ? "…" : ""}
                  </span>
                ) : (
                  <span className="small muted">{t("home.plan.noOptions")}</span>
                )}
              </span>
              {!s.done && first ? (
                <span className="plan-action">
                  <OptionLink option={first} primary={!s.optional} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
