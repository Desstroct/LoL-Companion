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
	private initialized = false;

	/**
	 * Initialize Data Dragon: fetches latest version and loads champion + spell data.
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
				this.version = "14.24.1"; // Fallback
				logger.warn(`Could not fetch DD version, using fallback ${this.version}`);
			}

			// Load champion data
			await this.loadChampions();
			// Load summoner spell data
			await this.loadSummonerSpells();
			// Load item data
			await this.loadItems();

			this.initialized = true;
			logger.info(`Data Dragon initialized: ${this.champions.size} champions, ${this.summonerSpells.size} spells, ${this.items.size} items`);
		} catch (e) {
			logger.error(`Data Dragon init failed: ${e}`);
		}
	}

	/**
	 * Get the current Data Dragon version.
	 */
	getVersion(): string {
		return this.version ?? "14.24.1";
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
	 * Get item image URL.
	 */
	getItemImageUrl(itemId: number): string {
		return `${DD_BASE}/cdn/${this.getVersion()}/img/item/${itemId}.png`;
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

	private async fetchJson<T>(url: string): Promise<T | null> {
		try {
			const response = await fetch(url);
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
