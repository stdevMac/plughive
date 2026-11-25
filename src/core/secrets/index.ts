// src/core/secrets/index.ts
export {
  InvalidSecretNameError,
  MissingSecretError,
  SecretDecryptError,
  SecretStoreError,
} from "./errors.js";
export type { MissingSecretInfo } from "./errors.js";
export { FileBackend } from "./file-backend.js";
export type { FileBackendOptions } from "./file-backend.js";
export { KeychainBackend } from "./keychain-backend.js";
export type { KeychainBackendOptions } from "./keychain-backend.js";
export { MemoryBackend } from "./memory-backend.js";
export {
  LONG_SECRET_LENGTH,
  MIN_REDACT_LENGTH,
  REDACTED,
  REDACTION_FAILED,
  Redactor,
} from "./redactor.js";
export { createSecretStore } from "./store.js";
export type { CreateSecretStoreOptions, LayeredSecretStore } from "./store.js";
export { SECRET_NAME_PATTERN, assertSecretName, isValidSecretName } from "./types.js";
export type {
  SecretBackend,
  SecretBackendKind,
  SecretListEntry,
  SecretSource,
  SecretStore,
} from "./types.js";
