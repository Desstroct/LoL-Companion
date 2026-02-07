import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";

const logger = streamDeck.logger.createScope("LobbyLevel");

/** Numeric value assigned to each tier for averaging */
const TIER_VALUES: Record<string, number> = {
	IRON: 0,
	BRONZE: 4,
	SILVER: 8,
	GOLD: 12,
	PLATINUM: 16,
	EMERALD: 20,
	DIAMOND: 24,
	MASTER: 28,
	GRANDMASTER: 29,
	CHALLENGER: 30,
};

const TIER_LABELS: Record<string, string> = {
	IRON: "Iron",
	BRONZE: "Bronze",
	SILVER: "Silver",
	GOLD: "Gold",
	PLATINUM: "Plat",
	EMERALD: "Em",
	DIAMOND: "Dia",
	MASTER: "Master",
	GRANDMASTER: "GM",
	CHALLENGER: "Chall",
};

const DIVISION_VALUES: Record<string, number> = {
	IV: 0,
	III: 1,
	II: 2,
	I: 3,
};

/**
 * Convert a tier + division to a numeric rank value (0-30).
 * Master+ has no division subdivisions (always 28/29/30).
 */
function rankToValue(tier: string, division: string): number {
	const base = TIER_VALUES[tier] ?? -1;
	if (base < 0) return -1;
	if (base >= 28) return base; // Master+
	return base + (DIVISION_VALUES[division] ?? 0);
}

/**
 * Convert a numeric rank value back to a short label like "Gold II".
 */
function valueToLabel(value: number): string {
	if (value >= 30) return "Chall";
	if (value >= 29) return "GM";
	if (value >= 28) return "Master";

	// Find the tier bracket
	const tiers = Object.entries(TIER_VALUES)
		.filter(([, v]) => v < 28)
		.sort((a, b) => b[1] - a[1]);

	for (const [tier, base] of tiers) {
		if (value >= base) {
			const divNum = value - base;
			const divs = ["IV", "III", "II", "I"];
			const div = divs[Math.min(divNum, 3)];
			return `${TIER_LABELS[tier]} ${div}`;
		}
	}
	return "Iron IV";
}

/**
 * Lobby Level Tracker action — shows average summoner level AND
 * average ranked tier of the lobby during Champion Select.
 *
 * Settings:
 * - view: "all" | "allies" | "enemies"
 */
@action({ UUID: "com.desstroct.lol-api.lobby-level" })
export class LobbyLevelTracker extends SingletonAction<LobbyLevelSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private lastHash = "";

	override onWillAppear(ev: WillAppearEvent<LobbyLevelSettings>): void | Promise<void> {
		this.startPolling();
		return ev.action.setTitle("Lobby\nLevel");
	}

	override onWillDisappear(_ev: WillDisappearEvent<LobbyLevelSettings>): void | Promise<void> {
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<LobbyLevelSettings>): Promise<void> {
		this.lastHash = "";
		await this.updateLobbyLevel();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateLobbyLevel();
		this.pollInterval = setInterval(() => this.updateLobbyLevel(), 5000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateLobbyLevel(): Promise<void> {
		if (!lcuConnector.isConnected()) return;

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			this.lastHash = "";
			for (const a of this.actions) {
				await a.setTitle("Lobby\nLevel");
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const allyPuuids = session.myTeam
			.map((p) => p.puuid)
			.filter((p) => p && p !== "");
		const enemyPuuids = session.theirTeam
			.map((p) => p.puuid)
			.filter((p) => p && p !== "");

		const allPuuids = [...allyPuuids, ...enemyPuuids];
		if (allPuuids.length === 0) {
			for (const a of this.actions) {
				await a.setTitle("Lobby Lvl\nWaiting...");
			}
			return;
		}

		const hash = allPuuids.sort().join(",");
		if (hash === this.lastHash) return;

		for (const a of this.actions) {
			const settings = (await a.getSettings()) as LobbyLevelSettings;
			const view = settings.view ?? "all";

			try {
				const allyData = await this.fetchPlayerData(allyPuuids);
				const enemyData = await this.fetchPlayerData(enemyPuuids);

				let title: string;

				if (view === "allies") {
					const avgLvl = this.avgLevel(allyData.map((d) => d.level));
					const avgRank = this.avgRankLabel(allyData);
					title = `Allies ${avgRank}\nLvl ${avgLvl}`;
				} else if (view === "enemies") {
					const avgLvl = this.avgLevel(enemyData.map((d) => d.level));
					const avgRank = this.avgRankLabel(enemyData);
					title = `Enemies ${avgRank}\nLvl ${avgLvl}`;
				} else {
					const allyRank = this.avgRankLabel(allyData);
					const enemyRank = this.avgRankLabel(enemyData);
					const allData = [...allyData, ...enemyData];
					const totalLvl = this.avgLevel(allData.map((d) => d.level));
					title = `Avg ${allyRank}\nLvl ${totalLvl}`;
				}

				await a.setTitle(title);
				this.lastHash = hash;
			} catch (e) {
				logger.error(`LobbyLevel error: ${e}`);
				await a.setTitle("Lobby Lvl\nError");
			}
		}
	}

	private async fetchPlayerData(puuids: string[]): Promise<PlayerData[]> {
		const results: PlayerData[] = [];
		for (const puuid of puuids) {
			const summoner = await lcuApi.getSummonerByPuuid(puuid);
			const level = summoner?.summonerLevel ?? 0;

			let rankValue = -1;
			try {
				const ranked = await lcuApi.getRankedStats(puuid);
				if (ranked?.queueMap?.RANKED_SOLO_5x5) {
					const solo = ranked.queueMap.RANKED_SOLO_5x5;
					rankValue = rankToValue(solo.tier, solo.division);
				}
			} catch {
				// Ranked data unavailable — skip
			}

			results.push({ level, rankValue });
		}
		return results;
	}

	/**
	 * Compute average rank label from player data.
	 * Only includes players with valid ranked data.
	 */
	private avgRankLabel(data: PlayerData[]): string {
		const ranked = data.filter((d) => d.rankValue >= 0);
		if (ranked.length === 0) return "Unranked";
		const avg = ranked.reduce((s, d) => s + d.rankValue, 0) / ranked.length;
		return valueToLabel(Math.round(avg));
	}

	private avgLevel(levels: number[]): number {
		const valid = levels.filter((l) => l > 0);
		if (valid.length === 0) return 0;
		return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
	}
}

interface PlayerData {
	level: number;
	/** -1 = unranked */
	rankValue: number;
}

type LobbyLevelSettings = {
	view?: "all" | "allies" | "enemies";
};
