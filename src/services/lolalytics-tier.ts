import { lcuApi } from "./lcu-api";

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
 * Fetch the current player's Lolalytics tier parameter.
 * Uses Solo/Duo rank, falls back to Flex, then to DEFAULT_TIER.
 */
export async function fetchPlayerTier(): Promise<string> {
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
