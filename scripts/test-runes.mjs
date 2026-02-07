// Test fetching rune data from Lolalytics build page
const url = 'https://lolalytics.com/lol/aatrox/build/?lane=top';
const resp = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
});
const html = await resp.text();
console.log('HTML length:', html.length);

// Look for qwik/json script
const qwikMatch = html.match(/<script\s+type="qwik\/json">([\s\S]*?)<\/script>/);
if (qwikMatch) {
  console.log('\n=== Found qwik/json, length:', qwikMatch[1].length);
  try {
    const data = JSON.parse(qwikMatch[1]);
    console.log('Keys:', Object.keys(data));
    // Look for rune IDs in the data
    const str = JSON.stringify(data);
    const runeIds = str.match(/8[0-4]\d{2}/g);
    if (runeIds) {
      const unique = [...new Set(runeIds)];
      console.log('Unique 4-digit rune-like IDs found:', unique.sort());
    }
  } catch(e) {
    console.log('Parse error:', e.message);
  }
}

// Look for any script with serialized JSON data 
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
console.log('\nTotal scripts:', scripts.length);
for (const [i, s] of scripts.entries()) {
  const content = s[1].trim();
  if (content.length > 10 && content.length < 500000) {
    // Check if it contains rune-related data
    if (content.includes('8112') || content.includes('selectedPerk') || content.includes('perkIds') || content.includes('"rune"')) {
      console.log(`\nScript ${i} (len=${content.length}): contains rune data`);
      console.log(content.substring(0, 500));
    }
  }
}

// Look for JSON-LD or embedded JSON with rune page data
const allRuneIds = [...html.matchAll(/rune\d+\/(\d+)\.webp/g)].map(m => m[1]);
console.log('\nRune IDs from image URLs:', [...new Set(allRuneIds)]);

const statModIds = [...html.matchAll(/statmod\d+\/(\d+)\.webp/g)].map(m => m[1]);
console.log('Stat mod IDs from image URLs:', [...new Set(statModIds)]);

// Try to find the "highest win" rune page section
// Look for patterns indicating selected runes in the HTML structure
const sectionMatch = html.match(/Highest Win[\s\S]{0,200}?Rune Page/);
if (sectionMatch) {
  console.log('\nFound "Highest Win Rune Page" section');
}

// Try to find serialized state with rune page arrays 
const stateMatch = html.match(/\[\d{4},\d{4},\d{4},\d{4},\d{4},\d{4},\d{4},\d{4},\d{4}\]/g);
if (stateMatch) {
  console.log('\nArrays of 9 4-digit numbers (possible rune pages):', stateMatch);
}
