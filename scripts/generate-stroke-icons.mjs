/**
 * generate-stroke-icons.mjs
 * Generates white stroke icons for the Stream Deck Marketplace & keys.
 *
 * Elgato requirement: action icons (sidebar) MUST be white stroke on
 * transparent background. Key images use the same stroke icons on a dark
 * background so the default state matches the sidebar appearance.
 *
 * Usage: node scripts/generate-stroke-icons.mjs
 *
 * Sizes:
 *   Action icon:   20×20  / @2x 40×40    (white stroke, transparent bg)
 *   Key image:     72×72  / @2x 144×144  (white stroke, dark bg)
 *   Category icon: 28×28  / @2x 56×56    (white stroke, transparent bg)
 */

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'com.desstroct.lol-api.sdPlugin');
const IMGS = path.join(PLUGIN_DIR, 'imgs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ─────────────────── White Stroke SVG Icons ───────────────────
// Based on Lucide Icons (https://lucide.dev) — ISC License.
// Adapted to 40×40 viewBox with white (#FFFFFF) stroke for Elgato compliance.
// RULE: No <text> elements (sharp can't render fonts).

const STROKE_ICONS = {
  // Game Status → Monitor
  'game-status': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect width="20" height="14" x="2" y="3" rx="2"/>
    <line x1="8" x2="16" y1="21" y2="21"/>
    <line x1="12" x2="12" y1="17" y2="21"/>
  </svg>`,

  // Lobby Scanner → Scan-search (magnifying glass with scan frame)
  'lobby-scanner': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 7V5a2 2 0 0 1 2-2h2"/>
    <path d="M17 3h2a2 2 0 0 1 2 2v2"/>
    <path d="M21 17v2a2 2 0 0 1-2 2h-2"/>
    <path d="M7 21H5a2 2 0 0 1-2-2v-2"/>
    <circle cx="12" cy="12" r="3"/>
    <path d="m16 16-1.9-1.9"/>
  </svg>`,

  // Jungle Path → Route (S-curve path between dots)
  'jungle-path': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="19" r="3"/>
    <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>
    <circle cx="18" cy="5" r="3"/>
  </svg>`,

  // KDA Tracker → Crosshair
  'kda-tracker': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <line x1="22" x2="18" y1="12" y2="12"/>
    <line x1="6" x2="2" y1="12" y2="12"/>
    <line x1="12" x2="12" y1="6" y2="2"/>
    <line x1="12" x2="12" y1="22" y2="18"/>
  </svg>`,

  // Auto Accept → Check in circle
  'auto-accept': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/>
    <path d="m9 12 2 2 4-4"/>
  </svg>`,

  // Smart Pick / Counterpick → Crossed swords
  'counterpick': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/>
    <line x1="13" x2="19" y1="19" y2="13"/>
    <line x1="16" x2="20" y1="16" y2="20"/>
    <line x1="19" x2="21" y1="21" y2="19"/>
    <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/>
    <line x1="5" x2="9" y1="14" y2="18"/>
    <line x1="7" x2="4" y1="17" y2="20"/>
    <line x1="3" x2="5" y1="19" y2="21"/>
  </svg>`,

  // Lobby Level → User silhouette (+ arrow up for level)
  'lobby-level': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="10" cy="7" r="4"/>
    <line x1="20" y1="14" x2="20" y2="6"/>
    <polyline points="17,9 20,6 23,9"/>
  </svg>`,

  // Auto Rune → Hexagon (rune stone shape)
  'auto-rune': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
    <circle cx="12" cy="12" r="3" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Best Item → Gem (faceted gemstone)
  'best-item': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.5 3 8 9l4 13 4-13-2.5-6"/>
    <path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"/>
    <path d="M2 9h20"/>
  </svg>`,

  // Death Timer → Hourglass
  'death-timer': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 22h14"/>
    <path d="M5 2h14"/>
    <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/>
    <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>
  </svg>`,

  // Auto Pick/Ban → Zap (lightning bolt)
  'auto-pick': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
  </svg>`,

  // LP Tracker → Trending up (line chart with arrow)
  'lp-tracker': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M16 7h6v6"/>
    <path d="m22 7-8.5 8.5-5-5L2 17"/>
  </svg>`,

  // Skill Order → Column chart (ascending bars)
  'skill-order': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 3v16a2 2 0 0 0 2 2h16"/>
    <path d="M18 17V9"/>
    <path d="M13 17V5"/>
    <path d="M8 17v-3"/>
  </svg>`,

  // Recall Window → Circular arrow (recall) with coin
  'recall-window': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
    <path d="M3 3v5h5"/>
    <circle cx="12" cy="13" r="3"/>
    <line x1="12" y1="11.5" x2="12" y2="14.5"/>
    <line x1="10.5" y1="13" x2="13.5" y2="13"/>
  </svg>`,

  // Session Stats → Trophy / medal with stats
  'session-stats': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>
    <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
    <path d="M4 22h16"/>
    <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
    <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
    <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
  </svg>`,

  // Post-Game Stats → Clipboard with check (results sheet)
  'post-game': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
    <path d="m9 14 2 2 4-4"/>
  </svg>`,

  // TFT Comp Advisor → Grid/puzzle (team composition)
  'tft-comp': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1"/>
    <rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/>
    <rect x="14" y="14" width="7" height="7" rx="1"/>
    <path d="M10 7h4" opacity="0.6"/>
    <path d="M10 17h4" opacity="0.6"/>
    <path d="M7 10v4" opacity="0.6"/>
    <path d="M17 10v4" opacity="0.6"/>
  </svg>`,
};

// Category icon → LoL diamond/hexagon emblem (white stroke)
const CATEGORY_STROKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="28,4 50,16 50,40 28,52 6,40 6,16"/>
  <polygon points="28,14 40,20 40,36 28,42 16,36 16,20" stroke-width="1.5" opacity="0.7"/>
  <circle cx="28" cy="28" r="4" fill="#FFFFFF" stroke="none"/>
</svg>`;

// ─────────────────────── Generator ───────────────────────

async function generateActionIcon(name, svg, size1x = 20) {
  const outDir = path.join(IMGS, 'actions', name);
  ensureDir(outDir);
  const size2x = size1x * 2;

  const buf2x = await sharp(Buffer.from(svg))
    .resize(size2x, size2x)
    .png()
    .toBuffer();

  const buf1x = await sharp(Buffer.from(svg))
    .resize(size1x, size1x)
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(outDir, 'icon.png'), buf1x);
  fs.writeFileSync(path.join(outDir, 'icon@2x.png'), buf2x);
  console.log(`  ✓ ${name}/icon.png (${size1x}×${size1x}) + @2x (${size2x}×${size2x})`);
}

// ─────────────── Key Image Generator (on-device default) ───────────────

const DARK_BG = '#0A1428';   // LoL dark blue
const GOLD    = '#C89B3C';   // LoL gold accent

/**
 * Generate a key image: stroke icon centered on a dark LoL-themed background
 * with a subtle gold border. 72×72 / 144×144.
 */
async function generateKeyImage(name, svg, size1x = 72) {
  const outDir = path.join(IMGS, 'actions', name);
  ensureDir(outDir);
  const size2x = size1x * 2;
  const borderW = 3;
  const cornerR = 14;
  const iconPad = Math.round(size2x * 0.2); // padding around stroke icon
  const iconSize = size2x - iconPad * 2;

  // Dark background with rounded corners and gold border
  const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size2x}" height="${size2x}">
    <rect width="${size2x}" height="${size2x}" rx="${cornerR}" ry="${cornerR}" fill="${DARK_BG}"/>
    <rect x="${borderW}" y="${borderW}" width="${size2x - borderW * 2}" height="${size2x - borderW * 2}"
      rx="${cornerR - borderW}" ry="${cornerR - borderW}" stroke="${GOLD}" stroke-width="${borderW}" fill="none"/>
  </svg>`;

  const bg = await sharp(Buffer.from(bgSvg)).png().toBuffer();

  // Render the stroke SVG at icon size
  const strokeIcon = await sharp(Buffer.from(svg))
    .resize(iconSize, iconSize)
    .png()
    .toBuffer();

  // Composite stroke icon on dark bg
  const buf2x = await sharp(bg)
    .composite([{ input: strokeIcon, left: iconPad, top: iconPad }])
    .png()
    .toBuffer();

  const buf1x = await sharp(buf2x).resize(size1x, size1x).png().toBuffer();

  fs.writeFileSync(path.join(outDir, 'key.png'), buf1x);
  fs.writeFileSync(path.join(outDir, 'key@2x.png'), buf2x);
  console.log(`  ✓ ${name}/key.png (${size1x}×${size1x}) + @2x (${size2x}×${size2x})`);
}

