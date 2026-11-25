// src/core/secrets/types.ts
import { InvalidSecretNameError } from "./errors.js";

export type SecretSource = "env" | "keychain" | "keyring" | "file" | "memory";
export type SecretBackendKind = "keychain" | "keyring" | "file" | "memory";

export interface SecretListEntry {
  name: string;
  source: SecretSource;
}

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<SecretListEntry[]>;
  has(name: string): Promise<boolean>;
}

/** A persistent (or in-memory) place secrets are written to. */
export interface SecretBackend {
  readonly kind: SecretBackendKind;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Names only, never values. */
  list(): Promise<string[]>;
  /** Existence check that avoids reading the value when the backend can. */
  has(name: string): Promise<boolean>;
}

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export function isValidSecretName(name: unknown): name is string {
  return typeof name === "string" && SECRET_NAME_PATTERN.test(name);
}

export function assertSecretName(name: unknown): asserts name is string {
  if (!isValidSecretName(name)) throw new InvalidSecretNameError();
}

/** Serialise async critical sections (read-modify-write) within one process. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
