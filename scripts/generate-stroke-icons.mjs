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
// All icons designed at 40×40 viewBox with white (#FFFFFF) stroke
// on transparent background. Stroke width ~2px for clarity at 20×20.
// RULE: No <text> elements (sharp can't render fonts). Keep shapes simple
// for legibility at 20×20. Max 4-5 elements per icon.

const STROKE_ICONS = {
  // Game Status → Monitor with signal waves
  'game-status': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="5" y="7" width="30" height="20" rx="2"/>
    <line x1="20" y1="27" x2="20" y2="32"/>
    <line x1="13" y1="32" x2="27" y2="32"/>
    <circle cx="20" cy="17" r="2" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Lobby Scanner → Magnifying glass (clean, no inner detail)
  'lobby-scanner': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="18" cy="18" r="12"/>
    <line x1="27" y1="27" x2="36" y2="36" stroke-width="2.5"/>
    <circle cx="18" cy="18" r="5"/>
  </svg>`,

  // Jungle Path → Three connected waypoints (route)
  'jungle-path': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="8" cy="32" r="4"/>
    <circle cx="20" cy="14" r="4"/>
    <circle cx="34" cy="28" r="4"/>
    <line x1="11" y1="29" x2="17" y2="17"/>
    <line x1="23" y1="17" x2="31" y2="25"/>
  </svg>`,

  // KDA Tracker → Crosshair / target
  'kda-tracker': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="20" cy="20" r="12"/>
    <circle cx="20" cy="20" r="5"/>
    <line x1="20" y1="4" x2="20" y2="10"/>
    <line x1="20" y1="30" x2="20" y2="36"/>
    <line x1="4" y1="20" x2="10" y2="20"/>
    <line x1="30" y1="20" x2="36" y2="20"/>
  </svg>`,

  // Auto Accept → Checkmark in circle
  'auto-accept': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="20" cy="20" r="15"/>
    <polyline points="12,20 18,26 28,14" stroke-width="2.5"/>
  </svg>`,

  // Smart Pick / Counterpick → Crossed swords
  'counterpick': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="8" y1="8" x2="32" y2="32" stroke-width="2.5"/>
    <line x1="32" y1="8" x2="8" y2="32" stroke-width="2.5"/>
    <polyline points="8,15 8,8 15,8"/>
    <polyline points="25,8 32,8 32,15"/>
    <polyline points="8,25 8,32 15,32"/>
    <polyline points="25,32 32,32 32,25"/>
  </svg>`,

  // Lobby Level → Single user with level-up arrow
  'lobby-level': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="16" cy="13" r="6"/>
    <path d="M4 34 Q4 24 16 24 Q28 24 28 34"/>
    <line x1="34" y1="24" x2="34" y2="10"/>
    <polyline points="30,14 34,10 38,14"/>
  </svg>`,

  // Auto Rune → Diamond / rune stone with inner glow
  'auto-rune': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="20,3 36,20 20,37 4,20"/>
    <polygon points="20,11 29,20 20,29 11,20" stroke-width="1.5"/>
    <circle cx="20" cy="20" r="3" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Best Item → Gem / diamond shape (precious item)
  'best-item': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="20,4 36,16 20,36 4,16"/>
    <line x1="4" y1="16" x2="36" y2="16"/>
    <line x1="13" y1="4" x2="10" y2="16"/>
    <line x1="27" y1="4" x2="30" y2="16"/>
    <line x1="10" y1="16" x2="20" y2="36"/>
    <line x1="30" y1="16" x2="20" y2="36"/>
  </svg>`,

  // Death Timer → Hourglass
  'death-timer': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="8" y1="4" x2="32" y2="4"/>
    <line x1="8" y1="36" x2="32" y2="36"/>
    <path d="M10 4 L10 12 Q10 20 20 20 Q30 20 30 12 L30 4"/>
    <path d="M10 36 L10 28 Q10 20 20 20 Q30 20 30 28 L30 36"/>
  </svg>`,

  // Auto Pick/Ban → Lightning bolt (instant auto-action)
  'auto-pick': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="24,3 10,22 19,22 16,37 30,18 21,18" stroke-width="2"/>
  </svg>`,

  // LP Tracker → Trending chart with arrow up
  'lp-tracker': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4,32 14,22 22,28 36,10" stroke-width="2.5"/>
    <polyline points="28,10 36,10 36,18"/>
    <line x1="4" y1="36" x2="36" y2="36"/>
  </svg>`,

  // Skill Order → Three ascending bars (skill levels rising)
  'skill-order': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="26" width="8" height="10" rx="1"/>
    <rect x="16" y="18" width="8" height="18" rx="1"/>
    <rect x="28" y="8" width="8" height="28" rx="1"/>
    <polyline points="6,10 20,4 34,10" stroke-width="1.5" stroke-dasharray="2 2"/>
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
