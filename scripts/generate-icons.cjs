// One-shot icon generator for Duo Synergy and Objective Timer.
// Run: node scripts/generate-icons.js
// Requires: sharp (devDependency)
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const BASE = path.join(__dirname, "..", "com.desstroct.lol-api.sdPlugin", "imgs", "actions");
const BG = "#0A1428";
const GOLD = "#C89B3C";

async function svgToPng(svgStr, outPath, w, h) {
	const sized = svgStr
		.replace(/width="[^"]*"/, `width="${w}"`)
		.replace(/height="[^"]*"/, `height="${h}"`);
	await sharp(Buffer.from(sized)).png().toFile(outPath);
	console.log(`  ${path.relative(path.join(__dirname, ".."), outPath)} (${w}×${h})`);
}

// ── Duo Synergy ───────────────────────────────────────────────
// Two person silhouettes (head + body arch) with a "+" link between them.
// viewBox 72×72 — scaled for @2x by changing width/height only.

const DUO_KEY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">
  <rect width="72" height="72" rx="8" fill="${BG}"/>
  <rect x="1.5" y="1.5" width="69" height="69" rx="7" fill="none" stroke="${GOLD}" stroke-width="2"/>
  <circle cx="22" cy="21" r="9" fill="white"/>
  <path d="M9,52 C9,38 13,31 22,31 C31,31 35,38 35,52 Z" fill="white"/>
  <circle cx="50" cy="21" r="9" fill="white"/>
  <path d="M37,52 C37,38 41,31 50,31 C59,31 63,38 63,52 Z" fill="white"/>
  <line x1="36" y1="33" x2="36" y2="43" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="31" y1="38" x2="41" y2="38" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// Icon (action list): transparent bg, same shapes, viewBox 28×28.
const DUO_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
  <circle cx="7" cy="7" r="4" fill="white"/>
  <path d="M1,22 C1,15 3,11 7,11 C11,11 13,15 13,22 Z" fill="white"/>
  <circle cx="21" cy="7" r="4" fill="white"/>
  <path d="M15,22 C15,15 17,11 21,11 C25,11 27,15 27,22 Z" fill="white"/>
  <line x1="14" y1="12" x2="14" y2="17" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="11.5" y1="14.5" x2="16.5" y2="14.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

// ── Objective Timer ───────────────────────────────────────────
// Stopwatch: crown button + clock face + 4 tick marks + 10:10 hands.
// Distinct from death-timer (hourglass) by using a round clock face.

const OBJ_KEY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">
  <rect width="72" height="72" rx="8" fill="${BG}"/>
  <rect x="1.5" y="1.5" width="69" height="69" rx="7" fill="none" stroke="${GOLD}" stroke-width="2"/>
  <rect x="33" y="9" width="6" height="6" rx="2" fill="white"/>
  <circle cx="36" cy="41" r="22" fill="none" stroke="white" stroke-width="2.5"/>
  <line x1="36" y1="19" x2="36" y2="24" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="58" y1="41" x2="53" y2="41" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="36" y1="63" x2="36" y2="58" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="14" y1="41" x2="19" y2="41" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="36" y1="41" x2="25" y2="34" stroke="white" stroke-width="3" stroke-linecap="round"/>
  <line x1="36" y1="41" x2="52" y2="32" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="36" cy="41" r="2.5" fill="white"/>
</svg>`;

const OBJ_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28">
  <rect x="12" y="2" width="4" height="3" rx="1" fill="white"/>
  <circle cx="14" cy="17" r="9" fill="none" stroke="white" stroke-width="1.5"/>
  <line x1="14" y1="8"  x2="14" y2="10" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="23" y1="17" x2="21" y2="17" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="14" y1="26" x2="14" y2="24" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="5"  y1="17" x2="7"  y2="17" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="14" y1="17" x2="10" y2="14" stroke="white" stroke-width="1.8" stroke-linecap="round"/>
  <line x1="14" y1="17" x2="20" y2="13" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="14" cy="17" r="1.5" fill="white"/>
</svg>`;

async function generate() {
	console.log("Generating icons...");

	const duoDir = path.join(BASE, "duo-synergy");
	await svgToPng(DUO_KEY,  path.join(duoDir, "key.png"),    72,  72);
	await svgToPng(DUO_KEY,  path.join(duoDir, "key@2x.png"), 144, 144);
	await svgToPng(DUO_ICON, path.join(duoDir, "icon.png"),   28,  28);
	await svgToPng(DUO_ICON, path.join(duoDir, "icon@2x.png"),56,  56);

	const objDir = path.join(BASE, "objective-timer");
	fs.mkdirSync(objDir, { recursive: true });
	await svgToPng(OBJ_KEY,  path.join(objDir, "key.png"),    72,  72);
	await svgToPng(OBJ_KEY,  path.join(objDir, "key@2x.png"), 144, 144);
	await svgToPng(OBJ_ICON, path.join(objDir, "icon.png"),   28,  28);
	await svgToPng(OBJ_ICON, path.join(objDir, "icon@2x.png"),56,  56);

	console.log("Done.");
}

generate().catch((e) => { console.error(e); process.exit(1); });
