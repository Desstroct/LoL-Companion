import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("TftComps");

// ─────────── Types ───────────

export interface TftComp {
	/** Tier: S, A, B */
	tier: string;
	/** Comp name, e.g. "Eternal Noxus" */
	name: string;
	/** Playstyle, e.g. "Fast 8", "Slow Roll (6)", "Standard" */
	playstyle: string;
	/** Trend: "up" | "down" | "stable" | "new" */
	trend: string;
	/** Champions in the comp */
	champions: TftCompChampion[];
}

export interface TftCompChampion {
	name: string;
	/** Item names for this champion (empty if none) */
	items: string[];
	/** Whether this is a 3-star reroll target */
	threeStarred: boolean;
}

// ─────────── Scraper ───────────

const COMPS_URL = "https://tftactics.gg/tierlist/team-comps";
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const FETCH_HEADERS: Record<string, string> = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
	Accept: "text/html,application/xhtml+xml",
};

let cachedComps: TftComp[] = [];
let cacheTimestamp = 0;
let fetchInProgress = false;

/**
 * Get the current TFT meta comps tier list.
 * Data is scraped from tftactics.gg and cached for 2 hours.
 */
export async function getTftComps(): Promise<TftComp[]> {
	if (cachedComps.length > 0 && Date.now() - cacheTimestamp < CACHE_TTL) {
		return cachedComps;
	}

	if (fetchInProgress) {
		// Wait for in-flight fetch
		for (let i = 0; i < 30; i++) {
			await new Promise((r) => setTimeout(r, 500));
			if (!fetchInProgress) break;
		}
		return cachedComps;
	}

	fetchInProgress = true;
	try {
		logger.info("Fetching TFT meta comps from tftactics.gg...");
		const res = await fetch(COMPS_URL, { headers: FETCH_HEADERS });
		if (!res.ok) {
			logger.warn(`TFT comps fetch failed: ${res.status}`);
			return cachedComps;
		}

		const html = await res.text();
		const comps = parseComps(html);

		if (comps.length > 0) {
			cachedComps = comps;
			cacheTimestamp = Date.now();
			logger.info(`Parsed ${comps.length} TFT meta comps (S: ${comps.filter((c) => c.tier === "S").length}, A: ${comps.filter((c) => c.tier === "A").length}, B: ${comps.filter((c) => c.tier === "B").length})`);
		} else {
			logger.warn("TFT comps parse returned 0 comps — page structure may have changed");
		}

		return cachedComps;
	} catch (e) {
		logger.error(`TFT comps fetch error: ${e}`);
		return cachedComps;
	} finally {
		fetchInProgress = false;
	}
}

/**
 * Get just S-tier comps.
 */
export function getSTierComps(): TftComp[] {
	return cachedComps.filter((c) => c.tier === "S");
}

/**
 * Get comps filtered by tier.
 */
export function getCompsByTier(tier: string): TftComp[] {
	return cachedComps.filter((c) => c.tier === tier);
}

// ─────────── HTML Parser ───────────

/**
 * Parse tftactics.gg team comps HTML.
 *
 * The page structure has comp entries that look like:
 *   ▴S<CompName><Playstyle>[champ1 item1 item2 champ1][champ2 champ2]...
 *
 * We extract: tier letter, comp name, playstyle, trend, and champion + item lists.
 */
