import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";

const logger = streamDeck.logger.createScope("ItemBuilds");

const LOLALYTICS_BASE = "https://lolalytics.com";
const FETCH_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

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
		}

		const url = `${LOLALYTICS_BASE}/lol/${championAlias}/build/?lane=${lane}`;
		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					const delay = 1000 * Math.pow(2, attempt - 1);
					logger.debug(`Retry ${attempt}/${maxRetries} for ${championAlias} ${lane} build in ${delay}ms`);
					await new Promise((r) => setTimeout(r, delay));
				}

				logger.debug(`Fetching build: ${url}`);

				const response = await fetch(url, { headers: FETCH_HEADERS });
				if (!response.ok) {
					logger.warn(`Lolalytics returned ${response.status} for ${championAlias} ${lane} build`);
					continue;
				}

				const html = await response.text();
				const build = this.parseBuildPage(html);

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

	/**
	 * Parse the Lolalytics build page HTML.
	 *
	 * Sections appear in order:
	 *   1. "Starting Items" – 2-3 starting items
	 *   2. "Core Build"     – 3 core items (boots + 2)
	 *   3. "Item 4"         – item 4 + alternatives
	 *   4. "Item 5"         – item 5 + alternatives
	 *   5. "Item 6"         – item 6 + alternatives
	 *
	 * Item images use: cdn5.lolalytics.com/item64/{id}.webp
	 */
	private parseBuildPage(html: string): ItemBuild | null {
		// Locate section markers
		const startIdx = html.indexOf("Starting Items");
		const coreIdx = html.indexOf("Core Build");
		const item4Idx = html.indexOf("Item 4");
		const item5Idx = html.indexOf("Item 5");
		const item6Idx = html.indexOf("Item 6");

		if (startIdx === -1 || coreIdx === -1) {
			logger.warn("Could not find Starting Items / Core Build sections");
			return null;
		}

		// Extract starting items (between "Starting Items" and "Core Build")
		const startingItems = this.extractItemIds(html, startIdx, coreIdx);

		// Extract core build items
		// End boundary: "Item 4" if present, otherwise use a 3000-char window
		const coreEnd = item4Idx !== -1 ? item4Idx : coreIdx + 3000;
		const coreItems = this.extractItemIds(html, coreIdx, coreEnd);

		// Build the full build starting with core items
		const fullBuild = [...coreItems];
		const seen = new Set(fullBuild);

		// Extract items 4, 5, 6 — take first item not already in the build
		const laterSections = [
			{ start: item4Idx, end: item5Idx },
			{ start: item5Idx, end: item6Idx },
			{ start: item6Idx, end: item6Idx !== -1 ? item6Idx + 3000 : -1 },
		];

		for (const section of laterSections) {
			if (section.start === -1) continue;
			const end = section.end !== -1 && section.end > section.start
				? section.end
				: section.start + 3000;

			const candidates = this.extractItemIds(html, section.start, end);
			for (const id of candidates) {
				if (!seen.has(id)) {
					fullBuild.push(id);
					seen.add(id);
					break; // Take only the first unique item per slot
				}
			}
		}

		return {
			startingItems,
			fullBuild,
		};
	}

	/**
	 * Extract item IDs from a slice of HTML using Lolalytics CDN image URL pattern.
	 */
	private extractItemIds(html: string, start: number, end: number): number[] {
		const slice = html.substring(start, end);
		const regex = /item64\/(\d+)\.webp/g;
		const ids: number[] = [];
		const seen = new Set<number>();

		let match: RegExpExecArray | null;
		while ((match = regex.exec(slice)) !== null) {
			const id = parseInt(match[1], 10);
			if (!isNaN(id) && !seen.has(id)) {
				ids.push(id);
				seen.add(id);
			}
		}

		return ids;
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
