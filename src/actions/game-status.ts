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
import { gameClient } from "../services/game-client";
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
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<GameStatusSettings>): Promise<void> {
		// Force refresh
		await this.updateStatus();
	}

	private startPolling(): void {
		if (this.pollInterval) return;

		this.updateStatus();
		this.pollInterval = setInterval(() => this.updateStatus(), 2000);
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
		if (phase === "InProgress") {
			const inGame = await gameClient.isInGame();
			if (!inGame) {
				phase = "GameStart"; // Game is loading
			}
		}

		if (phase !== this.currentPhase) {
			this.currentPhase = phase;
			const display = PHASE_DISPLAY[phase] ?? PHASE_DISPLAY.None;

			logger.info(`Game phase changed: ${phase}`);

			// Update all visible instances of this action
			for (const a of this.actions) {
				await a.setTitle(display.label);
			}
		}
	}
}

type GameStatusSettings = Record<string, never>;
