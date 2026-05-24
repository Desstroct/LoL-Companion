# LoL Data Sources Reference

Comparative analysis of League of Legends statistics websites for the LoL Companion
Stream Deck plugin. Evaluates data reliability, API accessibility, and suitability as
primary or fallback data providers.

**Last updated:** 2026-05-23  
**Current provider:** Lolalytics JSON API (`a1.lolalytics.com`)

---

## Table of Contents

1. [Lolalytics (Current Provider)](#1-lolalytics-current-provider)
2. [U.GG](#2-ugg)
3. [OP.GG](#3-opgg)
4. [Mobalytics](#4-mobalytics)
5. [MetaSRC](#5-metasrc)
6. [Riot Official Data Sources](#6-riot-official-data-sources)
7. [Community Consensus on Accuracy](#7-community-consensus-on-accuracy)
8. [Comparison Matrix](#8-comparison-matrix)
9. [Recommendations for This Plugin](#9-recommendations-for-this-plugin)

---

## 1. Lolalytics (Current Provider)

**Website:** https://lolalytics.com  
**API Base:** `https://a1.lolalytics.com`

### Data Source

Riot Games API with a production key. Lolalytics processes millions of games per day
and maintains complete patch-by-patch historical data for all champions.

### Sample Size Methodology

- Displays exact game count alongside every recommendation.
- Flags low-confidence results where win rate differences lack statistical significance.
- Early-patch handling: marks all data as preliminary during the first ~48 hours after a
  patch drops with insufficient game volume for reliable conclusions.
- Minimum thresholds filter out pairings with very few games (our code uses `n < 50`).
- Does NOT normalize win rates to 50% average -- raw aggregated values. This means the
  average displayed win rate across all champions is slightly above 50% (due to how
  surrenders and remakes are counted). Low win rates on Lolalytics look worse than on
  U.GG, and high win rates look better.

### Data Freshness

- Updates continuously as games are processed.
- Supports filtering by specific patch version or "last 30 days" window.
- Our plugin uses current patch with a `patch=30` fallback for early-patch periods.

### Available Data Types

| Data Type | Endpoint | Status |
|---|---|---|
| Counters/matchups | `ep=counter` | Working |
| Rune pages (most common + highest WR) | `ep=rune` | Working |
| Item builds (full sets with boots) | `ep=build-itemset` | Working |
| Skill order | SSR page parse | BLOCKED (Cloudflare) |
| Summoner spells | SSR page parse | BLOCKED (Cloudflare) |
| Matchup-specific runes | `ep=rune` (vsAlias ignored) | Not supported by API |

### API Accessibility

**JSON API (a1.lolalytics.com/mega/):**

Currently used by the plugin. Structured JSON responses, no HTML parsing needed.

Known working endpoints:

```
GET https://a1.lolalytics.com/mega/?ep=counter&p=d&v=1
    &patch={major.minor}   # e.g. "16.10" or "30" for last 30 days
    &c={champion}          # lolalytics alias, e.g. "aatrox"
    &lane={lane}           # top|jungle|middle|bottom|support|default
    &tier={tier}           # emerald_plus, gold_plus, all, etc.
    &queue=ranked          # ranked or 450 (ARAM)
    &region=all            # all, na, euw, kr, etc.

GET https://a1.lolalytics.com/mega/?ep=rune&v=1
    &patch={major.minor}&c={champion}&lane={lane}
    &tier=emerald_plus&queue=ranked&region=all

GET https://a1.lolalytics.com/mega/?ep=build-itemset&v=1
    &patch={major.minor}&c={champion}&lane={lane}
    &tier=emerald_plus&queue=ranked&region=all
```

**Access requirements:**
- Requires a browser-like `User-Agent` header (our throttle sets one).
- Returns **403 Forbidden** from generic HTTP clients (curl, Python requests without
  proper headers) -- confirmed during this research. The plugin's `throttledFetch()`
  works because it sends a Chrome-like User-Agent.
- No API key required, no authentication, no CORS restrictions for server-side use.
- Lolalytics states the API is "for the sole use of visitors to the website
  lolalytics.com" -- we are technically in a gray area.

**SSR/HTML pages (lolalytics.com/lol/{champ}/build/):**

Previously used for skill order and summoner spell data. Now blocked by Cloudflare JS
challenge protection (added ~2025). Non-browser requests get challenged/blocked.
Recovery would require headless browser (puppeteer/playwright), which is not practical
for a Stream Deck plugin.

### Rate Limiting

No documented rate limits, but aggressive fetching risks IP bans. Our plugin uses a
token-bucket throttle: 2 req/s sustained, burst of 3, max queue of 50.

### Legal/ToS Assessment

The API is explicitly marked as private/copyrighted. We have no agreement with
Lolalytics. Risk: they could block our User-Agent or add stricter protections at any
time (as they already did with the SSR pages).

---

## 2. U.GG

**Website:** https://u.gg  
**Status:** Riot-approved partner  
**Owner:** Enthusiast Gaming (acquired for $45M in 2021)

### Data Source

Riot Games API with production-level access. U.GG states they "analyze every game
available from Riot's API" to ensure the largest possible sample size.

### Sample Size Methodology

- Default filter: Platinum+ ranking (configurable by users on the website).
- Claims 99.9% accuracy on role-detection algorithm for classifying game roles.
- Normalizes win rates to 50% average across all champions -- this means displayed WRs
  are adjusted relative to the mean, making cross-champion comparisons more intuitive
  but raw values less transparent.
- Separates data by skill tier with sharper boundaries than OP.GG, allowing rank-specific
  stats.

### Data Freshness

- Continuous background pipelines fetch new match data as games complete.
- Aggregation jobs recompute champion statistics periodically (likely hourly or more).
- Prioritizes frequently-viewed summoners and pro players for near-real-time updates.

### Available Data Types

- Champion win rates, pick rates, ban rates by role and rank
- Full item builds (starting items, core items, situational items)
- Rune pages (most popular + highest WR)
- Skill order (max order + level-by-level)
- Summoner spells
- Counters and matchups
- Pro player builds
- Duo synergies

### API Accessibility

**No public API.** U.GG's data is served to their frontend via an internal GraphQL API.

- The frontend makes POST requests to `https://u.gg/api` with GraphQL queries.
- The GraphQL schema is not documented and likely changes without notice.
- Community-made scrapers exist (e.g., `Zadag/simple-u.gg-api` on GitHub) but they
  scrape HTML tier list tables, not the GraphQL endpoint.
- Cloudflare protection is present on the website.
- No public developer documentation or API keys available.

**Programmatic access verdict:** Not feasible without reverse-engineering their GraphQL
schema and risking breakage on every frontend update. Their Cloudflare + undocumented
API makes this the hardest site to integrate with programmatically.

### Reliability

High. Riot-approved partner with dedicated engineering team. Data is generally
considered accurate by the community, especially for rank-specific stats.

---

## 3. OP.GG

**Website:** https://op.gg  
**Status:** Unofficial but widely recognized; used by Riot employees for player analysis.

### Data Source

Riot Games API with production-level access. Aggregates data from all servers globally
with emphasis on Korea (OP.GG is Korean-owned and has historically had the deepest KR
data coverage).

### Sample Size Methodology

- Aggregates across multiple skill brackets simultaneously.
- Emphasis on Platinum-Diamond range where most ranked players exist.
- Global approach creates massive combined samples that reduce variance on popular
  champions to near-zero statistical noise.
- For niche picks in specific roles, sample sizes can be small.

### Data Freshness

- Continuous data pipelines, similar to U.GG.
- Profile data requires manual refresh on the website (cached data can be stale).
- Champion statistics are recomputed periodically.

### Available Data Types

- Champion builds, runes, skill orders, summoner spells
- Counters and matchups
- Summoner profiles and match history
- Live game lookup
- Tier lists
- Pro player builds

### API Accessibility

**MCP Server (official, new in 2025-2026):**

OP.GG released an official MCP (Model Context Protocol) server for AI agent access:

- Endpoint: `https://mcp-api.op.gg/mcp` (Streamable HTTP transport)
- Written in TypeScript
- 12 League of Legends tools available, including:
  - `lol_get_champion_analysis` -- builds, runes, counters, win/pick/ban rates
  - `lol_list_lane_meta_champions` -- tier rankings by lane
  - `lol_get_summoner_profile` -- rank, tier, LP, win rates
  - `lol_list_summoner_matches` -- match history
  - `lol_list_items` -- item data
- Uses `desired_output_fields` parameter for response filtering
- May require a Smithery API key for access

**Internal web API:**

OP.GG's website uses internal REST/GraphQL APIs that are not publicly documented.
Community scrapers exist (`miasmos/op.gg-api` on npm -- serves OP.GG web pages as JSON)
but these are fragile HTML scrapers.

**Programmatic access verdict:** The MCP server is the most promising official data
access from any stats site. However, MCP is designed for AI agent workflows, not direct
HTTP API consumption. Integration would require either:
1. Running an MCP client to query the server (adds complexity), or
2. Making direct HTTP POST requests to the MCP endpoint (undocumented protocol).

Worth investigating further if we need a fallback data source.

### Reliability

Very high. Longest-running LoL stats site, massive user base, deep KR data coverage.
Community standard for summoner lookups. However, their champion build recommendations
display all results with equal visual confidence regardless of sample size.

---

## 4. Mobalytics

**Website:** https://mobalytics.gg  
**Status:** Riot ToS-compliant; visual data partner for Riot/LCS. Not officially endorsed.

### Data Source

Riot Games API. Also invested in by LS (Last Shadow) and Nemesis, both high-profile
League analysts, lending credibility to their data interpretation.

### Sample Size Methodology

- Not publicly documented in detail.
- Widget documentation says data "pulls information directly from Riot's LoL API."
- Data updates automatically each patch.

### Data Freshness

- Auto-updates per patch.
- Desktop overlay provides live game data.

### Available Data Types

- Champion builds (items, runes, skill orders, summoner spells)
- Counters and matchups
- Summoner profiles and match history
- Pre-game analysis and live game overlay
- Post-game review
- TFT meta decks and compositions

### API Accessibility

**Builds Widget (semi-public):**

Mobalytics offers an embeddable widget for websites:
```
https://cdn.jsdelivr.net/gh/joneslloyd/builds-widget@<VERSION>/dist/index.bundle.js
```
Parameters: champion name, role, layout (full/compact). However, this renders an
iframe/web component -- not a JSON API. Not usable for programmatic data extraction.

**Internal API:**

- Documentation mentions "Ports need to be in the range of 3000 to 3005 to use the
  Mobalytics API without authentication" -- this likely refers to local development of
  their overlay/app, not a public API.
- The website uses internal GraphQL or REST APIs that are not publicly documented.
- Community scraper exists (`cashmerebuffalo/Mobalytics-Scraper` on GitHub).

**Programmatic access verdict:** No usable public API. The widget is for embedding, not
data extraction. Internal APIs are undocumented and likely protected.

### Reliability

Good data quality, backed by analyst investment. Desktop overlay is popular. However,
less statistical transparency than Lolalytics or U.GG.

---

## 5. MetaSRC

**Website:** https://www.metasrc.com  
**Status:** Independent, Riot API-based

### Data Source

All data collected from the Riot Games API, in accordance with Riot's Terms and
Conditions.

### Sample Size Methodology

- Only collects data from the most recent patch.
- When a new patch drops, waits until sufficient data accumulates before displaying.
- Algorithm-driven build recommendations (likely uses statistical or ML methods to
  determine optimal builds rather than just "most popular").

### Data Freshness

- Refreshes approximately once per hour.
- Current-patch only -- no historical data.

### Available Data Types

- Champion tier lists
- Statistical builds (items, runes, skill orders)
- Guides
- TFT compositions and tier lists

### API Accessibility

**No public API.**

- Website renders server-side; no obvious JSON endpoints.
- FAQ page returned 402 Payment Required during this research, suggesting possible
  paywall or access restrictions.
- No developer documentation found.
- No community scrapers found specifically targeting MetaSRC.

**Programmatic access verdict:** Not viable. No API, no documented endpoints,
potentially paywalled content.

### Reliability

Decent for builds and tier lists. The algorithm-driven approach can produce unique
recommendations. However, smallest community footprint of the sites reviewed, and least
transparency about methodology. Current-patch-only limitation means no data during early
patch days.

---

## 6. Riot Official Data Sources

### Data Dragon (DDragon)

**CDN Base:** `https://ddragon.leagueoflegends.com/cdn/`  
**Version file:** `https://ddragon.leagueoflegends.com/api/versions.json`

**What it provides (static data only -- no game statistics):**
- Champion data: stats, abilities, tags, images, skins
- Item data: descriptions, pricing, build paths, stat grants
- Rune/perk data: names, descriptions, icons
- Summoner spell data
- Profile icons
- Sprite sheets, splash art, loading screen images
- 27 languages supported

**URL patterns:**
```
/cdn/{version}/data/{lang}/champion.json          # All champions summary
/cdn/{version}/data/{lang}/champion/{Name}.json    # Individual champion detail
/cdn/{version}/data/{lang}/item.json               # All items
/cdn/{version}/data/{lang}/summoner.json           # Summoner spells
/cdn/{version}/data/{lang}/runesReforged.json      # Rune trees
/cdn/{version}/img/champion/{Name}.png             # Champion square icon
/cdn/{version}/img/item/{id}.png                   # Item icon
/cdn/{version}/img/spell/{spellKey}.png            # Summoner spell icon
```

**Current version:** 16.10.1

**Limitations:**
- Static data only -- no win rates, pick rates, builds, or any gameplay statistics.
- Manual update process: not always updated immediately after a patch.
- Version can differ by region.
- Already used by this plugin via `src/services/data-dragon.ts`.

### Community Dragon (CDragon)

**RAW:** `https://raw.communitydragon.org/latest/`  
**CDN:** `https://cdn.communitydragon.org/`

**What it provides beyond DDragon:**
- `champion-rune-recommendations.json` (359 KB) -- Riot's own recommended rune pages
- `items.json`, `perks.json`, `perkstyles.json` -- alternative format game data
- `queues.json` -- game mode definitions
- `objectives.json` -- dragon/baron/herald data
- Champion ability details (more granular than DDragon but harder to parse)
- Skin/chroma/cosmetic data
- Audio assets

**Key advantage:** `champion-rune-recommendations.json` provides Riot's official rune
recommendations per champion per role. This could serve as a basic fallback for rune
data if Lolalytics goes down. However, these are generic "recommended" pages, not
data-driven optimal builds.

**Status:** Open-source community project. Not officially endorsed by Riot but operates
under their Legal Jibber Jabber policy. CDN service is being redesigned for versioning
and multi-game support.

### Riot Developer API

**Portal:** https://developer.riotgames.com  
**Base:** `https://{region}.api.riotgames.com/`

**Rate limits:**
- Development key: 20 req/s, 100 req/2min (expires every 24h)
- Production key: 500 req/10s, 30,000 req/10min (requires app approval)

**Relevant endpoints:**
- `match-v5` -- match history and detailed match data
- `league-v4` -- ranked standings
- `summoner-v4` -- summoner profiles
- `spectator-v5` -- live game data
- `champion-mastery-v4` -- champion mastery scores

**Important policy:** No apps serving as "data brokers" between Riot's API and third
parties are approved. This means we cannot build our own stats aggregation pipeline
and redistribute the data.

**Why we don't use this directly:** Computing champion win rates, builds, and counters
from raw match data requires processing millions of matches -- a massive infrastructure
investment. The stats sites (Lolalytics, U.GG, OP.GG) do this work for us.

---

## 7. Community Consensus on Accuracy

### General Rankings (compiled from multiple sources)

1. **Lolalytics** -- Considered the most statistically rigorous. Uses the largest sample
   sizes, shows exact game counts, accounts for statistical confidence. Does NOT
   normalize win rates, which can be confusing but is more transparent. Preferred by
   data-minded players and some analysts. Best for "deep pre-session research."

2. **U.GG** -- Considered the most user-friendly with accurate data. Normalizes win
   rates to 50% average, making cross-champion comparisons easier. Elo-specific
   filtering produces personally relevant data. Riot-approved partner. Best for quick
   in-game reference.

3. **OP.GG** -- Oldest and most widely recognized. Used by Riot employees. Deepest
   Korea-region data. However, shows recommendations with equal confidence regardless
   of sample size.

4. **Mobalytics** -- Good desktop overlay and in-game experience. Less statistical
   depth than the top 3 but strong UX. Backed by pro analyst investment.

5. **MetaSRC** -- Smallest footprint. Algorithm-driven builds can be innovative but
   less transparent. Current-patch-only limitation.

### Key Insight

For popular champions in common roles, all sites agree on builds/runes within a few
percentage points. Divergences appear for niche picks, off-meta roles, and early-patch
data, where sample size methodology matters most. Lolalytics handles these edge cases
best due to explicit confidence scoring.

### Matchup-Specific Data

- **Lolalytics:** Most granular. Counter data includes per-matchup win rates with game
  counts. However, the JSON API does not support matchup-specific runes (the `vs`
  parameter is accepted but ignored).
- **U.GG:** Shows matchup-specific builds/runes on the website but not accessible
  programmatically.
- **OP.GG:** Shows counter matchups with win rates. MCP server may expose this via
  `lol_get_champion_analysis`.
- **Mobalytics/MetaSRC:** Basic counter lists, no matchup-specific builds.

---

## 8. Comparison Matrix

| Feature | Lolalytics | U.GG | OP.GG | Mobalytics | MetaSRC |
|---|---|---|---|---|---|
| **Data source** | Riot API | Riot API | Riot API | Riot API | Riot API |
| **Riot partner** | No | Yes | No (but recognized) | ToS-compliant | No |
| **Sample size** | Largest | Very large | Very large | Large | Unknown |
| **WR normalization** | None (raw) | Normalized to 50% | Blended tiers | Unknown | Unknown |
| **Update frequency** | Continuous | Continuous | Continuous | Per-patch | Hourly |
| **Public JSON API** | Yes (gray area) | No | MCP server | No | No |
| **Cloudflare** | SSR pages only | Full site | Full site | Full site | Unknown |
| **Counter data** | Yes (per-matchup) | Yes | Yes (MCP) | Yes | Yes |
| **Rune data** | Yes (generic) | Yes | Yes (MCP) | Yes | Yes |
| **Item build data** | Yes (full sets) | Yes | Yes (MCP) | Widget only | Yes |
| **Skill order data** | Blocked (SSR) | Yes | Yes | Yes | Yes |
| **Matchup-specific** | Counter WRs only | Website only | Unknown | No | No |
| **Programmatic access** | Feasible | Very hard | MCP (new) | Not feasible | Not feasible |
| **Stability risk** | Medium-high | N/A | Medium | N/A | N/A |
| **ToS compliance** | Violating | N/A | Unclear | N/A | N/A |

---

## 9. Recommendations for This Plugin

### Current State Assessment

Lolalytics JSON API works well for our three core needs:
- **Counters** (`ep=counter`) -- reliable, large sample sizes
- **Runes** (`ep=rune`) -- works but only returns generic runes (not matchup-specific)
- **Item builds** (`ep=build-itemset`) -- reliable with style-aware selection

**Known gaps:**
- Skill order data is unavailable (SSR blocked by Cloudflare)
- Matchup-specific runes not supported by the JSON API
- Summoner spell recommendations not available via API
- API terms explicitly say it is private/copyrighted
- 403 errors can occur if User-Agent header is wrong or if they tighten restrictions

### Potential Alternatives/Supplements

#### OP.GG MCP Server (Most Promising)

- **Pro:** Official, maintained by OP.GG, structured data, includes builds/runes/counters
- **Con:** MCP protocol adds complexity, may require API key, response format designed
  for AI agents not direct API consumption, relatively new (stability unknown)
- **Action:** Investigate `https://mcp-api.op.gg/mcp` -- test if direct HTTP POST
  requests work without an MCP client. If so, this could serve as a fallback for all
  data types including skill orders.

#### Community Dragon Rune Recommendations

- **Pro:** Free, open, Riot-endorsed data, no rate limits
- **Con:** Generic "recommended" runes, not data-driven optimal builds
- **Action:** Use `champion-rune-recommendations.json` as emergency fallback only
  (e.g., when Lolalytics API is completely down).

#### Direct Riot API (Not Recommended)

- Would require building our own match data pipeline to compute statistics
- Rate limits make this impractical for a Stream Deck plugin
- Riot prohibits "data broker" apps
- Only useful for per-player data we already get via LCU API

### Risk Mitigation Strategy

1. **Keep Lolalytics as primary** -- it works, has the best data, and the JSON API is
   stable (unlike their SSR pages).
2. **Add graceful degradation** -- when Lolalytics returns 403/500, fall back to cached
   data (already implemented via DiskCache with stale-read via `getRaw()`).
3. **Investigate OP.GG MCP** -- if it provides direct HTTP access, build a secondary
   data provider that can be swapped in.
4. **CDragon rune fallback** -- download `champion-rune-recommendations.json` at startup
   as an emergency rune source.
5. **Monitor Lolalytics stability** -- log all 403/timeout errors with timestamps to
   detect if they tighten access restrictions.

### What We Cannot Replace

No alternative provides the same combination of:
- Structured JSON API (no scraping needed)
- No authentication required
- Per-matchup counter win rates with game counts
- Elo-filtered data
- Multiple data types from one provider

If Lolalytics shuts down API access, the most realistic path is the OP.GG MCP server
or building a lightweight scraper with a headless browser -- neither of which is ideal
for a Stream Deck plugin's runtime constraints.
