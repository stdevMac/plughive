// src/clients/errors.ts

/** The client's config file exists but does not parse; it is left untouched. */
export class ConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigParseError";
  }
}

/** A write was refused for safety (path outside home, bad name, unsupported layout). */
export class ClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientConfigError";
  }
}
