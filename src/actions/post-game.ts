import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	type KeyAction,
	type DialAction,
	DialRotateEvent,
	TouchTapEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode, type GameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import type { GameflowPhase } from "../types/lol";

const logger = streamDeck.logger.createScope("PostGame");

// LoL color palette
const GOLD = "#C89B3C";
const DARK_BLUE = "#0A1428";
const GREEN = "#2ECC71";
const RED = "#E74C3C";
const BLUE = "#3498DB";

/** LCU match history endpoint — detailed per-participant stats */
const MATCH_HISTORY_URL = "/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=1";

/** Detailed match stats from LCU match history */
interface MatchStats {
	win: boolean;
	championName: string;
	kills: number;
	deaths: number;
	assists: number;
	cs: number;
	goldEarned: number;
	totalDamageDealt: number;
	visionScore: number;
	gameDuration: number; // seconds
	gameMode: string;
	queueId: number;
	gameId: number;
}

/** What we show — multiple pages the user can cycle through */
type DisplayPage = "overview" | "damage" | "details";
const PAGES: DisplayPage[] = ["overview", "damage", "details"];

type PostGameSettings = Record<string, never>;

/**
 * Post-Game Stats action — shows detailed game results after each match.
 *
 * Automatically detects when a game ends (via gameMode phase change to EndOfGame)
 * and fetches the latest match data from LCU match history.
 *
 * Displays: Win/Loss, KDA, CS, gold earned, damage dealt, vision score.
 *
 * Key press: force refresh
 * Dial rotate: cycle display pages (overview, damage, details)
 */
@action({ UUID: "com.desstroct.lol-api.post-game" })
export class PostGame extends SingletonAction<PostGameSettings> {
	private lastMatchStats: MatchStats | null = null;
	private lastGameId: number = 0;
	private displayPage: DisplayPage = "overview";
	private unsubscribeMode: (() => void) | null = null;
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private wasInGame = false;

	override onWillAppear(ev: WillAppearEvent<PostGameSettings>): void | Promise<void> {
		this.startListening();
		if (this.lastMatchStats) {
			return this.renderAll();
		}
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "Post-Game",
				result_text: "",
				kda_text: "No game yet",
				stat1_text: "",
				stat2_text: "",
				stat_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("Post\nGame");
	}

	override onWillDisappear(_ev: WillDisappearEvent<PostGameSettings>): void | Promise<void> {
		if (this.actions.length === 0) this.stopListening();
	}

	/** Key press: force refresh */
	override async onKeyDown(_ev: KeyDownEvent<PostGameSettings>): Promise<void> {
		await this.fetchLatestMatch();
		await this.renderAll();
	}

	/** Dial rotate: cycle display page */
	override async onDialRotate(ev: DialRotateEvent<PostGameSettings>): Promise<void> {
		const idx = PAGES.indexOf(this.displayPage);
		const next = (idx + (ev.payload.ticks > 0 ? 1 : -1) + PAGES.length) % PAGES.length;
		this.displayPage = PAGES[next];
		await this.renderAll();
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<PostGameSettings>): Promise<void> {
		await this.fetchLatestMatch();
		await this.renderAll();
	}

	private startListening(): void {
		// Listen for game phase changes
		if (!this.unsubscribeMode) {
			this.unsubscribeMode = gameMode.onChange((mode: GameMode, phase: GameflowPhase) => {
				// Track when we're in a game
				if (phase === "InProgress") {
					this.wasInGame = true;
				}

				// Detect game end — fetch match data
				if (this.wasInGame && (phase === "EndOfGame" || phase === "PreEndOfGame")) {
					this.wasInGame = false;
					// Small delay to ensure match history is updated
					setTimeout(() => {
						this.fetchLatestMatch()
							.then(() => this.renderAll())
							.catch((e) => logger.error(`Post-game fetch error: ${e}`));
					}, 3000);
				}
			});
		}

		// Also poll periodically to catch missed events
		if (!this.pollInterval) {
			this.pollInterval = setInterval(() => {
				// Only fetch if we don't have recent data and we're in EndOfGame/Lobby
				const phase = gameMode.getPhase();
				if (!this.lastMatchStats && (phase === "EndOfGame" || phase === "Lobby")) {
					this.fetchLatestMatch()
						.then(() => this.renderAll())
						.catch((e) => logger.error(`Post-game poll error: ${e}`));
				}
			}, 30_000);
		}
	}

