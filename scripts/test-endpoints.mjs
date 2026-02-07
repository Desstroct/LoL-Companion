// Test the discovered Lolalytics API endpoints
// Mapping discovered from JS bundles:
// build/front/tierlist/arena → a1.lolalytics.com
// vs/keystone → a3.lolalytics.com  
// item → a2.lolalytics.com

const tests = [
  // Build page endpoint (from q-C3cSVHEl.js)
  {
    name: 'Build page - base data',
    url: 'https://a1.lolalytics.com/mega/?ep=champion&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all'
  },
  {
    name: 'Build page - team data',
    url: 'https://a1.lolalytics.com/mega/?ep=build-team&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all'
  },
  {
    name: 'Build page - itemsets',
    url: 'https://a1.lolalytics.com/mega/?ep=build-itemset&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all'
  },
  {
    name: 'VS page - matchup data',
    url: 'https://a3.lolalytics.com/mega/?ep=champion&v=1&patch=16.3&c=aatrox&lane=top&vs=122&vslane=top&tier=emerald_plus&queue=ranked'
  },
  {
    name: 'VS page - with champion name',
    url: 'https://a3.lolalytics.com/mega/?ep=champion&v=1&patch=16.3&c=aatrox&lane=top&vs=darius&vslane=top&tier=emerald_plus&queue=ranked'
  },
  // Try counters endpoint
  {
    name: 'Counters endpoint guess 1',
    url: 'https://a1.lolalytics.com/mega/?ep=counters&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all'
  },
  {
    name: 'Counters endpoint guess 2',
    url: 'https://a1.lolalytics.com/mega/?ep=counter&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all'
  },
  // Tierlist
  {
    name: 'Tierlist endpoint',
    url: 'https://a1.lolalytics.com/mega/?ep=tierlist&v=1&patch=16.3&lane=top&tier=emerald_plus&queue=ranked&region=all'
  },
  // Try with 'cid' instead of 'c'
  {
    name: 'Build with cid param',
    url: 'https://a1.lolalytics.com/mega/?ep=champion&v=1&patch=16.3&cid=266&lane=top&tier=emerald_plus&queue=ranked&region=all'
  },
  // Arena 
  {
    name: 'Arena endpoint',
    url: 'https://a1.lolalytics.com/mega/?ep=champion&v=1&patch=16.3&c=aatrox&tier=emerald_plus&region=all'
  }
];

for (const test of tests) {
  try {
    const resp = await fetch(test.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const text = await resp.text();
    const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');
    
    console.log(`\n--- ${test.name} ---`);
    console.log(`URL: ${test.url}`);
    console.log(`Status: ${resp.status} | JSON: ${isJson} | Length: ${text.length}`);
    
    if (isJson && text.length > 10) {
      try {
        const data = JSON.parse(text);
        console.log('Keys:', Object.keys(data).join(', '));
        // Show first few values for important keys
        if (data.header) console.log('header:', JSON.stringify(data.header).substring(0, 200));
        if (data.enemy) console.log('enemy (first 200):', JSON.stringify(data.enemy).substring(0, 200));
        if (data.summary) console.log('summary (first 200):', JSON.stringify(data.summary).substring(0, 200));
      } catch(e) {
        console.log('Parse error:', e.message);
      }
    } else {
      console.log('Response:', text.substring(0, 300));
    }
  } catch(e) {
    console.log(`\n--- ${test.name} --- ERROR: ${e.message}`);
  }
}
