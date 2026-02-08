import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";

const logger = streamDeck.logger.createScope("ChampionStats");

/**
 * Lolalytics JSON API base — returns structured counter data.
 * Endpoint: /mega/?ep=counter&p=d&v=1&patch={major.minor}&c={champion}&lane={lane}&tier=emerald_plus&queue=420&region=all
 * Response: { stats: {...}, counters: [{ cid, vsWr, n, d1, d2, allWr, defaultLane }] }
 * - cid: Data Dragon champion key (numeric)
 * - vsWr: win rate of the searched champion VS this enemy (higher = enemy wins more)
 * - n: number of games in matchup
 * - allWr: overall win rate of the counter champion
 */
const LOLALYTICS_API = "https://a1.lolalytics.com";
const FETCH_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

export interface MatchupData {
	/** Champion alias as used in Lolalytics URLs (lowercase, no spaces) */
	alias: string;
	/** Display name */
	name: string;
	/** Win rate of the reference champion VS this enemy */
	winRateVs: number;
	/** Number of games in matchup sample */
	games: number;
}

/**
 * Fetches champion counter/matchup data from Lolalytics JSON API.
 * Uses structured API responses — no HTML scraping needed.
 */
export class ChampionStats {
	/** Cache: "championKey:lane" → { data, timestamp } */
	private cache: Map<string, { data: MatchupData[]; timestamp: number }> = new Map();
	private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

	/**
	 * Get counters (opponents that beat this champion) for a given lane.
	 * Returns sorted by win rate ascending (strongest counters first).
	 */
	async getCounters(championAlias: string, lane: string): Promise<MatchupData[]> {
		const matchups = await this.getMatchups(championAlias, lane);
		// Lower win rate = stronger counter (enemy wins more)
		return matchups.sort((a, b) => a.winRateVs - b.winRateVs);
	}

	/**
	 * Get best picks against a given champion for a lane.
	 * Returns sorted by win rate descending (highest WR first).
	 */
	async getBestCounterpicks(enemyAlias: string, lane: string): Promise<MatchupData[]> {
		const matchups = await this.getMatchups(enemyAlias, lane);
		// Invert logic: we want champions that beat the enemy
		// If Aatrox vs Singed = 43.3% WR, then Singed vs Aatrox = ~56.7%
		return matchups
			.map((m) => ({
				...m,
				winRateVs: +(100 - m.winRateVs).toFixed(2),
			}))
			.sort((a, b) => b.winRateVs - a.winRateVs);
	}

	/**
	 * Get the best overall pick considering multiple enemy champions AND ally synergy.
	 * Scores each potential pick by:
	 *   - Counter score (60%): average inverted WR against all enemy champions
	 *   - Synergy score (40%): team composition balance (damage type, role diversity)
	 *
	 * @param enemyAliases - Lolalytics aliases of enemy champions
	 * @param allyChampionKeys - Data Dragon keys (numeric IDs) of ally champions
	 * @param lane - Lolalytics lane string
	 */
	async getBestOverallPick(
		enemyAliases: string[],
		lane: string,
		allyChampionKeys?: string[],
	): Promise<{ alias: string; name: string; score: number; details: string }[]> {
		if (enemyAliases.length === 0) return [];

		// Fetch matchup data for each enemy
		const allMatchups: Map<string, { totalWr: number; count: number; name: string }> = new Map();

		// Fetch all enemy matchup pages in parallel
		const allCounters = await Promise.all(
			enemyAliases.map((enemy) => this.getBestCounterpicks(enemy, lane)),
		);

		for (const counters of allCounters) {
			for (const c of counters) {
				const existing = allMatchups.get(c.alias);
				if (existing) {
					existing.totalWr += c.winRateVs;
					existing.count += 1;
				} else {
					allMatchups.set(c.alias, { totalWr: c.winRateVs, count: 1, name: c.name });
				}
			}
		}

		// Build ally team profile for synergy scoring
		const allyProfile = allyChampionKeys?.length
			? this.buildTeamProfile(allyChampionKeys)
			: null;

		// Score = weighted combination of counter and synergy
		const results = [...allMatchups.entries()]
			.filter(([_, v]) => v.count >= 1) // Must have data vs at least one enemy
			.map(([alias, v]) => {
				const counterScore = v.totalWr / v.count;
				let synergyBonus = 0;

				if (allyProfile) {
					synergyBonus = this.computeSynergyBonus(alias, allyProfile);
				}

				// Weighted: 60% counter, 40% synergy (synergy is ±5 points max)
				const finalScore = counterScore + synergyBonus;

				return {
					alias,
					name: v.name,
					score: +finalScore.toFixed(2),
					details: allyProfile
						? `ctr ${counterScore.toFixed(1)}% syn ${synergyBonus >= 0 ? "+" : ""}${synergyBonus.toFixed(1)}`
						: `avg ${counterScore.toFixed(1)}%`,
				};
			})
			.sort((a, b) => b.score - a.score);

		return results;
	}