function parseComps(html: string): TftComp[] {
	const comps: TftComp[] = [];

	// Split by "Copy Team Code" buttons — each comp ends with one.
	// block[0] = page header + comp 1 data
	// block[1] = comp 2 data, etc.
	const compBlocks = html.split(/Copy Team Code/i);

	for (const block of compBlocks) {
		if (block.length < 50) continue;

		// ── 1. Trend detection (from CSS class before stripping HTML) ──
		const trend = block.includes('trait up"') || block.includes("trait up'")
			? "up"
			: block.includes('trait down"') || block.includes("trait down'")
				? "down"
				: block.includes("new-comp") || block.includes("NEW")
					? "new"
					: "stable";

		// ── 2. Strip HTML for text-based parsing ──
		const blockText = block
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();

		// ── 3. Extract tier + name + playstyle in one combined regex ──
		// Raw text pattern: "S Eternal Noxus Fast 9" or "A Trials of Twilight (Demacia) Slow Roll (6)"
		const compMatch = blockText.match(
			/\b([SABN])\s+([A-Z][a-zA-Z &'()]+?)\s+(Fast\s+\d+|Slow\s+Roll\s*\(\d+\)|Standard|lvl\s+\d+)/,
		);
		if (!compMatch) continue;

		const tier = compMatch[1];
		let compName = compMatch[2].trim();
		const playstyle = compMatch[3] || "";

		// Clean comp name
		compName = compName.replace(/\s+/g, " ").trim();
		if (compName.length < 3 || compName.length > 40) continue;

		// ── 4. Extract champions from HTML links: /champions/name/ ──
		const champLinks = block.matchAll(/\/champions\/([a-z_&]+)\/?/gi);
		const seenChamps = new Set<string>();
		const champions: TftCompChampion[] = [];

		for (const match of champLinks) {
			const rawName = match[1].replace(/_/g, " ").replace(/&/g, " & ");
			const champName = rawName
				.split(" ")
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(" ");

			if (seenChamps.has(champName)) continue;
			seenChamps.add(champName);

			// Check if 3-starred (preceded by ★★★ in text)
			const threeStarred = blockText.includes(`★★★ ${champName}`);

			// Extract items for this champion from the HTML
			const items = extractChampionItems(block, match[1]);

			champions.push({ name: champName, items, threeStarred });

			// TFT comps max out at ~10 champs; stop early to avoid noise
			if (champions.length >= 12) break;
		}

		if (champions.length < 3) continue; // Need at least 3 champs for a valid comp

		comps.push({ tier, name: compName, playstyle, trend, champions });
	}

	// Deduplicate by comp name (keep first occurrence = highest tier)
	const seen = new Set<string>();
	const unique: TftComp[] = [];
	for (const comp of comps) {
		const key = comp.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(comp);
	}

	return unique;
}

/**
 * Extract item names for a specific champion from the HTML block.
 * Items appear as link text or alt text near the champion's link.
 */
function extractChampionItems(html: string, champSlug: string): string[] {
	// Items typically appear as text content near the champion link
	// Pattern: champion name followed by item names
	const champSection = html.split(new RegExp(`/champions/${champSlug}/?`, "i"));
	if (champSection.length < 2) return [];

	// Look in the section before the champion link for item references
	// Items on tftactics are listed as text: "Bloodthirster Sterak's Gage Titan's Resolve"
	const nearText = champSection[1].substring(0, 300);
	const items: string[] = [];

	// Known TFT item patterns
	const knownItems = [
		"Bloodthirster", "Deathblade", "Giant Slayer", "Guinsoo's Rageblade",
		"Hand of Justice", "Hextech Gunblade", "Infinity Edge", "Last Whisper",
		"Nashor's Tooth", "Quicksilver", "Rabadon's Deathcap", "Spear of Shojin",
		"Statikk Shiv", "Titan's Resolve", "Archangel's Staff", "Blue Buff",
		"Bramble Vest", "Dragon's Claw", "Edge of Night", "Evenshroud",
		"Gargoyle Stoneplate", "Ionic Spark", "Morellonomicon", "Redemption",
		"Shroud of Stillness", "Spark", "Sunfire Cape", "Warmog's Armor",
		"Jeweled Gauntlet", "Crownguard", "Adaptive Helm", "Red Buff",
		"Spirit Visage", "Sterak's Gage", "Striker's Flail", "Void Staff",
		"Kraken's Fury",
	];

	for (const item of knownItems) {
		if (nearText.includes(item)) {
			items.push(item);
			if (items.length >= 3) break; // Max 3 items per champion
		}
	}

	return items;
}

/**
 * Clear the cache to force a fresh fetch.
 */
export function clearTftCache(): void {
	cachedComps = [];
	cacheTimestamp = 0;
}
