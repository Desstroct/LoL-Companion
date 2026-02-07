// Script to discover Lolalytics API endpoints

// Step 1: Fetch the page HTML and extract script bundle URLs
const resp = await fetch('https://lolalytics.com/lol/aatrox/counters/', {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
});
const html = await resp.text();

// Find all script src URLs
const scripts = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]).filter(s => s.endsWith('.js'));
console.log('=== JS Script URLs ===');
scripts.forEach(s => console.log(s));

// Find any lolalytics subdomains referenced
const apiDomains = [...html.matchAll(/https?:\/\/[a-z0-9]+\.lolalytics\.com[^"' <\s]*/gi)];
console.log('\n=== API domain references in HTML ===');
apiDomains.forEach(m => console.log(m[0]));

// Check for __NEXT_DATA__ or similar
console.log('\nHas __NEXT_DATA__:', html.includes('__NEXT_DATA__'));

// Look for inline script content with API references
const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .filter(s => s.length > 10 && (s.includes('lolalytics') || s.includes('fetch') || s.includes('api')));
console.log('\n=== Relevant inline scripts (truncated) ===');
inlineScripts.forEach((s, i) => {
  console.log(`--- Script ${i} (${s.length} chars) ---`);
  console.log(s.substring(0, 300));
});

// Step 2: If we found JS bundle URLs, fetch one and look for API patterns
const jsUrls = scripts.filter(s => s.includes('lolalytics') || s.startsWith('/'));
if (jsUrls.length > 0) {
  console.log('\n\n=== Fetching JS bundles to find API URLs ===');
  for (const jsUrl of jsUrls.slice(0, 5)) {
    const fullUrl = jsUrl.startsWith('http') ? jsUrl : `https://lolalytics.com${jsUrl}`;
    try {
      const jsResp = await fetch(fullUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const jsCode = await jsResp.text();
      
      // Look for API URL patterns
      const apiPatterns = [...jsCode.matchAll(/https?:\/\/[a-z0-9]+\.lolalytics\.com[^"' `\s]*/gi)];
      if (apiPatterns.length > 0) {
        console.log(`\n--- ${jsUrl} ---`);
        const unique = [...new Set(apiPatterns.map(m => m[0]))];
        unique.forEach(u => console.log('  ', u));
      }
      
      // Look for endpoint/ep= patterns
      const epPatterns = [...jsCode.matchAll(/ep=[a-z_]+/gi)];
      if (epPatterns.length > 0) {
        console.log(`  EP params in ${jsUrl}:`);
        const unique = [...new Set(epPatterns.map(m => m[0]))];
        unique.forEach(u => console.log('    ', u));
      }
      
      // Look for mega/ endpoint
      const megaPatterns = [...jsCode.matchAll(/mega\/[^"' `\s]*/gi)];
      if (megaPatterns.length > 0) {
        console.log(`  mega/ patterns in ${jsUrl}:`);
        const unique = [...new Set(megaPatterns.map(m => m[0]))];
        unique.forEach(u => console.log('    ', u));
      }
    } catch(e) {
      console.log(`  Error fetching ${fullUrl}: ${e.message}`);
    }
  }
}
