// src/core/secrets/memory-backend.ts
import type { SecretBackend } from "./types.js";

/** Process-local backend for tests and ephemeral runs. Nothing is persisted. */
export class MemoryBackend implements SecretBackend {
  readonly kind = "memory" as const;
  private readonly values = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [name, value] of Object.entries(initial ?? {})) this.values.set(name, value);
  }

  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name);
  }

  async list(): Promise<string[]> {
    return [...this.values.keys()].sort();
  }

  async has(name: string): Promise<boolean> {
    return this.values.has(name);
  }
}