	private stopListening(): void {
		if (this.unsubscribeMode) {
			this.unsubscribeMode();
			this.unsubscribeMode = null;
		}
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	/**
	 * Fetch the most recent match from LCU match history.
	 */
	private async fetchLatestMatch(): Promise<void> {
		if (!lcuConnector.isConnected()) return;

		try {
			const data = await lcuApi.get<LcuMatchHistoryResponse>(MATCH_HISTORY_URL);
			const games = data?.games?.games;
			if (!games || games.length === 0) {
				logger.debug("No recent matches in history");
				return;
			}

			// Most recent game
			const game = games[0];
			if (game.gameId === this.lastGameId) return; // Already displayed

			// Find the player's participant data
			const participant = game.participants?.[0];
			const stats = participant?.stats;
			if (!stats) {
				logger.warn("No participant stats in match history entry");
				return;
			}

			const champId = participant.championId;
			const champ = dataDragon.getChampionByKey(String(champId));

			this.lastMatchStats = {
				win: stats.win,
				championName: champ?.name ?? `Champ ${champId}`,
				kills: stats.kills ?? 0,
				deaths: stats.deaths ?? 0,
				assists: stats.assists ?? 0,
				cs: (stats.totalMinionsKilled ?? 0) + (stats.neutralMinionsKilled ?? 0),
				goldEarned: stats.goldEarned ?? 0,
				totalDamageDealt: stats.totalDamageDealtToChampions ?? 0,
				visionScore: stats.visionScore ?? 0,
				gameDuration: game.gameDuration ?? 0,
				gameMode: game.gameMode ?? "",
				queueId: game.queueId ?? 0,
				gameId: game.gameId,
			};
			this.lastGameId = game.gameId;
			this.displayPage = "overview"; // Reset to overview on new game

			logger.info(
				`Post-game: ${this.lastMatchStats.win ? "WIN" : "LOSS"} as ${this.lastMatchStats.championName} ` +
				`(${this.lastMatchStats.kills}/${this.lastMatchStats.deaths}/${this.lastMatchStats.assists}) ` +
				`${Math.round(this.lastMatchStats.gameDuration / 60)}min`,
			);
		} catch (e) {
			logger.error(`Failed to fetch match history: ${e}`);
		}
	}

	private async renderAll(): Promise<void> {
		for (const a of this.actions) {
			await this.renderAction(a);
		}
	}

	private async renderAction(
		a: DialAction<PostGameSettings> | KeyAction<PostGameSettings>,
	): Promise<void> {
		const stats = this.lastMatchStats;

		if (!stats) {
			if (a.isDial()) {
				await a.setFeedback({
					title: "Post-Game",
					result_text: "",
					kda_text: "No game yet",
					stat1_text: "",
					stat2_text: "",
					stat_bar: { value: 0 },
				});
			} else {
				await a.setImage("");
				await a.setTitle("Post\nGame");
			}
			return;
		}

		const kda = stats.deaths > 0
			? ((stats.kills + stats.assists) / stats.deaths).toFixed(1)
			: "Perfect";
		const kdaStr = `${stats.kills}/${stats.deaths}/${stats.assists}`;
		const csPerMin = stats.gameDuration > 0
			? (stats.cs / (stats.gameDuration / 60)).toFixed(1)
			: "0";
		const durationMin = Math.round(stats.gameDuration / 60);
		const goldK = (stats.goldEarned / 1000).toFixed(1);
		const dmgK = (stats.totalDamageDealt / 1000).toFixed(1);

		const resultColor = stats.win ? GREEN : RED;
		const resultText = stats.win ? "VICTORY" : "DEFEAT";

		if (a.isDial()) {
			// Dial display depends on current page
			switch (this.displayPage) {
				case "overview":
					await a.setFeedback({
						title: `${stats.championName} · ${durationMin}min`,
						result_text: { value: resultText, color: resultColor },
						kda_text: { value: `${kdaStr}  (${kda} KDA)`, color: "#FFF" },
						stat1_text: { value: `${stats.cs} CS (${csPerMin}/min)`, color: "#AAA" },
						stat2_text: { value: `${goldK}k gold · ${stats.visionScore} vision`, color: GOLD },
						stat_bar: {
							value: Math.min(100, Math.round(((stats.kills + stats.assists) / Math.max(1, stats.deaths)) * 20)),
							bar_fill_c: resultColor,
						},
					});
					break;

				case "damage":
					await a.setFeedback({
						title: `${stats.championName} · Damage`,
						result_text: { value: resultText, color: resultColor },
						kda_text: { value: `${dmgK}k damage to champs`, color: "#FFF" },
						stat1_text: { value: `${goldK}k gold earned`, color: GOLD },
						stat2_text: { value: `${kdaStr}  (${kda} KDA)`, color: "#AAA" },
						stat_bar: {
							value: Math.min(100, Math.round(stats.totalDamageDealt / 500)),
							bar_fill_c: BLUE,
						},
					});
					break;

				case "details":
					await a.setFeedback({
						title: `${stats.championName} · Details`,
						result_text: { value: resultText, color: resultColor },
						kda_text: { value: `${stats.cs} CS (${csPerMin}/min)`, color: "#FFF" },
						stat1_text: { value: `Vision: ${stats.visionScore}`, color: "#AAA" },
						stat2_text: { value: `Game: ${durationMin}min`, color: "#AAA" },
						stat_bar: {
							value: Math.min(100, Math.round(stats.visionScore * 3)),
							bar_fill_c: "#9B59B6",
						},
					});
					break;
			}
		} else {
			// Key: render SVG image
			const img = this.composeKeyImage(stats);
			if (img) await a.setImage(img);
			await a.setTitle("");
		}
	}

	/**
	 * Compose SVG key image for post-game display.
	 */
	private composeKeyImage(stats: MatchStats): string | null {
		const S = 144;
		const cx = S / 2;

		const kda = stats.deaths > 0
			? ((stats.kills + stats.assists) / stats.deaths).toFixed(1)
			: "Perfect";
		const kdaStr = `${stats.kills}/${stats.deaths}/${stats.assists}`;
		const csPerMin = stats.gameDuration > 0
			? (stats.cs / (stats.gameDuration / 60)).toFixed(1)
			: "0";
		const durationMin = Math.round(stats.gameDuration / 60);
		const goldK = (stats.goldEarned / 1000).toFixed(1);

		const resultColor = stats.win ? GREEN : RED;
		const resultText = stats.win ? "VICTORY" : "DEFEAT";
		const bgGlow = stats.win ? "rgba(46,204,113,0.15)" : "rgba(231,76,60,0.15)";

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="14" fill="${DARK_BLUE}"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="12" fill="none" stroke="${resultColor}" stroke-width="2" opacity="0.4"/>

			<!-- Result banner -->
			<rect x="10" y="8" width="${S - 20}" height="28" rx="6" fill="${bgGlow}"/>
			<text x="${cx}" y="28" font-size="20" fill="${resultColor}" text-anchor="middle" font-weight="bold" font-family="sans-serif">${resultText}</text>

			<!-- Champion name -->
			<text x="${cx}" y="52" font-size="13" fill="${GOLD}" text-anchor="middle" font-weight="600" font-family="sans-serif">${escapeXml(truncate(stats.championName, 14))} · ${durationMin}m</text>

			<!-- KDA -->
			<text x="${cx}" y="76" font-size="22" fill="#FFF" text-anchor="middle" font-weight="bold" font-family="sans-serif">${kdaStr}</text>
			<text x="${cx}" y="94" font-size="13" fill="#AAA" text-anchor="middle" font-family="sans-serif">${kda} KDA</text>

			<!-- Stats row -->
			<text x="${cx}" y="116" font-size="12" fill="#AAA" text-anchor="middle" font-family="sans-serif">${stats.cs} CS (${csPerMin}/m) · ${goldK}k gold</text>

			<!-- Vision -->
			<text x="${cx}" y="134" font-size="11" fill="#888" text-anchor="middle" font-family="sans-serif">Vision ${stats.visionScore}</text>
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}
}

// ── Helpers ──

function truncate(str: string, max: number): string {
	return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function escapeXml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── LCU Match History types ──

interface LcuMatchHistoryResponse {
	games: {
		games: LcuMatchEntry[];
	};
}

interface LcuMatchEntry {
	gameId: number;
	gameDuration: number;
	gameMode: string;
	queueId: number;
	participants: LcuParticipant[];
}

interface LcuParticipant {
	championId: number;
	stats: {
		win: boolean;
		kills: number;
		deaths: number;
		assists: number;
		totalMinionsKilled: number;
		neutralMinionsKilled: number;
		goldEarned: number;
		totalDamageDealtToChampions: number;
		visionScore: number;
	};
}
