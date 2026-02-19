import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";
import { throttledFetch } from "./lolalytics-throttle";
import { lolaBuild } from "./lolalytics-build";
import { ChampionStats } from "./champion-stats";

const logger = streamDeck.logger.createScope("RuneData");

/**
 * Lolalytics JSON API — `rune` endpoint.
 *
 * Returns structured rune data at:
 *   summary.runes.pick  → most common rune page (wr, n, page{pri,sec}, set{pri[4],sec[2],mod[3]})
 *   summary.runes.win   → highest win-rate rune page (same shape)
 *
 * Tree index → Riot style ID mapping:
 *   0=Precision(8000), 1=Domination(8100), 2=Sorcery(8200), 3=Resolve(8400), 4=Inspiration(8300)
 */
const LOLALYTICS_API = "https://a1.lolalytics.com";

/**
 * Lolalytics tree index → Riot tree style ID.
 * Order: Precision, Domination, Sorcery, Resolve, Inspiration.
 */
const TREE_STYLE_IDS = [8000, 8100, 8200, 8400, 8300];

/** Keystone/rune readable names for display. */
const KEYSTONE_NAMES: Record<number, string> = {
	// Precision
	8005: "Press the Attack",
	8008: "Lethal Tempo",
	8010: "Conqueror",
	8021: "Fleet Footwork",
	// Domination
	8112: "Electrocute",
	8124: "Predator",
	8128: "Dark Harvest",
	9923: "Hail of Blades",
	// Sorcery
	8214: "Summon Aery",
	8229: "Arcane Comet",
	8230: "Phase Rush",
	// Resolve
	8437: "Grasp of the Undying",
	8439: "Aftershock",
	8465: "Guardian",
	// Inspiration
	8351: "Glacial Augment",
	8360: "Unsealed Spellbook",
	8369: "First Strike",
};

export interface RunePageData {
	/** Riot style ID for primary tree (e.g. 8000 for Precision) */
	primaryStyleId: number;
	/** Riot style ID for secondary tree */
	subStyleId: number;
	/** 9 perk IDs: [4 primary, 2 secondary, 3 stat mods] */
	selectedPerkIds: number[];
	/** Win rate % */
	winRate: number;
	/** Number of games in sample */
	games: number;
	/** Data source label */
	source: "highest_wr" | "most_common";
	/** Human-readable keystone name */
	keystoneName: string;
}

/**
 * Fetches recommended rune pages from Lolalytics.
 *
 * Primary strategy: parse the build page SSR (Qwik) data.
 * Fallback: try the JSON API endpoint (may be deprecated).
 */
export class RuneData {
	private cache: Map<string, { data: RunePageData[]; timestamp: number }> = new Map();
	private readonly CACHE_TTL = 30 * 60 * 1000; // 30 min

	/**
	 * Get recommended rune pages for a champion + lane.
	 * Returns up to 2 pages: most common and highest win rate.
	 * @param vsChampionAlias  Lolalytics alias of the enemy champion for matchup-specific runes.
	 */
	async getRecommendedRunes(championAlias: string, lane: string, vsChampionAlias?: string): Promise<RunePageData[]> {
		const key = vsChampionAlias
			? `${championAlias}:${lane}:vs:${vsChampionAlias}`
			: `${championAlias}:${lane}`;
		const cached = this.cache.get(key);

		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
			return cached.data;
		} else if (cached) {
			this.cache.delete(key);
		}

		// Primary: SSR build page parser (reliable)
		try {
			const buildData = await lolaBuild.getBuildData(championAlias, lane, vsChampionAlias);
			if (buildData && buildData.runes.length > 0) {
				logger.info(
					`Parsed ${buildData.runes.length} rune page(s) via SSR for ${championAlias} ${lane}: ` +
						buildData.runes.map((d) => `${d.source} ${d.keystoneName} ${d.winRate}%`).join(", "),
				);
				this.cache.set(key, { data: buildData.runes, timestamp: Date.now() });
				return buildData.runes;
			}
		} catch (e) {
			logger.warn(`SSR rune fetch failed for ${championAlias} ${lane}: ${e}`);
		}

