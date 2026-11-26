// src/core/preferences.ts
//
// Preferences that every surface of plughive shares: the dashboard in a
// browser, the desktop app's window (its own web storage) and the desktop
// app's tray menu, which reads this file directly. Stored as
// <home>/preferences.json, owner-only, written atomically.
//
//   { "locale": "es" }
//
// Add a field here (schema + default) to share another preference. Unknown
// or invalid fields in the file are dropped on read, never fatal.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../lib/platform.js";

export const PREFERENCES_FILE = "preferences.json";

/** A BCP 47 language tag such as "en", "es" or "pt-BR". */
export const LocaleTag = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "a language tag such as en, es or pt-BR");

export const PreferencesSchema = z.object({
  locale: LocaleTag.nullable().default(null),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const PreferencesPatch = z.object({ locale: LocaleTag.nullable().optional() }).strict();
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

const DEFAULTS: Preferences = { locale: null };

export function preferencesPath(home: string): string {
  return join(home, PREFERENCES_FILE);
}

/** The saved preferences; defaults for a missing, unreadable or invalid file or field. */
export function readPreferences(home: string): Preferences {
  const path = preferencesPath(home);
  if (!existsSync(path)) return { ...DEFAULTS };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const out: Preferences = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Array<keyof Preferences>) {
    const field = PreferencesSchema.shape[key].safeParse((raw as Record<string, unknown>)[key]);
    if (field.success) out[key] = field.data;
  }
  return out;
}

/** Merge a validated patch into the file and return the result. */
export function writePreferences(home: string, patch: PreferencesPatch): Preferences {
  const next: Preferences = { ...readPreferences(home) };
  if (patch.locale !== undefined) next.locale = patch.locale;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // A fresh, unguessable temp file that never follows a planted symlink.
  writeFileAtomicSync(preferencesPath(home), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
