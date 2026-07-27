import streamDeck from "@elgato/streamdeck";
import type { DdChampion, DdSummonerSpell, DdItem } from "../types/lol";

const logger = streamDeck.logger.createScope("DataDragon");

const DD_BASE = "https://ddragon.leagueoflegends.com";

/**
 * Fetches and caches static data from Riot's Data Dragon CDN.
 * This includes champion data, summoner spell data, and image URLs.
 */
export class DataDragon {
	private version: string | null = null;
	private champions: Map<string, DdChampion> = new Map();
	private championsByKey: Map<string, DdChampion> = new Map();
	private summonerSpells: Map<string, DdSummonerSpell> = new Map();
	private items: Map<string, DdItem> = new Map();
	/** runeId → CDN-relative icon path (e.g. "perk-images/Styles/...") */
	private runeIcons: Map<number, string> = new Map();
	private initialized = false;
	private versionCheckTimer: ReturnType<typeof setInterval> | null = null;
	/** Listeners notified when the DDragon version changes (patch day). */
	private versionChangeListeners: Array<(oldVersion: string, newVersion: string) => void> = [];

	/** How often to check for a new Data Dragon version (30 minutes). */
	private static readonly VERSION_CHECK_INTERVAL = 30 * 60 * 1000;

	/**
	 * Whether Data Dragon has been successfully initialized with online data.
	 */
	isReady(): boolean {
		return this.initialized;
	}

	/**
	 * Register a listener that fires when DDragon detects a new patch.
	 * Used by services that cache patch-specific data (runes, items, counters)
	 * so they can invalidate stale entries immediately.
	 */
	onVersionChange(listener: (oldVersion: string, newVersion: string) => void): void {
		this.versionChangeListeners.push(listener);
	}

	/**
	 * Initialize Data Dragon: fetches latest version and loads champion + spell data.
	 * Starts a background timer to re-check the version every 30 minutes.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		try {
			// Get latest version
			const versions = await this.fetchJson<string[]>(`${DD_BASE}/api/versions.json`);
			if (versions && versions.length > 0) {
				this.version = versions[0];
				logger.info(`Data Dragon version: ${this.version}`);
			} else {
				this.version = "15.14.1"; // Fallback
				logger.warn(`Could not fetch DD version, using fallback ${this.version}`);
			}

			// Load champion data
			await this.loadChampions();
			// Load summoner spell data
			await this.loadSummonerSpells();
			// Load item data
			await this.loadItems();
			// Load rune icon paths (used as CDN fallback for keystone images)
			await this.loadRunes();

			this.initialized = true;
			logger.info(`Data Dragon initialized: ${this.champions.size} champions, ${this.summonerSpells.size} spells, ${this.items.size} items`);

			// Start periodic version check for patch-day refreshes
			this.startVersionCheck();
		} catch (e) {
			logger.error(`Data Dragon init failed: ${e}`);
		}
	}

	/**
	 * Periodically checks if a new Data Dragon version has been released.
	 * On patch day, this picks up new champions, items, and spell data
	 * without requiring a Stream Deck restart.
	 */
	private startVersionCheck(): void {
		if (this.versionCheckTimer) return;
		this.versionCheckTimer = setInterval(() => this.checkForNewVersion().catch(() => {}), DataDragon.VERSION_CHECK_INTERVAL);
	}

	private async checkForNewVersion(): Promise<void> {
		const versions = await this.fetchJson<string[]>(`${DD_BASE}/api/versions.json`);
		if (!versions || versions.length === 0) return;

		const latest = versions[0];
		if (latest === this.version) return;

		logger.info(`New Data Dragon version detected: ${this.version} → ${latest}`);

		// Load into temporary maps first — only swap on success (atomic)
		const oldVersion = this.version;
		this.version = latest;

		const tmpChampions = new Map<string, import("../types/lol").DdChampion>();
		const tmpChampionsByKey = new Map<string, import("../types/lol").DdChampion>();
		const tmpSpells = new Map<string, import("../types/lol").DdSummonerSpell>();
		const tmpItems = new Map<string, import("../types/lol").DdItem>();

		try {
			const champData = await this.fetchJson<{ data: Record<string, import("../types/lol").DdChampion> }>(
				`${DD_BASE}/cdn/${latest}/data/en_US/champion.json`,
			);
			if (champData?.data) {
				for (const [id, champ] of Object.entries(champData.data)) {
					tmpChampions.set(id, champ);
					tmpChampionsByKey.set(champ.key, champ);
				}
			}

			const spellData = await this.fetchJson<{ data: Record<string, import("../types/lol").DdSummonerSpell> }>(
				`${DD_BASE}/cdn/${latest}/data/en_US/summoner.json`,
			);
			if (spellData?.data) {
				for (const [id, spell] of Object.entries(spellData.data)) {
					tmpSpells.set(id, spell);
				}
			}

			const itemData = await this.fetchJson<{ data: Record<string, import("../types/lol").DdItem> }>(
				`${DD_BASE}/cdn/${latest}/data/en_US/item.json`,
			);
			if (itemData?.data) {
				for (const [id, item] of Object.entries(itemData.data)) {
					tmpItems.set(id, item);
				}
			}

			// Verify we got meaningful data before swapping
			if (tmpChampions.size === 0) {
				throw new Error("Champion data empty after fetch");
			}

			// Load rune icons into a temporary map (not the live one)
			const tmpRuneIcons = await this.loadRunesInto(latest);

			// Atomic swap — old maps are GC'd
			this.champions = tmpChampions;
			this.championsByKey = tmpChampionsByKey;
			this.summonerSpells = tmpSpells;
			this.items = tmpItems;
			if (tmpRuneIcons) this.runeIcons = tmpRuneIcons;

			logger.info(`Data Dragon refreshed: ${this.champions.size} champions, ${this.summonerSpells.size} spells, ${this.items.size} items`);

			// Notify services to invalidate patch-specific caches
			for (const listener of this.versionChangeListeners) {
				try { listener(oldVersion!, latest); } catch { /* swallow */ }
			}
		} catch (e) {
			// Rollback version — keep old data intact
			logger.error(`Data Dragon refresh failed, keeping ${oldVersion}: ${e}`);
			this.version = oldVersion;
		}
	}

