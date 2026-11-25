// src/core/advisor/plan.ts
//
// setup_plan: "what does this machine still need for <goal>". A goal (goals.json)
// is a few steps; each step can be met by any one of its options: software to
// install, a key to set, an account or server to connect (a mount), or a pack
// to switch on. A step is met when one of its options already is, or when the
// capability router has a configured provider for the step's capability.
//
// Options are ordered free-and-local first, then free, then free tier, then paid,
// so an agent proposes what costs nothing and keeps data on the machine first.
import { z } from "zod";
import type { SoftwareView } from "../installer/installer.js";
import type { CapabilityProviderInfo } from "../pack-api.js";
import raw from "./goals.json" with { type: "json" };

const Cost = z.enum(["free", "free_tier", "paid"]);
const Option = z
  .object({
    needs: z.enum(["install", "key", "login", "enable_pack"]),
    id: z.string().min(1).max(80),
    pack: z.string().max(40).optional(),
    cost: Cost,
    local: z.boolean(),
    why: z.string().min(1).max(200),
    /** For an install: more catalog entries it needs too (whisper.cpp and a model file). */
    with: z.array(z.string().min(1).max(80)).max(4).optional(),
  })
  .strict()
  .refine((o) => o.needs !== "key" || !!o.pack, "a key option names its pack")
  .refine((o) => !o.with || o.needs === "install", "only an install option has `with`");
const Step = z
  .object({
    need: z.string().min(1).max(80),
    capability: z.string().max(40).optional(),
    optional: z.boolean().optional(),
    options: z.array(Option).min(1),
  })
  .strict();
const Goal = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    title: z.string().min(1).max(60),
    summary: z.string().min(1).max(200),
    match: z.array(z.string().max(40)).min(1),
    steps: z.array(Step).min(1),
  })
  .strict();
export const Goals = z.object({ schema: z.literal(1), goals: z.array(Goal).min(1) }).strict();
export type Goal = z.output<typeof Goal>;
type GoalOption = z.output<typeof Option>;

export function loadGoals(data: unknown = raw): Goal[] {
  return Goals.parse(data).goals;
}

/** What the advisor reads to see what is already set up. */
export interface AdvisorSources {
  software(): Promise<SoftwareView[]>;
  packs(): Promise<
    {
      id: string;
      name: string | null;
      enabled: boolean;
      state: string;
      secrets: { name: string; present: boolean }[];
    }[]
  >;
  mounts(): Promise<
    {
      id: string;
      name: string;
      enabled: boolean;
      connected: boolean;
      auth: string;
      secrets: { name: string; present: boolean }[];
    }[]
  >;
  capabilities(): Promise<
    Pick<CapabilityProviderInfo, "capability" | "configured" | "pack" | "id">[]
  >;
}

export type CostHint = "free, runs on this computer" | "free" | "free tier, then paid" | "paid";

export interface PlanOption {
  needs: GoalOption["needs"];
  id: string;
  /** For a key: the pack that uses it. */
  pack?: string;
  name: string;
  why: string;
  cost_hint: CostHint;
  local: boolean;
  /** What to do: a tool call for an agent, a dashboard page for a person, or a link. */
  how: {
    tool?: string;
    args?: Record<string, unknown>;
    dashboard?: string;
    url?: string;
    text: string;
  };
  /** The step this option meets. */
  step: string;
  /** Size and approval, for an install. */
  size_mb?: number;
  needs_approval?: boolean;
}

export interface PlanStep {
  need: string;
  optional: boolean;
  done: boolean;
  /** What meets it now (an installed program, a set key, a configured provider). */
  done_by: string | null;
  options: PlanOption[];
}

export interface SetupPlan {
  goal: string;
  title: string;
  summary: string;
  /** Every required step is met. */
  ready: boolean;
  steps: PlanStep[];
  /** One pick per unmet step, required steps first: the cheapest, most local option. */
  next: PlanOption[];
}

const COST_RANK = (o: GoalOption): number =>
  o.cost === "free" && o.local ? 0 : o.cost === "free" ? 1 : o.cost === "free_tier" ? 2 : 3;

function costHint(o: GoalOption): CostHint {
  if (o.cost === "free" && o.local) return "free, runs on this computer";
  if (o.cost === "free") return "free";
  if (o.cost === "free_tier") return "free tier, then paid";
  return "paid";
}

/** The goal `text` names: an id, a title, or words from its match list. */
export function matchGoal(goals: readonly Goal[], text: string): Goal | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const exact = goals.find((g) => g.id === t || g.title.toLowerCase() === t);
  if (exact) return exact;
  let best: { goal: Goal; score: number } | null = null;
  for (const g of goals) {
    let score = 0;
    for (const m of g.match) if (t.includes(m)) score += m.length;
    if (g.title.toLowerCase().includes(t)) score += t.length;
    if (score > 0 && (!best || score > best.score)) best = { goal: g, score };
  }
  return best?.goal ?? null;
}

export class SetupAdvisor {
  readonly goals: Goal[];
  constructor(
    private readonly sources: AdvisorSources,
    goals: Goal[] = loadGoals(),
  ) {
    this.goals = goals;
  }

  list(): { id: string; title: string; summary: string }[] {
    return this.goals.map((g) => ({ id: g.id, title: g.title, summary: g.summary }));
  }

