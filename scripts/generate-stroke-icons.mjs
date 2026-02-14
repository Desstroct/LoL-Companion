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

const STROKE_ICONS = {
  // Game Status → Monitor / screen with signal dot
  'game-status': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="4" y="6" width="32" height="22" rx="3"/>
    <line x1="20" y1="28" x2="20" y2="33"/>
    <line x1="13" y1="33" x2="27" y2="33"/>
    <circle cx="20" cy="17" r="3" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Lobby Scanner → Magnifying glass with user
  'lobby-scanner': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="17" cy="17" r="11"/>
    <line x1="25" y1="25" x2="35" y2="35"/>
    <circle cx="17" cy="14" r="3" stroke-width="1.5"/>
    <path d="M11 22 Q17 18 23 22" stroke-width="1.5"/>
  </svg>`,

  // Jungle Path → Winding path with trees
  'jungle-path': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 36 Q14 28 10 20 Q6 12 20 6 Q34 0 32 14 Q30 22 26 26 Q22 30 28 36"/>
    <circle cx="8" cy="10" r="3" stroke-width="1.5"/>
    <circle cx="34" cy="28" r="3" stroke-width="1.5"/>
  </svg>`,

  // KDA Tracker → Crosshair / target
  'kda-tracker': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="20" cy="20" r="13"/>
    <circle cx="20" cy="20" r="7"/>
    <circle cx="20" cy="20" r="2" fill="#FFFFFF" stroke="none"/>
    <line x1="20" y1="3" x2="20" y2="9"/>
    <line x1="20" y1="31" x2="20" y2="37"/>
    <line x1="3" y1="20" x2="9" y2="20"/>
    <line x1="31" y1="20" x2="37" y2="20"/>
  </svg>`,

  // Auto Accept → Checkmark in circle
  'auto-accept': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="20" cy="20" r="15"/>
    <polyline points="12,20 18,26 28,14" stroke-width="2.5"/>
  </svg>`,

  // Smart Pick / Counterpick → Sword + shield (strategy)
  'counterpick': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10 4 L10 22 L20 30 L30 22 L30 4" stroke-width="2"/>
    <line x1="10" y1="12" x2="30" y2="12"/>
    <line x1="20" y1="12" x2="20" y2="26"/>
    <circle cx="20" cy="36" r="2" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Lobby Level → Users with level badge
  'lobby-level': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="14" cy="12" r="5"/>
    <path d="M4 32 Q4 22 14 22 Q24 22 24 32"/>
    <circle cx="28" cy="10" r="4" stroke-width="1.5"/>
    <path d="M20 30 Q20 22 28 22 Q36 22 36 30" stroke-width="1.5"/>
  </svg>`,

  // Auto Rune → Diamond / rune stone
  'auto-rune': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polygon points="20,3 36,20 20,37 4,20"/>
    <polygon points="20,10 30,20 20,30 10,20" stroke-width="1.5"/>
    <circle cx="20" cy="20" r="3" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Best Item → Shopping bag with star
  'best-item': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 14 L6 36 L34 36 L32 14 Z"/>
    <path d="M14 14 L14 10 Q14 4 20 4 Q26 4 26 10 L26 14"/>
    <polygon points="20,19 22,24 27,24 23,27 24,32 20,29 16,32 17,27 13,24 18,24" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Death Timer → Skull
  'death-timer': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 22 Q8 6 20 6 Q32 6 32 22 L32 28 L28 28 L26 34 L22 28 L18 28 L14 34 L12 28 L8 28 Z"/>
    <circle cx="15" cy="18" r="3" fill="#FFFFFF" stroke="none"/>
    <circle cx="25" cy="18" r="3" fill="#FFFFFF" stroke="none"/>
  </svg>`,

  // Auto Pick/Ban → Cursor click / lightning pick
  'auto-pick': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 4 L8 28 L14 22 L22 34 L26 32 L18 20 L26 20 Z"/>
  </svg>`,

  // LP Tracker → Trending chart with arrow up
  'lp-tracker': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="4,32 12,24 20,28 36,8" stroke-width="2.5"/>
    <polyline points="28,8 36,8 36,16"/>
    <line x1="4" y1="36" x2="36" y2="36"/>
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
