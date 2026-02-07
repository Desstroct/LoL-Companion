// Fetch and analyze the key API JS chunks

const chunks = ['q-C3cSVHEl.js', 'q-DfIkTzcw.js', 'q-BWOnPwtL.js'];

for (const chunk of chunks) {
  const resp = await fetch('https://lolalytics.com/build/' + chunk, {headers: {'User-Agent': 'Mozilla/5.0'}});
  const code = await resp.text();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== ${chunk} (${code.length} bytes) ===`);
  console.log(`${'='.repeat(60)}`);
  console.log(code);
}

// Also let's fetch the SSR HTML and find the nav.api config
console.log(`\n${'='.repeat(60)}`);
console.log('=== Looking for nav.api config in HTML ===');
console.log(`${'='.repeat(60)}`);

const htmlResp = await fetch('https://lolalytics.com/lol/aatrox/counters/', {headers: {'User-Agent': 'Mozilla/5.0'}});
const html = await htmlResp.text();

// Search for api configuration in the serialized state
const apiMatches = [...html.matchAll(/api[^}]{0,200}/gi)].filter(m => 
  m[0].includes('a1') || m[0].includes('a2') || m[0].includes('cdn') || m[0].includes('lolalytics')
);
console.log('API config matches:');
apiMatches.forEach(m => console.log('  ', m[0].substring(0, 300)));

// Also look for the big inline script that has serialized state
const bigScript = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .filter(s => s.length > 100000);
  
console.log('\nBig inline scripts:', bigScript.length);
if (bigScript.length > 0) {
  // Search for api property in the serialized data
  const s = bigScript[0];
  const apiIdx = s.indexOf('"api"');
  if (apiIdx >= 0) {
    console.log('Found "api" at index', apiIdx);
    console.log('Context:', s.substring(apiIdx - 50, apiIdx + 500));
  }
  
  // Alternative: search for a1, a2 patterns near "api"
  const patterns = [...s.matchAll(/"a[0-9]"/g)];
  console.log('"aX" patterns:', patterns.length);
  patterns.slice(0, 10).forEach(m => {
    console.log('  at', m.index, ':', s.substring(m.index - 30, m.index + 30));
  });
}
