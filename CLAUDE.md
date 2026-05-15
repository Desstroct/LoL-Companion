# LoL Companion — Stream Deck Plugin

TypeScript + `@elgato/streamdeck` v2. Reads LCU API + Live Client Data API + Lolalytics.

## Commands

```
npm run build    # rollup -c → dist: com.desstroct.lol-api.sdPlugin/bin/plugin.js
npm run watch    # rollup -c -w + auto-restart Stream Deck plugin
npm run deploy   # build + copy sdPlugin/ to %APPDATA%/Elgato/StreamDeck/Plugins/
```

Type-check (no emit): `npx tsc --noEmit`
Full lint check: `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`

## Structure

```
src/
  plugin.ts          # entry — imports all actions/services, registers, init
  actions/           # one SingletonAction per file
  services/          # shared singletons
  types/lol.ts       # all LCU + DDragon + LiveClient types
com.desstroct.lol-api.sdPlugin/
  bin/plugin.js      # build output (gitignored)
  imgs/              # icons (actions/, categories/)
  ui/*.html          # property inspectors (sdpi-components v4)
  layouts/*.json     # dial layouts
  manifest.json      # plugin manifest v1.3.0.0
cache/               # DiskCache runtime files (gitignored)
```

## Actions (UUID → file)

| UUID suffix | File | Notes |
|---|---|---|
| `auto-accept` | auto-accept.ts | Polls ReadyCheck 1s; never stops polling (runs off-page) |
| `auto-rune` | auto-rune.ts | Multi-key: different roles |
| `best-item` | best-item.ts | Singleton buildPromise (class-level); AP/AD style detection |
| `death-timer` | death-timer.ts | Live Client only — no LCU guard needed |
| `game-status` | game-status.ts | Press = open OP.GG profile; auto-detects region |
| `jungle-path` | jungle-path.ts | CHAMPION_PATHS record; SVG key with camp dots |
| `kda-tracker` | kda-tracker.ts | Live Client only |
| `lobby-scanner` | lobby-scanner.ts | Key: champ icon + rank + WR. Dial: full ranked dashboard |
| `lp-tracker` | lp-tracker.ts | Session delta persisted to disk (24h baseline) |
| `objective-timer` | objective-timer.ts | Live Client only |
| `session-stats` | session-stats.ts | Match history from LCU; streak + champ stats |
| `skill-order` | skill-order.ts | Live Client + LCU fallback via isInGame() |
| `smart-pick` | smart-pick.ts | Elo-aware; Lolalytics tier param |

All UUIDs are `com.desstroct.lol-api.<suffix>`.

## Services

### lcuConnector (`src/services/lcu-connector.ts`)
```ts
lcuConnector.startPolling(intervalMs?)
lcuConnector.stopPolling()
lcuConnector.isConnected(): boolean
lcuConnector.getCredentials(): LcuCredentials | null
lcuConnector.onConnectionChange((creds: LcuCredentials | null) => void): void
```

### lcuApi (`src/services/lcu-api.ts`)
```ts
lcuApi.get<T>(endpoint): Promise<T | null>
lcuApi.post(endpoint, body?): Promise<boolean>
lcuApi.put<T>(endpoint, body?): Promise<T | null>
lcuApi.patch<T>(endpoint, body?): Promise<T | null>
lcuApi.del(endpoint): Promise<boolean>
lcuApi.getGameflowPhase(): Promise<GameflowPhase>
lcuApi.getChampSelectSession(): Promise<LcuChampSelectSession | null>
lcuApi.getCurrentSummoner(): Promise<LcuSummoner | null>
lcuApi.getRankedStats(puuid): Promise<LcuRankedStats | null>
lcuApi.getCurrentRankedStats(): Promise<LcuRankedStats | null>
lcuApi.getRunePages(): Promise<LcuRunePage[]>
lcuApi.updateRunePage(id, payload): Promise<boolean>
lcuApi.createRunePage(payload): Promise<boolean>
lcuApi.deleteRunePage(id): Promise<boolean>
lcuApi.setSummonerSpells(spell1Id, spell2Id): Promise<boolean>
```

