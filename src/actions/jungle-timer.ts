import {
	action,
	DialRotateEvent,
	DialUpEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { gameClient } from "../services/game-client";
import type { GameEvent } from "../types/lol";

const logger = streamDeck.logger.createScope("JungleTimer");

// Respawn timers in seconds
const DRAGON_RESPAWN = 300; // 5 min
const ELDER_RESPAWN = 360; // 6 min
const BARON_RESPAWN = 360; // 6 min
const BARON_SPAWN_TIME = 1200; // 20:00
const DRAGON_SPAWN_TIME = 300; // 5:00

const DRAGON_TYPE_EMOJI: Record<string, string> = {
	Fire: "INF",
	Water: "OCE",
	Air: "CLD",
	Earth: "MTN",
	Hextech: "HEX",
	Chemtech: "CHM",
	Elder: "ELD",
};

/**
 * Jungle Timer action — tracks Dragon / Baron respawn timers.
 *
 * Shows countdown until objective respawns. Detects kills via the
 * Game Client event API and starts the appropriate respawn timer.
 *
 * Settings: objective = "dragon" | "baron"
 *
 * Press the key to manually start a timer (if event was missed).
 */
@action({ UUID: "com.desstroct.lol-api.jungle-timer" })
export class JungleTimer extends SingletonAction<JungleTimerSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private processedEventIds: Set<number> = new Set();
	/** Per-dial instance state: which objective is being viewed */
	private dialStates: Map<string, { objective: "dragon" | "baron" }> = new Map();

	// Dragon state
	private dragonKillTime: number | null = null;
	private dragonCount = 0;
	private lastDragonType = "";
	private isElderPhase = false;

	// Baron state
	private baronKillTime: number | null = null;
	private baronAlive = false;

	override onWillAppear(ev: WillAppearEvent<JungleTimerSettings>): void | Promise<void> {
		this.startPolling();
		const obj = ev.payload.settings.objective ?? "dragon";
		if (ev.action.isDial()) {
			this.getDialObjective(ev.action.id, obj);
			return ev.action.setFeedback({
				title: obj === "dragon" ? "🐲 DRAGON" : "👑 BARON",
				timer: "--:--",
				status: "Waiting...",
				progress: { value: 0 },
			});
		}
		return ev.action.setTitle(obj === "dragon" ? "Dragon" : "Baron");
	}

	override onWillDisappear(ev: WillDisappearEvent<JungleTimerSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<JungleTimerSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const objective = settings.objective ?? "dragon";
		await this.manualTimer(objective);
	}

	/** Dial rotation: toggle dragon ↔ baron */
	override async onDialRotate(ev: DialRotateEvent<JungleTimerSettings>): Promise<void> {
		const ds = this.getDialObjective(ev.action.id);
		ds.objective = ds.objective === "dragon" ? "baron" : "dragon";
		await this.updateAll();
	}

	/** Dial press: manual timer for current objective */
	override async onDialUp(ev: DialUpEvent<JungleTimerSettings>): Promise<void> {
		const ds = this.getDialObjective(ev.action.id);
		await this.manualTimer(ds.objective);
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<JungleTimerSettings>): Promise<void> {
		await this.updateAll();
	}

	private getDialObjective(actionId: string, initial?: string): { objective: "dragon" | "baron" } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { objective: (initial as "dragon" | "baron") ?? "dragon" };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private async manualTimer(objective: string): Promise<void> {
		const gameTime = await gameClient.getGameTime();
		if (gameTime <= 0) return;

		if (objective === "dragon") {
			this.dragonKillTime = gameTime;
			logger.info(`Manual dragon timer at ${Math.floor(gameTime)}s`);
		} else {
			this.baronKillTime = gameTime;
			this.baronAlive = false;
			logger.info(`Manual baron timer at ${Math.floor(gameTime)}s`);
		}

		await this.updateAll();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.resetState();
		this.updateAll();
		this.pollInterval = setInterval(() => this.updateAll(), 1000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private resetState(): void {
		this.processedEventIds.clear();
		this.dragonKillTime = null;
		this.dragonCount = 0;
		this.lastDragonType = "";
		this.isElderPhase = false;
		this.baronKillTime = null;
		this.baronAlive = false;
	}

	private async updateAll(): Promise<void> {
		const allData = await gameClient.getAllData();

		if (!allData) {
			// Not in game
			for (const a of this.actions) {
				if (a.isDial()) {
					const ds = this.getDialObjective(a.id);
					await a.setFeedback({
						title: ds.objective === "dragon" ? "🐲 DRAGON" : "👑 BARON",
						timer: "--:--",
						status: "No game",
						progress: { value: 0 },
					});
				} else {
					const settings = (await a.getSettings()) as JungleTimerSettings;
					const obj = settings.objective ?? "dragon";
					await a.setTitle(obj === "dragon" ? "Dragon\n--:--" : "Baron\n--:--");
				}
			}
			return;
		}

		const gameTime = allData.gameData.gameTime;

		// Process events for kills
		this.processEvents(allData.events.Events, gameTime);

		// Update baron spawn state
		if (!this.baronAlive && gameTime >= BARON_SPAWN_TIME && this.baronKillTime === null) {
			this.baronAlive = true;
		}

		// Render each action instance
		for (const a of this.actions) {
			let objective: string;
			const isDial = a.isDial();

			if (isDial) {
				objective = this.getDialObjective(a.id).objective;
			} else {
				const settings = (await a.getSettings()) as JungleTimerSettings;
				objective = settings.objective ?? "dragon";
			}

			if (isDial) {
				const data = objective === "dragon"
					? this.getDragonDialData(gameTime)
					: this.getBaronDialData(gameTime);
				await a.setFeedback({
					title: data.title,
					timer: data.timer,
					status: data.status,
					progress: {
						value: data.progress,
						bar_fill_c: data.alive ? "#2ECC71" : "#E67E22",
					},
				});
			} else {
				if (objective === "dragon") {
					await a.setTitle(this.getDragonDisplay(gameTime));
				} else {
					await a.setTitle(this.getBaronDisplay(gameTime));
				}
			}
		}
	}

	private processEvents(events: GameEvent[], _gameTime: number): void {
		for (const ev of events) {
			if (this.processedEventIds.has(ev.EventID)) continue;
			this.processedEventIds.add(ev.EventID);

			if (ev.EventName === "DragonKill") {
				this.dragonKillTime = ev.EventTime;
				this.dragonCount++;
				this.lastDragonType = ev.DragonType ?? "";

				if (ev.DragonType === "Elder") {
					this.isElderPhase = true;
				}
				// After 4 dragons by one team → elder phase
				// We simplify: track count loosely, elder event will set isElderPhase
				logger.info(`Dragon killed: ${ev.DragonType} at ${Math.floor(ev.EventTime)}s (total: ${this.dragonCount})`);
			}

			if (ev.EventName === "BaronKill") {
				this.baronKillTime = ev.EventTime;
				this.baronAlive = false;
				logger.info(`Baron killed at ${Math.floor(ev.EventTime)}s`);
			}
		}
	}

	private getDragonDialData(gameTime: number): { title: string; timer: string; status: string; progress: number; alive: boolean } {
		if (gameTime < DRAGON_SPAWN_TIME && this.dragonKillTime === null) {
			const remaining = DRAGON_SPAWN_TIME - gameTime;
			const pct = Math.round(((DRAGON_SPAWN_TIME - remaining) / DRAGON_SPAWN_TIME) * 100);
			return { title: "🐲 DRAGON", timer: formatTime(remaining), status: "First spawn", progress: pct, alive: false };
		}

		if (this.dragonKillTime !== null) {
			const respawn = this.isElderPhase ? ELDER_RESPAWN : DRAGON_RESPAWN;
			const spawnAt = this.dragonKillTime + respawn;
			const remaining = spawnAt - gameTime;

			if (remaining > 0) {
				const typeStr = this.lastDragonType
					? (DRAGON_TYPE_EMOJI[this.lastDragonType] ?? this.lastDragonType.substring(0, 3))
					: "";
				const pct = Math.round(((respawn - remaining) / respawn) * 100);
				return { title: "🐲 DRAGON", timer: formatTime(remaining), status: `${typeStr} #${this.dragonCount} · Respawn`, progress: pct, alive: false };
			}

			this.dragonKillTime = null;
		}

		return { title: "🐲 DRAGON", timer: "ALIVE", status: `#${this.dragonCount} · Kill it!`, progress: 100, alive: true };
	}

	private getBaronDialData(gameTime: number): { title: string; timer: string; status: string; progress: number; alive: boolean } {
		if (gameTime < BARON_SPAWN_TIME && this.baronKillTime === null) {
			const remaining = BARON_SPAWN_TIME - gameTime;
			const pct = Math.round(((BARON_SPAWN_TIME - remaining) / BARON_SPAWN_TIME) * 100);
			return { title: "👑 BARON", timer: formatTime(remaining), status: "First spawn", progress: pct, alive: false };
		}

		if (this.baronKillTime !== null) {
			const spawnAt = this.baronKillTime + BARON_RESPAWN;
			const remaining = spawnAt - gameTime;

			if (remaining > 0) {
				const pct = Math.round(((BARON_RESPAWN - remaining) / BARON_RESPAWN) * 100);
				return { title: "👑 BARON", timer: formatTime(remaining), status: "Respawning...", progress: pct, alive: false };
			}

			this.baronKillTime = null;
			this.baronAlive = true;
		}

		if (this.baronAlive) {
			return { title: "👑 BARON", timer: "ALIVE", status: "Fight now!", progress: 100, alive: true };
		}

		const remaining = BARON_SPAWN_TIME - gameTime;
		const pct = Math.round(((BARON_SPAWN_TIME - remaining) / BARON_SPAWN_TIME) * 100);
		return { title: "👑 BARON", timer: formatTime(remaining), status: "Spawns at 20:00", progress: pct, alive: false };
	}

	private getDragonDisplay(gameTime: number): string {
		// Before first dragon spawns
		if (gameTime < DRAGON_SPAWN_TIME && this.dragonKillTime === null) {
			const remaining = DRAGON_SPAWN_TIME - gameTime;
			return `Dragon\n${formatTime(remaining)}`;
		}

		// Dragon is on respawn timer
		if (this.dragonKillTime !== null) {
			const respawn = this.isElderPhase ? ELDER_RESPAWN : DRAGON_RESPAWN;
			const spawnAt = this.dragonKillTime + respawn;
			const remaining = spawnAt - gameTime;

			if (remaining > 0) {
				return `Dragon #${this.dragonCount}\n${formatTime(remaining)}`;
			}

			// Respawn timer expired → dragon is alive
			this.dragonKillTime = null;
		}

		// Dragon is alive
		return `Dragon\nALIVE`;
	}

	private getBaronDisplay(gameTime: number): string {
		// Before baron spawns
		if (gameTime < BARON_SPAWN_TIME && this.baronKillTime === null) {
			const remaining = BARON_SPAWN_TIME - gameTime;
			return `Baron\n${formatTime(remaining)}`;
		}

		// Baron is on respawn timer
		if (this.baronKillTime !== null) {
			const spawnAt = this.baronKillTime + BARON_RESPAWN;
			const remaining = spawnAt - gameTime;

			if (remaining > 0) {
				return `Baron\n${formatTime(remaining)}`;
			}

			// Respawn timer expired
			this.baronKillTime = null;
			this.baronAlive = true;
		}

		// Baron is alive
		if (this.baronAlive) {
			return `Baron\nALIVE`;
		}

		// Waiting for baron to spawn
		return `Baron\n${formatTime(BARON_SPAWN_TIME - gameTime)}`;
	}
}

function formatTime(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	const m = Math.floor(s / 60);
	const sec = s % 60;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

type JungleTimerSettings = {
	objective?: "dragon" | "baron";
};
