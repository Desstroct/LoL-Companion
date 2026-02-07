// Search Qwik JS chunks for API endpoint references

const graphResp = await fetch('https://lolalytics.com/assets/bXBnzvxJ-bundle-graph.json', {headers:{'User-Agent':'Mozilla/5.0'}});
const graphText = await graphResp.text();

const chunks = [...graphText.matchAll(/q-[A-Za-z0-9_-]+\.js/g)].map(m => m[0]);
const uniqueChunks = [...new Set(chunks)];
console.log('Total unique chunks:', uniqueChunks.length);

let found = false;
for (let i = 0; i < uniqueChunks.length; i++) {
  const chunk = uniqueChunks[i];
  try {
    const resp = await fetch('https://lolalytics.com/build/' + chunk, {headers:{'User-Agent':'Mozilla/5.0'}});
    const code = await resp.text();
    
    // Search for API-related patterns
    const hasApi = code.includes('lolalytics.com') || code.includes('/mega/') || 
                   code.includes('ep=') || code.includes('/mega?');
    
    if (hasApi) {
      console.log(`\n=== FOUND API REFS in ${chunk} (${code.length} bytes) ===`);

      // Extract URLs containing lolalytics
      const urlMatches = [...code.matchAll(/https?:\/\/[^\s"'`]+lolalytics[^\s"'`]*/gi)];
      urlMatches.forEach(m => console.log('  URL:', m[0]));
      
      // Extract ep= params
      const epMatches = [...code.matchAll(/ep=[a-z_]+/gi)];
      [...new Set(epMatches.map(m => m[0]))].forEach(m => console.log('  EP:', m));
      
      // Extract mega references
      const megaMatches = [...code.matchAll(/.{0,80}mega.{0,80}/gi)];
      megaMatches.forEach(m => console.log('  MEGA:', m[0].substring(0, 200)));
      
      // Show broader context around lolalytics.com references 
      const idx = code.indexOf('lolalytics.com');
      if (idx >= 0) {
        console.log('  CONTEXT:', code.substring(Math.max(0, idx - 100), idx + 200));
      }
      
      found = true;
    }
  } catch(e) {
    // skip errors
  }
  
  if (i % 50 === 0) process.stdout.write(`Checked ${i}/${uniqueChunks.length}... `);
}

if (!found) {
  console.log('\nNo API references found in any chunks. The API might be called server-side.');
  
  // Let's also check the inline script data more carefully
  console.log('\nTrying to find data in the server-rendered HTML...');
  const pageResp = await fetch('https://lolalytics.com/lol/aatrox/counters/', {headers:{'User-Agent':'Mozilla/5.0'}});
  const html = await pageResp.text();
  
  // Check for any JSON data blocks
  const jsonBlocks = [...html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)];
  console.log('JSON script blocks found:', jsonBlocks.length);
  jsonBlocks.forEach((m, i) => {
    console.log(`Block ${i} (${m[1].length} chars):`, m[1].substring(0, 300));
  });
  
  // Check for any data attributes on elements
  const qData = [...html.matchAll(/q:data="([^"]*)"/g)];
  console.log('q:data attributes:', qData.length);
  
  // Check for qwik serialized state
  const scriptBlocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  console.log('Total script blocks:', scriptBlocks.length);
  scriptBlocks.forEach((m, i) => {
    if (m[1].length > 100 && m[1].length < 5000) {
      console.log(`Script ${i} (${m[1].length}):`, m[1].substring(0, 200));
    }
  });
}
