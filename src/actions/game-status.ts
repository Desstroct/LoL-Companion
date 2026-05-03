import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { spawn } from "node:child_process";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import type { GameflowPhase } from "../types/lol";

const logger = streamDeck.logger.createScope("GameStatus");

const PHASE_DISPLAY: Record<string, { label: string }> = {
	None: { label: "Status\nOffline" },
	Lobby: { label: "Status\nLobby" },
	Matchmaking: { label: "Status\nQueue..." },
	ReadyCheck: { label: "MATCH\nFOUND" },
	ChampSelect: { label: "Champ\nSelect" },
	GameStart: { label: "Status\nLoading" },
	InProgress: { label: "Status\nIn Game" },
	WaitingForStats: { label: "Status\nStats..." },
	EndOfGame: { label: "Status\nEnd" },
	Reconnect: { label: "Status\nReconnect" },
};

/** TFT-specific labels (override LoL ones) */
const TFT_PHASE_DISPLAY: Record<string, { label: string }> = {
	Lobby: { label: "TFT\nLobby" },
	Matchmaking: { label: "TFT\nQueue..." },
	ReadyCheck: { label: "TFT\nFOUND" },
	ChampSelect: { label: "TFT\nLoading" },
	GameStart: { label: "TFT\nLoading" },
	InProgress: { label: "TFT\nIn Game" },
	WaitingForStats: { label: "TFT\nStats..." },
	EndOfGame: { label: "TFT\nEnd" },
	Reconnect: { label: "TFT\nReconnect" },
};

/** Map LCU region codes to OP.GG region slugs */
const REGION_TO_OPGG: Record<string, string> = {
	EUW: "euw",
	EUNE: "eune",
	NA: "na",
	KR: "kr",
	JP: "jp",
	BR: "br",
	LAN: "lan",
	LAS: "las",
	OCE: "oce",
	TR: "tr",
	RU: "ru",
	PH: "ph",
	SG: "sg",
	TH: "th",
	TW: "tw",
	VN: "vn",
	ME: "me",
};

/**
 * Game Status action — shows the current LoL client state on a Stream Deck key.
 * Displays: Offline / Lobby / Queue / Champ Select / In Game / etc.
 * Press to open OP.GG profile of current summoner.
 */
@action({ UUID: "com.desstroct.lol-api.game-status" })
export class GameStatus extends SingletonAction<GameStatusSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private currentPhase: GameflowPhase = "None";
	private detectedRegion: string | null = null;

	override onWillAppear(ev: WillAppearEvent<GameStatusSettings>): void | Promise<void> {
		this.startPolling();
		return ev.action.setTitle("LoL\nStatus");
	}

	override onWillDisappear(_ev: WillDisappearEvent<GameStatusSettings>): void | Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<GameStatusSettings>): Promise<void> {
		// Open OP.GG profile of current summoner
		if (lcuConnector.isConnected()) {
			try {
				const summoner = await lcuApi.getCurrentSummoner();
				if (summoner && summoner.gameName) {
					const name = encodeURIComponent(summoner.gameName);
					const tag = encodeURIComponent(summoner.tagLine || "EUW");

					// Auto-detect region from LCU, fallback to settings, then "euw"
					if (!this.detectedRegion) {
						const lcuRegion = await lcuApi.getRegion();
						if (lcuRegion) {
							this.detectedRegion = REGION_TO_OPGG[lcuRegion.toUpperCase()] ?? lcuRegion.toLowerCase();
						}
					}
					const region = ev.payload.settings.region ?? this.detectedRegion ?? "euw";
					const url = `https://www.op.gg/summoners/${region}/${name}-${tag}`;
						logger.info(`Opening OP.GG: ${url}`);
					if (process.platform === "darwin") {
						spawn("open", [url], { stdio: "ignore" });
					} else {
						spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
					}
					return;
				}
			} catch (e) {
				logger.error(`Failed to open OP.GG: ${e}`);
			}
		}
		// Fallback: force refresh
		await this.updateStatus();
	}

	private startPolling(): void {
		if (this.pollInterval) return;

		this.updateStatus().catch((e) => logger.error(`updateStatus error: ${e}`));
		this.pollInterval = setInterval(() => this.updateStatus().catch((e) => logger.error(`updateStatus error: ${e}`)), 2000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateStatus(): Promise<void> {
		let phase: GameflowPhase = "None";

		if (lcuConnector.isConnected()) {
			phase = await lcuApi.getGameflowPhase();
		}

		// If LCU says InProgress, double check with Game Client
		// Skip for TFT — the Live Client Data API doesn't serve TFT data
		let gameTimeSec = 0;
		if (phase === "InProgress" && !gameMode.isTFT()) {
			const inGame = await gameClient.isInGame();
			if (!inGame) {
				phase = "GameStart"; // Game is loading
			} else {
				gameTimeSec = await gameClient.getGameTime();
			}
		}

		if (phase !== this.currentPhase || (phase === "InProgress" && gameTimeSec > 0)) {
			this.currentPhase = phase;

			// Use TFT labels when the game mode is TFT
			const displayMap = gameMode.isTFT() ? TFT_PHASE_DISPLAY : PHASE_DISPLAY;
			const display = displayMap[phase] ?? PHASE_DISPLAY[phase] ?? PHASE_DISPLAY.None;

			// Show game time when in-game
			let label = display.label;
			if (phase === "InProgress" && gameTimeSec > 0) {
				const min = Math.floor(gameTimeSec / 60);
				const sec = Math.floor(gameTimeSec % 60);
				const timeStr = `${min}:${String(sec).padStart(2, "0")}`;
				label = gameMode.isTFT() ? `TFT\n${timeStr}` : `In Game\n${timeStr}`;
			}

			if (phase !== "InProgress") {
				logger.info(`Game phase changed: ${phase} (mode=${gameMode.get()})`);
			}

			// Update all visible instances of this action
			for (const a of this.actions) {
				await a.setTitle(label);
			}
		}
	}
}

type GameStatusSettings = {
	region?: string;
};
