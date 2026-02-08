import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";

const logger = streamDeck.logger.createScope("ChampionStats");

const LOLALYTICS_BASE = "https://lolalytics.com";
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
 * Parses the Lolalytics counters page to extract matchup data.
 * The counters page is server-side rendered (Qwik SSR), so all data is in the initial HTML.
 *
 * Data pattern in HTML:
 *   /lol/{champ}/vs/{enemy}/build/  ... <!--t=XX-->{winRate}<!---->% ... VS ... {games} Games
 */
export class ChampionStats {
	/** Cache: "championAlias:lane" → { data, timestamp } */
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
		// Resolve candidate champion data
		const allChamps = dataDragon["champions"] as Map<string, { info: { magic: number; attack: number; defense: number }; tags: string[] }>;
		let candidateChamp: { info: { magic: number; attack: number; defense: number }; tags: string[] } | null = null;
		for (const [id, c] of allChamps) {
			if (id.toLowerCase() === candidateAlias.toLowerCase()) {
				candidateChamp = c;
				break;
			}
		}
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
	 * Fetch and parse matchup data for a champion on a lane.
	 * Retries up to 2 times on failure with exponential backoff.
	 */
	private async getMatchups(championAlias: string, lane: string): Promise<MatchupData[]> {
		const key = `${championAlias}:${lane}`;
		const cached = this.cache.get(key);

		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
			return cached.data;
		}

		const url = `${LOLALYTICS_BASE}/lol/${championAlias}/counters/?lane=${lane}`;
		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					const delay = 1000 * Math.pow(2, attempt - 1);
					logger.debug(`Retry ${attempt}/${maxRetries} for ${championAlias} ${lane} in ${delay}ms`);
					await new Promise((r) => setTimeout(r, delay));
				}

				logger.debug(`Fetching matchups: ${url}`);

				const response = await fetch(url, { headers: FETCH_HEADERS });
				if (!response.ok) {
					logger.warn(`Lolalytics returned ${response.status} for ${championAlias} ${lane}`);
					continue;
				}

				const html = await response.text();
				const matchups = this.parseCountersPage(html, championAlias);

				if (matchups.length === 0) {
					logger.warn(`Parsed 0 matchups for ${championAlias} ${lane} (attempt ${attempt + 1})`);
					continue;
				}

				logger.info(`Parsed ${matchups.length} matchups for ${championAlias} ${lane}`);
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
	 * Parse the Lolalytics counters HTML page.
	 *
	 * Each card is an <a> tag containing:
	 *   href="/lol/{champ}/vs/{enemy}/build/..."
	 *   ... alt="{EnemyName}" ...
	 *   ... <!--t=XX-->{winRate}<!---->% ... VS ...
	 *   ... {games} Games ...
	 *
	 * WR is ~1000 chars from the href, Games is ~2200 chars from the href.
	 * We use a 4000-char window to capture both reliably.
	 */
	private parseCountersPage(html: string, championAlias: string): MatchupData[] {
		const matchups: MatchupData[] = [];

		const linkRegex = new RegExp(
			`href="/lol/${championAlias}/vs/([^/]+)/build/[^"]*"`,
			"g",
		);

		let linkMatch: RegExpExecArray | null;
		const seen = new Set<string>();

		while ((linkMatch = linkRegex.exec(html)) !== null) {
			const enemyAlias = linkMatch[1];
			if (seen.has(enemyAlias)) continue;

			// 4000-char window: WR is ~1000 chars in, Games is ~2200 chars in
			const afterLink = html.substring(linkMatch.index, linkMatch.index + 4000);

			// Win rate pattern: <!--t=XX-->{number}<!---->% (Qwik SSR)
			// Fallback: plain {number}% for non-Qwik pages
			const wrMatch =
				afterLink.match(/<!--t=\w+-->([\d.]+)<!---->%/) ??
				afterLink.match(/(\d{2,3}\.\d{1,2})%/);
			// Games pattern: {number} Games
			const gamesMatch = afterLink.match(/([\d,]+)\s*Games/);

			if (wrMatch && gamesMatch) {
				const wr = parseFloat(wrMatch[1]);
				const games = parseInt(gamesMatch[1].replace(/,/g, ""), 10);

				if (!isNaN(wr) && games >= 50) {
					const champData = this.resolveChampionName(enemyAlias);

					matchups.push({
						alias: enemyAlias,
						name: champData ?? this.formatAlias(enemyAlias),
						winRateVs: wr,
						games,
					});

					seen.add(enemyAlias);
				}
			}
		}

		return matchups;
	}

	/**
	 * Try to resolve champion display name from DataDragon.
	 */
	private resolveChampionName(alias: string): string | null {
		// DataDragon uses PascalCase IDs like "MasterYi", Lolalytics uses "masteryi"
		// Try to find a match in the loaded champions
		const allChamps = dataDragon["champions"] as Map<string, { name: string }>;
		for (const [id, champ] of allChamps) {
			if (id.toLowerCase() === alias.toLowerCase()) {
				return champ.name;
			}
		}
		return null;
	}

	/**
	 * Format a Lolalytics alias for display (fallback).
	 */
	private formatAlias(alias: string): string {
		return alias.charAt(0).toUpperCase() + alias.slice(1);
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

interface TeamProfile {
	avgMagic: number;
	avgAttack: number;
	avgDefense: number;
	tags: string[];
	hasTank: boolean;
	hasEngage: boolean;
	count: number;
}
