// src/core/policy/run-context.ts
//
// What the policy gate needs to know about the call it is checking, carried
// through async calls: the background job it runs in (so the gate can wait
// for a person instead of failing) and whether a person has already approved
// the whole run (a paid tool or a workflow), so nested provider calls do not
// ask again.
import { AsyncLocalStorage } from "node:async_hooks";

export interface PolicyJob {
  id: string;
  /** Shows the job as awaiting approval (true) or running again (false). */
  awaiting(waiting: boolean, message: string | null): void;
}

export interface SpendReservation {
  /** Unused amount still held by this reservation for `scopeKey`. */
  remaining(scopeKey: string): number;
  /** Carve up to `amount` from this reservation for `scopeKey`; returns what was taken. */
  carve(scopeKey: string, amount: number): number;
}

interface PolicyRun {
  job?: PolicyJob;
  preApproved?: boolean;
  reservation?: SpendReservation;
}

const storage = new AsyncLocalStorage<PolicyRun>();

export function currentPolicyRun(): PolicyRun {
  return storage.getStore() ?? {};
}

/** Run `fn` as the body of a background job: approvals are waited for, not returned as errors. */
export function runInPolicyJob<T>(job: PolicyJob, fn: () => T): T {
  return storage.run({ ...currentPolicyRun(), job }, fn);
}

/**
 * Run `fn` after a person approved its cost: cost-asking rules ("ask" caps,
 * auto-approve threshold) pass inside it. Blocking caps, per-call maximums,
 * explicit always-ask lists and destructive/sending prompts still apply.
 */
export function runPreApproved<T>(fn: () => T): T {
  return storage.run({ ...currentPolicyRun(), preApproved: true }, fn);
}

/** Run `fn` as if nothing above it was approved: its own cost rules apply again. */
export function runNotPreApproved<T>(fn: () => T): T {
  return storage.run({ ...currentPolicyRun(), preApproved: false }, fn);
}

/** Run `fn` with an active spend reservation so nested calls carve from it instead of double-counting. */
export function runWithReservation<T>(reservation: SpendReservation, fn: () => T): T {
  return storage.run({ ...currentPolicyRun(), reservation }, fn);
}
