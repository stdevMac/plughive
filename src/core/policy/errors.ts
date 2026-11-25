// src/core/policy/errors.ts
//
// The one error the spend policy throws. The registry turns it into a tool
// error with the same code (and the approval link); the MCP layer turns
// APPROVAL_REQUIRED into a URL elicitation when the client supports it.

export const POLICY_ERROR_CODES = [
  "APPROVAL_REQUIRED",
  "APPROVAL_DENIED",
  "APPROVAL_EXPIRED",
  "SPEND_BLOCKED",
] as const;
export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

/** What a caller is told about an approval request: never the arguments. */
export interface ApprovalRef {
  id: string;
  /** The dashboard page where a person approves or denies it (admin sign-in required). */
  url: string;
  expires_at: string;
  estimate_usd: number | null;
  reason: string;
}

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly code: PolicyErrorCode,
    readonly approval?: ApprovalRef,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export function isPolicyErrorCode(code: unknown): code is PolicyErrorCode {
  return typeof code === "string" && (POLICY_ERROR_CODES as readonly string[]).includes(code);
}