### dataDragon (`src/services/data-dragon.ts`)
```ts
dataDragon.init(): Promise<void>
dataDragon.isReady(): boolean
dataDragon.getVersion(): string
dataDragon.getChampion(id: string): DdChampion | undefined        // by DDragon id e.g. "Aatrox"
dataDragon.getChampionByKey(key: string): DdChampion | undefined  // by numeric key e.g. "266"
dataDragon.getChampionByName(name: string): DdChampion | undefined // normalized: accents/apostrophes stripped
dataDragon.getSummonerSpell(key: string): DdSummonerSpell | undefined
dataDragon.getItem(id: string): DdItem | undefined
dataDragon.getChampionImageUrl(championId): string
```

### gameMode (`src/services/game-mode.ts`)
```ts
gameMode.start() / stop()
gameMode.get(): GameMode   // "CLASSIC"|"ARAM"|"TFT"|"CHERRY"|"UNKNOWN"|"NONE"
gameMode.getPhase(): GameflowPhase
gameMode.isTFT(): boolean
gameMode.isLoL(): boolean
gameMode.isARAM(): boolean
gameMode.isArena(): boolean
gameMode.onChange((mode, phase) => void): () => void  // returns unsubscribe
```

### gameClient (`src/services/game-client.ts`)
Live Client Data API (127.0.0.1:2999), 500ms cache.
```ts
gameClient.getAllData(): Promise<GameClientAllData | null>
gameClient.getActivePlayer(): Promise<ActivePlayer | null>
gameClient.getAllPlayers(): Promise<GamePlayer[] | null>
gameClient.getEvents(): Promise<GameEvents | null>
gameClient.getGameData(): Promise<GameData | null>
gameClient.isInGame(): Promise<boolean>
```

### ChampionStats (`src/services/champion-stats.ts`)
```ts
ChampionStats.toLolalytics(ddId: string): string        // DDragon id → Lolalytics alias
ChampionStats.toLolalyticsLane(lcuPosition: string): string  // LCU pos → lane
championStats.getCounters(alias, lane): Promise<MatchupData[]>
championStats.getBestCounterpicks(enemyAlias, lane): Promise<MatchupData[]>
championStats.getBestOverallPick(enemyAliases, lane, allyKeys?): Promise<{alias,name,score,details}[]>
championStats.flushCache(): Promise<void>
```
LCU positions: `top|jungle|middle|bottom|utility` → Lolalytics lanes: `top|jungle|middle|adc|support`

### itemBuilds (`src/services/item-builds.ts`)
```ts
ItemBuilds.toAlias(champName: string): string   // static — name → alias
itemBuilds.getBuild(alias, lane): Promise<ItemBuildData | null>
itemBuilds.flushCache(): Promise<void>
```

### lolaBuild (`src/services/lolalytics-build.ts`)
```ts
// Main SSR parser — returns runes, spells, skills in one call
lolaBuild.getBuildData(alias, lane, vsAlias?): Promise<BuildPageData | null>
lolaBuild.flushCache(): Promise<void>

// BuildPageData shape:
{
  runes: RunePageData[]
  summonerSpells: SummonerSpellCombo[]
  skillPriority: SkillPriorityData[]
  skillOrder: SkillOrderData[]
}
```

### runeData (`src/services/rune-data.ts`)
```ts
runeData.getRecommendedRunes(alias, lane, vsAlias?): Promise<RunePageData[]>
runeData.flushCache(): Promise<void>
// Returns up to 2 RunePageData: source="most_common" | "highest_wr"
// Known keystones (patch 26.09): 8005 8008 8010 8021 8112 8124 8128 9923
//   8214 8229 8230(Stormraider's) 8992(DeathfireTouch) 8437 8439 8465 8351 8360 8369
```

### DiskCache (`src/services/disk-cache.ts`)
```ts
new DiskCache<T>(fileName, ttlMs, maxEntries=500)
cache.get(key): Promise<CacheEntry<T> | undefined>   // returns undefined if missing or expired
cache.set(key, data, timestamp?): Promise<void>
cache.getRaw(key): Promise<CacheEntry<T> | undefined> // bypasses TTL check
cache.flush(): Promise<void>   // writes to disk (call on shutdown)
```
Files written to `cache/` dir (gitignored). Debounced 5s write, LRU eviction at maxEntries.

### throttledFetch (`src/services/lolalytics-throttle.ts`)
```ts
throttledFetch(url, options?: { signal?, headers? }): Promise<Response>
// Token bucket: 2 req/s sustained, burst 3. Queue max 50, timeout 30s.
```