async function main() {
  console.log('🎨 Generating white stroke icons for Elgato Marketplace…\n');

  // 1. Action sidebar icons (20×20 / 40×40)
  console.log('── Action Sidebar Icons (white stroke, transparent bg) ──');
  for (const [name, svg] of Object.entries(STROKE_ICONS)) {
    await generateActionIcon(name, svg);
  }

  // 2. Key images (72×72 / 144×144) — same stroke icons on dark background
  console.log('\n── Key Images (white stroke, dark bg) ──');
  for (const [name, svg] of Object.entries(STROKE_ICONS)) {
    await generateKeyImage(name, svg);
  }

  // 3. Category icon (28×28 / 56×56)
  console.log('\n── Category Icon (white stroke) ──');
  const catDir = path.join(IMGS, 'plugin');
  ensureDir(catDir);

  const cat2x = await sharp(Buffer.from(CATEGORY_STROKE_SVG))
    .resize(56, 56)
    .png()
    .toBuffer();

  const cat1x = await sharp(Buffer.from(CATEGORY_STROKE_SVG))
    .resize(28, 28)
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(catDir, 'category-icon.png'), cat1x);
  fs.writeFileSync(path.join(catDir, 'category-icon@2x.png'), cat2x);
  console.log('  ✓ category-icon.png (28×28) + @2x (56×56)');

  console.log('\n✅ All white stroke icons generated!');
  console.log('   Sidebar icons: white stroke on transparent background');
  console.log('   Key images: white stroke on dark LoL-themed background');
  console.log('   Key images change dynamically during gameplay (champion, items, runes)');
  console.log(`   Output: ${IMGS}`);
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
