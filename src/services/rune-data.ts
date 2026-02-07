import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("RuneData");

const LOLALYTICS_BASE = "https://lolalytics.com";
const FETCH_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

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
 * Fetches recommended rune pages from Lolalytics build pages.
 * Parses the Qwik SSR-serialized state to extract rune configurations.
 */
export class RuneData {
	private cache: Map<string, { data: RunePageData[]; timestamp: number }> = new Map();
	private readonly CACHE_TTL = 30 * 60 * 1000; // 30 min

	/**
	 * Get recommended rune pages for a champion + lane.
	 * Returns up to 2 pages: highest win rate and most common.
	 */
	async getRecommendedRunes(championAlias: string, lane: string): Promise<RunePageData[]> {
		const key = `${championAlias}:${lane}`;
		const cached = this.cache.get(key);

		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
			return cached.data;
		}

		try {
			const url = `${LOLALYTICS_BASE}/lol/${championAlias}/build/?lane=${lane}`;
			logger.debug(`Fetching runes: ${url}`);

			const response = await fetch(url, { headers: FETCH_HEADERS });
			if (!response.ok) {
				logger.warn(`Lolalytics returned ${response.status} for rune data`);
				return cached?.data ?? [];
			}

			const html = await response.text();
			const data = this.parseQwikRunes(html);

			if (data.length > 0) {
				logger.info(
					`Parsed ${data.length} rune page(s) for ${championAlias} ${lane}: ` +
						data.map((d) => `${d.source} ${d.keystoneName} ${d.winRate}%`).join(", "),
				);
				this.cache.set(key, { data, timestamp: Date.now() });
			} else {
				logger.warn(`No rune data found for ${championAlias} ${lane}`);
			}

			return data;
		} catch (e) {
			logger.error(`Failed to fetch runes for ${championAlias} ${lane}: ${e}`);
			return cached?.data ?? [];
		}
	}

	/**
	 * Parse the Qwik SSR state embedded in the Lolalytics build page HTML.
	 */
	private parseQwikRunes(html: string): RunePageData[] {
		// Extract the Qwik serialized JSON block
		const qwikMatch = html.match(/<script\s+type="qwik\/json">([\s\S]*?)<\/script>/);
		if (!qwikMatch) {
			logger.warn("No Qwik JSON state found in HTML");
			return [];
		}

		let qData: { objs: unknown[] };
		try {
			qData = JSON.parse(qwikMatch[1]) as { objs: unknown[] };
		} catch {
			logger.warn("Failed to parse Qwik JSON");
			return [];
		}

		const objs = qData.objs;
		if (!Array.isArray(objs)) return [];

		// Base-36 reference resolver
		const r = (ref: unknown): unknown => {
			if (typeof ref !== "string") return ref;
			const idx = parseInt(ref, 36);
			if (!isNaN(idx) && idx >= 0 && idx < objs.length) return objs[idx];
			return ref;
		};

		// Deep-resolve references up to a given depth
		const deepResolve = (ref: unknown, depth = 0): unknown => {
			if (depth > 6) return ref;
			const val = r(ref);
			if (typeof val === "object" && val !== null && !Array.isArray(val)) {
				const result: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
					result[k] = deepResolve(v, depth + 1);
				}
				return result;
			}
			if (Array.isArray(val)) {
				return val.map((v) => deepResolve(v, depth + 1));
			}
			return val;
		};

		// Discover build objects containing rune data
		const buildIndices = this.findRuneObjects(objs, r);
		const results: RunePageData[] = [];

		for (const { index, label } of buildIndices) {
			try {
				const obj = objs[index] as Record<string, unknown>;
				const runesResolved = deepResolve(obj.runes, 0) as Record<string, unknown> | null;

				if (!runesResolved?.set || !runesResolved?.page) continue;

				const set = runesResolved.set as { pri: number[]; sec: number[]; mod: number[] };
				const page = runesResolved.page as { pri: number; sec: number };
				const wr = typeof runesResolved.wr === "number" ? runesResolved.wr : 0;
				const n = typeof runesResolved.n === "number" ? runesResolved.n : 0;

				// Validate arrays
				if (
					!Array.isArray(set.pri) ||
					!Array.isArray(set.sec) ||
					!Array.isArray(set.mod) ||
					set.pri.length !== 4 ||
					set.sec.length !== 2 ||
					set.mod.length !== 3
				) {
					continue;
				}

				// Map tree indices to Riot style IDs
				const primaryStyleId = TREE_STYLE_IDS[page.pri] ?? this.treeFromKeystoneId(set.pri[0]);
				const subStyleId = TREE_STYLE_IDS[page.sec] ?? this.treeFromRuneId(set.sec[0]);

				if (!primaryStyleId || !subStyleId) continue;

				const selectedPerkIds = [...set.pri, ...set.sec, ...set.mod];
				const keystoneName = KEYSTONE_NAMES[set.pri[0]] ?? `Keystone ${set.pri[0]}`;

				results.push({
					primaryStyleId,
					subStyleId,
					selectedPerkIds,
					winRate: wr,
					games: n,
					source: label,
					keystoneName,
				});
			} catch (e) {
				logger.debug(`Skipped rune object at ${index}: ${e}`);
			}
		}

		return results;
	}

	/**
	 * Search for build objects in the Qwik state that have a `runes` field
	 * with the expected sub-structure (set, page).
	 */
	private findRuneObjects(
		objs: unknown[],
		r: (ref: unknown) => unknown,
	): { index: number; label: "highest_wr" | "most_common" }[] {
		const candidates: { index: number; label: "highest_wr" | "most_common" }[] = [];

		// Try known hardcoded indices first (faster)
		for (const idx of [1802, 1858]) {
			if (this.isRuneObject(objs, idx, r)) {
				candidates.push({
					index: idx,
					label: candidates.length === 0 ? "highest_wr" : "most_common",
				});
			}
		}

		// Fallback: scan for rune objects if hardcoded indices don't match
		if (candidates.length === 0) {
			logger.debug("Hardcoded indices missed, scanning for rune objects...");
			for (let i = 0; i < objs.length && candidates.length < 2; i++) {
				if (this.isRuneObject(objs, i, r)) {
					candidates.push({
						index: i,
						label: candidates.length === 0 ? "highest_wr" : "most_common",
					});
				}
			}
		}

		return candidates;
	}

	/**
	 * Check whether objs[index] is a build object containing valid rune data.
	 */
	private isRuneObject(objs: unknown[], index: number, r: (ref: unknown) => unknown): boolean {
		if (index >= objs.length) return false;
		const obj = objs[index];
		if (typeof obj !== "object" || obj === null || !("runes" in obj)) return false;

		// Resolve one level to check structure
		const runesVal = r((obj as Record<string, unknown>).runes);
		if (typeof runesVal !== "object" || runesVal === null) return false;

		const rv = runesVal as Record<string, unknown>;
		return "set" in rv && "page" in rv && "wr" in rv;
	}

	/**
	 * Derive tree style ID from a keystone ID.
	 * Keystones: 80xx=Precision, 81xx=Domination, 82xx=Sorcery, 83xx=Inspiration, 84xx=Resolve.
	 */
	private treeFromKeystoneId(id: number): number {
		if (id >= 8000 && id < 8500) return Math.floor(id / 100) * 100;
		// Hail of Blades special case
		if (id === 9923) return 8100;
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
		// 9xxx runes are Precision
		if (id >= 9100 && id < 9200) return 8000;
		return 8000;
	}
}

/** Singleton instance */
export const runeData = new RuneData();
