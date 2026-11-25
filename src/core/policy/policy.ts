// src/core/policy/policy.ts
//
// The spend policy: `$PLUGHIVE_HOME/policy.json`. Caps (global, per provider,
// per profile; daily or monthly; "block" or "ask" when reached) and approval
// rules (auto-approve under an amount, always ask for some tools or
// providers, ask before destructive tools). Written only by the admin API,
// atomically and readable by the owner only.
//
// A file that does not parse or validate is never overwritten (the user may
// be editing it by hand) and the daemon FAILS CLOSED while it is broken: calls
// that may cost money (a non-zero or unknown estimate, a "paid" tool) and
// destructive tools are refused; free calls go on. No file at all is the
// default policy: no caps, no approvals.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicReplaceSync, writeFileAtomicSync } from "../../lib/platform.js";

export const POLICY_FILE = "policy.json";
export const DEFAULT_APPROVAL_TTL_MINUTES = 30;
/** Largest amount a cap or threshold may name. */
export const MAX_POLICY_USD = 1_000_000;

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const usd = z.number().finite().min(0).max(MAX_POLICY_USD);
const idList = z.array(z.string().regex(ID_RE)).max(500);

export const CapSchema = z
  .object({
    scope: z.enum(["global", "provider", "profile"]),
    /** Provider id (the usage ledger's vendor) or profile id. Not for "global". */
    id: z.string().regex(ID_RE).optional(),
    period: z.enum(["daily", "monthly"]),
    limit_usd: usd,
    /** "block": refuse (another provider may still run). "ask": a human decides. */
    mode: z.enum(["block", "ask"]),
  })
  .strict()
  .refine((c) => (c.scope === "global" ? c.id === undefined : c.id !== undefined), {
    message: 'a "provider" or "profile" cap needs an id; a "global" cap has none',
  });
export type Cap = z.infer<typeof CapSchema>;

export const RulesSchema = z
  .object({
    /** Calls estimated under this amount run without asking; others (and unknown estimates) ask. Null: off. */
    auto_approve_under_usd: usd.nullable().default(null),
    always_ask_tools: idList.default([]),
    always_ask_providers: idList.default([]),
    /** Ask before tools annotated destructiveHint. Off by default. */
    ask_before_destructive: z.boolean().default(false),
    /** Ask before tools tagged "sends" (email, SMS, calls, posts, bookings: they reach other people). On by default. */
    ask_before_sending: z.boolean().default(true),
    /**
     * Let MCP clients that support form elicitation show approve/deny in the
     * chat. Off by default: the answer then comes from the client, not from
     * the dashboard, Telegram or the tray, so only turn it on for clients you trust.
     */
    approve_in_chat: z.boolean().default(false),
  })
  .strict();
export type Rules = z.infer<typeof RulesSchema>;

const PartialRulesSchema = z
  .object({
    auto_approve_under_usd: usd.nullable().optional(),
    always_ask_tools: idList.optional(),
    always_ask_providers: idList.optional(),
    ask_before_destructive: z.boolean().optional(),
    ask_before_sending: z.boolean().optional(),
    approve_in_chat: z.boolean().optional(),
  })
  .strict();

export const TelegramApprovalsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Only callbacks from these chats count; approval requests are sent to them. */
    allowed_chat_ids: z
      .array(z.string().regex(/^-?\d{1,20}$/))
      .max(20)
      .default([]),
    /**
     * Opt-in: only button presses from these Telegram users count. A group
     * chat lets any member press the button, so set this to the user who may
     * approve. Empty: any member of an allowed chat may decide.
     */
    allowed_user_ids: z.array(z.number().int()).max(20).default([]),
  })
  .strict();

