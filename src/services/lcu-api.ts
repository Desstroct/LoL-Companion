import https from "node:https";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "./lcu-connector";
import type {
	GameflowPhase,
	LcuChampSelectSession,
	LcuRankedStats,
	LcuRunePage,
	LcuSummoner,
} from "../types/lol";

const logger = streamDeck.logger.createScope("LcuApi");

/**
 * Wrapper around the LCU REST API.
 * All endpoints are relative to the LCU base URL (https://127.0.0.1:{port}).
 * Authentication is HTTP Basic with riot:{auth-token}.
 *
 * Features:
 * - Shared https.Agent for connection reuse (no socket leaks)
 * - Short-TTL request deduplication cache to avoid 7+ identical calls per poll cycle
 */
export class LcuApi {
	/** Shared agent (rejectUnauthorized: false for LCU self-signed cert) */
	private agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

	/** Short-lived GET cache: endpoint → { data, timestamp } */
	private getCache = new Map<string, { data: unknown; timestamp: number }>();
	private readonly GET_CACHE_TTL = 500; // 500ms dedup window
	/**
	 * Generic GET request to the LCU API.
	 * Results are cached for 500ms to deduplicate concurrent polling calls.
	 */
	async get<T>(endpoint: string): Promise<T | null> {
		const creds = lcuConnector.getCredentials();
		if (!creds) {
			return null;
		}

		// Check dedup cache
		const cached = this.getCache.get(endpoint);
		if (cached && Date.now() - cached.timestamp < this.GET_CACHE_TTL) {
			return cached.data as T;
		} else if (cached) {
			// Evict stale entry to prevent unbounded Map growth
			this.getCache.delete(endpoint);
		}

		return new Promise((resolve) => {
			const auth = Buffer.from(`riot:${creds.password}`).toString("base64");

			const req = https.request(
				{
					hostname: "127.0.0.1",
					port: creds.port,
					path: endpoint,
					method: "GET",
					headers: {
						Authorization: `Basic ${auth}`,
						Accept: "application/json",
					},
					agent: this.agent,
				},
				(res) => {
					let data = "";
					res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
					res.on("end", () => {
						try {
							if (res.statusCode === 200) {
								const parsed = JSON.parse(data) as T;
								this.getCache.set(endpoint, { data: parsed, timestamp: Date.now() });
								resolve(parsed);
							} else {
								logger.warn(`LCU ${endpoint} returned ${res.statusCode}`);
								resolve(null);
							}
						} catch (e) {
							logger.error(`LCU parse error on ${endpoint}: ${e}`);
							resolve(null);
						}
					});
				},
			);

			req.on("error", (e) => {
				logger.debug(`LCU request error on ${endpoint}: ${e.message}`);
				resolve(null);
			});

			req.setTimeout(3000, () => {
				req.destroy();
				resolve(null);
			});

			req.end();
		});
	}

