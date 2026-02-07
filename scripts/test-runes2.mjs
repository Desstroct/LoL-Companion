// Deeper rune page parsing from Lolalytics build page HTML
const url = 'https://lolalytics.com/lol/aatrox/build/?lane=top';
const resp = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});
const html = await resp.text();

// Parse the Qwik JSON state
const qwikMatch = html.match(/<script\s+type="qwik\/json">([\s\S]*?)<\/script>/);
const qData = JSON.parse(qwikMatch[1]);

// The Qwik state stores UI state in 'objs' array. 
// Let's look for arrays that contain rune perk IDs
const objs = qData.objs;
console.log('Total objects in qwik state:', objs.length);

// Find objects that look like rune page arrays (arrays with perk IDs)
const perkIdPattern = /^(8\d{3}|9\d{3}|5\d{3})$/;
const runeArrays = [];

for (let i = 0; i < objs.length; i++) {
  const obj = objs[i];
  if (Array.isArray(obj) && obj.length >= 6 && obj.length <= 12) {
    const allPerks = obj.every(item => typeof item === 'number' && (
      (item >= 8000 && item <= 9999) || (item >= 5000 && item <= 5999)
    ));
    if (allPerks) {
      runeArrays.push({ index: i, data: obj });
    }
  }
}

console.log('\nArrays that look like rune configs:');
for (const ra of runeArrays) {
  console.log(` [${ra.index}] (${ra.data.length} items): [${ra.data.join(', ')}]`);
}

// Also look for rune page objects with perkStyle / selectedPerkIds-like structure
for (let i = 0; i < objs.length; i++) {
  const obj = objs[i];
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const keys = Object.keys(obj);
    if (keys.some(k => k.includes('perk') || k.includes('rune') || k.includes('style'))) {
      console.log(`\n Object ${i} with rune-like keys:`, JSON.stringify(obj).substring(0, 300));
    }
  }
}

// Look for data near the "Highest Win" section in HTML
// We need to understand the HTML structure around rune images
const highestWinIdx = html.indexOf('Highest Win');
if (highestWinIdx > -1) {
  // Extract ~5000 chars after "Highest Win"
  const section = html.substring(highestWinIdx, highestWinIdx + 8000);
  
  // Find all rune images in this section
  const runeImgs = [...section.matchAll(/rune\d+\/(\d+)\.webp/g)].map(m => parseInt(m[1]));
  const statImgs = [...section.matchAll(/statmod\d+\/(\d+)\.webp/g)].map(m => parseInt(m[1]));
  
  console.log('\n=== Rune images after "Highest Win" ===');
  console.log('Rune IDs:', runeImgs);
  console.log('Stat mod IDs:', statImgs);
  
  // Check for data-qwik attributes or classes near rune images that indicate "selected"
  const selectedPatterns = [...section.matchAll(/class="([^"]*)"[^>]*(?:rune|perk)/gi)];
  console.log('\nClasses near rune elements:', selectedPatterns.slice(0, 10).map(m => m[1]));
}

// Let's look at all img tags with rune/statmod and their parent element classes
const runeImgContexts = [...html.matchAll(/(<[^>]{0,500}?)(rune\d+\/(\d+)\.webp)/g)];
console.log('\n=== First 5 rune image contexts ===');
for (const ctx of runeImgContexts.slice(0, 5)) {
  const tag = ctx[1].substring(Math.max(0, ctx[1].length - 200));
  console.log(`Perk ${ctx[3]}: ...${tag}`);
}

// Check for opacity or similar styling on rune images (selected vs unselected)
const opacityPatterns = [...html.matchAll(/opacity[^>]*?rune\d+\/(\d+)\.webp|rune\d+\/(\d+)\.webp[^<]*?opacity/g)];
console.log('\nOpacity patterns near rune images:', opacityPatterns.length);

// Check for "q:s" (Qwik signal subscriptions) near rune elements
const qSignals = [...html.matchAll(/q:s[^>]*?(\d{4})\.webp/g)];
console.log('q:s subscriptions near rune images:', qSignals.slice(0, 3));
