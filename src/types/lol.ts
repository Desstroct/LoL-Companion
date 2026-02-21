// ============================================================
// League of Legends Types — LCU, Game Client & Data Dragon
// ============================================================

// ---- LCU Connector ----

export interface LcuCredentials {
	pid: number;
	port: number;
	password: string;
	protocol: string;
}

// ---- LCU API: Summoner / Ranked ----

export interface LcuSummoner {
	accountId: number;
	displayName: string;
	gameName: string;
	tagLine: string;
	internalName: string;
	profileIconId: number;
	puuid: string;
	summonerId: number;
	summonerLevel: number;
}

export interface LcuRankedEntry {
	queueType: string;
	tier: string;
	division: string;
	leaguePoints: number;
	wins: number;
	losses: number;
	miniSeriesProgress?: string;
}

export interface LcuRankedStats {
	queueMap: Record<string, LcuRankedEntry>;
}

// ---- LCU API: Perks / Rune Pages ----

export interface LcuRunePage {
	id: number;
	name: string;
	primaryStyleId: number;
	subStyleId: number;
	selectedPerkIds: number[];
	current: boolean;
	isEditable: boolean;
	isDeletable: boolean;
	isActive: boolean;
	isValid: boolean;
	lastModified: number;
	order: number;
}

// ---- LCU API: Champion Select ----

export interface LcuChampSelectSession {
	gameId: number;
	timer: LcuChampSelectTimer;
	myTeam: LcuChampSelectPlayer[];
	theirTeam: LcuChampSelectPlayer[];
	actions: LcuChampSelectAction[][];
	localPlayerCellId: number;
	isSpectating: boolean;
}

export interface LcuChampSelectTimer {
	phase: "PLANNING" | "BAN_PICK" | "FINALIZATION" | string;
	adjustedTimeLeftInPhase: number;
	totalTimeInPhase: number;
}

export interface LcuChampSelectPlayer {
	cellId: number;
	championId: number;
	championPickIntent: number;
	selectedSkinId: number;
	spell1Id: number;
	spell2Id: number;
	summonerId: number;
	puuid: string;
	team: number;
	assignedPosition: string; // "top" | "jungle" | "middle" | "bottom" | "utility"
}

export interface LcuChampSelectAction {
	id: number;
	actorCellId: number;
	championId: number;
	completed: boolean;
	isAllyAction: boolean;
	isInProgress: boolean;
	type: "pick" | "ban" | string;
}

// ---- LCU API: Gameflow ----

export type GameflowPhase =
	| "None"
	| "Lobby"
	| "Matchmaking"
	| "ReadyCheck"
	| "ChampSelect"
	| "GameStart"
	| "InProgress"
	| "WaitingForStats"
	| "PreEndOfGame"
	| "EndOfGame"
	| "Reconnect";

// ---- Game Client API (localhost:2999) ----

export interface GameClientAllData {
	activePlayer: ActivePlayer;
	allPlayers: GamePlayer[];
	events: GameEvents;
	gameData: GameData;
}

export interface ActivePlayer {
	summonerName: string;
	level: number;
	currentGold: number;
	championStats: ChampionStats;
	abilities: Record<string, AbilityInfo>;
	fullRunes: FullRunes;
}

export interface ChampionStats {
	abilityPower: number;
	armor: number;
	attackDamage: number;
	attackSpeed: number;
	currentHealth: number;
	maxHealth: number;
	moveSpeed: number;
	magicResist: number;
}

export interface AbilityInfo {
	displayName: string;
	abilityLevel: number;
}

export interface FullRunes {
	generalRunes: RuneInfo[];
	keystone: RuneInfo;
	primaryRuneTree: RuneTree;
	secondaryRuneTree: RuneTree;
	statRunes: StatRune[];
}

export interface RuneInfo {
	id: number;
	displayName: string;
	rawDescription: string;
}

export interface RuneTree {
	id: number;
	displayName: string;
}

export interface StatRune {
	id: number;
	rawDescription: string;
}

export interface GamePlayer {
	championName: string;
	isBot: boolean;
	isDead: boolean;
	items: GameItem[];
	level: number;
	position: string; // "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"
	rawChampionName: string; // "game_character_displayname_Aatrox"
	respawnTimer: number;
	riotId: string; // "Name#Tag"
	riotIdGameName: string;
	riotIdTagline: string;
	scores: PlayerScores;
	skinID: number;
	summonerName: string;
	summonerSpells: SummonerSpells;
	team: "ORDER" | "CHAOS";
}

export interface GameItem {
	canUse: boolean;
	consumable: boolean;
	count: number;
	displayName: string;
	itemID: number;
	price: number;
	rawDescription: string;
	rawDisplayName: string;
	slot: number;
}

export interface PlayerScores {
	assists: number;
	creepScore: number;
	deaths: number;
	kills: number;
	wardScore: number;
}

export interface SummonerSpells {
	summonerSpellOne: SummonerSpellInfo;
	summonerSpellTwo: SummonerSpellInfo;
}

export interface SummonerSpellInfo {
	displayName: string;
	rawDescription: string;
	rawDisplayName: string;
}

export interface GameEvents {
	Events: GameEvent[];
}

