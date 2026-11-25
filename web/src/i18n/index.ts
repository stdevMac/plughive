// Dashboard translations.
//
// Every language is a folder of JSON files under ./locales/<code>/, one file
// per area of the dashboard (common.json, settings.json, ...). To add a
// language, copy locales/en to locales/<code> (a BCP 47 code such as "fr" or
// "pt-BR"), set "name" in its _meta.json, and translate the values. Nothing
// else needs to change: the folder is picked up at build time and the
// language appears in Settings. Keys missing from a translation fall back to
// English, so a partial translation still works.
//
// A key is "<file>.<path.inside.the.file>", e.g. t("settings.theme.label").
// Messages may hold {placeholders}: t("jobs.ran", { name: "x" }). Pass
// { count } to pick a plural form: the key's object holds "one", "other" and
// any other form the language needs (zero, two, few, many) as named by
// Intl.PluralRules, and {count} inside it shows the number formatted for the
// language.

type Messages = Record<string, string>;
type Tree = { [k: string]: string | Tree };

export interface LocaleInfo {
  code: string;
  /** The language's own name for itself: "English", "Español". */
  name: string;
}

const files = import.meta.glob("./locales/*/*.json", { eager: true, import: "default" }) as Record<
  string,
  Tree
>;

const catalogs = new Map<string, Messages>();
const meta = new Map<string, LocaleInfo>();

function flatten(tree: Tree, prefix: string, out: Messages): void {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else flatten(v, key, out);
  }
}

const FILE_PATH = /\.\/locales\/([^/]+)\/([^/]+)\.json$/;

for (const [path, tree] of Object.entries(files)) {
  const m = path.match(FILE_PATH);
  if (!m) continue;
  const code = m[1] as string;
  const file = m[2] as string;
  if (file === "_meta") {
    meta.set(code, { code, name: String((tree as Record<string, unknown>).name ?? code) });
    continue;
  }
  let cat = catalogs.get(code);
  if (!cat) {
    cat = {};
    catalogs.set(code, cat);
  }
  flatten(tree, file, cat);
}

export const DEFAULT_LOCALE = "en";
const STORAGE_KEY = "plughive.locale";

/** The languages there are translations for, English first, then by name. */
export function availableLocales(): LocaleInfo[] {
  return [...catalogs.keys()]
    .map((code) => meta.get(code) ?? { code, name: code })
    .sort((a, b) =>
      a.code === DEFAULT_LOCALE ? -1 : b.code === DEFAULT_LOCALE ? 1 : a.name.localeCompare(b.name),
    );
}

/** The best supported language for a list of preferred ones ("es-MX" -> "es"). */
export function matchLocale(preferred: readonly string[]): string {
  const codes = [...catalogs.keys()];
  const base = (c: string) => c.split("-")[0]?.toLowerCase();
  for (const p of preferred) {
    const exact = codes.find((c) => c.toLowerCase() === p.toLowerCase());
    if (exact) return exact;
    const near = codes.find((c) => base(c) === base(p));
    if (near) return near;
  }
  return DEFAULT_LOCALE;
}

function initialLocale(): string {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved && catalogs.has(saved)) return saved;
  } catch {
    // Storage can be unavailable (private window).
  }
  const nav = globalThis.navigator;
  return matchLocale(nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []);
}

let current = initialLocale();
const listeners = new Set<() => void>();

function applyToDocument(): void {
  if (typeof document !== "undefined") document.documentElement.lang = current;
}
applyToDocument();

export function getLocale(): string {
  return current;
}

/** Switch language, remember the choice, and tell subscribers (the app re-renders). */
export function setLocale(code: string): void {
  if (!catalogs.has(code) || code === current) return;
  current = code;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, code);
  } catch {
    // The choice lasts for this page.
  }
  applyToDocument();
  for (const l of listeners) l();
}

/** Whether someone picked a language here (vs. it being guessed from the browser). */
export function hasChosenLocale(): boolean {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return !!saved && catalogs.has(saved);
  } catch {
    return false;
  }
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Placeholder values; numbers are formatted for the language, null shows as nothing. */
export type Params = Record<string, string | number | null>;

const pluralRules = new Map<string, Intl.PluralRules>();
function pluralForm(locale: string, n: number): string {
  let pr = pluralRules.get(locale);
  if (!pr) {
    pr = new Intl.PluralRules(locale);
    pluralRules.set(locale, pr);
  }
  return pr.select(n);
}

function lookup(locale: string, key: string, count: number | undefined): string | undefined {
  const cat = catalogs.get(locale);
  if (!cat) return undefined;
  if (count !== undefined && cat[key] === undefined) {
    if (count === 0 && cat[`${key}.zero`] !== undefined) return cat[`${key}.zero`];
    return cat[`${key}.${pluralForm(locale, count)}`] ?? cat[`${key}.other`];
  }
  return cat[key];
}

function formatNumberFor(n: number): string {
  return new Intl.NumberFormat(current).format(n);
}

/** Translate a key into the current language. Unknown keys come back as the key. */
export function t(key: string, params?: Params): string {
  const count = typeof params?.count === "number" ? params.count : undefined;
  const msg = lookup(current, key, count) ?? lookup(DEFAULT_LOCALE, key, count);
  if (msg === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    if (v === null) return "";
    return typeof v === "number" ? formatNumberFor(v) : v;
  });
}

/** Every flattened key of one language, for tests and tooling. */
export function catalog(code: string): Readonly<Messages> {
  return catalogs.get(code) ?? {};
}