### champ-select-utils (`src/services/champ-select-utils.ts`)
```ts
findEnemyLaner(session, myPosition, strict=false): { player, alias, name } | null
// strict=true disables Strategy 3 (single-picker fallback) — use in smart-pick/counter
// contexts where a wrong-role enemy causes bad recommendations. auto-rune uses default false.
championMatchesLane(champ: { tags: string[] }, lane: string): boolean
getUnavailableAliases(session): Set<string>
```

### lol-icons (`src/services/lol-icons.ts`)
```ts
// All return Promise<string | null> — data URI or null
getChampionIcon(alias)
getChampionIconByKey(key)
getChampionIconByName(name)
getSpellIcon(spellKey)
getItemIcon(itemId)
getDragonIcon(dragonType)
getBaronIcon() / getHeraldIcon() / getGrubsIcon()
getRankedEmblemIcon(tier)
getProfileIcon(iconId)
prefetchChampionIcons(aliases[]) / prefetchItemIcons(itemIds[]) / prefetchObjectiveIcons()
```

## Dial Layout System

Layout JSON files live in `com.desstroct.lol-api.sdPlugin/layouts/`. Each action that supports `Encoder` declares one in `manifest.json` under `"Encoder": { "layout": "layouts/<name>.json" }`.

**Canvas**: 200×100 px. Left panel convention: pixmap icon at `[4, 4-10, 72, 72-80]`. Right panel: text/bar items starting at x=82.

**Element types**:

- `pixmap` — image. **Must use square `rect` for square source images** (DDragon icons: champ, item, spell, rank emblems are all square). A non-square rect stretches the image.
- `text` — label. `font: { size, weight }`, `alignment: "left"|"center"|"right"`, `color: "#hex"`.
- `bar` — flat progress bar. Properties: `range: {min,max}`, `value`, `bar_fill_c`, `bar_bg_c`.
- `gbar` — same as `bar` but adds a triangle indicator at the current position. Prefer gbar for 0-100 gauges (LP, gold progress). Needs same height as bar or slightly taller.

**Updating elements via `setFeedback()`**:
```ts
// Text — value only (uses layout color):
await a.setFeedback({ my_text: "Hello" });

// Text — override color dynamically:
await a.setFeedback({ my_text: { value: "+18 LP", color: "#2ECC71" } });

// Bar — override fill color dynamically:
await a.setFeedback({ my_bar: { value: 75, bar_fill_c: "#E74C3C" } });

// Pixmap — send data URI or empty string to clear:
await a.setFeedback({ my_icon: dataUri ?? "" });
```

**Current layout inventory** (key elements per action):

| Layout | Left pixmap | Notable right elements |
| --- | --- | --- |
| `auto-rune` | `keystone_icon` 72×66 | `title`, `rune_name`, `rune_info`, `wr_bar`(bar); `spell1_icon`/`spell2_icon` 22×22 below keystone |
| `best-item` | `item_icon` 72×72 | `title`(gold), `item_name`, `cost_text`, `gold_bar`(gbar), `status_text` |
| `death-timer` | `champ_icon` 72×72 | `status_text`, `timer_text`, `respawn_bar`(bar) |
| `jungle-path` | `map_icon` pixmap | `title`, `camp_list` text, `progress_bar` |
| `kda-tracker` | `champ_icon` 72×72 | `kda_line`, `cs_line`, `gold_text`(gold), `kda_bar`(bar), `ratio_text` |
| `lobby-scanner` | `champ_icon` 72×72 | `title`(blue), `champion`, `rank`, `wr_text`, `wr_bar`(bar) |
| `lp-tracker` | `rank_icon` 72×72 | `rank_text`, `lp_text`(gold), `delta_text`(dynamic color), `lp_bar`(gbar), `winrate_text`, `queue_text` |
| `objective-timer` | `obj_icon` 48×48 | `title`, `timer_text`, `next_text`, `timer_bar`(bar) |
| `session-stats` | `rank_icon` 72×72 | `title`, `record_text`, `lp_text`(gold), `streak_text`(dynamic color), `winrate_bar`(bar), `champ_text` |
| `skill-order` | — | SVG grid key; dial shows skill sequence |
| `smart-pick` | `champ_icon` 72×72 | `title`(red), `pick_name`, `pick_info`, `score_bar`(bar, range 45-65) |

**Dynamic color patterns already in use**:

