import streamDeck from "@elgato/streamdeck";
import { lcuApi } from "./lcu-api";

const logger = streamDeck.logger.createScope("PlayerTier");

/** Default tier when rank is unknown or unranked. */
export const DEFAULT_TIER = "emerald_plus";

/**
 * Convert an LCU rank tier string to the Lolalytics tier URL parameter.
 *
 * Low elo gets exact tier data; Gold+ gets "plus" tiers that aggregate
 * data from that tier and above (better sample sizes).
 */
export function lolalyticsTier(lcuTier: string): string {
	switch (lcuTier.toUpperCase()) {
		case "IRON":       return "iron";
		case "BRONZE":     return "bronze";
		case "SILVER":     return "silver";
		case "GOLD":       return "gold_plus";
		case "PLATINUM":   return "platinum_plus";
		case "EMERALD":    return "emerald_plus";
		case "DIAMOND":    return "diamond_plus";
		case "MASTER":
		case "GRANDMASTER":
		case "CHALLENGER": return "master_plus";
		default:           return DEFAULT_TIER;
	}
}

/**
 * Fetch the current player's Lolalytics tier parameter (uncached — internal).
 * Uses Solo/Duo rank, falls back to Flex, then to DEFAULT_TIER.
 */
async function fetchPlayerTier(): Promise<string> {
	try {
		const ranked = await lcuApi.getCurrentRankedStats();
		const solo = ranked?.queueMap?.RANKED_SOLO_5x5;
		if (solo?.tier && solo.tier !== "NONE" && solo.tier !== "") {
			return lolalyticsTier(solo.tier);
		}
		const flex = ranked?.queueMap?.RANKED_FLEX_SR;
		if (flex?.tier && flex.tier !== "NONE" && flex.tier !== "") {
			return lolalyticsTier(flex.tier);
		}
	} catch {
		// LCU unavailable — use default
	}
	return DEFAULT_TIER;
}

// ────────────────── Centralized tier cache ──────────────────
//
// All actions (Smart Pick, Auto Rune, Best Item) share this cache
// so they always use the same elo bracket for Lolalytics queries.
// TTL is 5 minutes — covers a full champ select + game start transition.
// After a game ends the cache expires naturally, picking up any rank change.

let _cachedTier: string | null = null;
let _cachedAt = 0;
const TIER_CACHE_TTL = 5 * 60 * 1000;

/**
 * Get the player's Lolalytics tier parameter (cached, shared).
 *
 * Smart Pick, Auto Rune, and Best Item all call this instead of fetching
 * independently.  Guarantees they use the same elo bracket within a session.
 */
export async function getPlayerTier(): Promise<string> {
	if (_cachedTier && Date.now() - _cachedAt < TIER_CACHE_TTL) return _cachedTier;
	_cachedTier = await fetchPlayerTier();
	_cachedAt = Date.now();
	logger.info(`Player tier resolved: ${_cachedTier}`);
	return _cachedTier;
}

/**
 * Invalidate the cached tier.
 * Call when the player might have promoted/demoted (e.g. EndOfGame phase).
 * The next `getPlayerTier()` call will re-query the LCU.
 */
export function invalidatePlayerTier(): void {
	_cachedTier = null;
	_cachedAt = 0;
}
