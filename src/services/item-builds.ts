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
		} else if (cached) {
			this.cache.delete(key);
		}

		// ARAM uses a different URL path: /lol/{champ}/aram/build/
		const url =
			lane === "aram"
				? `${LOLALYTICS_BASE}/lol/${championAlias}/aram/build/`
				: `${LOLALYTICS_BASE}/lol/${championAlias}/build/?lane=${lane}`;
		const maxRetries = 2;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					const delay = 1000 * Math.pow(2, attempt - 1);
					logger.debug(`Retry ${attempt}/${maxRetries} for ${championAlias} ${lane} build in ${delay}ms`);
					await new Promise((r) => setTimeout(r, delay));
				}

				logger.debug(`Fetching build: ${url}`);

				const response = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(10_000) });
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
	 * Parse the Lolalytics build page Qwik SSR state for item data.
	 *
	 * Build objects in the Qwik JSON have keys:
	 *   skillpriority, skillorder, sums, runes, items
	 *
	 * The `items` sub-object has the shape:
	 *   { start: { set: number[], ... }, core: { set: number[], ... },
	 *     item4: [{ id, n, wr }], item5: [...], item6: [...] }
	 */
	private parseBuildPage(html: string): ItemBuild | null {
		// First try: structured Qwik JSON (robust)
		const qwikResult = this.parseQwikItems(html);
		if (qwikResult) return qwikResult;

		// Fallback: HTML section marker parsing (legacy)
		logger.warn("Qwik JSON parsing failed, falling back to HTML scraping");
		return this.parseHtmlSections(html);
	}

	/** Expected keys on a per-build Qwik object. */
	private static readonly BUILD_KEYS = new Set(["skillpriority", "skillorder", "sums", "runes", "items"]);

	/**
	 * Extract item build from the Qwik SSR JSON block.
	 */
	private parseQwikItems(html: string): ItemBuild | null {
		const qwikMatch = html.match(/<script\s+type="qwik\/json">([\s\S]*?)<\/script>/);
		if (!qwikMatch) return null;

		let qData: { objs: unknown[] };
		try {
			qData = JSON.parse(qwikMatch[1]) as { objs: unknown[] };
		} catch {
			return null;
		}

		const objs = qData.objs;
		if (!Array.isArray(objs)) return null;

		// Base-36 reference resolver
		const resolve = (ref: unknown): unknown => {
			if (typeof ref !== "string") return ref;
			const idx = parseInt(ref, 36);
			if (!isNaN(idx) && idx >= 0 && idx < objs.length) return objs[idx];
			return ref;
		};

		// Deep-resolve references
		const deep = (ref: unknown, depth = 0): unknown => {
			if (depth > 6) return ref;
			const val = resolve(ref);
			if (Array.isArray(val)) return val.map((v) => deep(v, depth + 1));
			if (typeof val === "object" && val !== null) {
				const result: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
					result[k] = deep(v, depth + 1);
				}
				return result;
			}
			return val;
		};

		// Find build objects by key signature (most_common has highest sample size)
		let bestBuild: Record<string, unknown> | null = null;
		let bestN = -1;

		for (let i = 0; i < objs.length; i++) {
			const obj = objs[i];
			if (typeof obj !== "object" || obj === null) continue;
			const keys = Object.keys(obj);
			if (keys.length < ItemBuilds.BUILD_KEYS.size) continue;
			if (!keys.every((k) => ItemBuilds.BUILD_KEYS.has(k))) continue;

			// Quick-validate the items sub-object has a start or core field
			const itemsRef = resolve((obj as Record<string, unknown>).items);
			if (typeof itemsRef !== "object" || itemsRef === null) continue;
			const iv = itemsRef as Record<string, unknown>;
			if (!("start" in iv || "core" in iv)) continue;

			// Resolve start to read sample size
			const startRef = resolve(iv.start);
			const n = typeof startRef === "object" && startRef !== null
				? (startRef as Record<string, unknown>).n as number ?? 0
				: 0;

			if (n > bestN) {
				bestN = n;
				bestBuild = obj as Record<string, unknown>;
			}
		}

		if (!bestBuild) return null;

		const items = deep(bestBuild.items, 0) as Record<string, unknown>;
		if (!items) return null;

		return this.extractBuildFromQwikItems(items);
	}

	/**
	 * Convert the resolved Qwik items object into an ItemBuild.
	 */
	private extractBuildFromQwikItems(items: Record<string, unknown>): ItemBuild | null {
		const start = items.start as { set?: number[] } | undefined;
		const core = items.core as { set?: number[] } | undefined;

		const startingItems = Array.isArray(start?.set) ? start!.set.filter((id) => typeof id === "number") : [];
		const coreSet = Array.isArray(core?.set) ? core!.set.filter((id) => typeof id === "number") : [];

		if (coreSet.length === 0) return null;

		const fullBuild = [...coreSet];
		const seen = new Set(fullBuild);

		// Pick the best (highest n) item from slots 4, 5, 6
		for (const slot of ["item4", "item5", "item6"]) {
			const candidates = items[slot];
			if (!Array.isArray(candidates)) continue;

			for (const c of candidates) {
				const id = typeof c === "object" && c !== null ? (c as { id?: number }).id : undefined;
				if (typeof id === "number" && !seen.has(id)) {
					fullBuild.push(id);
					seen.add(id);
					break;
				}
			}
		}

		return { startingItems, fullBuild };
	}

	/**
	 * Legacy HTML section marker parser (fallback).
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
	private parseHtmlSections(html: string): ItemBuild | null {
		const startIdx = html.indexOf("Starting Items");
		const coreIdx = html.indexOf("Core Build");
		const item4Idx = html.indexOf("Item 4");
		const item5Idx = html.indexOf("Item 5");
		const item6Idx = html.indexOf("Item 6");

		if (startIdx === -1 || coreIdx === -1) {
			logger.warn("Could not find Starting Items / Core Build sections");
			return null;
		}

		const startingItems = this.extractItemIds(html, startIdx, coreIdx);
		const coreEnd = item4Idx !== -1 ? item4Idx : coreIdx + 3000;
		const coreItems = this.extractItemIds(html, coreIdx, coreEnd);

		const fullBuild = [...coreItems];
		const seen = new Set(fullBuild);

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
					break;
				}
			}
		}

		return { startingItems, fullBuild };
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
