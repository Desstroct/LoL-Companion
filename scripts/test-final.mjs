// Final detailed exploration of the working endpoints

// 1. Full counter data 
console.log('===== ep=counter (MATCHUP/COUNTER DATA) =====');
const counterResp = await fetch('https://a1.lolalytics.com/mega/?ep=counter&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
});
const counterData = await counterResp.json();
console.log(JSON.stringify(counterData, null, 2).substring(0, 3000));

// 2. Tier list
console.log('\n\n===== ep=tier (TIER LIST) =====');
const tierResp = await fetch('https://a1.lolalytics.com/mega/?ep=tier&v=1&patch=16.3&lane=top&tier=emerald_plus&queue=ranked&region=all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
});
const tierData = await tierResp.json();
console.log('Keys:', Object.keys(tierData));
console.log('queue:', tierData.queue);
console.log('view:', tierData.view);
console.log('fields:', tierData.fields);
console.log('avgWr:', tierData.avgWr);
console.log('analysed:', tierData.analysed);
console.log('tier type:', typeof tierData.tier, Array.isArray(tierData.tier) ? `length: ${tierData.tier.length}` : '');
if (Array.isArray(tierData.tier)) {
  console.log('tier[0]:', JSON.stringify(tierData.tier[0]));
  console.log('tier[1]:', JSON.stringify(tierData.tier[1]));
}

// 3. ep=list
console.log('\n\n===== ep=list (CHAMPION LIST) =====');
const listResp = await fetch('https://a1.lolalytics.com/mega/?ep=list&v=1&patch=16.3&lane=top&tier=emerald_plus&queue=ranked&region=all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
});
const listData = await listResp.json();
console.log('Keys:', Object.keys(listData));
console.log('cid type:', typeof listData.cid, Array.isArray(listData.cid) ? `length: ${listData.cid.length}` : '');
if (Array.isArray(listData.cid)) {
  console.log('cid[0]:', JSON.stringify(listData.cid[0]).substring(0, 200));
  console.log('cid[1]:', JSON.stringify(listData.cid[1]).substring(0, 200));
} else if (typeof listData.cid === 'object') {
  const keys = Object.keys(listData.cid);
  console.log('cid keys (first 5):', keys.slice(0, 5));
  console.log('cid[first]:', JSON.stringify(listData.cid[keys[0]]).substring(0, 300));
}

// 4. Test counter by lane (middle, jungle, etc)
console.log('\n\n===== ep=counter for jungle Aatrox =====');
const jgResp = await fetch('https://a1.lolalytics.com/mega/?ep=counter&v=1&patch=16.3&c=aatrox&lane=jungle&tier=emerald_plus&queue=ranked&region=all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
});
const jgData = await jgResp.json();
console.log('stats:', JSON.stringify(jgData.stats));
console.log('counters length:', jgData.counters?.length);
if (jgData.counters?.length > 0) {
  console.log('counters[0]:', JSON.stringify(jgData.counters[0]));
}

// 5. Test with build-team to see matchup details
console.log('\n\n===== ep=build-team (TEAM MATCHUP DATA) =====');
const teamResp = await fetch('https://a1.lolalytics.com/mega/?ep=build-team&v=1&patch=16.3&c=aatrox&lane=top&tier=emerald_plus&queue=ranked&region=all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
});
const teamData = await teamResp.json();
console.log('Keys:', Object.keys(teamData));
console.log('team type:', typeof teamData.team);
if (teamData.team) {
  const teamKeys = Object.keys(teamData.team);
  console.log('team keys:', teamKeys);
  if (teamKeys.length > 0) {
    const firstKey = teamKeys[0];
    const val = teamData.team[firstKey];
    console.log(`team.${firstKey} type:`, typeof val, Array.isArray(val) ? `length: ${val.length}` : '');
    if (Array.isArray(val) && val.length > 0) {
      console.log(`team.${firstKey}[0]:`, JSON.stringify(val[0]).substring(0, 300));
    } else if (typeof val === 'object') {
      console.log(`team.${firstKey}:`, JSON.stringify(val).substring(0, 300));
    }
  }
}
