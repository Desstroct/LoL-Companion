import { SUMMONER_SPELLS } from "../data/summoner-spells";

const FLASH = 4;
const SMITE = 11;
const SNOWBALL = 32;

/**
 * Get the recommended summoner spell pair for a champion on a given lane.
 *
 * Uses static data extracted from Lolalytics (champion's default lane),
 * with smart adjustments for off-role play:
 *   - Jungle always includes Smite (preserving the champion's non-Smite spell)
 *   - ARAM always returns Flash + Snowball
 *   - Non-jungle lanes filter out Smite (falls back to lane defaults)
 *
 * @returns Spell IDs or null if no data (caller should use lane defaults)
 */
export function getChampionSpells(championId: string, lane: string): [number, number] | null {
	if (lane === "aram") return [FLASH, SNOWBALL];

	const key = championId.toLowerCase().replace(/['\s.]/g, "");
	const data = SUMMONER_SPELLS[key];

	if (!data) return null;

	const hasSmite = data[0] === SMITE || data[1] === SMITE;

	if (lane === "jungle") {
		// Jungle: always need Smite
		if (hasSmite) return data; // e.g. Shaco [11,14], Hecarim [6,11]
		// Champion data is from a non-jungle lane → force Flash+Smite
		return [FLASH, SMITE];
	}

	// Non-jungle lane
	if (hasSmite) {
		// Champion data includes Smite (jungle-primary champ played off-role)
		// Can't use Smite in lane → return null so caller uses lane defaults
		return null;
	}

	return data;
}

/**
 * Check if champion-specific spell data exists.
 */
export function hasSpellData(championId: string): boolean {
	const key = championId.toLowerCase().replace(/['\s.]/g, "");
	return key in SUMMONER_SPELLS;
}