	/**
	 * Build a team profile from ally champion keys for synergy analysis.
	 */
	private buildTeamProfile(allyKeys: string[]): TeamProfile {
		let totalMagic = 0;
		let totalAttack = 0;
		let totalDefense = 0;
		let count = 0;
		const tags: string[] = [];

		for (const key of allyKeys) {
			const champ = dataDragon.getChampionByKey(key);
			if (!champ) continue;
			totalMagic += champ.info.magic;
			totalAttack += champ.info.attack;
			totalDefense += champ.info.defense;
			tags.push(...champ.tags);
			count++;
		}

		if (count === 0) {
			return { avgMagic: 5, avgAttack: 5, avgDefense: 5, tags, hasTank: false, hasEngage: false, count: 0 };
		}

		return {
			avgMagic: totalMagic / count,
			avgAttack: totalAttack / count,
			avgDefense: totalDefense / count,
			tags,
			hasTank: tags.includes("Tank"),
			hasEngage: tags.includes("Tank") || tags.includes("Support"),
			count,
		};
	}

	/**
	 * Compute a synergy bonus (±5 points) for a candidate champion based on team composition.
	 *
	 * Factors:
	 * - Damage balance: if team is mostly AD, AP picks get bonus (and vice versa)
	 * - Tank presence: if team lacks tanks, tanky picks get bonus
	 * - Role diversity: avoid stacking the same tags
	 */
	private computeSynergyBonus(candidateAlias: string, profile: TeamProfile): number {
		if (!candidateAlias) return 0;
		// Resolve candidate champion data via public API
		const candidateChamp = dataDragon.getChampionByName(candidateAlias);
		if (!candidateChamp || profile.count === 0) return 0;

		let bonus = 0;

		// 1. Damage balance: team avg magic vs candidate magic
		//    If team is AD-heavy (avgMagic < 4) and candidate is AP (magic >= 7): bonus
		//    If team is AP-heavy (avgMagic > 6) and candidate is AD (magic <= 3): bonus
		if (profile.avgMagic < 4 && candidateChamp.info.magic >= 7) {
			bonus += 2.5; // Team needs AP
		} else if (profile.avgMagic > 6 && candidateChamp.info.magic <= 3) {
			bonus += 2.5; // Team needs AD
		} else if (profile.avgMagic >= 4 && profile.avgMagic <= 6) {
			bonus += 0.5; // Balanced team, small bonus for any
		}

		// 2. Tank/frontline presence
		//    If no tanks on team and candidate is a tank/fighter: bonus
		if (!profile.hasTank && candidateChamp.tags.includes("Tank")) {
			bonus += 1.5;
		} else if (!profile.hasTank && candidateChamp.info.defense >= 7) {
			bonus += 1.0;
		}

		// 3. Role diversity penalty: if candidate shares primary tag with most allies
		const primaryTag = candidateChamp.tags[0];
		const tagCount = profile.tags.filter((t) => t === primaryTag).length;
		if (tagCount >= 2) {
			bonus -= 1.0; // Too many of the same role
		}

		// Clamp to ±5
		return Math.max(-5, Math.min(5, bonus));
	}

	/**
	 * Fetch matchup data for a champion on a lane via Lolalytics JSON API.
	 * Retries up to 2 times on failure with exponential backoff.
	 *
	 * @param championAlias - Lolalytics champion alias (lowercase, e.g. "aatrox")
	 * @param lane - Lolalytics lane string (e.g. "top", "middle", "support")
	 */
	private async getMatchups(championAlias: string, lane: string): Promise<MatchupData[]> {
		const key = `${championAlias}:${lane}`;
		const cached = this.cache.get(key);

		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
			return cached.data;
		}

