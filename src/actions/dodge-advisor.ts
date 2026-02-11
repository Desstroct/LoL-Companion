import {
	action,
	DialRotateEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { getChampionIconByKey } from "../services/lol-icons";
import type { LcuChampSelectSession, LcuChampSelectPlayer } from "../types/lol";

const logger = streamDeck.logger.createScope("DodgeAdvisor");

/**
 * Match history entry from LCU.
 */
interface LcuMatchHistoryEntry {
	gameId: number;
	gameCreation: number;
	queueId: number;
	participants: {
		championId: number;
		stats: {
			win: boolean;
		};
	}[];
}

interface LcuMatchHistory {
	games: {
		games: LcuMatchHistoryEntry[];
	};
}

/**
 * Ranked position data.
 */
interface LcuRankedPosition {
	tier: string;
	division: string;
	wins: number;
	losses: number;
	leaguePoints: number;
}

interface LcuRankedStats {
	queueMap: {
		RANKED_SOLO_5x5?: LcuRankedPosition;
		RANKED_FLEX_SR?: LcuRankedPosition;
	};
}

/**
 * Dodge Advisor action — analyzes teammates during champion select
 * to help decide whether to dodge.
 *
 * Key display: Overall lobby score (1-100)
 * Dial display:
 *   - Rotate: Cycle through teammates
 *   - Shows win rate, games on champ, autofill status
 */
@action({ UUID: "com.desstroct.lol-api.dodge-advisor" })
export class DodgeAdvisor extends SingletonAction<DodgeAdvisorSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-dial state: which teammate (0-4) */
	private dialStates: Map<string, { playerIndex: number }> = new Map();
	/** Cached player analysis to avoid re-fetching */
	private playerCache: Map<string, PlayerAnalysis> = new Map();
	private lastGameId: number | null = null;

	override onWillAppear(ev: WillAppearEvent<DodgeAdvisorSettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			this.getDialState(ev.action.id);
			return ev.action.setFeedback({
				champ_icon: "",
				player_name: "DODGE ADVISOR",
				stats_line: "Waiting for champ select...",
				score_text: "",
				score_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("Dodge\nAdvisor");
	}

	override onWillDisappear(ev: WillDisappearEvent<DodgeAdvisorSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(_ev: KeyDownEvent<DodgeAdvisorSettings>): Promise<void> {
		// Force reanalysis
		this.playerCache.clear();
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<DodgeAdvisorSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		ds.playerIndex = ((ds.playerIndex + ev.payload.ticks + 100) % 5);
		await this.updateAll();
	}

	override async onTouchTap(_ev: TouchTapEvent<DodgeAdvisorSettings>): Promise<void> {
		await this.updateAll();
	}

	private getDialState(actionId: string): { playerIndex: number } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { playerIndex: 0 };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 4000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		// TFT not supported
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", player_name: "", stats_line: "N/A in TFT", score_text: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle("Dodge\nN/A TFT");
				}
			}
			return;
		}

		// Only works in champ select
		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			// Clear cache when leaving champ select
			if (this.playerCache.size > 0) {
				this.playerCache.clear();
				this.lastGameId = null;
			}
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						player_name: "DODGE ADVISOR",
						stats_line: "Enter champ select",
						score_text: "",
						score_bar: { value: 0 },
					});
				} else {
					await a.setTitle("Dodge\nNo CS");
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		// New lobby? Clear cache
		if (session.gameId !== this.lastGameId) {
			this.playerCache.clear();
			this.lastGameId = session.gameId;
		}

		// Analyze teammates
		const teammates = session.myTeam.filter((p) => p.puuid && p.cellId !== session.localPlayerCellId);
		const analyses: PlayerAnalysis[] = [];

		for (const tm of teammates) {
			let analysis = this.playerCache.get(tm.puuid);
			if (!analysis) {
				analysis = await this.analyzePlayer(tm, session);
				this.playerCache.set(tm.puuid, analysis);
			} else {
				// Update champion if it changed
				if (tm.championId > 0 && tm.championId !== analysis.championId) {
					analysis = await this.analyzePlayer(tm, session);
					this.playerCache.set(tm.puuid, analysis);
				}
			}
			analyses.push(analysis);
		}

		// Calculate overall lobby score (0-100)
		const lobbyScore = this.calculateLobbyScore(analyses);

		// Update displays
		for (const a of this.actions) {
			if (a.isDial()) {
				const ds = this.getDialState(a.id);
				if (analyses.length === 0) {
					await a.setFeedback({
						champ_icon: "",
						player_name: "No teammates",
						stats_line: "",
						score_text: "",
						score_bar: { value: 0 },
					});
				} else {
					const idx = ds.playerIndex % analyses.length;
					const player = analyses[idx];
					const champIcon = player.championId > 0
						? await getChampionIconByKey(String(player.championId))
						: null;

					const statsLine = this.formatStatsLine(player);
					const scoreColor = player.score >= 70 ? "#2ECC71" : player.score >= 40 ? "#F1C40F" : "#E74C3C";

					await a.setFeedback({
						champ_icon: champIcon ?? "",
						player_name: `${player.displayName} (${idx + 1}/${analyses.length})`,
						stats_line: statsLine,
						score_text: `${player.score}/100`,
						score_bar: { value: player.score, bar_fill_c: scoreColor },
					});
				}
			} else {
				// Key: show lobby score with color-coded emoji
				const emoji = lobbyScore >= 70 ? "✓" : lobbyScore >= 40 ? "~" : "✗";
				await a.setTitle(`${emoji} ${lobbyScore}\nLobby`);
			}
		}
	}

	/**
	 * Analyze a single teammate.
	 */
	private async analyzePlayer(player: LcuChampSelectPlayer, session: LcuChampSelectSession): Promise<PlayerAnalysis> {
		const analysis: PlayerAnalysis = {
			puuid: player.puuid,
			displayName: "Player",
			championId: player.championId,
			assignedPosition: player.assignedPosition,
			isAutofill: false,
			winRate: 50,
			gamesOnChamp: 0,
			recentForm: "unknown",
			rank: "Unranked",
			score: 50,
		};

		try {
			// Get summoner name
			const summoner = await lcuApi.getSummonerByPuuid(player.puuid);
			if (summoner) {
				analysis.displayName = summoner.gameName ?? summoner.displayName ?? "Player";
			}

			// Get ranked stats
			const ranked = await lcuApi.get<LcuRankedStats>(`/lol-ranked/v1/ranked-stats/${encodeURIComponent(player.puuid)}`);
			if (ranked?.queueMap?.RANKED_SOLO_5x5) {
				const soloQ = ranked.queueMap.RANKED_SOLO_5x5;
				const totalGames = soloQ.wins + soloQ.losses;
				if (totalGames > 0) {
					analysis.winRate = Math.round((soloQ.wins / totalGames) * 100);
				}
				analysis.rank = `${soloQ.tier} ${soloQ.division}`;
			}

			// Get match history for champion-specific stats
			const history = await lcuApi.get<LcuMatchHistory>(
				`/lol-match-history/v1/products/lol/${encodeURIComponent(player.puuid)}/matches?begIndex=0&endIndex=20`
			);

			if (history?.games?.games) {
				const games = history.games.games;
				
				// Count games on this champion
				let champWins = 0;
				let champGames = 0;
				let recentWins = 0;
				const recentCount = Math.min(5, games.length);

				for (let i = 0; i < games.length; i++) {
					const game = games[i];
					const participant = game.participants?.[0];
					if (!participant) continue;

					// Check if same champion
					if (participant.championId === player.championId) {
						champGames++;
						if (participant.stats.win) champWins++;
					}

					// Recent form (last 5 games)
					if (i < recentCount && participant.stats.win) {
						recentWins++;
					}
				}

				analysis.gamesOnChamp = champGames;
				if (champGames > 0) {
					analysis.winRate = Math.round((champWins / champGames) * 100);
				}

				// Recent form
				if (recentCount >= 3) {
					const recentWinRate = recentWins / recentCount;
					if (recentWinRate >= 0.6) {
						analysis.recentForm = "hot";
					} else if (recentWinRate <= 0.3) {
						analysis.recentForm = "cold";
					} else {
						analysis.recentForm = "neutral";
					}
				}
			}

			// Detect autofill (simplified — just check if very few games on role)
			// In a real implementation, we'd check position frequency in match history
			if (analysis.gamesOnChamp === 0 && player.championId > 0) {
				analysis.isAutofill = true;
			}

			// Calculate player score
			analysis.score = this.calculatePlayerScore(analysis);

		} catch (e) {
			logger.warn(`Failed to analyze player ${player.puuid}: ${e}`);
		}

		return analysis;
	}

	/**
	 * Calculate a player's "safe to play with" score (0-100).
	 */
	private calculatePlayerScore(player: PlayerAnalysis): number {
		let score = 50;

		// Win rate component (up to ±25 points)
		score += (player.winRate - 50) * 0.5;

		// Games on champion (up to +20 points)
		score += Math.min(20, player.gamesOnChamp * 2);

		// Recent form (±10 points)
		if (player.recentForm === "hot") score += 10;
		if (player.recentForm === "cold") score -= 10;

		// Autofill penalty (-15 points)
		if (player.isAutofill) score -= 15;

		// Clamp to 0-100
		return Math.max(0, Math.min(100, Math.round(score)));
	}

	/**
	 * Calculate overall lobby score.
	 */
	private calculateLobbyScore(players: PlayerAnalysis[]): number {
		if (players.length === 0) return 50;
		const avg = players.reduce((sum, p) => sum + p.score, 0) / players.length;
		// Penalty for any very low-score player
		const hasLiability = players.some((p) => p.score < 30);
		return Math.round(hasLiability ? avg - 10 : avg);
	}

	/**
	 * Format player stats for display.
	 */
	private formatStatsLine(player: PlayerAnalysis): string {
		const parts: string[] = [];

		// Win rate
		parts.push(`${player.winRate}% WR`);

		// Games on champ
		if (player.gamesOnChamp > 0) {
			parts.push(`${player.gamesOnChamp}g`);
		} else if (player.championId > 0) {
			parts.push("1st time!");
		}

		// Form indicator
		if (player.recentForm === "hot") parts.push("🔥");
		if (player.recentForm === "cold") parts.push("❄️");

		// Autofill warning
		if (player.isAutofill) parts.push("⚠️AF");

		return parts.join(" | ");
	}
}

type DodgeAdvisorSettings = {
	// No settings needed
};

interface PlayerAnalysis {
	puuid: string;
	displayName: string;
	championId: number;
	assignedPosition: string;
	isAutofill: boolean;
	winRate: number;
	gamesOnChamp: number;
	recentForm: "hot" | "cold" | "neutral" | "unknown";
	rank: string;
	score: number;
}
