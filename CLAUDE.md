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
| `auto-rune` | auto-rune.ts | Multi-key: different roles. OTP-aware. |
| `auto-accept` | auto-accept.ts | Polls ReadyCheck 1s |
| `auto-pick` | auto-pick.ts | |
| `best-item` | best-item.ts | Singleton buildPromise (class-level) |
| `death-timer` | death-timer.ts | |
| `duo-synergy` | duo-synergy.ts | |
| `game-status` | game-status.ts | |
| `jungle-path` | jungle-path.ts | |
| `kda-tracker` | kda-tracker.ts | |
| `lobby-level` | lobby-level.ts | |
| `lobby-scanner` | lobby-scanner.ts | |
| `lp-tracker` | lp-tracker.ts | |
| `objective-timer` | objective-timer.ts | |
| `otp` | otp.ts | Singleton exported as `otp`. Used by auto-rune, smart-pick, best-item |
| `post-game` | post-game.ts | |
| `session-stats` | session-stats.ts | |
| `skill-order` | skill-order.ts | |
| `smart-pick` | smart-pick.ts | OTP-aware |
| `tft-comp` | tft-comp.ts | |

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
findEnemyLaner(session, myPosition): { player, alias, name } | null
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

### OTP singleton (`src/actions/otp.ts`)
```ts
otp.getCurrentOTP(): { alias: string; config: OTPChampionConfig } | null
otp.getAllOTP(): Map<string, OTPChampionConfig>
otp.addChampion(alias, config?): Promise<void>
otp.removeChampion(alias): Promise<void>
otp.updateChampionConfig(alias, config): Promise<void>
// OTPChampionConfig: { enabled, autoRune, autoItem, autoSpell, counterMode, bestMode, preferredLane?, preferredRole? }
```

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

**OTP check pattern** (in auto-apply guards):
```ts
const otpConfig = otp.getCurrentOTP();
const shouldAutoApply = settings.autoApply && (!otpConfig || otpConfig.config.autoRune !== false);
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