		// Extract major.minor patch from Data Dragon version (e.g. "16.3.1" → "16.3")
		const ddVersion = dataDragon.getVersion();
		const patchParts = ddVersion.split(".");
		const patch = `${patchParts[0]}.${patchParts[1]}`;

		const url = `${LOLALYTICS_API}/mega/?ep=counter&p=d&v=1&patch=${patch}&c=${championAlias}&lane=${lane}&tier=emerald_plus&queue=420&region=all`;
		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					const delay = 1000 * Math.pow(2, attempt - 1);
					logger.debug(`Retry ${attempt}/${maxRetries} for ${championAlias} ${lane} in ${delay}ms`);
					await new Promise((r) => setTimeout(r, delay));
				}

				logger.debug(`Fetching matchups: ${url}`);

				const response = await fetch(url, {
					headers: FETCH_HEADERS,
					signal: AbortSignal.timeout(10_000),
				});

				if (!response.ok) {
					logger.warn(`Lolalytics API returned ${response.status} for ${championAlias} ${lane}`);
					continue;
				}

				const json = await response.json() as LolalyticCounterResponse;

				if (!json?.counters || !Array.isArray(json.counters)) {
					logger.warn(`Invalid API response structure for ${championAlias} ${lane}`);
					continue;
				}

				const matchups: MatchupData[] = [];

				for (const c of json.counters) {
					if (!c.cid || c.n < 50) continue; // Skip very low sample sizes

					// Resolve champion info from Data Dragon using numeric key
					const champ = dataDragon.getChampionByKey(String(c.cid));
					const alias = champ ? ChampionStats.toLolalytics(champ.id) : String(c.cid);
					const name = champ?.name ?? `Champion ${c.cid}`;

					matchups.push({
						alias,
						name,
						winRateVs: c.vsWr,
						games: c.n,
					});
				}

				if (matchups.length === 0) {
					logger.warn(`0 matchups from API for ${championAlias} ${lane} (attempt ${attempt + 1})`);
					continue;
				}

				logger.info(`Parsed ${matchups.length} matchups for ${championAlias} ${lane} via API`);
				this.cache.set(key, { data: matchups, timestamp: Date.now() });
				return matchups;
			} catch (e) {
				logger.error(`Failed to fetch matchups for ${championAlias} ${lane} (attempt ${attempt + 1}): ${e}`);
			}
		}

		logger.error(`All ${maxRetries + 1} attempts failed for ${championAlias} ${lane}`);
		return cached?.data ?? [];
	}

	/**
	 * Convert a Data Dragon champion ID (e.g., "MasterYi") to a Lolalytics alias (e.g., "masteryi").
	 */
	static toLolalytics(ddId: string): string {
		return ddId.toLowerCase().replace(/['\s.]/g, "");
	}

	/**
	 * Convert a lane from LCU format to Lolalytics format.
	 */
	static toLolalyticsLane(lcuPosition: string): string {
		const map: Record<string, string> = {
			top: "top",
			jungle: "jungle",
			middle: "middle",
			bottom: "bottom",
			utility: "support",
		};
		return map[lcuPosition] ?? "top";
	}
}

// Singleton instance
export const championStats = new ChampionStats();

/** Lolalytics counter API response shape */
interface LolalyticCounterResponse {
	stats?: {
		cid: number;
		lane: string;
		avgWr: number;
		wr: string;
		pr: string;
		counters?: { strong: number[]; weak: number[] };
	};
	counters?: Array<{
		/** Champion key (Data Dragon numeric ID) */
		cid: number;
		/** Win rate of searched champion vs this enemy (higher = enemy wins more) */
		vsWr: number;
		/** Number of games */
		n: number;
		/** Delta 1 (matchup vs average) */
		d1: number;
		/** Delta 2 */
		d2: number;
		/** Overall win rate of this champion */
		allWr: number;
		/** Default lane for this champion */
		defaultLane: string;
	}>;
	response?: { valid: boolean; duration: number };
}

interface TeamProfile {
	avgMagic: number;
	avgAttack: number;
	avgDefense: number;
	tags: string[];
	hasTank: boolean;
	hasEngage: boolean;
	count: number;
}