  async plan(goalText: string): Promise<SetupPlan | null> {
    const goal = matchGoal(this.goals, goalText);
    if (!goal) return null;
    const settled = <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);
    const [software, packs, mounts, caps] = await Promise.all([
      settled(this.sources.software()),
      settled(this.sources.packs()),
      settled(this.sources.mounts()),
      settled(this.sources.capabilities()),
    ]);
    const sw = new Map(software.map((s) => [s.id, s]));
    const packById = new Map(packs.map((p) => [p.id, p]));
    const mountById = new Map(mounts.map((m) => [m.id, m]));

    const describe = (
      o: GoalOption,
      step: string,
    ): { option: PlanOption; done: boolean } | null => {
      const base = {
        needs: o.needs,
        id: o.id,
        why: o.why,
        cost_hint: costHint(o),
        local: o.local,
        step,
      };
      switch (o.needs) {
        case "install": {
          const main = sw.get(o.id);
          if (!main) return null; // not offered on this platform
          const parts = [main, ...(o.with ?? []).map((id) => sw.get(id))];
          if (parts.some((p) => !p)) return null;
          const all = parts as SoftwareView[];
          // The first part still missing is the one to install next.
          const s = all.find((p) => !p.installed) ?? main;
          const missing = all.filter((p) => !p.installed);
          const names = (missing.length ? missing : all).map((p) => p.name).join(" and ");
          const sizeMb = (missing.length ? missing : all).reduce((n, p) => n + p.size_mb, 0);
          const approval = (missing.length ? missing : all).some((p) => p.needs_approval);
          const detectOnly = s.method === "link" || s.method === "unsupported";
          const how: PlanOption["how"] = detectOnly
            ? {
                ...(s.install_url || s.homepage ? { url: s.install_url ?? s.homepage } : {}),
                text: `Install ${s.name} from its official page${s.install_url ? ` (${s.install_url})` : ""}.`,
              }
            : s.method === "apt"
              ? { text: `Run \`${s.command}\` in a terminal.`, dashboard: "/software" }
              : {
                  tool: "install_software",
                  args: { id: s.id },
                  dashboard: `/software?install=${encodeURIComponent(s.id)}`,
                  text:
                    missing.length > 1
                      ? `Install ${names} (about ${sizeMb} MB in all), one install_software call each${approval ? "; the larger ones after you approve them on the dashboard" : ""}.`
                      : `Install ${s.name} (${s.license}, about ${s.size_mb} MB)${s.needs_approval ? " after you approve it on the dashboard" : ""}.`,
                };
          return {
            option: {
              ...base,
              name: all.length > 1 ? all.map((p) => p.name).join(" + ") : main.name,
              how,
              size_mb: sizeMb,
              needs_approval: approval,
            },
            done: all.every((p) => p.installed),
          };
        }
        case "key": {
          const pack = packById.get(o.pack as string);
          if (!pack) return null;
          const secret = pack.secrets.find((x) => x.name === o.id);
          const enabled = pack.enabled && pack.state !== "failed";
          const set = secret?.present === true;
          return {
            option: {
              ...base,
              pack: o.pack,
              name: `${pack.name ?? pack.id} key`,
              how: {
                dashboard: `/packs?pack=${encodeURIComponent(pack.id)}`,
                text: `${enabled ? "" : `Switch on the ${pack.name ?? pack.id} pack and `}${enabled ? "Set" : "set"} ${o.id} on the Packs page. Keys are typed on the dashboard, never in chat.`,
              },
            },
            done: set && enabled,
          };
        }
        case "login": {
          const m = mountById.get(o.id);
          if (!m) return null;
          const keysSet = m.secrets.every((x) => x.present);
          return {
            option: {
              ...base,
              name: m.name,
              how: {
                dashboard: "/mounts",
                text:
                  m.auth === "oauth"
                    ? `Connect ${m.name} on the Mounts page (sign in with your account).`
                    : `Switch on ${m.name} on the Mounts page${m.secrets.length ? ` and set ${m.secrets.map((x) => x.name).join(", ")}` : ""}.`,
              },
            },
            done: m.enabled && keysSet,
          };
        }
        case "enable_pack": {
          const p = packById.get(o.id);
          if (!p) return null;
          return {
            option: {
              ...base,
              name: p.name ?? p.id,
              how: {
                dashboard: `/packs?pack=${encodeURIComponent(p.id)}`,
                text: `Switch on the ${p.name ?? p.id} pack.`,
              },
            },
            done: p.enabled && p.state !== "failed",
          };
        }
      }
    };

    const steps: PlanStep[] = goal.steps.map((step) => {
      const rows = [...step.options]
        .map((o, i) => ({ o, i }))
        .sort((a, b) => COST_RANK(a.o) - COST_RANK(b.o) || a.i - b.i)
        .map(({ o }) => describe(o, step.need))
        .filter((r): r is { option: PlanOption; done: boolean } => r !== null);
      const doneRow = rows.find((r) => r.done);
      const provider = step.capability
        ? caps.find((c) => c.capability === step.capability && c.configured)
        : undefined;
      const done = !!doneRow || !!provider;
      return {
        need: step.need,
        optional: step.optional === true,
        done,
        done_by: doneRow
          ? doneRow.option.name
          : provider
            ? `${provider.pack} (${provider.id})`
            : null,
        options: rows.filter((r) => !r.done).map((r) => r.option),
      };
    });
    const unmet = steps.filter((s) => !s.done && s.options.length > 0);
    const next = [...unmet.filter((s) => !s.optional), ...unmet.filter((s) => s.optional)]
      .map((s) => s.options[0])
      .filter((o): o is PlanOption => !!o);
    return {
      goal: goal.id,
      title: goal.title,
      summary: goal.summary,
      ready: steps.every((s) => s.optional || s.done),
      steps,
      next,
    };
  }
}
