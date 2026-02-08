import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";

const logger = streamDeck.logger.createScope("ChampionIcons");

/** In-memory cache: Lolalytics alias → base64 data URI */
const iconCache = new Map<string, string>();

/**
 * Fetch a champion square portrait from Data Dragon, return as base64 data URI.
 * Caches in memory for the session lifetime.
 *
 * @param alias Lolalytics alias (e.g., "aatrox", "masteryi")
 * @returns base64 data URI or null on failure
 */
export async function getChampionIcon(alias: string): Promise<string | null> {
	if (iconCache.has(alias)) return iconCache.get(alias)!;

	try {
		// Resolve Data Dragon champion ID from Lolalytics alias
		const ddId = resolveDataDragonId(alias);
		if (!ddId) {
			logger.warn(`Cannot resolve DDragon ID for alias: ${alias}`);
			return null;
		}

		const url = dataDragon.getChampionImageUrl(ddId);
		logger.debug(`Downloading champion icon: ${url}`);

		const response = await fetch(url);
		if (!response.ok) {
			logger.warn(`Failed to download icon for ${alias}: HTTP ${response.status}`);
			return null;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;

		iconCache.set(alias, dataUri);
		logger.debug(`Cached icon for ${alias} (${buffer.length} bytes)`);
		return dataUri;
	} catch (e) {
		logger.error(`Error fetching champion icon for ${alias}: ${e}`);
		return null;
	}
}

/**
 * Prefetch icons for a list of champion aliases (non-blocking).
 * Useful to warm the cache before rendering.
 */
export function prefetchChampionIcons(aliases: string[]): void {
	for (const alias of aliases) {
		if (!iconCache.has(alias)) {
			getChampionIcon(alias).catch(() => {});
		}
	}
}

/**
 * Resolve a Lolalytics alias (lowercase, no spaces) to a Data Dragon champion ID (PascalCase).
 * e.g., "masteryi" → "MasterYi", "aatrox" → "Aatrox"
 */
function resolveDataDragonId(alias: string): string | null {
	const lowerAlias = alias.toLowerCase().replace(/['\s.]/g, "");

	for (const champ of dataDragon.getAllChampions()) {
		const ddLower = champ.id.toLowerCase().replace(/['\s.]/g, "");
		if (ddLower === lowerAlias) {
			return champ.id;
		}
	}

	return null;
}
