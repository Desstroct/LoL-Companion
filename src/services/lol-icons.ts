import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";

const logger = streamDeck.logger.createScope("LoLIcons");

/**
 * Unified in-memory icon cache: key → base64 data URI (bounded to 500 entries).
 * A value of "" means the fetch was attempted and failed (negative cache).
 */
const iconCache = new Map<string, { data: string; timestamp: number }>();
const ICON_CACHE_MAX = 500;
const NEGATIVE_SENTINEL = "";
/** Negative cache entries expire after 5 minutes (allows retry on transient failures). */
const NEGATIVE_TTL = 5 * 60 * 1000;

// ────────────────── Generic fetch ──────────────────

/**
 * Fetch any image URL and return as base64 data URI. Cached in memory.
 * Failed fetches are negatively cached so they are not retried every tick.
 * Evicts oldest entries when cache exceeds ICON_CACHE_MAX.
 */
async function fetchIcon(cacheKey: string, url: string): Promise<string | null> {
	const cached = iconCache.get(cacheKey);
	if (cached !== undefined) {
		// Negative cache entries expire after NEGATIVE_TTL
		if (cached.data === NEGATIVE_SENTINEL) {
			if (Date.now() - cached.timestamp < NEGATIVE_TTL) return null;
			iconCache.delete(cacheKey); // expired — retry
		} else {
			return cached.data;
		}
	}
	try {
		const response = await fetch(url);
		if (!response.ok) {
			logger.warn(`Icon fetch failed (${response.status}): ${url}`);
			iconCache.set(cacheKey, { data: NEGATIVE_SENTINEL, timestamp: Date.now() });
			return null;
		}
		const buffer = Buffer.from(await response.arrayBuffer());
		const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;
		// Evict oldest entries if cache is full
		if (iconCache.size >= ICON_CACHE_MAX) {
			const firstKey = iconCache.keys().next().value;
			if (firstKey) iconCache.delete(firstKey);
		}
		iconCache.set(cacheKey, { data: dataUri, timestamp: Date.now() });
		return dataUri;
	} catch (e) {
		logger.error(`Icon fetch error: ${url} — ${e}`);
		iconCache.set(cacheKey, { data: NEGATIVE_SENTINEL, timestamp: Date.now() });
		return null;
	}
}

// ────────────────── Champion icons ──────────────────

/**
 * Get a champion square portrait as base64 data URI.
 * @param alias Lolalytics alias (e.g., "aatrox", "masteryi")
 */
export async function getChampionIcon(alias: string): Promise<string | null> {
	const ddId = resolveDataDragonId(alias);
	if (!ddId) {
		logger.warn(`Cannot resolve DDragon ID for alias: ${alias}`);
		return null;
	}
	return fetchIcon(`champ:${alias}`, dataDragon.getChampionImageUrl(ddId));
}

/**
 * Get a champion square portrait by numeric key (champion ID).
 * @param key Numeric champion ID as string (e.g., "266" for Aatrox)
 */
export async function getChampionIconByKey(key: string): Promise<string | null> {
	if (!key) return null;
	const champ = dataDragon.getChampionByKey(key);
	if (!champ) return null;
	return fetchIcon(`champ:${champ.id.toLowerCase()}`, dataDragon.getChampionImageUrl(champ.id));
}

/**
 * Get a champion icon by exact champion name (as returned by Game Client API).
 * @param name Champion name (e.g., "Aatrox", "Master Yi", "Wukong")
 */