export interface GameEvent {
	EventID: number;
	EventName: string;
	EventTime: number;
	// Optional fields depending on event type
	KillerName?: string;
	VictimName?: string;
	Assisters?: string[];
	DragonType?: string;
	Stolen?: string;
	TurretKilled?: string;
	InhibKilled?: string;
	Result?: string;
}

export interface GameData {
	gameMode: string;
	gameTime: number;
	mapName: string;
	mapNumber: number;
	mapTerrain: string;
}

// ---- Data Dragon ----

export interface DdChampionInfo {
	attack: number;
	defense: number;
	magic: number;
	difficulty: number;
}

export interface DdChampion {
	id: string;
	key: string;
	name: string;
	title: string;
	tags: string[];
	info: DdChampionInfo;
	image: DdImage;
}

export interface DdImage {
	full: string;
	sprite: string;
	group: string;
}

export interface DdSummonerSpell {
	id: string;
	key: string;
	name: string;
	description: string;
	cooldownBurn: string;
	image: DdImage;
}

export interface DdItem {
	name: string;
	gold: DdItemGold;
	description: string;
	plaintext: string;
	image: DdImage;
	tags: string[];
	into?: string[];
	from?: string[];
	maps: Record<string, boolean>;
}

export interface DdItemGold {
	base: number;
	total: number;
	sell: number;
	purchasable: boolean;
}

// ---- Plugin Internal Types ----

export interface SummonerSpellState {
	spellName: string;
	spellKey: string;
	cooldown: number; // base cooldown in seconds
	usedAtGameTime: number | null; // game time when the spell was used
	isOnCooldown: boolean;
	remainingCooldown: number;
}

export interface PlayerCardData {
	gameName: string;
	tagLine: string;
	tier: string;
	division: string;
	lp: number;
	wins: number;
	losses: number;
	winRate: number;
	championName: string;
	position: string;
}

// ---- Summoner Spell Cooldowns (base values) ----

export const SUMMONER_SPELL_COOLDOWNS: Record<string, number> = {
	SummonerFlash: 300,
	SummonerDot: 180, // Ignite
	SummonerTeleport: 360,
	SummonerHeal: 240,
	SummonerExhaust: 210,
	SummonerBarrier: 180,
	SummonerSmite: 90,
	SummonerCleanse: 210,
	SummonerGhost: 210,
	SummonerMana: 240, // Clarity
	SummonerSnowball: 80, // Mark (ARAM)
};

export const SUMMONER_SPELL_DISPLAY_NAMES: Record<string, string> = {
	SummonerFlash: "Flash",
	SummonerDot: "Ignite",
	SummonerTeleport: "Teleport",
	SummonerHeal: "Heal",
	SummonerExhaust: "Exhaust",
	SummonerBarrier: "Barrier",
	SummonerSmite: "Smite",
	SummonerCleanse: "Cleanse",
	SummonerGhost: "Ghost",
	SummonerMana: "Clarity",
	SummonerSnowball: "Mark",
};

// Maps the Game Client API display names to internal spell names.
// Includes common localisations (FR, ES, DE, PT, IT, KO, JA, ZH, etc.)
export const SPELL_DISPLAY_TO_KEY: Record<string, string> = {
	// English
	"Flash": "SummonerFlash",
	"Ignite": "SummonerDot",
	"Teleport": "SummonerTeleport",
	"Heal": "SummonerHeal",
	"Exhaust": "SummonerExhaust",
	"Barrier": "SummonerBarrier",
	"Smite": "SummonerSmite",
	"Cleanse": "SummonerCleanse",
	"Ghost": "SummonerGhost",
	"Clarity": "SummonerMana",
	"Mark": "SummonerSnowball",
	// French (FR)
	"Téléportation": "SummonerTeleport",
	"Embrasement": "SummonerDot",
	"Soin": "SummonerHeal",
	"Épuisement": "SummonerExhaust",
	"Châtiment": "SummonerSmite",
	"Purification": "SummonerCleanse",
	"Fantôme": "SummonerGhost",
	"Clarté": "SummonerMana",
	"Marque": "SummonerSnowball",
	"Barrière": "SummonerBarrier",
	// Spanish (ES)
	"Teletransporte": "SummonerTeleport",
	"Incendiar": "SummonerDot",
	"Curación": "SummonerHeal",
	"Agotar": "SummonerExhaust",
	"Castigo": "SummonerSmite",
	"Purificar": "SummonerCleanse",
	"Fantasmal": "SummonerGhost",
	"Claridad": "SummonerMana",
	"Destello": "SummonerFlash",
	"Marca": "SummonerSnowball",
	"Barrera": "SummonerBarrier",
	// German (DE) — Teleport is same as English
	"Entzünden": "SummonerDot",
	"Heilung": "SummonerHeal",
	"Erschöpfung": "SummonerExhaust",
	"Zerschmettern": "SummonerSmite",
	"Geistererscheinung": "SummonerGhost",
	"Klarheit": "SummonerMana",
	"Ruf der Leere": "SummonerSnowball",
	"Blitz": "SummonerFlash",
	// Portuguese (PT) — Incendiar already mapped from ES
	"Teletransportar": "SummonerTeleport",
	"Curar": "SummonerHeal",
	"Exaurir": "SummonerExhaust",
	"Punição": "SummonerSmite",
	"Interface Limpa": "SummonerCleanse",
	"Espírito Inquieto": "SummonerGhost",
	"Lampejo": "SummonerFlash",
};
