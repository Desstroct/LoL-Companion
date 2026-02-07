// Follow the rune page data chain
const url = 'https://lolalytics.com/lol/aatrox/build/?lane=top';
const resp = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});
const html = await resp.text();

const qwikMatch = html.match(/<script\s+type="qwik\/json">([\s\S]*?)<\/script>/);
const qData = JSON.parse(qwikMatch[1]);
const objs = qData.objs;

function r(ref) {
  if (typeof ref !== 'string') return ref;
  const idx = parseInt(ref, 36);
  if (idx >= 0 && idx < objs.length) return objs[idx];
  return `<unresolved:${ref}>`;
}

function deepResolve(ref, depth = 0) {
  if (depth > 5) return `<max-depth>`;
  const val = r(ref);
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const result = {};
    for (const [k, v] of Object.entries(val)) {
      result[k] = deepResolve(v, depth + 1);
    }
    return result;
  }
  if (Array.isArray(val)) {
    return val.map(v => typeof v === 'string' ? deepResolve(v, depth + 1) : v);
  }
  return val;
}

// Object 1802 → runes → 1cp → { wr, n, page, set }
const runesRef = objs[1802].runes;
const runesObj = r(runesRef);
console.log('runes raw:', JSON.stringify(runesObj));

// Resolve each field
const wr = deepResolve(runesObj.wr, 0);
const n = deepResolve(runesObj.n, 0);
const page = deepResolve(runesObj.page, 0);
const set = deepResolve(runesObj.set, 0);

console.log('\nwr:', JSON.stringify(wr)?.substring(0, 300));
console.log('\nn:', JSON.stringify(n)?.substring(0, 300));
console.log('\npage:', JSON.stringify(page)?.substring(0, 500));
console.log('\nset:', JSON.stringify(set)?.substring(0, 500));

// If page is an array, resolve deeper
if (typeof page === 'object') {
  console.log('\npage type:', typeof page, Array.isArray(page) ? 'array' : 'obj');
  if (Array.isArray(page)) {
    for (let i = 0; i < Math.min(page.length, 15); i++) {
      const item = typeof page[i] === 'string' ? deepResolve(page[i], 0) : page[i];
      console.log(`  page[${i}]:`, JSON.stringify(item)?.substring(0, 200));
    }
  } else {
    for (const [k, v] of Object.entries(page)) {
      console.log(`  page.${k}:`, JSON.stringify(v)?.substring(0, 200));
    }
  }
}

// Also check 1858 (likely "Most Common Build")
const runesRef2 = objs[1858].runes;
const runesObj2 = r(runesRef2);
console.log('\n\n=== Object 1858 runes ===');
const page2 = deepResolve(runesObj2.page, 0);
console.log('page:', JSON.stringify(page2)?.substring(0, 500));

// Let the fullSet deep resolve
if (typeof set === 'object' && Array.isArray(set)) {
  console.log('\n\n=== Full set (resolved) ===');
  for (let i = 0; i < Math.min(set.length, 20); i++) {
    console.log(`  set[${i}]:`, JSON.stringify(set[i])?.substring(0, 300));
  }
}