	/**
	 * Get the current Data Dragon version.
	 */
	getVersion(): string {
		return this.version ?? "15.14.1";
	}

	/**
	 * Get champion data by ID (e.g., "Aatrox").
	 */
	getChampion(id: string): DdChampion | undefined {
		return this.champions.get(id);
	}

	/**
	 * Get champion data by key (e.g., "266" for Aatrox).
	 */
	getChampionByKey(key: string): DdChampion | undefined {
		return this.championsByKey.get(key);
	}

	/**
	 * Get champion data by display name (e.g., "Lee Sin", "Aatrox").
	 * Case-insensitive, accent-insensitive lookup via a lazy-built cache.
	 * O(1) after the first call per patch \u2014 the map is rebuilt when DDragon
	 * detects a new version.
	 */
	private championsByName: Map<string, DdChampion> | null = null;
	private championsByNameVersion = "";

	private ensureNameIndex(): Map<string, DdChampion> {
		const v = this.getVersion();
		if (this.championsByName && this.championsByNameVersion === v) return this.championsByName;
		this.championsByName = new Map();
		this.championsByNameVersion = v;
		for (const champ of this.champions.values()) {
			this.championsByName.set(DataDragon.normalizeName(champ.name), champ);
			this.championsByName.set(champ.id.toLowerCase(), champ);
		}
		return this.championsByName;
	}

