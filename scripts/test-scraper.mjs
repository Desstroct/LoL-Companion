// Quick test of our Lolalytics scraping logic against the live site
const url = "https://lolalytics.com/lol/aatrox/counters/?lane=top";

const res = await fetch(url, {
  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
});

console.log("Status:", res.status);
const html = await res.text();
console.log("HTML length:", html.length);

// 1. Test our link regex
const linkRegex = /href="\/lol\/aatrox\/vs\/([^/]+)\/build\/[^"]*"/g;
const allLinks = [...html.matchAll(linkRegex)];
console.log("\n=== LINK MATCHES ===");
console.log("Total links found:", allLinks.length);

// 2. For each link, test WR and Games extraction - skip first 10 (intro text)
let successCount = 0;
let failCount = 0;
for (let i = 0; i < allLinks.length; i++) {
  const m = allLinks[i];
  const enemy = m[1];
  const afterLink = html.substring(m.index, m.index + 4000);
  
  // Try Qwik SSR pattern first
  const wrQwik = afterLink.match(/<!--t=\w+-->([\d.]+)<!---->%/);
  // Try plain percentage fallback
  const wrPlain = afterLink.match(/(\d{2,3}\.\d{1,2})%/);
  // Games
  const games = afterLink.match(/([\d,]+)\s*Games/);
  
  console.log(`\n[${i}] Enemy: ${enemy}`);
  console.log("  Qwik WR:", wrQwik ? wrQwik[1] : "NO MATCH");
  console.log("  Plain WR:", wrPlain ? wrPlain[1] : "NO MATCH");
  console.log("  Games:", games ? games[1] : "NO MATCH");
  
  if (wrPlain || wrQwik) successCount++;
  else failCount++;
  
  // Show a snippet around the link for debugging (only for first success and first fail)
  if ((successCount === 1 && (wrPlain || wrQwik)) || (failCount <= 2)) {
    const snippet = afterLink.substring(0, 800).replace(/\n/g, " ").replace(/\s+/g, " ");
    console.log("  Snippet:", snippet.substring(0, 600));
  }
}

console.log("\nSummary: Success:", successCount, "Fail:", failCount);

// 3. If no links found, show what the HTML looks like around "vs" 
if (allLinks.length === 0) {
  console.log("\n=== NO LINKS FOUND - HTML debugging ===");
  // Look for any /vs/ patterns
  const vsPatterns = [...html.matchAll(/\/vs\/([^/]+)\//g)].slice(0, 5);
  console.log("vs patterns:", vsPatterns.map(m => m[0]));
  
  // Look for any href patterns with champion
  const hrefPatterns = [...html.matchAll(/href="[^"]*aatrox[^"]*"/g)].slice(0, 10);
  console.log("href with aatrox:", hrefPatterns.map(m => m[0]));
  
  // Show first 3000 chars
  console.log("\nFirst 3000 chars of HTML:");
  console.log(html.substring(0, 3000));
}

// 4. Also check if there's a JSON API call embedded
const apiMatch = html.match(/api[^"]*lolalytics[^"]*/g);
if (apiMatch) {
  console.log("\n=== API URLs in HTML ===");
  apiMatch.forEach(u => console.log(" ", u));
}

// 5. Check for q:id or qwik data attributes  
const qwikData = html.match(/q:id="[^"]+"/g);
console.log("\n=== Qwik markers ===");
console.log("q:id count:", qwikData ? qwikData.length : 0);
