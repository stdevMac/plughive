// Shapes of the daemon's /api responses that the dashboard reads.

export type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  examples?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

export interface ToolInfo {
  name: string;
  pack: string;
  origin: string;
  description: string;
  tags: string[];
  capability: string | null;
  requires_secrets: string[];
  long_running: boolean;
  annotations?: ToolAnnotations | null;
  input_schema: JsonSchema;
}

export interface Profile {
  id: string;
  name: string;
  mode: "list" | "search" | "auto";
  include: string[];
  exclude: string[];
  pinned: string[];
  autoThresholdTokens: number;
  autoThresholdTools: number;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ProfilePreview {
  profile: string;
  mode: "list" | "search";
  tools: ToolDescriptor[];
  cost: { totalTokens: number; perTool: Array<{ name: string; tokens: number }> };
  direct_tokens: number;
  exposed_tools: number;
  exposed?: string[];
}

export interface SecretStatus {
  name: string;
  label: string | null;
  helpUrl: string | null;
  required: boolean;
  granted: boolean;
  present: boolean;
}

export type PackState = "disabled" | "loaded" | "failed" | "invalid" | "needs-review";

export interface PackStatus {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Terms or caveats to read before turning the pack on. */
  notice?: string | null;
  source: "builtin" | "user" | string;
  enabled: boolean;
  state: PackState;
  error: string | null;
  tools: string[];
  providers: string[];
  secrets: SecretStatus[];
  permissions: {
    network?: string[];
    localNetwork?: string[];
    spawn?: string[];
    library?: string[] | boolean | string;
    llm?: boolean;
    tools?: string[];
    /** Spawned programs see the user's real home folder instead of a private per-pack one. */
    userHome?: boolean;
    [k: string]: unknown;
  };
  review?: unknown;
}

export interface ConsentItem {
  kind: string;
  text: string;
  risk: "high" | "normal" | string;
}

export interface PackConsent {
  id: string;
  name: string;
  version: string;
  source: string;
  items: ConsentItem[];
  summary: string[];
  highRisk: boolean;
  /** The pack ships code, which runs with the user's full rights (older daemons omit it). */
  runsCode?: boolean;
  secrets: Array<{
    name: string;
    label?: string;
    required: boolean;
    granted: boolean;
    grantable?: boolean;
    stored?: boolean;
    declaredBy?: string[];
    wellKnown?: boolean;
    warnings?: string[];
  }>;
  manifestHash: string;
  entryHash: string;
  review: unknown;
}

export interface SettingProperty {
  /** "array" is a list of strings ({type:"array",items:{type:"string"}}); unknown types fall back to a text field. */
  type: "string" | "number" | "integer" | "boolean" | "array" | (string & {});
  items?: { type?: string; enum?: unknown[] };
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
}

export interface PackSettings {
  pack: string;
  schema: {
    type: "object";
    properties: Record<string, SettingProperty>;
    required?: string[];
  } | null;
  values: Record<string, unknown>;
}

export interface SecretRow {
  pack: string;
  name: string;
  label: string | null;
  help_url: string | null;
  required: boolean;
  granted: boolean;
  present: boolean;
  source: string | null;
}

export interface CapabilityProvider {
  capability: string;
  id: string;
  pack: string;
  priority: number;
  configured: boolean;
  models?: string[];
  coolingDownUntil?: string | null;
  preferred?: number | null;
  autoRoute?: boolean;
  /** "local": free on this computer; "account": an app or plan you already have; "paid": billed per call. */
  cost?: "local" | "account" | "paid";
  /** What to set up to enable it, or null. */
  setupHint?: string | null;
}

export interface Capability {
  name: string;
  preference: string[];
  /** The provider a call would run first right now, or null when none is ready. */
  wouldUse?: string | null;
  providers: CapabilityProvider[];
}

export interface MountInfo {
  id: string;
  pack: string;
  mountId: string;
  name: string;
  description?: string;
  url?: string;
  transport: "http" | "stdio" | string;
  prefix: string;
  auth?: unknown;
  docsUrl?: string;
  enabled: boolean;
  mountable: boolean;
  note?: string | null;
  secrets: Array<{ name: string; present: boolean }>;
  source: "pack" | "user";
  command?: string;
  connected: boolean;
  tools: number;
  error: string | null;
  /** OAuth pack mounts only: the sign-in kept by the daemon (never the tokens). */
  oauth?: { signedIn: boolean; pending: boolean } | null;
}

export type JobStatus =
  | "queued"
  | "running"
  | "staging"
  | "submitting"
  | "submitted"
  | "polling"
  | "downloading"
  | "awaiting_approval"
  | "submission_unknown"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface JobView {
  job_id: string;
  tool: string;
  status: JobStatus;
  progress: number | null;
  message: string | null;
  result: unknown;
  error: unknown;
  created_at: string;
  updated_at: string;
  input?: unknown;
}

export interface Artifact {
  id: string;
  url: string;
  path?: string;
  kind: "image" | "video" | "audio" | "pdf" | "document" | "data" | "other";
  mime: string;
  bytes: number;
  tool: string | null;
  model: string | null;
  prompt: string | null;
  cost_usd: number | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface UsageSummary {
  total_calls: number | null;
  ok_calls: number | null;
  error_calls: number | null;
  fallback_calls: number | null;
  /** Paid calls answered from the paid-call cache at no cost. */
  cached_calls?: number | null;
  total_cost_usd: number | null;
  by_tool: Array<{ tool: string; calls: number; cost_usd: number | null }>;
  by_vendor: Array<{ vendor: string; calls: number; cost_usd: number | null }>;
  by_capability?: Array<{ capability: string; calls: number; cost_usd: number | null }>;
  rate_limits: Array<{
    vendor?: string;
    provider?: string;
    cooldown_until: string | null;
    in_cooldown: boolean;
    [k: string]: unknown;
  }>;
}

export interface UsageResponse {
  since: string | null;
  summary: UsageSummary;
  by_provider_day: Array<{
    day: string;
    provider: string;
    calls: number;
    errors: number;
    cost_usd: number | null;
  }>;
}

export type SecretStorage = "keychain" | "keyring" | "file-encrypted" | "file-plain" | "memory";

export interface DaemonInfo {
  version: string;
  base_url: string;
  mcp_url: string;
  profile_url_template: string;
  bind_host: string;
  port: number;
  auth_required: boolean;
  data_dir: string | null;
  secrets_backend: string | null;
  /** Where keys are kept; null from an older daemon or when it is not known. */
  secrets_storage?: SecretStorage | null;
  /** The macOS Keychain service name, when keys are in the Keychain. */
  secrets_keychain_service?: string | null;
  node_version?: string;
  platform?: string;
  uptime_s: number;
  /** MCP clients seen since the daemon started, newest first. Absent on older daemons. */
  agents?: Array<{
    name: string;
    version: string | null;
    profile: string;
    first_seen: number;
    last_seen: number;
  }>;
}

/** GET /api/software: a program plughive installs or detects. */
export interface SoftwareView {
  id: string;
  name: string;
  summary: string;
  version: string;
  license: string;
  size_mb: number;
  gated: boolean;
  homepage: string;
  install_url?: string;
  tags: string[];
  bins: string[];
  /** archive, uv, brew, winget, apt (a command to run), link (official page only), unsupported. */
  method: "archive" | "uv" | "model" | "brew" | "winget" | "apt" | "link" | "unsupported";
  command?: string;
  needs_approval: boolean;
  installed: boolean;
  managed: boolean;
  path: string | null;
  detected_version: string | null;
  running?: boolean;
  job_id?: string;
}

export type InstallStart =
  | { status: "started"; id: string; job_id: string }
  | { status: "already_installed"; id: string; path: string | null; version: string | null }
  | {
      status: "approval_required";
      id: string;
      approval_path: string;
      message: string;
      size_mb: number;
      license: string;
    }
  | { status: "manual"; id: string; message: string; url?: string; command?: string }
  | { status: "unsupported"; id: string; message: string };

export interface GoalInfo {
  id: string;
  title: string;
  summary: string;
}

export interface PlanOption {
  needs: "install" | "key" | "login" | "enable_pack";
  id: string;
  pack?: string;
  name: string;
  why: string;
  cost_hint: string;
  local: boolean;
  how: {
    tool?: string;
    args?: Record<string, unknown>;
    dashboard?: string;
    url?: string;
    text: string;
  };
  step: string;
  size_mb?: number;
  needs_approval?: boolean;
}

export interface PlanStep {
  need: string;
  optional: boolean;
  done: boolean;
  done_by: string | null;
  options: PlanOption[];
}

export interface SetupPlan {
  goal: string;
  title: string;
  summary: string;
  ready: boolean;
  steps: PlanStep[];
  next: PlanOption[];
}
