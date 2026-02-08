/**
 * generate-icons.mjs
 * Downloads REAL LoL assets from Data Dragon / Community Dragon and generates
 * all required Stream Deck plugin icons.
 *
 * Usage: node scripts/generate-icons.mjs
 *
 * Icon requirements (Stream Deck SDK v2):
 *   Action icon   (sidebar)  : 20×20  /  @2x 40×40
 *   Key image     (on key)   : 72×72  /  @2x 144×144  — full color
 *   Category icon (sidebar)  : 28×28  /  @2x 56×56
 *   Marketplace   (store)    : 144×144 / @2x 288×288  — full color
 */

import sharp from 'sharp';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'com.desstroct.lol-api.sdPlugin');
const IMGS = path.join(PLUGIN_DIR, 'imgs');

// LoL color palette
const GOLD = '#C89B3C';
const DARK_BLUE = '#0A1428';

// ─────────────────────────── Helpers ───────────────────────────

function download(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Fetch the latest Data Dragon version.
 */
async function getLatestDDVersion() {
  const data = await download('https://ddragon.leagueoflegends.com/api/versions.json');
  const versions = JSON.parse(data.toString());
  return versions[0]; // Latest patch
}

// ─────────────────── Key Image Compositing ───────────────────

/**
 * Create a key image from a source image buffer.
 * Composites the LoL asset onto a dark blue background with gold border.
 */
async function createKeyImage(sourceBuffer, outDir, baseName = 'key', size1x = 72) {
  ensureDir(outDir);
  const size2x = size1x * 2;
  const borderWidth = 3;
  const innerPadding = Math.round(size2x * 0.1);
  const cornerRadius = 14;

  // Create dark background with gold border
  const bgSvg = `<svg width="${size2x}" height="${size2x}">
    <rect x="0" y="0" width="${size2x}" height="${size2x}" rx="${cornerRadius}" ry="${cornerRadius}" fill="${DARK_BLUE}"/>
    <rect x="${borderWidth}" y="${borderWidth}" width="${size2x - borderWidth * 2}" height="${size2x - borderWidth * 2}"
      rx="${cornerRadius - borderWidth}" ry="${cornerRadius - borderWidth}" stroke="${GOLD}" stroke-width="${borderWidth}" fill="none"/>
  </svg>`;

  const bg = await sharp(Buffer.from(bgSvg)).png().toBuffer();

  // Resize source icon to fit inside the border
  const iconSize = size2x - innerPadding * 2;
  const resizedIcon = await sharp(sourceBuffer)
    .resize(iconSize, iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Composite icon centered on background
  const buf2x = await sharp(bg)
    .composite([{ input: resizedIcon, left: innerPadding, top: innerPadding }])
    .png()
    .toBuffer();

  const buf1x = await sharp(buf2x).resize(size1x, size1x).png().toBuffer();

  fs.writeFileSync(path.join(outDir, `${baseName}.png`), buf1x);
  fs.writeFileSync(path.join(outDir, `${baseName}@2x.png`), buf2x);
  console.log(`  ✓ ${baseName}.png (${size1x}×${size1x}) + @2x (${size2x}×${size2x})`);
}

/**
 * Create a sidebar icon from a source image buffer.
 * Resizes to 20×20 (1x) and 40×40 (2x).
 */
async function createSidebarIcon(sourceBuffer, outDir, baseName = 'icon', size1x = 20) {
  ensureDir(outDir);
  const size2x = size1x * 2;

  const buf2x = await sharp(sourceBuffer)
    .resize(size2x, size2x, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const buf1x = await sharp(buf2x).resize(size1x, size1x).png().toBuffer();

  fs.writeFileSync(path.join(outDir, `${baseName}.png`), buf1x);
  fs.writeFileSync(path.join(outDir, `${baseName}@2x.png`), buf2x);
  console.log(`  ✓ ${baseName}.png (${size1x}×${size1x}) + @2x (${size2x}×${size2x})`);
}

// ─────────────────── LoL Asset Definitions ───────────────────

/**
 * Each action mapped to a Data Dragon / Community Dragon asset URL.
 */
function getAssetUrls(ddVersion) {
  const DD = `https://ddragon.leagueoflegends.com/cdn/${ddVersion}`;
  const CD = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1';

  return {
    // Game Status → Poro profile icon (LoL mascot)
    'game-status': `${DD}/img/profileicon/29.png`,

    // Lobby Scanner → Oracle Lens (scanning/vision)
    'lobby-scanner': `${DD}/img/item/3364.png`,

    // Summoner Tracker → Flash (most tracked spell)
    'summoner-tracker': `${DD}/img/spell/SummonerFlash.png`,

    // Jungle Timer → Smite (quintessential jungle spell)
    'jungle-timer': `${DD}/img/spell/SummonerSmite.png`,

    // KDA Tracker → Mejai's Soulstealer (stacks on kills/assists!)
    'kda-tracker': `${DD}/img/item/3041.png`,

    // Auto Accept → Guardian Angel (auto-revive ≈ auto-accept)
    'auto-accept': `${DD}/img/item/3026.png`,

    // Counterpick → Thornmail (THE counter item in LoL)
    'counterpick': `${DD}/img/item/3075.png`,

    // Best Pick → Infinity Edge (THE iconic best item)
    'best-pick': `${DD}/img/item/3031.png`,

    // Lobby Level → Doran's Ring (classic starting item)
    'lobby-level': `${DD}/img/item/1056.png`,

    // Auto Rune → Conqueror keystone (most iconic rune) from Community Dragon
    'auto-rune': `${CD}/perk-images/styles/precision/conqueror/conqueror.png`,

    // Death Timer → Dead Man's Plate (skull on a plate — perfect for death/respawn)
    'death-timer': `${DD}/img/item/3742.png`,

    // Auto Pick/Ban → Blade of the Ruined King (iconic weapon — champion power/selection)
    'auto-pick': `${DD}/img/item/3153.png`,

    // Best Item → Rabadon's Deathcap (THE best item — wizard hat)
    'best-item': `${DD}/img/item/3089.png`,

    // LP Tracker → Watchful Wardstone (ranked/LP tracking)
    'lp-tracker': `${DD}/img/item/3108.png`,
  };
}

// ─────────────────── Keystone Rune Icons ───────────────────

/**
 * All 14 keystone rune icons from Community Dragon.
 * These are downloaded and saved individually so the plugin can dynamically
 * swap the key image based on the detected keystone.
 */
function getKeystoneUrls() {
  const CD = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1';
  return {
    // Precision
    8005: `${CD}/perk-images/styles/precision/presstheattack/presstheattack.png`,
    8008: `${CD}/perk-images/styles/precision/lethaltempo/lethaltempotemp.png`,
    8010: `${CD}/perk-images/styles/precision/conqueror/conqueror.png`,
    8021: `${CD}/perk-images/styles/precision/fleetfootwork/fleetfootwork.png`,
    // Domination
    8112: `${CD}/perk-images/styles/domination/electrocute/electrocute.png`,
    8124: `${CD}/perk-images/styles/domination/predator/predator.png`,
    8128: `${CD}/perk-images/styles/domination/darkharvest/darkharvest.png`,
    9923: `${CD}/perk-images/styles/domination/hailofblades/hailofblades.png`,
    // Sorcery
    8214: `${CD}/perk-images/styles/sorcery/summonaery/summonaery.png`,
    8229: `${CD}/perk-images/styles/sorcery/arcanecomet/arcanecomet.png`,
    8230: `${CD}/perk-images/styles/sorcery/phaserush/phaserush.png`,
    // Resolve
    8437: `${CD}/perk-images/styles/resolve/graspoftheundying/graspoftheundying.png`,
    8439: `${CD}/perk-images/styles/resolve/veteranaftershock/veteranaftershock.png`,
    8465: `${CD}/perk-images/styles/resolve/guardian/guardian.png`,
    // Inspiration
    8351: `${CD}/perk-images/styles/inspiration/glacialaugment/glacialaugment.png`,
    8360: `${CD}/perk-images/styles/inspiration/unsealedspellbook/unsealedspellbook.png`,
    8369: `${CD}/perk-images/styles/inspiration/firststrike/firststrike.png`,
  };
}

// ─────────────────── Marketplace / Category SVGs ───────────────────

const CATEGORY_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56">
  <polygon points="28,4 50,16 50,40 28,52 6,40 6,16" fill="${DARK_BLUE}" stroke="${GOLD}" stroke-width="2"/>
  <polygon points="28,14 40,20 40,36 28,42 16,36 16,20" fill="none" stroke="${GOLD}" stroke-width="1.5" opacity="0.6"/>
  <circle cx="28" cy="28" r="5" fill="${GOLD}"/>
</svg>`;

const MARKETPLACE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 288 288">
  <rect width="288" height="288" rx="32" ry="32" fill="${DARK_BLUE}"/>
  <rect x="6" y="6" width="276" height="276" rx="28" ry="28" stroke="${GOLD}" stroke-width="4" fill="none"/>
  <path d="M144 50 L210 80 L210 160 Q210 220 144 250 Q78 220 78 160 L78 80 Z"
    stroke="${GOLD}" stroke-width="5" fill="none"/>
  <path d="M144 60 L202 87 L202 158 Q202 212 144 240 Q86 212 86 158 L86 87 Z"
    fill="${DARK_BLUE}" opacity="0.8"/>
  <path d="M144 90 L180 150 L144 210 L108 150 Z"
    stroke="${GOLD}" stroke-width="3" fill="${GOLD}" opacity="0.15"/>
  <path d="M144 90 L180 150 L144 210 L108 150 Z"
    stroke="${GOLD}" stroke-width="3" fill="none"/>
  <ellipse cx="144" cy="148" rx="22" ry="13" stroke="${GOLD}" stroke-width="2.5" fill="none"/>
  <circle cx="144" cy="148" r="6" fill="${GOLD}"/>
  <circle cx="144" cy="50" r="8" fill="${DARK_BLUE}" stroke="${GOLD}" stroke-width="2.5"/>
  <circle cx="144" cy="50" r="3" fill="${GOLD}"/>
</svg>`;

// ─────────────────────────── Main ───────────────────────────

async function main() {
  console.log('🎮 Generating LoL Companion icons from REAL League assets…\n');

  // 1. Resolve latest Data Dragon version
  console.log('── Resolving Data Dragon version ──');
  let ddVersion;
  try {
    ddVersion = await getLatestDDVersion();
    console.log(`  ✓ Using Data Dragon v${ddVersion}\n`);
  } catch (e) {
    ddVersion = '14.24.1'; // Fallback
    console.log(`  ⚠ Could not fetch version, falling back to v${ddVersion}\n`);
  }

  const assets = getAssetUrls(ddVersion);

  // 2. Download and generate action icons
  console.log('── Downloading LoL assets & generating action icons ──');
  for (const [actionName, url] of Object.entries(assets)) {
    const outDir = path.join(IMGS, 'actions', actionName);
    console.log(`\n${actionName}:`);
    console.log(`  ↓ ${url}`);

    try {
      const buf = await download(url);
      console.log(`  ✓ Downloaded (${buf.length} bytes)`);

      // Key image (72×72 / 144×144) — composited on LoL-themed background
      await createKeyImage(buf, outDir, 'key', 72);

      // Sidebar icon (20×20 / 40×40) — just the asset resized
      await createSidebarIcon(buf, outDir, 'icon', 20);
    } catch (err) {
      console.log(`  ✗ Failed: ${err.message}`);
      console.log(`  → Keeping existing icons for ${actionName}`);
    }
  }

  // 3. Keystone rune icons for Auto Rune (individual icons per keystone)
  console.log('\n── Keystone Rune Icons ──');
  const keystones = getKeystoneUrls();
  const keystoneDir = path.join(IMGS, 'actions', 'auto-rune', 'keystones');
  for (const [id, url] of Object.entries(keystones)) {
    console.log(`  Keystone ${id}:`);
    console.log(`    ↓ ${url}`);
    try {
      const buf = await download(url);
      console.log(`    ✓ Downloaded (${buf.length} bytes)`);
      await createKeyImage(buf, keystoneDir, String(id), 72);
    } catch (err) {
      console.log(`    ✗ Failed: ${err.message}`);
    }
  }

  // 4. Category icon (SVG → 28×28 / 56×56)
  console.log('\n── Category Icon ──');
  const catDir = path.join(IMGS, 'plugin');
  ensureDir(catDir);
  const cat2x = await sharp(Buffer.from(CATEGORY_SVG)).resize(56, 56).png().toBuffer();
  const cat1x = await sharp(cat2x).resize(28, 28).png().toBuffer();
  fs.writeFileSync(path.join(catDir, 'category-icon.png'), cat1x);
  fs.writeFileSync(path.join(catDir, 'category-icon@2x.png'), cat2x);
  console.log('  ✓ category-icon.png (28×28) + @2x (56×56)');

  // 5. Marketplace icon (SVG → 144×144 / 288×288)
  console.log('\n── Marketplace Icon ──');
  const mp2x = await sharp(Buffer.from(MARKETPLACE_SVG)).resize(288, 288).png().toBuffer();
  const mp1x = await sharp(mp2x).resize(144, 144).png().toBuffer();
  fs.writeFileSync(path.join(catDir, 'marketplace.png'), mp1x);
  fs.writeFileSync(path.join(catDir, 'marketplace@2x.png'), mp2x);
  console.log('  ✓ marketplace.png (144×144) + @2x (288×288)');

  console.log('\n✅ All icons generated from real LoL assets!');
  console.log(`   Output: ${IMGS}`);
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
