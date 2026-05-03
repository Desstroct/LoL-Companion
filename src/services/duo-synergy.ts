import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";
import { throttledFetch } from "./lolalytics-throttle";
import { DiskCache } from "./disk-cache";

const logger = streamDeck.logger.createScope("DuoSynergy");

const LOLALYTICS_API = "https://a1.lolalytics.com";

// ── Role pairing logic ──
// Given your lane, this is the lane whose synergy matters most:
const DUO_LANE_MAP: Record<string, string> = {
	bottom: "support",
	support: "bottom",
	top: "jungle",
	jungle: "top", // primary — also merges "middle" in parseResult
	middle: "jungle",
};

// Jungle pairs with both top and mid — we merge both for better recommendations
const JUNGLE_SECONDARY_LANE = "middle";

export interface DuoEntry {
	/** DDragon champion ID (e.g. "Lulu", "Thresh") */
	championId: string;
	/** Display name (e.g. "Lulu") */
	championName: string;
	/** Numeric champion key (e.g. "117") */
	championKey: string;
	/** Combined duo win rate (%) */
	winRate: number;
	/** Win rate delta vs average (positive = above avg) */
	delta: number;
	/** Synergy-specific delta */
	synergy: number;
	/** Games played together */
	games: number;
}

export interface DuoSynergyResult {
	/** Your champion alias */
	champion: string;
	/** Your lane */
	lane: string;
	/** The duo lane we're showing synergy for */
	duoLane: string;
	/** Sorted list of best duo partners (highest synergy first) */
	entries: DuoEntry[];
}

/**
 * Fetches champion duo synergy data from Lolalytics `build-team` endpoint.
 *
 * For a given champion + lane, returns the best ally champions for the
 * paired lane (ADC↔Support, Top↔Jungle, Mid↔Jungle).
 */
export class DuoSynergyService {
	private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes
	private cache = new DiskCache<DuoSynergyResult>("duo-synergy.json", this.CACHE_TTL);

	/**
	 * Get the best duo synergy picks for a champion on a given lane.
	 *
	 * @param championAlias Lolalytics alias (e.g. "jinx", "lulu")
	 * @param lane Lolalytics lane (e.g. "bottom", "support", "top", "jungle", "middle")
	 * @returns Sorted list of best duo partners, or null on failure
	 */
	async getSynergy(championAlias: string, lane: string): Promise<DuoSynergyResult | null> {
		const key = `${championAlias}:${lane}`;
		const cached = await this.cache.get(key);
		if (cached) return cached.data;

		const ddVersion = dataDragon.getVersion();
		const patchParts = ddVersion.split(".");
		const patch = `${patchParts[0]}.${patchParts[1]}`;

		const url = `${LOLALYTICS_API}/mega/?ep=build-team&v=1&patch=${patch}&c=${championAlias}&lane=${lane}&tier=emerald_plus&queue=ranked&region=all`;

		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					const delay = 1000 * Math.pow(2, attempt - 1);
					await new Promise((r) => setTimeout(r, delay));
				}

				const response = await throttledFetch(url, { signal: AbortSignal.timeout(10_000) });
				if (!response.ok) {
					logger.warn(`Lolalytics API returned ${response.status} for ${championAlias} ${lane} duo`);
					continue;
				}

				const json = (await response.json()) as {
					team_h?: string[];
					team?: Record<string, number[][]>;
					response?: { valid?: boolean };
				};

				if (!json?.team) {
					logger.warn(`Invalid API response for ${championAlias} ${lane} duo synergy`);
					continue;
				}

				const result = this.parseResult(json.team, championAlias, lane);
				if (!result || result.entries.length === 0) {
					logger.warn(`No duo synergy data for ${championAlias} ${lane}`);
					continue;
				}

				logger.info(
					`Duo synergy for ${championAlias} ${lane}: ` +
						`${result.entries.length} partners in ${result.duoLane}, ` +
						`top: ${result.entries[0].championName} (${result.entries[0].winRate}% WR, +${result.entries[0].synergy.toFixed(1)} syn)`,
				);

