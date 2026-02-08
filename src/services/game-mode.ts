import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "./lcu-connector";
import { lcuApi } from "./lcu-api";
import type { GameflowPhase } from "../types/lol";

const logger = streamDeck.logger.createScope("GameMode");

/**
 * Known game modes returned by the LCU `/lol-gameflow/v1/session` endpoint.
 * `gameData.queue.gameMode` field values:
 */
export type GameMode = "CLASSIC" | "ARAM" | "TFT" | "CHERRY" | "UNKNOWN" | "NONE";

/** TFT queue IDs for reference */
export const TFT_QUEUE_IDS = new Set([1090, 1100, 1130, 1160, 1170]);

/**
 * Minimal shape of the gameflow session we care about.
 * The full response has many more fields; we only extract what's needed.
 */
interface GameflowSession {
	gameData?: {
		queue?: {
			id?: number;
			gameMode?: string;
			type?: string;
			description?: string;
		};
	};
	phase?: string;
}

/**
 * Centralised game-mode detection.
 *
 * Actions import `gameMode` (singleton) and call:
 *   - `gameMode.get()`        → current GameMode ("CLASSIC" | "TFT" | …)
 *   - `gameMode.isTFT()`      → shortcut boolean
 *   - `gameMode.isLoL()`      → CLASSIC or ARAM (Summoner's Rift / ARAM)
 *   - `gameMode.getPhase()`   → cached GameflowPhase
 *
 * The module polls once every 2 seconds (same cadence as game-status).
 * Because it goes through `lcuApi.get()`, it benefits from the 500 ms
 * dedup cache — multiple actions reading in the same tick share one HTTP call.
 */
class GameModeService {
	private currentMode: GameMode = "NONE";
	private currentPhase: GameflowPhase = "None";
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private listeners: Array<(mode: GameMode, phase: GameflowPhase) => void> = [];

	/** Start background polling (idempotent). */
	start(): void {
		if (this.pollTimer) return;
		this.refresh().catch(() => {});
		this.pollTimer = setInterval(() => this.refresh().catch(() => {}), 2000);
		logger.info("GameMode service started");
	}

	/** Stop background polling. */
	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	// ── Getters ──────────────────────────────────────────────────

	get(): GameMode {
		return this.currentMode;
	}

	isTFT(): boolean {
		return this.currentMode === "TFT";
	}

	/** True when game mode is Summoner's Rift (CLASSIC) or Howling Abyss (ARAM). */
	isLoL(): boolean {
		return this.currentMode === "CLASSIC" || this.currentMode === "ARAM";
	}

	/** True for Arena / other rotating modes. */
	isArena(): boolean {
		return this.currentMode === "CHERRY";
	}

	/** True when playing ARAM (Howling Abyss). */
	isARAM(): boolean {
		return this.currentMode === "ARAM";
	}

	getPhase(): GameflowPhase {
		return this.currentPhase;
	}

	// ── Events ───────────────────────────────────────────────────

	/**
	 * Register a listener that fires whenever the game mode or phase changes.
	 * Returns an unsubscribe function.
	 */
	onChange(fn: (mode: GameMode, phase: GameflowPhase) => void): () => void {
		this.listeners.push(fn);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== fn);
		};
	}

	// ── Internal ─────────────────────────────────────────────────

	private async refresh(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			this.update("NONE", "None");
			return;
		}

		// Always get the phase (cheap, cached)
		const phase = await lcuApi.getGameflowPhase();

		// Only fetch the full session when we're actually in a lobby/game
		// to avoid unnecessary requests when idling at "None"
		if (phase === "None") {
			this.update("NONE", phase);
			return;
		}

		const session = await lcuApi.get<GameflowSession>("/lol-gameflow/v1/session");
		const rawMode = session?.gameData?.queue?.gameMode ?? "";

		let mode: GameMode;
		switch (rawMode) {
			case "CLASSIC":
				mode = "CLASSIC";
				break;
			case "ARAM":
				mode = "ARAM";
				break;
			case "TFT":
				mode = "TFT";
				break;
			case "CHERRY":
				mode = "CHERRY";
				break;
			case "":
				// No queue info yet (e.g. just opened lobby) — assume NONE
				mode = "NONE";
				break;
			default:
				mode = "UNKNOWN";
				logger.debug(`Unknown game mode: "${rawMode}"`);
				break;
		}

		this.update(mode, phase);
	}

	private update(mode: GameMode, phase: GameflowPhase): void {
		const changed = mode !== this.currentMode || phase !== this.currentPhase;
		if (!changed) return;

		const oldMode = this.currentMode;
		const oldPhase = this.currentPhase;
		this.currentMode = mode;
		this.currentPhase = phase;

		logger.info(`Mode: ${oldMode}→${mode}, Phase: ${oldPhase}→${phase}`);

		for (const fn of this.listeners) {
			try {
				fn(mode, phase);
			} catch (e) {
				logger.error(`GameMode listener error: ${e}`);
			}
		}
	}
}

/** Singleton — import this in your actions. */
export const gameMode = new GameModeService();
