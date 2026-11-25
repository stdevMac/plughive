// Theme: follow the system, or a choice kept in localStorage.
export type ThemeChoice = "system" | "light" | "dark";

const KEY = "plughive.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let unlisten: (() => void) | null = null;

/** Always sets html[data-theme] to the theme in effect; tokens.css keys the dark values on it.
 *  For "system", follows later changes to the computer's setting. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", effectiveTheme(choice));
  unlisten?.();
  unlisten = null;
  if (choice === "system" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => root.setAttribute("data-theme", mq.matches ? "dark" : "light");
    mq.addEventListener?.("change", onChange);
    unlisten = () => mq.removeEventListener?.("change", onChange);
  }
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Storage can be unavailable (private window); the choice lasts for this page.
  }
  applyTheme(choice);
}

/** The theme in effect, for things that cannot use CSS variables. */
export function effectiveTheme(choice: ThemeChoice = readTheme()): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
