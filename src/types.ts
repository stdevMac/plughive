// src/types.ts
export type ArtifactKind = "image" | "video" | "audio" | "pdf" | "document" | "data" | "other";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  mime: string;
  path: string;
  bytes: number;
  tool: string;
  model: string | null;
  prompt: string | null;
  meta: Record<string, unknown> | null;
  costUsd: number | null;
  createdAt: string;
}

export interface ArtifactRef {
  id: string;
  path: string;
  url: string;
  mime: string;
  model?: string | null;
  cost_usd?: number | null;
  prompt?: string | null;
  bytes?: number;
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

export interface Job {
  id: string;
  tool: string;
  status: JobStatus;
  input: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
  result: unknown;
  error: string | null;
  progress: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ToolResult<T> = { ok: true; result: T } | { ok: false; error: ToolError };
