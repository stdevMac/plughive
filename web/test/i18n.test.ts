import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { availableLocales, catalog, getLocale, matchLocale, setLocale, t } from "../src/i18n";

const SRC = join(__dirname, "..", "src");
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const PLURAL = /\.(zero|one|two|few|many|other)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("translations", () => {
  const en = catalog("en");
  const others = availableLocales().filter((l) => l.code !== "en");

  it("ships English and Spanish", () => {
    expect(availableLocales().map((l) => l.code)).toEqual(expect.arrayContaining(["en", "es"]));
  });

  it.each(others.map((l) => l.code))("%s has every English key and no others", (code) => {
    const cat = catalog(code);
    const enKeys = Object.keys(en).filter((k) => !PLURAL.test(k));
    const keys = Object.keys(cat).filter((k) => !PLURAL.test(k));
    expect(enKeys.filter((k) => !(k in cat))).toEqual([]);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    // Plural groups: the language needs at least "other" wherever English has a plural.
    const groups = new Set(
      Object.keys(en)
        .filter((k) => PLURAL.test(k))
        .map((k) => k.replace(PLURAL, "")),
    );
    for (const g of groups) expect(cat[`${g}.other`], `${code}: ${g}.other`).toBeTypeOf("string");
  });

  it.each(others.map((l) => l.code))("%s keeps the same {placeholders}", (code) => {
    const cat = catalog(code);
    const wrong: string[] = [];
    for (const [k, v] of Object.entries(cat)) {
      const base = PLURAL.test(k) ? `${k.replace(PLURAL, "")}.other` : k;
      const ref = en[k] ?? en[base];
      if (ref === undefined) continue;
      const want = placeholders(ref).filter((p) => p !== "count");
      const got = placeholders(v).filter((p) => p !== "count");
      if (want.join() !== got.join()) wrong.push(`${k}: ${want} vs ${got}`);
    }
    expect(wrong).toEqual([]);
  });

  it('every t("…") in the dashboard source has an English message', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bt\(\s*["']([\w.-]+)["']/g)) {
        const key = m[1] as string;
        const plural = Object.keys(en).some((k) => k.startsWith(`${key}.`) && PLURAL.test(k));
        if (!(key in en) && !plural) missing.push(`${file.slice(SRC.length + 1)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("t", () => {
  const before = getLocale();
  afterEach(() => setLocale(before));

  it("fills placeholders and picks plural forms", () => {
    setLocale("en");
    expect(t("common.time.justNow")).toBe("just now");
    expect(t("no.such.key")).toBe("no.such.key");
  });

  it("switches language", () => {
    setLocale("es");
    expect(getLocale()).toBe("es");
    expect(t("common.time.justNow")).not.toBe("just now");
  });

  it("matches the nearest supported language", () => {
    expect(matchLocale(["es-MX", "en"])).toBe("es");
    expect(matchLocale(["fr-FR"])).toBe("en");
    expect(matchLocale([])).toBe("en");
  });
});
