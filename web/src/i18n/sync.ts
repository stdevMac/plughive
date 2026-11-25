// Keeps the dashboard's language in step with the daemon's shared preference
// (GET/PUT /api/preferences, saved in <home>/preferences.json), so a browser,
// the desktop app's window and its tray menu all use the same language.
//
// - chooseLocale(): what every language picker calls. Switches now, and once
//   signed in, saves the choice for the other surfaces.
// - syncLocaleFromDaemon(): called once after sign-in. A language saved on
//   the daemon wins; if none is saved yet, a choice made here (say, on the
//   sign-in page) is saved instead. A guess from the browser is never saved.
import { api } from "../lib/api";
import { getLocale, hasChosenLocale, matchLocale, setLocale } from "./index";

interface PreferencesResponse {
  ok: boolean;
  preferences: { locale: string | null };
}

let signedIn = false;

async function save(code: string): Promise<void> {
  try {
    await api.put<PreferencesResponse>("/api/preferences", { locale: code });
  } catch {
    // Best effort: the language still applies here; other surfaces keep theirs.
  }
}

/** Switch language from a picker, and share it with the daemon when signed in. */
export function chooseLocale(code: string): void {
  setLocale(code);
  if (signedIn && getLocale() === code) void save(code);
}

/** After sign-in: adopt the daemon's saved language, or share the one chosen here. */
export async function syncLocaleFromDaemon(): Promise<void> {
  signedIn = true;
  let saved: string | null = null;
  try {
    saved = (await api.get<PreferencesResponse>("/api/preferences")).preferences.locale;
  } catch {
    return; // An older daemon without preferences: stay local.
  }
  const code = saved ? matchLocale([saved]) : null;
  // A language this dashboard has no translation for (matchLocale fell back): keep ours.
  const usable = code && (code !== "en" || saved?.split("-")[0] === "en");
  if (usable) {
    if (code !== getLocale()) setLocale(code);
  } else if (!saved && hasChosenLocale()) {
    await save(getLocale());
  }
}

/** For sign-out: later picks stay in this browser until signed in again. */
export function forgetDaemonSession(): void {
  signedIn = false;
}
