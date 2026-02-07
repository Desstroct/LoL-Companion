import https from "node:https";
import streamDeck from "@elgato/streamdeck";
import type { GameClientAllData, GamePlayer, GameData, GameEvents, ActivePlayer } from "../types/lol";

const logger = streamDeck.logger.createScope("GameClient");

const GAME_CLIENT_BASE = "https://127.0.0.1:2999";
const agent = new https.Agent({ rejectUnauthorized: false });

/**
 * Wrapper around the League of Legends Game Client API.
 * Available at https://127.0.0.1:2999 during an active game.
 * No authentication required. Uses self-signed certificate.
 */
export class GameClient {
	private cachedData: GameClientAllData | null = null;
	private lastFetchTime = 0;
	private readonly cacheTtlMs = 500; // cache for 500ms to avoid hammering

	/**
	 * Generic GET request to the Game Client API.
	 */
	private request<T>(path: string): Promise<T | null> {
		return new Promise((resolve) => {
			const url = new URL(path, GAME_CLIENT_BASE);

			const req = https.request(
				{
					hostname: url.hostname,
					port: url.port,
					path: url.pathname,
					method: "GET",
					headers: { Accept: "application/json" },
					agent,
				},
				(res) => {
					let data = "";
					res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
					res.on("end", () => {
						try {
							if (res.statusCode === 200) {
								resolve(JSON.parse(data) as T);
							} else {
								resolve(null);
							}
						} catch {
							resolve(null);
						}
					});
				},
			);

			req.on("error", () => {
				resolve(null);
			});

			req.setTimeout(2000, () => {
				req.destroy();
				resolve(null);
			});

			req.end();
		});
	}

	/**
	 * Check if a game is currently running.
	 */
	async isInGame(): Promise<boolean> {
		const data = await this.request<GameData>("/liveclientdata/gamestats");
		return data !== null;
	}

	/**
	 * Get all live game data (cached for 500ms).
	 */
	async getAllData(): Promise<GameClientAllData | null> {
		const now = Date.now();
		if (this.cachedData && now - this.lastFetchTime < this.cacheTtlMs) {
			return this.cachedData;
		}

		const data = await this.request<GameClientAllData>("/liveclientdata/allgamedata");
		if (data) {
			this.cachedData = data;
			this.lastFetchTime = now;
		} else {
			this.cachedData = null;
		}
		return this.cachedData;
	}

	/**
	 * Get the active player (you).
	 */
	async getActivePlayer(): Promise<ActivePlayer | null> {
		const data = await this.getAllData();
		return data?.activePlayer ?? null;
	}

	/**
	 * Get all players in the game.
	 */
	async getAllPlayers(): Promise<GamePlayer[]> {
		const data = await this.getAllData();
		return data?.allPlayers ?? [];
	}

	/**
	 * Get enemy players.
	 */
	async getEnemyPlayers(): Promise<GamePlayer[]> {
		const data = await this.getAllData();
		if (!data) return [];

		// Determine our team
		const activePlayerName = data.activePlayer.summonerName;
		const me = data.allPlayers.find(
			(p) => p.riotIdGameName === activePlayerName || p.summonerName === activePlayerName,
		);
		if (!me) return [];

		return data.allPlayers.filter((p) => p.team !== me.team);
	}

	/**
	 * Get game time in seconds.
	 */
	async getGameTime(): Promise<number> {
		const data = await this.getAllData();
		return data?.gameData.gameTime ?? 0;
	}

	/**
	 * Get game events list.
	 */
	async getEvents(): Promise<GameEvents | null> {
		const data = await this.getAllData();
		return data?.events ?? null;
	}

	/**
	 * Clear the cache (useful when we know data has changed).
	 */
	clearCache(): void {
		this.cachedData = null;
		this.lastFetchTime = 0;
	}
}

// Singleton instance
export const gameClient = new GameClient();
