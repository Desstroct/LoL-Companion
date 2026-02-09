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

/**
 * Game Status action — shows the current LoL client state on a Stream Deck key.
 * Displays: Offline / Lobby / Queue / Champ Select / In Game / etc.
 * Press to open OP.GG profile of current summoner.
 */
@action({ UUID: "com.desstroct.lol-api.game-status" })
export class GameStatus extends SingletonAction<GameStatusSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private currentPhase: GameflowPhase = "None";

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
					const region = ev.payload.settings.region ?? "euw";
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
		if (phase === "InProgress" && !gameMode.isTFT()) {
			const inGame = await gameClient.isInGame();
			if (!inGame) {
				phase = "GameStart"; // Game is loading
			}
		}

		if (phase !== this.currentPhase) {
			this.currentPhase = phase;

			// Use TFT labels when the game mode is TFT
			const displayMap = gameMode.isTFT() ? TFT_PHASE_DISPLAY : PHASE_DISPLAY;
			const display = displayMap[phase] ?? PHASE_DISPLAY[phase] ?? PHASE_DISPLAY.None;

			logger.info(`Game phase changed: ${phase} (mode=${gameMode.get()})`);

			// Update all visible instances of this action
			for (const a of this.actions) {
				await a.setTitle(display.label);
			}
		}
	}
}

type GameStatusSettings = {
	region?: string;
};
