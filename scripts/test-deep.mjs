// Deep dive into the working endpoints

// 1. Inspect the counter endpoint response
console.log('=== ep=counter response ===');
const counterResp = await fetch('https://a1.lolalytics.com/mega/?ep=counter&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
});
const counterData = await counterResp.json();
console.log('Keys:', Object.keys(counterData));
console.log('stats:', JSON.stringify(counterData.stats).substring(0, 500));
console.log('\ncounters type:', typeof counterData.counters);
if (Array.isArray(counterData.counters)) {
  console.log('counters length:', counterData.counters.length);
  console.log('counters[0]:', JSON.stringify(counterData.counters[0]));
  console.log('counters[1]:', JSON.stringify(counterData.counters[1]));
} else {
  console.log('counters:', JSON.stringify(counterData.counters).substring(0, 1000));
}
console.log('response:', JSON.stringify(counterData.response));

// 2. Try more ep values
const epValues = [
  'champion', 'build', 'overview', 'stats', 'matchup', 'matchups',
  'lane', 'runes', 'items', 'spells', 'skills', 'build-earlyset',
  'tierlist', 'tier', 'ranking', 'popular', 'winning', 'list',
  'header', 'summary', 'graph', 'sidebar', 'enemy', 'team',
  'build-boot', 'build-rune', 'counters', 'counter2',
  'build2', 'build3', 'champion2', 'champion3', 'all',
  'general', 'champ', 'profile', 'data', 'mega'
];

console.log('\n=== Testing ep values on a1 ===');
for (const ep of epValues) {
  const resp = await fetch(`https://a1.lolalytics.com/mega/?ep=${ep}&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const text = await resp.text();
  const valid = !text.includes('invalid end point');
  if (valid) {
    const isJson = text.trim().startsWith('{');
    console.log(`  ep=${ep}: VALID (${text.length} bytes, JSON: ${isJson})`);
    if (isJson) {
      const data = JSON.parse(text);
      console.log(`    Keys: ${Object.keys(data).join(', ')}`);
    }
  }
}

// 3. Try the VS (a3) domain with working ep values
console.log('\n=== Testing ep values on a3 (vs domain) ===');
const vsEpValues = ['counter', 'build-team', 'build-itemset', 'build-earlyset', 'vs', 'matchup', 'champion'];
for (const ep of vsEpValues) {
  const resp = await fetch(`https://a3.lolalytics.com/mega/?ep=${ep}&v=1&patch=16.3&c=aatrox&lane=top&vs=darius&vslane=top&tier=emerald_plus&queue=ranked`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const text = await resp.text();
  const valid = !text.includes('invalid end point');
  if (valid) {
    const isJson = text.trim().startsWith('{');
    console.log(`  ep=${ep}: VALID (${text.length} bytes, JSON: ${isJson})`);
    if (isJson) {
      const data = JSON.parse(text);
      console.log(`    Keys: ${Object.keys(data).join(', ')}`);
    }
  }
}

// 4. Try the item (a2) domain
console.log('\n=== Testing ep values on a2 (item domain) ===');
for (const ep of ['counter', 'build-team', 'build-itemset', 'champion', 'item']) {
  const resp = await fetch(`https://a2.lolalytics.com/mega/?ep=${ep}&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all&item=3071`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const text = await resp.text();
  const valid = !text.includes('invalid end point');
  if (valid) {
    const isJson = text.trim().startsWith('{');
    console.log(`  ep=${ep}: VALID (${text.length} bytes, JSON: ${isJson})`);
    if (isJson) {
      const data = JSON.parse(text);
      console.log(`    Keys: ${Object.keys(data).join(', ')}`);
    }
  }
}
