// Extract the nav.api mapping from the serialized HTML state

const htmlResp = await fetch('https://lolalytics.com/lol/aatrox/counters/', {headers: {'User-Agent': 'Mozilla/5.0'}});
const html = await htmlResp.text();

// Get the big inline script
const bigScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1])
  .filter(s => s.length > 100000);

const s = bigScripts[0];

// Now find the context around the api values (a1, a3, a2)
const idx = s.indexOf('"a1","a3","a2"');
if (idx >= 0) {
  console.log('=== Context around "a1","a3","a2" ===');
  console.log(s.substring(Math.max(0, idx - 300), idx + 300));
}

// Also look for the api object definition pattern
// The serialized state uses references. Let's find what's near "api"
const apiIdx = s.indexOf('"api"');
if (apiIdx >= 0) {
  console.log('\n=== Context around "api" ===');
  console.log(s.substring(Math.max(0, apiIdx - 200), apiIdx + 200));
}

// The key order for nav.api[v] where v can be "build", "vs", "keystone", "item"
// Let's search for these keys together
const buildVsIdx = s.indexOf('"build"');
if (buildVsIdx >= 0) {
  console.log('\n=== Context around first "build" ===');
  console.log(s.substring(Math.max(0, buildVsIdx - 100), buildVsIdx + 200));
}

// Search for the navigation config that defines the api endpoints
// Look for patterns like {"build":"a1","vs":"a3"...}
const apiObjPatterns = [...s.matchAll(/\{[^}]*"build"[^}]*"vs"[^}]*\}/g)];
console.log('\n=== API object patterns ===');
apiObjPatterns.forEach(m => console.log(m[0].substring(0, 300)));

// Also look for "arena" near the api config
const arenaIdx = s.indexOf('"arena"');
if (arenaIdx >= 0) {
  console.log('\n=== Context around "arena" ===');
  console.log(s.substring(Math.max(0, arenaIdx - 200), arenaIdx + 200));
}

// Let's try the approach: find all index references in the serialized format
// The Qwik serialization uses references by index
// "api":"1" means api points to index 1 in some array
// Let's find the full navigation object

// Search more broadly for nav object initialization
const navIdx = s.indexOf('"nav"');
if (navIdx >= 0) {
  console.log('\n=== First "nav" context ===');
  console.log(s.substring(Math.max(0, navIdx - 100), navIdx + 400));
}

// Let's just look at ALL the serialized data that includes "a1" or "a3"
console.log('\n=== All "a1" references ===');
const a1Matches = [...s.matchAll(/"a1"/g)];
a1Matches.forEach(m => {
  console.log(`  at ${m.index}: ${s.substring(Math.max(0, m.index - 50), m.index + 50)}`);
});

console.log('\n=== All "a3" references ===');
const a3Matches = [...s.matchAll(/"a3"/g)];
a3Matches.forEach(m => {
  console.log(`  at ${m.index}: ${s.substring(Math.max(0, m.index - 50), m.index + 50)}`);
});