export async function getChampionIconByName(name: string): Promise<string | null> {
	if (!name) return null;
	// Game Client API uses display names; DDragon uses IDs
	const lower = name.toLowerCase().replace(/['\s.]/g, "");
	for (const champ of dataDragon.getAllChampions()) {
		const ddLower = champ.id.toLowerCase().replace(/['\s.]/g, "");
		const nameLower = champ.name.toLowerCase().replace(/['\s.]/g, "");
		if (ddLower === lower || nameLower === lower) {
			return fetchIcon(`champ:${ddLower}`, dataDragon.getChampionImageUrl(champ.id));
		}
	}
	return null;
}

/** Prefetch champion icons (non-blocking). */
export function prefetchChampionIcons(aliases: string[]): void {
	for (const alias of aliases) {
		if (!iconCache.has(`champ:${alias}`)) {
			getChampionIcon(alias).catch(() => {});
		}
	}
}

// ────────────────── Summoner spell icons ──────────────────

/**
 * Get a summoner spell icon by DDragon spell key (e.g., "SummonerFlash").
 */
export async function getSpellIcon(spellKey: string): Promise<string | null> {
	if (!spellKey || spellKey === "Unknown") return null;
	return fetchIcon(`spell:${spellKey}`, dataDragon.getSpellImageUrl(spellKey));
}

/**
 * Get a summoner spell icon by display name (e.g., "Flash", "Ignite").
 * Resolves display name → DDragon key automatically.
 */
export async function getSpellIconByDisplayName(displayName: string): Promise<string | null> {
	const key = DISPLAY_TO_SPELL_KEY[displayName];
	if (!key) {
		logger.warn(`Unknown spell display name: ${displayName}`);
		return null;
	}
	return getSpellIcon(key);
}

const DISPLAY_TO_SPELL_KEY: Record<string, string> = {
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
};

// ────────────────── Item icons ──────────────────

/**
 * Get an item icon by item ID.
 */
export async function getItemIcon(itemId: number): Promise<string | null> {
	const url = `https://ddragon.leagueoflegends.com/cdn/${dataDragon.getVersion()}/img/item/${itemId}.png`;
	return fetchIcon(`item:${itemId}`, url);
}

// ────────────────── Jungle objective icons ──────────────────

// Community Dragon URLs for jungle objectives (correct path: /icons/ subfolder)
const CD_ICONS = "https://raw.communitydragon.org/latest/game/assets/ux/minimap/icons";

const DRAGON_ICON_URLS: Record<string, string> = {
	Fire: `${CD_ICONS}/dragon_infernal.png`,
	Water: `${CD_ICONS}/dragon_ocean.png`,
	Air: `${CD_ICONS}/dragon_cloud.png`,
	Earth: `${CD_ICONS}/dragon_mountain.png`,
	Hextech: `${CD_ICONS}/dragon_hextech.png`,
	Chemtech: `${CD_ICONS}/dragon_chemtech.png`,
	Elder: `${CD_ICONS}/dragon_elder.png`,
};

const BARON_ICON_URL = `${CD_ICONS}/baron.png`;
const HERALD_ICON_URL = `${CD_ICONS}/riftherald.png`;
const GRUBS_ICON_URL = `${CD_ICONS}/grub.png`;

/**
 * Get a dragon type icon (Infernal, Ocean, Cloud, Mountain, Hextech, Chemtech, Elder).
 */
export async function getDragonIcon(dragonType: string): Promise<string | null> {
	const url = DRAGON_ICON_URLS[dragonType];
	if (!url) return null;
	return fetchIcon(`dragon:${dragonType}`, url);
}

/** Get the Baron Nashor icon. */
export async function getBaronIcon(): Promise<string | null> {
	return fetchIcon("baron", BARON_ICON_URL);
}

/** Get the Rift Herald icon. */
export async function getHeraldIcon(): Promise<string | null> {
	return fetchIcon("herald", HERALD_ICON_URL);
}

/** Get the Voidgrubs (Horde) icon. */
export async function getGrubsIcon(): Promise<string | null> {
	return fetchIcon("grubs", GRUBS_ICON_URL);
}

// ────────────────── Profile icons ──────────────────

/**
 * Get a summoner profile icon by ID.
 */
export async function getProfileIcon(iconId: number): Promise<string | null> {
	const url = `https://ddragon.leagueoflegends.com/cdn/${dataDragon.getVersion()}/img/profileicon/${iconId}.png`;
	return fetchIcon(`profile:${iconId}`, url);
}

/**
 * Get a ranked tier emblem icon (e.g. GOLD, PLATINUM, DIAMOND).
 * Uses Community Dragon ranked crest images.
 */
export async function getRankedEmblemIcon(tier: string): Promise<string | null> {
	if (!tier || tier === "NONE") return null;
	const tierLower = tier.toLowerCase();
	const url = `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/images/${tierLower}.png`;
	return fetchIcon(`ranked-emblem:${tierLower}`, url);
}

// ────────────────── Internal helpers ──────────────────

function resolveDataDragonId(alias: string): string | null {
	if (!alias) return null;
	const lowerAlias = alias.toLowerCase().replace(/['\s.]/g, "");
	for (const champ of dataDragon.getAllChampions()) {
		const ddLower = champ.id.toLowerCase().replace(/['\s.]/g, "");
		if (ddLower === lowerAlias) {
			return champ.id;
		}
	}
	return null;
}
