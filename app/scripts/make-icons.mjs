// Generates the app's icons with the repo's sharp install:
//   src-tauri/icons/source.png          1024x1024 app icon source for `tauri icon`
//   src-tauri/icons/tray.png            44x44 menu-bar template image: running
//   src-tauri/icons/tray-starting.png   template image: starting (dashed frame)
//   src-tauri/icons/tray-attention.png  template image: needs attention (badge)
//   src-tauri/icons/tray-color*.png     64x64 coloured tray icons for Windows and Linux
//
// macOS tray images are template images (black plus alpha only): macOS tints
// them for light and dark menu bars and for the highlighted state. Windows
// and Linux show tray icons as they are, on light or dark task bars, so they
// get a small copy of the app icon with a coloured status dot instead.
//
// Run from app/:  node scripts/make-icons.mjs && npx tauri icon src-tauri/icons/source.png -o src-tauri/icons
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(appDir, "..", "package.json"));
const sharp = require("sharp");
const out = join(appDir, "src-tauri", "icons");
mkdirSync(out, { recursive: true });

// App icon: macOS-style rounded square (824 of 1024, centred), dark gradient,
// a light "M" whose strokes end in plug-like dots.
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#334155"/>
      <stop offset="1" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#cbd5e1"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>
  <g fill="none" stroke="url(#fg)" stroke-width="72" stroke-linecap="round" stroke-linejoin="round">
    <path d="M322 690 V350 L512 560 L702 350 V690"/>
  </g>
  <g fill="#38bdf8">
    <circle cx="322" cy="720" r="34"/>
    <circle cx="702" cy="720" r="34"/>
  </g>
</svg>`;
await sharp(Buffer.from(appSvg)).png().toFile(join(out, "source.png"));

const mark = `<path d="M13 30 V16 L22 25 L31 16 V30" fill="none" stroke="#000" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const tray = (frame, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44">${frame}${mark}${extra}</svg>`;

const solid = `<rect x="5" y="5" width="34" height="34" rx="8" fill="none" stroke="#000" stroke-width="3.5"/>`;
const dashed = `<rect x="5" y="5" width="34" height="34" rx="8" fill="none" stroke="#000" stroke-width="3.5" stroke-dasharray="6 4.5"/>`;
// Attention: the frame is cut away at the top right and a filled badge sits there.
const cut = `<mask id="m"><rect width="44" height="44" fill="#fff"/><circle cx="36" cy="8" r="9.5" fill="#000"/></mask>`;
const attention = `<defs>${cut}</defs><rect x="5" y="5" width="34" height="34" rx="8" fill="none" stroke="#000" stroke-width="3.5" mask="url(#m)"/>`;
const badge = `<circle cx="36" cy="8" r="6.5" fill="#000"/>`;

await sharp(Buffer.from(tray(solid)))
  .png()
  .toFile(join(out, "tray.png"));
await sharp(Buffer.from(tray(dashed)))
  .png()
  .toFile(join(out, "tray-starting.png"));
await sharp(Buffer.from(tray(attention, badge)))
  .png()
  .toFile(join(out, "tray-attention.png"));
console.log("icons written to", out);

// Windows / Linux: the app icon at tray size, with a status dot.
const colour = (dot) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#334155"/><stop offset="1" stop-color="#0f172a"/>
  </linearGradient></defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bg)"/>
  <path d="M18 46 V20 L32 36 L46 20 V46" fill="none" stroke="#f8fafc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  ${dot ? `<circle cx="52" cy="12" r="10" fill="${dot}" stroke="#0f172a" stroke-width="3"/>` : ""}
</svg>`;
await sharp(Buffer.from(colour("")))
  .png()
  .toFile(join(out, "tray-color.png"));
await sharp(Buffer.from(colour("#f59e0b")))
  .png()
  .toFile(join(out, "tray-color-starting.png"));
await sharp(Buffer.from(colour("#ef4444")))
  .png()
  .toFile(join(out, "tray-color-attention.png"));