- `delta_text` in lp-tracker: green (+LP), red (−LP), gray (±0)
- `streak_text` in session-stats: green (win streak), red (loss streak)
- `kda_bar` in kda-tracker: green (≥3.0 KDA), yellow (≥1.5), red (<1.5)
- `score_bar` in smart-pick: green (≥54% WR), yellow (≥50%), red (<50%)
- `timer_bar` in objective-timer: per-objective color from `getObjectiveInfo()`
- `respawn_bar` in death-timer: red (dead), green (alive/respawned)

## Key Types (`src/types/lol.ts`)

```ts
GameflowPhase = "None"|"Lobby"|"Matchmaking"|"ReadyCheck"|"ChampSelect"|"GameStart"|"InProgress"|"WaitingForStats"|"PreEndOfGame"|"EndOfGame"|"Reconnect"

LcuChampSelectSession {
  localPlayerCellId: number
  myTeam: LcuChampSelectPlayer[]
  theirTeam: LcuChampSelectPlayer[]
  actions: LcuChampSelectAction[][]   // jagged: each sub-array is a phase
}
LcuChampSelectPlayer { cellId, championId, assignedPosition, spell1Id, spell2Id, ... }
LcuChampSelectAction { actorCellId, championId, completed, type: "pick"|"ban" }

GameClientAllData { activePlayer: ActivePlayer, allPlayers: GamePlayer[], events: GameEvents, gameData: GameData }
ActivePlayer { summonerName, currentGold, level, championStats, fullRunes }
GamePlayer { championName, riotIdGameName, isBot, isDead, respawnTimer, items, scores, team }
GameData { gameMode, gameTime }

DdChampion { id, key, name, title, tags: string[], info, image }
// id = "Aatrox", key = "266" (numeric string), name = "Aatrox"
```

## Patterns & Conventions

**Action polling**: `startPolling()` → 3s setInterval → `updateState()`. Stop in `onWillDisappear` when `this.actions.length === 0`.

**State per action instance**: `Map<actionId, StateType>` in class field. `getState(actionId)` initializes lazily.

**LCU detection guard** (start of every `updateState`):
```ts
if (!lcuConnector.isConnected()) { /* show offline */ return; }
if (gameMode.isTFT()) { /* show N/A */ return; }
const phase = await lcuApi.getGameflowPhase();
if (phase !== "ChampSelect") { /* reset + return */ }
```

**Lolalytics alias**: always go through `ChampionStats.toLolalytics(champ.id)` or `ItemBuilds.toAlias(champName)`.

**Champion lookup**:
- By numeric key (LCU championId): `dataDragon.getChampionByKey(String(me.championId))`
- By display name / alias: `dataDragon.getChampionByName(alias)` — handles accents/apostrophes

**LCU `isLocked` check** (auto-rune pattern):
```ts
const isLocked = session.actions.flat().some(
  act => act.actorCellId === localCell && act.type === "pick" && act.completed && act.championId > 0
);
```

**Flush on shutdown** (`plugin.ts`): `SIGTERM/SIGINT/SIGHUP/beforeExit` → `flushCaches()` for all 5 services that have caches.

**EPIPE guard** (`plugin.ts`): stdout/stderr `error` events swallow `EPIPE`/`ERR_STREAM_DESTROYED`.

**Fetch retry cooldown** (auto-rune pattern): `state.runeFetchFailedUntil = Date.now() + 30_000` in catch. `shouldRetry = lastRunes.length === 0 && Date.now() >= runeFetchFailedUntil && lastChampKey !== ""`.

**Property inspector**: uses `sdpi-components v4` from CDN. Settings stored as JSON via `@elgato/streamdeck` SDK. Checkboxes → boolean, selects → string.

**SVG key images**: composed inline, embedded PNG base64 (disk-cached per keystoneId). `data:image/svg+xml;base64,...` passed to `setImage()`.

## Auto-Rune specifics

Key images: `imgs/actions/auto-rune/keystones/<id>@2x.png`, `imgs/actions/auto-rune/trees/<styleId>@2x.png`
- Green border/glow = runes applied. Gold border = pending.
- `composeRuneImage(keystoneId, subStyleId, applied): string | null`

Mode label in title: `settings.autoApply === false ? "Manual" : "Auto"`

## File helpers (present in multiple actions)

```ts
// best-item.ts
formatGold(gold): string   // >= 1000 → "1.5k"
truncate(str, max): string // slice at max-1 + "…"
```

## What NOT to do (Vanguard compliance)

- No game process memory read/write
- No input injection into the game window
- No network packet interception/modification
- No fog-of-war / enemy position data
- LCU API (localhost) = allowed. LeagueOfLegends.exe = never touch.