	/**
	 * Generic POST request to the LCU API.
	 */
	async post(endpoint: string, body?: unknown): Promise<boolean> {
		const creds = lcuConnector.getCredentials();
		if (!creds) {
			return false;
		}

		return new Promise((resolve) => {
			const auth = Buffer.from(`riot:${creds.password}`).toString("base64");
			const postData = body ? JSON.stringify(body) : "";

			const req = https.request(
				{
					hostname: "127.0.0.1",
					port: creds.port,
					path: endpoint,
					method: "POST",
					headers: {
						Authorization: `Basic ${auth}`,
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(postData),
					},
					agent: this.agent,
				},
				(res) => {
					let data = "";
					res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
					res.on("end", () => {
						if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
							resolve(true);
						} else {
							logger.warn(`LCU POST ${endpoint} returned ${res.statusCode}`);
							resolve(false);
						}
					});
				},
			);

			req.on("error", (e) => {
				logger.debug(`LCU POST error on ${endpoint}: ${e.message}`);
				resolve(false);
			});

			req.setTimeout(3000, () => {
				req.destroy();
				resolve(false);
			});

			req.write(postData);
			req.end();
		});
	}

	// ---- Gameflow ----

	/**
	 * Get the current gameflow phase.
	 */
	async getGameflowPhase(): Promise<GameflowPhase> {
		const phase = await this.get<string>("/lol-gameflow/v1/gameflow-phase");
		return (phase as GameflowPhase) ?? "None";
	}

	// ---- Champion Select ----

	/**
	 * Get the current champion select session.
	 */
	async getChampSelectSession(): Promise<LcuChampSelectSession | null> {
		return this.get<LcuChampSelectSession>("/lol-champ-select/v1/session");
	}

	// ---- Summoner ----

	/**
	 * Get the current logged-in summoner.
	 */
	async getCurrentSummoner(): Promise<LcuSummoner | null> {
		return this.get<LcuSummoner>("/lol-summoner/v1/current-summoner");
	}

	/**
	 * Get a summoner by PUUID.
	 */
	async getSummonerByPuuid(puuid: string): Promise<LcuSummoner | null> {
		return this.get<LcuSummoner>(`/lol-summoner/v2/summoners/puuid/${encodeURIComponent(puuid)}`);
	}

	// ---- Ranked ----

	/**
	 * Get ranked stats for a summoner by PUUID.
	 */
	async getRankedStats(puuid: string): Promise<LcuRankedStats | null> {
		return this.get<LcuRankedStats>(`/lol-ranked/v1/ranked-stats/${encodeURIComponent(puuid)}`);
	}

	/**
	 * Get ranked stats for the current summoner.
	 */
	async getCurrentRankedStats(): Promise<LcuRankedStats | null> {
		return this.get<LcuRankedStats>("/lol-ranked/v1/current-ranked-stats");
	}

	// ---- HTTP helpers for PUT / DELETE ----

	/**
	 * Generic PUT request to the LCU API.
	 */
	async put<T = unknown>(endpoint: string, body?: unknown): Promise<T | null> {
		return this.request<T>("PUT", endpoint, body);
	}

	/**
	 * Generic PATCH request to the LCU API.
	 * Returns the parsed response on success, or undefined if body is empty.
	 * Returns null on error.
	 */
	async patch<T = unknown>(endpoint: string, body?: unknown): Promise<T | undefined | null> {
		logger.debug(`PATCH ${endpoint} body: ${JSON.stringify(body)}`);
		const result = await this.request<T>("PATCH", endpoint, body);
		return result;
	}

	/**
	 * Generic DELETE request to the LCU API.
	 */
	async del(endpoint: string): Promise<boolean> {
		const creds = lcuConnector.getCredentials();
		if (!creds) return false;

		return new Promise((resolve) => {
			const auth = Buffer.from(`riot:${creds.password}`).toString("base64");

			const req = https.request(
				{
					hostname: "127.0.0.1",
					port: creds.port,
					path: endpoint,
					method: "DELETE",
					headers: { Authorization: `Basic ${auth}` },
					agent: this.agent,
				},
				(res) => {
					let data = "";
					res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
					res.on("end", () => {
						resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
					});
				},
			);

			req.on("error", () => resolve(false));
			req.setTimeout(3000, () => { req.destroy(); resolve(false); });
			req.end();
		});
	}

	/**
	 * Generic request returning parsed JSON (used by PUT).
	 */
	private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T | null> {
		const creds = lcuConnector.getCredentials();
		if (!creds) return null;

		return new Promise((resolve) => {
			const auth = Buffer.from(`riot:${creds.password}`).toString("base64");
			const postData = body ? JSON.stringify(body) : "";

			const req = https.request(
				{
					hostname: "127.0.0.1",
					port: creds.port,
					path: endpoint,
					method,
					headers: {
						Authorization: `Basic ${auth}`,
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(postData),
						Accept: "application/json",
					},
					agent: this.agent,
				},
				(res) => {
					let data = "";
					res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
					res.on("end", () => {
						try {
							if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && data.length > 0) {
								resolve(JSON.parse(data) as T);
							} else if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
								// Success but no body (e.g. PATCH returns empty on success)
								resolve(null);
							} else {
								logger.warn(`LCU ${method} ${endpoint} returned ${res.statusCode}: ${data.slice(0, 200)}`);
								resolve(null);
							}
						} catch {
							resolve(null);
						}
					});
				},
			);

			req.on("error", (e) => {
				logger.warn(`LCU ${method} ${endpoint} error: ${e.message}`);
				resolve(null);
			});
			req.setTimeout(3000, () => { req.destroy(); resolve(null); });
			req.write(postData);
			req.end();
		});
	}

	// ---- Perks / Rune Pages ----

	/**
	 * Get all custom rune pages.
	 */
	async getRunePages(): Promise<LcuRunePage[]> {
		return (await this.get<LcuRunePage[]>("/lol-perks/v1/pages")) ?? [];
	}

	/**
	 * Get the current active rune page.
	 */
	async getCurrentRunePage(): Promise<LcuRunePage | null> {
		return this.get<LcuRunePage>("/lol-perks/v1/currentpage");
	}

	/**
	 * Create a new rune page. Returns the created page.
	 */
	async createRunePage(page: Omit<LcuRunePage, "id" | "isActive" | "isDeletable" | "isEditable" | "isValid" | "lastModified" | "order">): Promise<LcuRunePage | null> {
		const creds = lcuConnector.getCredentials();
		if (!creds) return null;
		return this.request<LcuRunePage>("POST", "/lol-perks/v1/pages", page);
	}

	/**
	 * Update an existing rune page by ID.
	 */
	async updateRunePage(id: number, page: Partial<LcuRunePage>): Promise<LcuRunePage | null> {
		return this.put<LcuRunePage>(`/lol-perks/v1/pages/${id}`, page);
	}

	/**
	 * Delete a rune page by ID.
	 */
	async deleteRunePage(id: number): Promise<boolean> {
		return this.del(`/lol-perks/v1/pages/${id}`);
	}

	// ---- Summoner Spells ----

	/**
	 * Update the current player's summoner spells during champion select.
	 * Uses PATCH /lol-champ-select/v1/session/my-selection.
	 *
	 * @param spell1Id First summoner spell ID (e.g. 4 = Flash)
	 * @param spell2Id Second summoner spell ID (e.g. 14 = Ignite)
	 */
	async setSummonerSpells(spell1Id: number, spell2Id: number): Promise<boolean> {
		const result = await this.patch("/lol-champ-select/v1/session/my-selection", {
			spell1Id,
			spell2Id,
		});
		return result !== null;
	}
}

// Singleton instance
export const lcuApi = new LcuApi();
