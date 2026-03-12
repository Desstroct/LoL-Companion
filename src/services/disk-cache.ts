import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("DiskCache");

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

/**
 * A Map-backed cache that persists entries to a JSON file on disk.
 * On startup, loads any previously saved entries (respecting TTL).
 * Writes are debounced to avoid excessive disk I/O.
 */
export class DiskCache<T> {
	private cache = new Map<string, CacheEntry<T>>();
	private dirty = false;
	private writeTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly WRITE_DEBOUNCE = 5_000; // 5 seconds
	private readonly filePath: string;
	private readonly maxEntries: number;
	private loaded = false;
	private loadPromise: Promise<void> | null = null;

	/**
	 * @param fileName  Name of the cache file (e.g. "champion-stats.json")
	 * @param ttl       Cache TTL in milliseconds
	 * @param maxEntries Maximum entries to store (default 500)
	 */
	constructor(
		fileName: string,
		private readonly ttl: number,
		maxEntries = 500,
	) {
		this.maxEntries = maxEntries;
		// Store cache files in the plugin's cache directory
		this.filePath = join(dirname(dirname(__dirname)), "cache", fileName);
		this.loadPromise = this.loadFromDisk();
	}

	/** Ensure the cache is loaded before any read/write. */
	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		if (this.loadPromise) await this.loadPromise;
	}

	/** Get a cached entry (returns undefined if expired or missing). */
	async get(key: string): Promise<CacheEntry<T> | undefined> {
		await this.ensureLoaded();
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() - entry.timestamp >= this.ttl) {
			this.cache.delete(key);
			this.markDirty();
			return undefined;
		}
		return entry;
	}

	/** Set a cache entry and schedule a disk write. */
	async set(key: string, data: T, timestamp?: number): Promise<void> {
		await this.ensureLoaded();
		this.cache.set(key, { data, timestamp: timestamp ?? Date.now() });
		// Evict oldest entries if over limit
		if (this.cache.size > this.maxEntries) {
			const excess = this.cache.size - this.maxEntries;
			const iter = this.cache.keys();
			for (let i = 0; i < excess; i++) {
				const oldest = iter.next().value;
				if (oldest !== undefined) this.cache.delete(oldest);
			}
		}
		this.markDirty();
	}

	/** Delete a cache entry. */
	async delete(key: string): Promise<void> {
		await this.ensureLoaded();
		this.cache.delete(key);
		this.markDirty();
	}

	/** Check if a key exists and is not expired. */
	async has(key: string): Promise<boolean> {
		return (await this.get(key)) !== undefined;
	}

	/** Clear all cache entries. */
	async clear(): Promise<void> {
		await this.ensureLoaded();
		this.cache.clear();
		this.markDirty();
	}

	/** Get the raw entry (even if expired) for fallback usage. */
	async getRaw(key: string): Promise<CacheEntry<T> | undefined> {
		await this.ensureLoaded();
		return this.cache.get(key);
	}

	// ─── Disk I/O ───

	private async loadFromDisk(): Promise<void> {
		try {
			const raw = await readFile(this.filePath, "utf-8");
			const entries: [string, CacheEntry<T>][] = JSON.parse(raw);
			const now = Date.now();
			let loaded = 0;
			let expired = 0;
			for (const [key, entry] of entries) {
				if (now - entry.timestamp < this.ttl) {
					this.cache.set(key, entry);
					loaded++;
				} else {
					expired++;
				}
			}
			if (loaded > 0) {
				logger.info(`Loaded ${loaded} cached entries from ${this.filePath} (${expired} expired)`);
			}
		} catch {
			// File doesn't exist or is corrupt — start fresh
		}
		this.loaded = true;
		this.loadPromise = null;
	}

	private markDirty(): void {
		this.dirty = true;
		if (!this.writeTimer) {
			this.writeTimer = setTimeout(() => this.writeToDisk(), this.WRITE_DEBOUNCE);
		}
	}

	private async writeToDisk(): Promise<void> {
		this.writeTimer = null;
		if (!this.dirty) return;
		this.dirty = false;

		try {
			const dir = dirname(this.filePath);
			await mkdir(dir, { recursive: true });
			const entries = [...this.cache.entries()];
			await writeFile(this.filePath, JSON.stringify(entries), "utf-8");
			logger.debug(`Wrote ${entries.length} cache entries to ${this.filePath}`);
		} catch (e) {
			logger.error(`Failed to write cache to disk: ${e}`);
		}
	}

	/** Force an immediate write (call on shutdown). */
	async flush(): Promise<void> {
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
		if (this.dirty) {
			await this.writeToDisk();
		}
	}
}