	private static normalizeName(name: string): string {
		return name
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/['\s.]/g, "");
	}

	getChampionByName(name: string): DdChampion | undefined {
		return this.ensureNameIndex().get(DataDragon.normalizeName(name));
	}

	/**
	 * Get the champion square image URL.
	 */
	getChampionImageUrl(championId: string): string {
		return `${DD_BASE}/cdn/${this.getVersion()}/img/champion/${championId}.png`;
	}

	/**
	 * Get all champions as an iterable.
	 */
	getAllChampions(): IterableIterator<DdChampion> {
		return this.champions.values();
	}

	/**
	 * Get summoner spell data by ID (e.g., "SummonerFlash").
	 */
	getSummonerSpell(id: string): DdSummonerSpell | undefined {
		return this.summonerSpells.get(id);
	}

	/**
	 * Get summoner spell image URL.
	 */
	getSpellImageUrl(spellId: string): string {
		const spell = this.summonerSpells.get(spellId);
		const imageName = spell?.image.full ?? `${spellId}.png`;
		return `${DD_BASE}/cdn/${this.getVersion()}/img/spell/${imageName}`;
	}

	/**
	 * Get item data by ID (e.g., "3031" for Infinity Edge).
	 */
	getItem(id: string): DdItem | undefined {
		return this.items.get(id);
	}

	/**
	 * Get item display name.
	 */
	getItemName(id: number): string {
		return this.items.get(String(id))?.name ?? `Item ${id}`;
	}

	/**
	 * Get item total gold cost.
	 */
	getItemCost(id: number): number {
		return this.items.get(String(id))?.gold.total ?? 0;
	}

	/**
	 * Get the component recipe for an item (item IDs it builds from).
	 */
	getItemComponents(id: number): number[] {
		const item = this.items.get(String(id));
		return item?.from?.map(Number).filter((n) => !isNaN(n)) ?? [];
	}

	/**
	 * Get item base (combine) cost — the gold needed on top of all components.
	 */
	getItemBaseCost(id: number): number {
		return this.items.get(String(id))?.gold.base ?? 0;
	}

	/**
	 * Check if an item is a completed boots item (has "Boots" tag, costs > 500g, purchasable).
	 * Tier-1 boots (plain Boots, 300g) are excluded.
	 */
	isTier2Boots(itemId: number): boolean {
		const item = this.items.get(String(itemId));
		if (!item) return false;
		return item.tags.includes("Boots") && item.gold.purchasable && item.gold.total > 500 && item.gold.total <= 1500;
	}

	/**
	 * Get all tier-2 boots item IDs from DDragon data.
	 * Dynamic — picks up new boots on patch day without code changes.
	 */
	private tier2BootsCache: Set<number> | null = null;
	private tier2BootsCacheVersion = "";

	getTier2BootsIds(): Set<number> {
		const v = this.getVersion();
		if (this.tier2BootsCache && this.tier2BootsCacheVersion === v) return this.tier2BootsCache;
		this.tier2BootsCache = new Set<number>();
		this.tier2BootsCacheVersion = v;
		for (const [id] of this.items) {
			const numId = Number(id);
			if (!isNaN(numId) && numId < 200000 && this.isTier2Boots(numId)) {
				this.tier2BootsCache.add(numId);
			}
		}
		return this.tier2BootsCache;
	}

	/**
	 * Check if an item is any boots item (tier 1 or tier 2).
	 */
	isBootsItem(itemId: number): boolean {
		const item = this.items.get(String(itemId));
		if (!item) return false;
		return item.tags.includes("Boots") && item.gold.purchasable && itemId < 200000;
	}

	/**
	 * Get item image URL.
	 */
	getItemImageUrl(itemId: number): string {
		return `${DD_BASE}/cdn/${this.getVersion()}/img/item/${itemId}.png`;
	}

	/**
	 * Get the CDN URL for a rune/keystone icon by its Riot perk ID.
	 * Returns null if rune data hasn't loaded or the ID is unknown.
	 * URL format: ddragon.leagueoflegends.com/cdn/img/{icon} (no version in path).
	 */
	getRuneIconUrl(runeId: number): string | null {
		const icon = this.runeIcons.get(runeId);
		return icon ? `${DD_BASE}/cdn/img/${icon}` : null;
	}

	// ---- Private methods ----

	private async loadChampions(): Promise<void> {
		const url = `${DD_BASE}/cdn/${this.getVersion()}/data/en_US/champion.json`;
		const data = await this.fetchJson<{ data: Record<string, DdChampion> }>(url);

		if (data?.data) {
			for (const [id, champ] of Object.entries(data.data)) {
				this.champions.set(id, champ);
				this.championsByKey.set(champ.key, champ);
			}
		}
	}

	private async loadSummonerSpells(): Promise<void> {
		const url = `${DD_BASE}/cdn/${this.getVersion()}/data/en_US/summoner.json`;
		const data = await this.fetchJson<{ data: Record<string, DdSummonerSpell> }>(url);

		if (data?.data) {
			for (const [id, spell] of Object.entries(data.data)) {
				this.summonerSpells.set(id, spell);
			}
		}
	}

	private async loadItems(): Promise<void> {
		const url = `${DD_BASE}/cdn/${this.getVersion()}/data/en_US/item.json`;
		const data = await this.fetchJson<{ data: Record<string, DdItem> }>(url);

		if (data?.data) {
			for (const [id, item] of Object.entries(data.data)) {
				this.items.set(id, item);
			}
		}
	}

	private async loadRunes(): Promise<void> {
		const icons = await this.loadRunesInto(this.getVersion());
		if (icons) {
			this.runeIcons = icons;
		}
	}

	/**
	 * Fetch rune data for a specific version into a NEW map (doesn't touch this.runeIcons).
	 * Returns null if the fetch fails, so callers can skip the swap.
	 */
	private async loadRunesInto(version: string): Promise<Map<number, string> | null> {
		const url = `${DD_BASE}/cdn/${version}/data/en_US/runesReforged.json`;
		const data = await this.fetchJson<DdRuneTree[]>(url);
		if (!data) return null;
		const icons = new Map<number, string>();
		for (const tree of data) {
			for (const slot of tree.slots) {
				for (const rune of slot.runes) {
					icons.set(rune.id, rune.icon);
				}
			}
		}
		logger.debug(`Loaded ${icons.size} rune icons from DDragon (v${version})`);
		return icons;
	}

	private async fetchJson<T>(url: string): Promise<T | null> {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
			if (response.ok) {
				return (await response.json()) as T;
			}
			logger.warn(`DD fetch ${url} returned ${response.status}`);
			return null;
		} catch (e) {
			logger.error(`DD fetch error ${url}: ${e}`);
			return null;
		}
	}
}

// Singleton instance
export const dataDragon = new DataDragon();

// ─────────── Internal DDragon types ───────────

interface DdRuneTree {
	id: number;
	slots: Array<{ runes: Array<{ id: number; icon: string }> }>;
}
