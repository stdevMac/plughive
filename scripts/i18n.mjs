#!/usr/bin/env node
// Translation helpers. See docs/i18n.md.
//
//   pnpm i18n:new <code> "<Name>"   start a language: copies the English files
//                                    for the dashboard and the desktop menu
//   pnpm i18n:status [code]          per language: keys missing, extra, or
//                                    still the same as English
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(root, "web/src/i18n/locales");
const TRAY = join(root, "app/src-tauri/locales");
const BASE = "en";

function flatten(tree, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.set(key, String(v));
  }
  return out;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Every key of one language, "<file>.<path>" for the dashboard, "tray:<path>" for the menu. */
function keysOf(code) {
  const out = new Map();
  const dir = join(WEB, code);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "_meta.json")) {
      for (const [k, v] of flatten(readJson(join(dir, f)), f.slice(0, -5))) out.set(k, v);
    }
  }
  const tray = join(TRAY, `${code}.json`);
  if (existsSync(tray))
    for (const [k, v] of flatten(readJson(tray), "tray:")) out.set(k.replace(":.", ":"), v);
  return out;
}

const languages = () =>
  readdirSync(WEB, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== BASE)
    .map((d) => d.name)
    .sort();

// A string with no letters outside {placeholders} always matches English.
const MAY_MATCH = /^[^a-zA-Z]*$/;

function status(only) {
  const en = keysOf(BASE);
  let bad = false;
  for (const code of only ? [only] : languages()) {
    const cat = keysOf(code);
    const missing = [...en.keys()].filter((k) => !cat.has(k));
    const extra = [...cat.keys()].filter((k) => !en.has(k));
    const same = [...en.keys()].filter(
      (k) => cat.get(k) === en.get(k) && !MAY_MATCH.test(en.get(k).replace(/\{\w+\}/g, "")),
    );
    const done = en.size - missing.length - same.length;
    console.log(`${code}: ${done}/${en.size} translated (${Math.floor((done / en.size) * 100)}%)`);
    if (missing.length)
      console.log(
        `  missing (${missing.length}): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`,
      );
    if (extra.length)
      console.log(`  not in English (${extra.length}): ${extra.slice(0, 10).join(", ")}`);
    if (same.length)
      console.log(
        `  same as English, fine for names and units (${same.length}):${same.slice(0, 10).join(", ")}${same.length > 10 ? ", ..." : ""}`,
      );
    if (missing.length || extra.length) bad = true;
  }
  if (bad) process.exitCode = 1;
}

function create(code, name) {
  if (!code || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code) || !name) {
    console.error(
      'usage: pnpm i18n:new <code> "<Name>"   e.g. pnpm i18n:new fr "Français", pnpm i18n:new pt-BR "Português (Brasil)"',
    );
    process.exit(2);
  }
  const web = join(WEB, code);
  const tray = join(TRAY, `${code}.json`);
  if (existsSync(web) || existsSync(tray)) {
    console.error(`${code} already exists. Run pnpm i18n:status ${code} to see what is left.`);
    process.exit(1);
  }
  cpSync(join(WEB, BASE), web, { recursive: true });
  writeFileSync(join(web, "_meta.json"), `${JSON.stringify({ name }, null, 2)}\n`);
  cpSync(join(TRAY, `${BASE}.json`), tray);
  console.log(`Created ${code} (${name}) from English:
  web/src/i18n/locales/${code}/*.json    the dashboard
  app/src-tauri/locales/${code}.json      the desktop menu, dialogs and notifications

Translate the values (never the keys or the {placeholders}), then:
  pnpm i18n:status ${code}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "new") create(args[0], args.slice(1).join(" "));
else if (cmd === "status") status(args[0]);
else {
  console.error("usage: node scripts/i18n.mjs new <code> <Name> | status [code]");
  process.exit(2);
}