				await this.cache.set(key, result);
				return result;
			} catch (e) {
				logger.error(`Duo synergy fetch error for ${championAlias} ${lane} (attempt ${attempt + 1}): ${e}`);
			}
		}

		logger.error(`All ${maxRetries + 1} attempts failed for ${championAlias} ${lane} duo synergy`);
		const fallback = await this.cache.getRaw(key);
		return fallback?.data ?? null;
	}

	/**
	 * Parse the build-team response into a sorted DuoSynergyResult.
	 * Data format per entry: [champKey, winRate, delta1, synergy, pairRate, games]
	 *
	 * For jungle, merges both top and mid lane data (picking each champion's
	 * best synergy from either lane) since junglers pair with both solo laners.
	 */
	private parseResult(
		teamData: Record<string, number[][]>,
		championAlias: string,
		lane: string,
	): DuoSynergyResult | null {
		// Determine the best duo lane
		const duoLane = DUO_LANE_MAP[lane] ?? "support";
		const laneData = teamData[duoLane];

		// For jungle: merge top + mid synergy data
		if (lane === "jungle") {
			const topEntries = teamData["top"] ?? [];
			const midEntries = teamData[JUNGLE_SECONDARY_LANE] ?? [];

			if (topEntries.length > 0 || midEntries.length > 0) {
				return this.mergeMultiLaneEntries(topEntries, midEntries, championAlias, lane);
			}
		}

		if (!laneData || laneData.length === 0) {
			// Try all lanes and pick the one with most data
			let bestLane = duoLane;
			let bestCount = 0;
			for (const [l, entries] of Object.entries(teamData)) {
				if (entries.length > bestCount) {
					bestCount = entries.length;
					bestLane = l;
				}
			}
			if (bestCount === 0) return null;
			return this.parseLaneEntries(teamData[bestLane], championAlias, lane, bestLane);
		}

		return this.parseLaneEntries(laneData, championAlias, lane, duoLane);
	}

	/**
	 * Merge synergy data from two lanes (top + mid) for jungle.
	 * For each champion appearing in both, pick the higher synergy value.
	 */
	private mergeMultiLaneEntries(
		primaryEntries: number[][],
		secondaryEntries: number[][],
		championAlias: string,
		lane: string,
	): DuoSynergyResult | null {
		const MIN_GAMES = 50;
		const merged = new Map<string, DuoEntry>();

		// Process primary lane entries
		for (const entry of primaryEntries) {
			const [champKey, winRate, delta, synergy, _pairRate, games] = entry;
			if (!champKey || games < MIN_GAMES) continue;
			const champ = dataDragon.getChampionByKey(String(champKey));
			if (!champ) continue;
			merged.set(String(champKey), {
				championId: champ.id,
				championName: champ.name,
				championKey: String(champKey),
				winRate, delta, synergy, games,
			});
		}

		// Process secondary lane entries — keep the higher synergy per champion
		for (const entry of secondaryEntries) {
			const [champKey, winRate, delta, synergy, _pairRate, games] = entry;
			if (!champKey || games < MIN_GAMES) continue;
			const champ = dataDragon.getChampionByKey(String(champKey));
			if (!champ) continue;
			const existing = merged.get(String(champKey));
			if (!existing || synergy > existing.synergy) {
				merged.set(String(champKey), {
					championId: champ.id,
					championName: champ.name,
					championKey: String(champKey),
					winRate, delta, synergy, games,
				});
			}
		}

		const parsed = [...merged.values()];
		if (parsed.length === 0) return null;

		parsed.sort((a, b) => b.synergy - a.synergy);

		return {
			champion: championAlias,
			lane,
			duoLane: "top+mid",
			entries: parsed,
		};
	}

	private parseLaneEntries(
		entries: number[][],
		championAlias: string,
		lane: string,
		duoLane: string,
	): DuoSynergyResult | null {
		const MIN_GAMES = 50;

		const parsed: DuoEntry[] = [];
		for (const entry of entries) {
			const [champKey, winRate, delta, synergy, _pairRate, games] = entry;
			if (!champKey || games < MIN_GAMES) continue;

			const champ = dataDragon.getChampionByKey(String(champKey));
			if (!champ) continue;

			parsed.push({
				championId: champ.id,
				championName: champ.name,
				championKey: String(champKey),
				winRate,
				delta,
				synergy,
				games,
			});
		}

		if (parsed.length === 0) return null;

		// Sort by synergy delta descending (strongest synergy first)
		parsed.sort((a, b) => b.synergy - a.synergy);

		return {
			champion: championAlias,
			lane,
			duoLane,
			entries: parsed,
		};
	}

	/** Clear cache. */
	clearCache(): void {
		this.cache.clear().catch(() => {});
	}

	/** Flush cache to disk. */
	async flushCache(): Promise<void> {
		await this.cache.flush();
	}
}

// Singleton
export const duoSynergy = new DuoSynergyService();
