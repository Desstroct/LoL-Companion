import { SKILL_ORDERS, type SkillOrderEntry } from "../data/skill-orders";

/**
 * Skill order data service.
 *
 * Provides recommended skill max order and level-by-level sequence
 * from statically extracted Lolalytics data.
 *
 * Key = DDragon champion ID (lowercase). Use `champ.id.toLowerCase()`.
 */

/**
 * Look up the most common skill order for a champion.
 * Returns null if the champion isn't in the static dataset.
 */
export function getSkillOrder(championId: string): SkillOrderEntry | null {
	const key = championId.toLowerCase().replace(/['\s.]/g, "");
	return SKILL_ORDERS[key] ?? null;
}

/**
 * Check whether skill data is available for a champion.
 */
export function hasSkillData(championId: string): boolean {
	return getSkillOrder(championId) !== null;
}
