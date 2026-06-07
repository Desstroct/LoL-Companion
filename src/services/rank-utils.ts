/**
 * Shared ranked tier utilities used by LP Tracker and Session Stats.
 */

/** Absolute LP value for each tier base (Iron 0 → Challenger 3000). */
const TIER_BASE_LP: Record<string, number> = {
	IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200,
	PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400,
	MASTER: 2800, GRANDMASTER: 2900, CHALLENGER: 3000,
};

/** LP offset per division within a tier. */
const DIV_LP: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };

/**
 * Convert tier + division + LP to an absolute LP value for accurate delta
 * tracking across tier/division promotions and demotions.
 *
 * Master+ tiers have no divisions — LP adds directly to the tier base.
 */
export function tierToAbsoluteLp(tier: string, div: string, lp: number): number {
	const base = TIER_BASE_LP[tier] ?? 0;
	if (base >= 2800) return base + lp; // Master+ LP adds directly
	return base + (DIV_LP[div] ?? 0) + lp;
}
