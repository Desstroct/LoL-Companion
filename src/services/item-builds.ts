import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";
import { throttledFetch } from "./lolalytics-throttle";

const logger = streamDeck.logger.createScope("ItemBuilds");

/**
 * Lolalytics JSON API — `build-itemset` endpoint.
 *
 * Returns structured item set data:
 *   itemSet1..5:     arrays of [itemIds, games, wins] without boots
 *   itemBootSet1..6: arrays of [itemIds, games, wins] with boots included
 *
 * Item IDs within an entry are underscore-separated (e.g. "3161_3047_6699").
 * Entries are NOT pre-sorted — we sort by games played (index 1) or win rate.
 */
const LOLALYTICS_API = "https://a1.lolalytics.com";

export interface ItemBuild {
	/** Starting items (e.g., Doran's Blade + Health Potion) */
	startingItems: number[];
	/** Full 6-item build in purchase order (boots + 5 items) */
	fullBuild: number[];
}

/**
 * Fetches and caches recommended item builds from Lolalytics.
 *
 * Scrapes the build page HTML, extracting item IDs from Lolalytics CDN
 * image URLs in the "Starting Items", "Core Build", and "Item 4/5/6" sections.
 */
export class ItemBuilds {
	/** Cache: "championAlias:lane" → { data, timestamp } */
	private cache: Map<string, { data: ItemBuild; timestamp: number }> = new Map();
	private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes

	/**
	 * Get the recommended item build for a champion on a lane.
	 *
	 * @param championAlias Lolalytics alias (e.g., "aatrox", "masteryi")
	 * @param lane Lolalytics lane (e.g., "top", "jungle", "middle", "bottom", "support")
	 */
	async getBuild(championAlias: string, lane: string): Promise<ItemBuild | null> {
		const key = `${championAlias}:${lane}`;
		const cached = this.cache.get(key);

		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
			return cached.data;
		} else if (cached) {
			this.cache.delete(key);
		}

		const ddVersion = dataDragon.getVersion();
		const patchParts = ddVersion.split(".");
		const patch = `${patchParts[0]}.${patchParts[1]}`;

