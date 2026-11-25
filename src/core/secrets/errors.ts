// src/core/secrets/errors.ts
//
// None of these errors ever carry a secret value, a passphrase, or raw output
// from a helper process.

export interface MissingSecretInfo {
  pack: string;
  name: string;
  label?: string;
  helpUrl?: string;
}

/**
 * Thrown when a pack asks for a secret that is not configured anywhere.
 *
 * Per the pack contract the fields are `{ pack, name, label, helpUrl }`, so
 * `name` is the SECRET NAME (for example "EXA_API_KEY"), not the class name.
 * Identify the error with `instanceof MissingSecretError` or `code`.
 */
export class MissingSecretError extends Error {
  readonly code = "MISSING_SECRET" as const;
  readonly pack: string;
  readonly label?: string;
  readonly helpUrl?: string;
  constructor(info: MissingSecretInfo) {
    const label = info.label ? ` (${info.label})` : "";
    super(`Pack "${info.pack}" needs the secret ${info.name}${label}, which is not set.`);
    this.pack = info.pack;
    this.name = info.name;
    if (info.label !== undefined) this.label = info.label;
    if (info.helpUrl !== undefined) this.helpUrl = info.helpUrl;
  }
}

export class InvalidSecretNameError extends Error {
  readonly code = "INVALID_SECRET_NAME" as const;
  constructor() {
    // The offending name is not echoed: a caller could have passed a value by mistake.
    super("Invalid secret name: expected a name matching ^[A-Z][A-Z0-9_]{1,63}$");
    this.name = "InvalidSecretNameError";
  }
}

export class SecretStoreError extends Error {
  readonly code: string;
  constructor(message: string, code = "SECRET_STORE_ERROR") {
    super(message);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

/** Wrong passphrase, or the encrypted file was modified. */
export class SecretDecryptError extends SecretStoreError {
  constructor() {
    super(
      "Could not decrypt the secrets file: wrong passphrase or the file was modified.",
      "SECRET_DECRYPT_FAILED",
    );
    this.name = "SecretDecryptError";
  }
}
