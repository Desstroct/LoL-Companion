import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";
import type { DdChampion } from "../types/lol";

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

/** Concurrency limiter — max 3 parallel icon fetches to avoid burst CDN requests */
let activeIconFetches = 0;
const MAX_CONCURRENT_ICON_FETCHES = 3;
const fetchQueue: Array<() => void> = [];

function acquireFetchSlot(): Promise<void> {
	if (activeIconFetches < MAX_CONCURRENT_ICON_FETCHES) {
		activeIconFetches++;
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => fetchQueue.push(resolve));
}

function releaseFetchSlot(): void {
	const next = fetchQueue.shift();
	if (next) {
		next(); // hand slot to next waiter (count stays the same)
	} else {
		activeIconFetches--;
	}
}

/**
 * Fetch any image URL and return as base64 data URI. Cached in memory.
 * Failed fetches are negatively cached so they are not retried every tick.
 * Evicts oldest entries when cache exceeds ICON_CACHE_MAX.
 * Limits to 3 concurrent network requests to avoid burst CDN traffic.
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
	await acquireFetchSlot();
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
	} finally {
		releaseFetchSlot();
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
	const champ = resolveChampionByName(name);
	if (!champ) return null;
	const ddLower = champ.id.toLowerCase().replace(/['\s.]/g, "");
	return fetchIcon(`champ:${ddLower}`, dataDragon.getChampionImageUrl(champ.id));
}

/**
 * Get a rune/keystone icon as a base64 data URI using DDragon's perk image CDN.
 * Falls back gracefully when the rune ID is unknown or DDragon hasn't loaded yet.
 * @param runeId Riot perk ID (e.g. 8992 for Deathfire Touch)
 */
export async function getRuneIcon(runeId: number): Promise<string | null> {
	const url = dataDragon.getRuneIconUrl(runeId);
	if (!url) return null;
	return fetchIcon(`rune:${runeId}`, url);
}

/** Prefetch champion icons (non-blocking). */
export function prefetchChampionIcons(aliases: string[]): void {
	for (const alias of aliases) {
		if (!iconCache.has(`champ:${alias}`)) {
			getChampionIcon(alias).catch(() => {});
		}
	}
}

/** Prefetch item icons (non-blocking). */
export function prefetchItemIcons(itemIds: number[]): void {
	for (const id of itemIds) {
		if (!iconCache.has(`item:${id}`)) {
			getItemIcon(id).catch(() => {});
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

const SPELL_NUMERIC_ID_TO_KEY: Record<number, string> = {
	1: "SummonerCleanse",
	3: "SummonerExhaust",
	4: "SummonerFlash",
	6: "SummonerGhost",
	7: "SummonerHeal",
	11: "SummonerSmite",
	12: "SummonerTeleport",
	13: "SummonerMana",
	14: "SummonerDot",
	21: "SummonerBarrier",
	32: "SummonerSnowball",
};

/**
 * Get a summoner spell icon by its numeric game ID (e.g., 4 = Flash, 14 = Ignite).
 */
export async function getSpellIconById(id: number): Promise<string | null> {
	const key = SPELL_NUMERIC_ID_TO_KEY[id];
	if (!key) return null;
	return getSpellIcon(key);
}

// ────────────────── Item icons ──────────────────

/**
 * Get an item icon by item ID.
 */
export async function getItemIcon(itemId: number): Promise<string | null> {
	const url = `https://ddragon.leagueoflegends.com/cdn/${dataDragon.getVersion()}/img/item/${itemId}.png`;
	return fetchIcon(`item:${itemId}`, url);
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

/**
 * Lazy-built lookup map: normalized name/id → DdChampion.
 * Rebuilt when DataDragon version changes (patch day) or on first access.
 * Turns O(n) champion lookups into O(1) — called on every icon request.
 */
let champLookup: Map<string, DdChampion> | null = null;
let champLookupVersion = "";

/** Strip accents, lowercase, remove apostrophes/spaces/dots. */
function normalizeStr(s: string): string {
	return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['\s.]/g, "");
}

function getChampLookup(): Map<string, DdChampion> {
	const currentVersion = dataDragon.getVersion();
	if (champLookup && champLookupVersion === currentVersion) return champLookup;

	champLookup = new Map();
	champLookupVersion = currentVersion;
	for (const champ of dataDragon.getAllChampions()) {
		// Index by both DDragon id ("Aatrox") and display name ("Aatrox")
		// For most champs these match, but e.g. "MonkeyKing" vs "Wukong"
		champLookup.set(normalizeStr(champ.id), champ);
		champLookup.set(normalizeStr(champ.name), champ);
	}
	return champLookup;
}

function resolveChampionByName(name: string): DdChampion | undefined {
	return getChampLookup().get(normalizeStr(name));
}

function resolveDataDragonId(alias: string): string | null {
	if (!alias) return null;
	const champ = getChampLookup().get(normalizeStr(alias));
	return champ?.id ?? null;
}