		// ARAM uses queue=450 instead of ranked
		const queueParam = lane === "aram" ? "&queue=450" : "&queue=ranked";
		const apiLane = lane === "aram" ? "default" : lane;
		const url = `${LOLALYTICS_API}/mega/?ep=build-itemset&v=1&patch=${patch}&c=${championAlias}&lane=${apiLane}&tier=emerald_plus${queueParam}&region=all`;

		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					const delay = 1000 * Math.pow(2, attempt - 1);
					logger.debug(`Retry ${attempt}/${maxRetries} for ${championAlias} ${lane} build in ${delay}ms`);
					await new Promise((r) => setTimeout(r, delay));
				}

				logger.debug(`Fetching build (API): ${url}`);

				const response = await throttledFetch(url, { signal: AbortSignal.timeout(10_000) });
				if (!response.ok) {
					logger.warn(`Lolalytics API returned ${response.status} for ${championAlias} ${lane} build`);
					continue;
				}

				const json = (await response.json()) as {
					itemSets?: Record<string, [string, number, number][]>;
					response?: { valid?: boolean };
				};

				if (!json?.itemSets) {
					logger.warn(`Invalid API response for ${championAlias} ${lane} build`);
					continue;
				}

				const build = this.extractBuild(json.itemSets);

				if (!build || build.fullBuild.length === 0) {
					logger.warn(`Parsed no build data for ${championAlias} ${lane} (attempt ${attempt + 1})`);
					continue;
				}

				logger.info(
					`Parsed build for ${championAlias} ${lane}: ` +
						`start=[${build.startingItems.join(",")}] ` +
						`build=[${build.fullBuild.join(",")}]`,
				);

				this.cache.set(key, { data: build, timestamp: Date.now() });
				return build;
			} catch (e) {
				logger.error(`Failed to fetch build for ${championAlias} ${lane} (attempt ${attempt + 1}): ${e}`);
			}
		}

		logger.error(`All ${maxRetries + 1} attempts failed for ${championAlias} ${lane} build`);
		return cached?.data ?? null;
	}

	// ─────────── Build extraction ───────────

	/**
	 * Extract the best full build from the `build-itemset` API data.
	 *
	 * Strategy:
	 * 1. Full build (6 items with boots): pick from `itemBootSet6` by most played
	 *    → fallback to building slot-by-slot from `itemSet1..5` + boots
	 * 2. Starting items: inferred (API doesn't provide them explicitly)
	 */
	private extractBuild(sets: Record<string, [string, number, number][]>): ItemBuild | null {
		// ── Full build (6 items with boots) ──
		let fullBuild = this.getBestSet(sets.itemBootSet6, 6);

		// Fallback: build slot-by-slot
		if (fullBuild.length < 4) {
			fullBuild = this.buildSlotBySlot(sets);
		}

		if (fullBuild.length === 0) return null;

		// ── Starting items: infer from startSet or first item in build ──
		const startingItems = this.extractStartingItems(sets, fullBuild);

		return { startingItems, fullBuild };
	}

	/**
	 * Extract starting items from API data.
	 * Uses startSet if available, otherwise infers from the first build item.
	 */
	private extractStartingItems(
		sets: Record<string, [string, number, number][]>,
		fullBuild: number[],
	): number[] {
		// Try startSet from API (if Lolalytics provides it)
		if (sets.startSet) {
			const best = this.getBestSet(sets.startSet, 1);
			if (best.length > 0) return best;
		}

		// Infer from first item in build: pick a matching Doran's / support / jungle start
		const firstItem = fullBuild[0];
		if (firstItem) {
			const cost = dataDragon.getItemCost(firstItem);
			// If first item is cheap enough to be a starting item itself
			if (cost > 0 && cost <= 500) return [firstItem, 2003]; // item + HP pot

			// Infer by item tags / common starter associations
			const name = dataDragon.getItemName(firstItem)?.toLowerCase() ?? "";
			// Jungle items
			if (this.isJungleItem(firstItem)) return [1103, 2003]; // Jungle pet + HP pot
			// AP-oriented builds
			if (name.includes("rod") || name.includes("luden") || name.includes("liandry") ||
				name.includes("everfrost") || name.includes("malignance") || name.includes("stormsurge")) {
				return [1056, 2003]; // Doran's Ring + HP pot
			}
			// Tank / bruiser
			if (name.includes("sunfire") || name.includes("heartsteel") || name.includes("hollow") ||
				name.includes("iceborn") || name.includes("jak'sho") || name.includes("unending")) {
				return [1054, 2003]; // Doran's Shield + HP pot
			}
			// Support
			if (name.includes("shurelya") || name.includes("moonstone") || name.includes("redemption") ||
				name.includes("echoes") || name.includes("dream maker") || name.includes("celestial")) {
				return [3850, 2003]; // Spellthief's + HP pot
			}
		}

		// Default: Doran's Blade + HP pot (most common for AD)
		return [1055, 2003];
	}

	/** Check if an item is a jungle starter/pet. */
	private isJungleItem(itemId: number): boolean {
		// Jungle items: Gustwalker/Scorchclaw/Mosstomper pets and their upgrades
		return (itemId >= 1101 && itemId <= 1104) || (itemId >= 1035 && itemId <= 1041);
	}

	/**
	 * Pick the most-played entry from a set and return its item IDs.
	 */
	private getBestSet(entries: [string, number, number][] | undefined, expectedLen: number): number[] {
		if (!entries || entries.length === 0) return [];

		const sorted = [...entries]
			.map(([ids, games]) => ({ ids, games }))
			.filter((e) => e.games >= 5)
			.sort((a, b) => b.games - a.games);

		for (const entry of sorted) {
			const items = entry.ids.split("_").map(Number).filter((n) => !isNaN(n) && n > 0);
			if (items.length >= expectedLen) return items;
		}

		if (sorted.length > 0) {
			return sorted[0].ids.split("_").map(Number).filter((n) => !isNaN(n) && n > 0);
		}

		return [];
	}

	/**
	 * Build a full item set slot-by-slot from itemSet1..5 + boots.
	 */
	private buildSlotBySlot(sets: Record<string, [string, number, number][]>): number[] {
		const result: number[] = [];
		const seen = new Set<number>();

		for (let slot = 1; slot <= 5; slot++) {
			const entries = sets[`itemSet${slot}`];
			if (!entries) continue;

			const sorted = [...entries]
				.map(([ids, games]) => ({ ids: ids.split("_").map(Number), games }))
				.filter((e) => e.games >= 3)
				.sort((a, b) => b.games - a.games);

			for (const entry of sorted) {
				const lastItem = entry.ids[entry.ids.length - 1];
				if (lastItem && !seen.has(lastItem)) {
					result.push(lastItem);
					seen.add(lastItem);
					break;
				}
			}
		}

		// Add boots from itemBootSet1
		const bootEntries = sets.itemBootSet1;
		if (bootEntries) {
			const boots = [...bootEntries]
				.map(([ids, games]) => ({ id: Number(ids), games }))
				.filter((e) => !isNaN(e.id) && e.games >= 5 && this.isBootsItem(e.id))
				.sort((a, b) => b.games - a.games);

			if (boots.length > 0 && !seen.has(boots[0].id)) {
				result.splice(1, 0, boots[0].id); // Insert as 2nd item
			}
		}

		return result;
	}

	/** Check if an item ID is a boots item. */
	private isBootsItem(itemId: number): boolean {
		return (
			(itemId >= 3006 && itemId <= 3020) ||
			itemId === 3047 || itemId === 3111 ||
			itemId === 3117 || itemId === 3158 || itemId === 3009
		);
	}

	/**
	 * Convert a Game Client position (e.g., "TOP") to Lolalytics lane string.
	 */
	static toLolalyticsLane(gamePosition: string): string {
		const map: Record<string, string> = {
			TOP: "top",
			JUNGLE: "jungle",
			MIDDLE: "middle",
			BOTTOM: "bottom",
			UTILITY: "support",
		};
		return map[gamePosition] ?? "top";
	}

	/**
	 * Convert a Game Client champion name (e.g., "Master Yi") to Lolalytics alias.
	 */
	static toAlias(championName: string): string {
		if (!championName) return "unknown";
		// Try DDragon lookup first (display name → DDragon ID → lowercase)
		for (const champ of dataDragon.getAllChampions()) {
			if (champ.name.toLowerCase() === championName.toLowerCase()) {
				return champ.id.toLowerCase().replace(/['\s.]/g, "");
			}
		}
		// Fallback: strip special chars and lowercase
		return championName.toLowerCase().replace(/['\s.]/g, "");
	}

	/**
	 * Clear the cache (useful when starting a new game).
	 */
	clearCache(): void {
		this.cache.clear();
	}
}

// Singleton instance
export const itemBuilds = new ItemBuilds();
