// Parse runes from the Qwik state by following references
const url = 'https://lolalytics.com/lol/aatrox/build/?lane=top';
const resp = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});
const html = await resp.text();

const qwikMatch = html.match(/<script\s+type="qwik\/json">([\s\S]*?)<\/script>/);
const qData = JSON.parse(qwikMatch[1]);
const objs = qData.objs;

// Qwik references use a custom base encoding
// Let's understand the reference format - they look like base36 but might be sequential indices
function resolveRef(ref) {
  // The ref is a string like "1cp" - it's a base36 index into the objs array
  const idx = parseInt(ref, 36);
  if (idx >= 0 && idx < objs.length) {
    return objs[idx];
  }
  return undefined;
}

// Look at the rune page objects we found
// Object 9724: {description, $$runePage, $$active, primary}
const runePageObj1 = objs[9724];
console.log('Object 9724:', JSON.stringify(runePageObj1));
const runePage1 = resolveRef(runePageObj1['$$runePage']);
console.log('$$runePage resolved:', JSON.stringify(runePage1)?.substring(0, 500));

const runePageObj2 = objs[9729];
console.log('\nObject 9729:', JSON.stringify(runePageObj2));
const runePage2 = resolveRef(runePageObj2['$$runePage']);
console.log('$$runePage resolved:', JSON.stringify(runePage2)?.substring(0, 500));

// Object 9737 has `runePage` (not $$)
const runePageObj3 = objs[9737];
console.log('\nObject 9737:', JSON.stringify(runePageObj3));
const runePage3 = resolveRef(runePageObj3['runePage']);
console.log('runePage resolved:', JSON.stringify(runePage3)?.substring(0, 500));

// Let's also check the runes data from object 1802 and 9190
const buildObj = objs[1802];
console.log('\nObject 1802:', JSON.stringify(buildObj));
if (buildObj?.runes) {
  const runes = resolveRef(buildObj.runes);
  console.log('runes resolved:', JSON.stringify(runes)?.substring(0, 500));
  // If it's another reference or object, resolve deeper
  if (typeof runes === 'string') {
    const deeper = resolveRef(runes);
    console.log('deeper:', JSON.stringify(deeper)?.substring(0, 500));
  } else if (Array.isArray(runes)) {
    for (let i = 0; i < Math.min(runes.length, 5); i++) {
      const item = typeof runes[i] === 'string' ? resolveRef(runes[i]) : runes[i];
      console.log(`  runes[${i}]:`, JSON.stringify(item)?.substring(0, 300));
    }
  }
}

// Let's also search for objects with specific rune style IDs (8000, 8100, 8200, 8300, 8400)
const styleIds = [8000, 8100, 8200, 8300, 8400];
for (let i = 0; i < objs.length; i++) {
  if (Array.isArray(objs[i])) {
    const hasStyle = objs[i].some(v => styleIds.includes(v));
    const hasPerk = objs[i].some(v => typeof v === 'number' && v > 8000 && v < 9999);
    if (hasStyle && hasPerk && objs[i].length >= 2) {
      console.log(`\nArray at ${i} with style IDs:`, objs[i]);
    }
  }
}

// Search for the "19t" reference (from object 9737's runePage)
const idx19t = parseInt('19t', 36);
console.log('\n"19t" = index', idx19t);
if (idx19t < objs.length) {
  const val = objs[idx19t];
  console.log('Value:', JSON.stringify(val)?.substring(0, 500));
  if (typeof val === 'object' && val !== null) {
    for (const [k, v] of Object.entries(val)) {
      const resolved = typeof v === 'string' ? resolveRef(v) : v;
      console.log(`  ${k}:`, JSON.stringify(resolved)?.substring(0, 200));
    }
  }
}

// Also look for objects that are arrays of numbers with rune-like values
// but this time, smaller arrays that might be the actual selected perk configs
for (let i = 0; i < objs.length; i++) {
  const obj = objs[i];
  if (Array.isArray(obj) && obj.length >= 4 && obj.length <= 6) {
    const allPerks = obj.every(item => typeof item === 'number' && item >= 8000 && item <= 9999);
    if (allPerks) {
      console.log(`\nSmall perk array at ${i}:`, obj);
    }
  }
}