		// Fallback: JSON API (may be deprecated)
		return this.fetchFromApi(championAlias, lane, cached?.data ?? []);
	}

	/**
	 * Legacy JSON API fetch (fallback if SSR parsing fails).
	 */
	private async fetchFromApi(championAlias: string, lane: string, fallback: RunePageData[]): Promise<RunePageData[]> {
		const ddVersion = dataDragon.getVersion();
		const patchParts = ddVersion.split(".");
		const patch = `${patchParts[0]}.${patchParts[1]}`;

		const queueParam = lane === "aram" ? "&queue=450" : "&queue=ranked";
		const apiLane = lane === "aram" ? "default" : lane;
		const url = `${LOLALYTICS_API}/mega/?ep=rune&v=1&patch=${patch}&c=${championAlias}&lane=${apiLane}&tier=emerald_plus${queueParam}&region=all`;

		try {
			logger.debug(`Fetching runes (API fallback): ${url}`);

			const response = await throttledFetch(url, { signal: AbortSignal.timeout(10_000) });
			if (!response.ok) {
				logger.warn(`Lolalytics API returned ${response.status} for rune data`);
				return fallback;
			}

			const json = (await response.json()) as RuneApiResponse;

			if (!json?.summary?.runes) {
				logger.warn(`Invalid rune API response for ${championAlias} ${lane}`);
				return fallback;
			}

			const data = this.parseApiRunes(json.summary.runes);

			if (data.length > 0) {
				logger.info(
					`Parsed ${data.length} rune page(s) via API for ${championAlias} ${lane}: ` +
						data.map((d) => `${d.source} ${d.keystoneName} ${d.winRate}%`).join(", "),
				);
				return data;
			}

			logger.warn(`No rune data found via API for ${championAlias} ${lane}`);
			return fallback;
		} catch (e) {
			logger.error(`API rune fetch failed for ${championAlias} ${lane}: ${e}`);
			return fallback;
		}
	}

	// ─────────── API response parsing ───────────

	/**
	 * Parse rune pages from the `rune` API response.
	 */
	private parseApiRunes(runes: { pick?: RuneApiEntry; win?: RuneApiEntry }): RunePageData[] {
		const results: RunePageData[] = [];

		if (runes.pick) {
			const page = this.convertApiEntry(runes.pick, "most_common");
			if (page) results.push(page);
		}

		if (runes.win) {
			const page = this.convertApiEntry(runes.win, "highest_wr");
			if (page) results.push(page);
		}

		return results;
	}

	/**
	 * Convert a single API rune entry into our RunePageData format.
	 */
	private convertApiEntry(entry: RuneApiEntry, source: "most_common" | "highest_wr"): RunePageData | null {
		const { set, page, wr, n } = entry;

		if (
			!set?.pri || !set?.sec || !set?.mod || !page ||
			set.pri.length !== 4 || set.sec.length !== 2 || set.mod.length !== 3
		) {
			return null;
		}

		const primaryStyleId = TREE_STYLE_IDS[page.pri] ?? this.treeFromKeystoneId(set.pri[0]);
		const subStyleId = TREE_STYLE_IDS[page.sec] ?? this.treeFromRuneId(set.sec[0]);

		if (!primaryStyleId || !subStyleId) return null;

		const selectedPerkIds = [...set.pri, ...set.sec, ...set.mod];
		const keystoneName = KEYSTONE_NAMES[set.pri[0]] ?? `Keystone ${set.pri[0]}`;

		return {
			primaryStyleId,
			subStyleId,
			selectedPerkIds,
			winRate: wr ?? 0,
			games: n ?? 0,
			source,
			keystoneName,
		};
	}

	// ─────────── Tree ID helpers ───────────

	/**
	 * Derive tree style ID from a keystone ID.
	 * Keystones: 80xx=Precision, 81xx=Domination, 82xx=Sorcery, 83xx=Inspiration, 84xx=Resolve.
	 */
	private treeFromKeystoneId(id: number): number {
		if (id >= 8000 && id < 8500) return Math.floor(id / 100) * 100;
		if (id === 9923) return 8100; // Hail of Blades
		return 8000;
	}

	/**
	 * Derive tree style ID from a secondary rune ID.
	 */
	private treeFromRuneId(id: number): number {
		if (id >= 8400 && id < 8500) return 8400; // Resolve
		if (id >= 8300 && id < 8400) return 8300; // Inspiration
		if (id >= 8200 && id < 8300) return 8200; // Sorcery
		if (id >= 8100 && id < 8200) return 8100; // Domination
		if (id >= 8000 && id < 8100) return 8000; // Precision
		if (id >= 9100 && id < 9200) return 8000;
		return 8000;
	}
}

// ─────────── API response types ───────────

interface RuneApiEntry {
	wr: number;
	n: number;
	page: { pri: number; sec: number };
	set: { pri: number[]; sec: number[]; mod: number[] };
}

interface RuneApiResponse {
	summary?: {
		runes?: {
			pick?: RuneApiEntry;
			win?: RuneApiEntry;
		};
	};
	response?: { valid?: boolean };
}

/** Singleton instance */
export const runeData = new RuneData();