export const PolicySchema = z
  .object({
    version: z.literal(1),
    caps: z.array(CapSchema).max(200).default([]),
    rules: RulesSchema.default(RulesSchema.parse({})),
    /** Per-profile overrides of `rules`; a field left out keeps the global rule. */
    profiles: z.record(z.string().regex(ID_RE), PartialRulesSchema).default({}),
    approval_ttl_minutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .default(DEFAULT_APPROVAL_TTL_MINUTES),
    telegram: TelegramApprovalsSchema.default(TelegramApprovalsSchema.parse({})),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

export function defaultPolicy(): Policy {
  return PolicySchema.parse({ version: 1 });
}

export type PolicyState =
  | { ok: true; policy: Policy; exists: boolean }
  | { ok: false; error: string; policy: Policy };

export function policyPath(home: string): string {
  return join(home, POLICY_FILE);
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** Read and validate policy.json. Never throws. */
export function readPolicy(home: string): PolicyState {
  const path = policyPath(home);
  if (!existsSync(path)) return { ok: true, policy: defaultPolicy(), exists: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return {
      ok: false,
      error: `policy.json is not valid JSON (${(e as Error).message.slice(0, 200)})`,
      policy: defaultPolicy(),
    };
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `policy.json is invalid: ${issuesText(parsed.error)}`,
      policy: defaultPolicy(),
    };
  }
  return { ok: true, policy: parsed.data, exists: true };
}

export class PolicyFileError extends Error {
  constructor(
    message: string,
    readonly code: "POLICY_INVALID" | "POLICY_FILE_BROKEN",
  ) {
    super(message);
    this.name = "PolicyFileError";
  }
}

/**
 * Validate and write a new policy. Refuses (POLICY_FILE_BROKEN) while the
 * file on disk does not validate: a hand edit in progress is never lost; fix
 * or delete the file first.
 */
export function writePolicy(home: string, next: unknown): Policy {
  const parsed = PolicySchema.safeParse(next);
  if (!parsed.success) throw new PolicyFileError(issuesText(parsed.error), "POLICY_INVALID");
  const current = readPolicy(home);
  if (!current.ok) {
    throw new PolicyFileError(
      `${current.error}. It is not overwritten: fix or delete ${POLICY_FILE} in the data directory first`,
      "POLICY_FILE_BROKEN",
    );
  }
  mkdirSync(home, { recursive: true });
  const path = policyPath(home);
  writeFileAtomicSync(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}

/** policy.json, read again only when its mtime or size changes. */
export class PolicyCache {
  private cached: { key: string; state: PolicyState } | null = null;
  constructor(private readonly home: string) {}

  get(): PolicyState {
    let key = "absent";
    try {
      const st = statSync(policyPath(this.home));
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      key = "absent";
    }
    if (this.cached && this.cached.key === key) return this.cached.state;
    const state = readPolicy(this.home);
    this.cached = { key, state };
    return state;
  }

  invalidate(): void {
    this.cached = null;
  }
}

/** The rules that apply to a profile: the global rules with its overrides. */
export function rulesFor(policy: Policy, profile: string | undefined): Rules {
  const own = profile ? policy.profiles[profile] : undefined;
  if (!own) return policy.rules;
  return {
    auto_approve_under_usd:
      own.auto_approve_under_usd !== undefined
        ? own.auto_approve_under_usd
        : policy.rules.auto_approve_under_usd,
    always_ask_tools: own.always_ask_tools ?? policy.rules.always_ask_tools,
    always_ask_providers: own.always_ask_providers ?? policy.rules.always_ask_providers,
    ask_before_destructive: own.ask_before_destructive ?? policy.rules.ask_before_destructive,
    ask_before_sending: own.ask_before_sending ?? policy.rules.ask_before_sending,
    approve_in_chat: own.approve_in_chat ?? policy.rules.approve_in_chat,
  };
}

/** Start of the cap's current period (UTC day or UTC month), as an ISO string. */
export function periodStart(period: Cap["period"], now: number): string {
  const d = new Date(now);
  const start =
    period === "daily"
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return new Date(start).toISOString();
}
