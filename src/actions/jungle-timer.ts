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
import { gameMode } from "../services/game-mode";
import { getDragonIcon, getBaronIcon, getHeraldIcon, getGrubsIcon } from "../services/lol-icons";
import type { GameEvent } from "../types/lol";

const logger = streamDeck.logger.createScope("JungleTimer");

// ──────────── Game timeline constants (Season 14+) ────────────
// BOT side pit
const DRAGON_SPAWN_TIME = 300;   // 5:00
const DRAGON_RESPAWN = 300;      // 5 min
const ELDER_RESPAWN = 360;       // 6 min

// TOP side pit: Grubs (5:00→14:00) → Herald (14:00→19:45) → Baron (20:00+)
const GRUBS_SPAWN_TIME = 300;    // 5:00
const GRUBS_RESPAWN = 240;       // ~4 min between waves
const GRUBS_REMOVED_TIME = 840;  // 14:00 — herald replaces grubs

const HERALD_SPAWN_TIME = 840;   // 14:00
const HERALD_REMOVED_TIME = 1185; // 19:45 — baron pit opens

const BARON_SPAWN_TIME = 1200;   // 20:00
const BARON_RESPAWN = 360;       // 6 min

type Objective = "dragon" | "grubs" | "herald" | "baron";
const OBJECTIVE_CYCLE: Objective[] = ["dragon", "grubs", "herald", "baron"];

const DRAGON_TYPE_SHORT: Record<string, string> = {
	Fire: "INF",
	Water: "OCE",
	Air: "CLD",
	Earth: "MTN",
	Hextech: "HEX",
	Chemtech: "CHM",
	Elder: "ELD",
};

/**
 * Jungle Timer action — tracks Dragon, Voidgrubs, Rift Herald, and Baron
 * respawn timers using the Game Client live event API.
 *
 * Settings: objective = "dragon" | "grubs" | "herald" | "baron"
 * Dial: rotate to cycle objectives, press to start manual timer, touch to refresh.
 * Key: press to start manual timer for the configured objective.
 */
@action({ UUID: "com.desstroct.lol-api.jungle-timer" })
export class JungleTimer extends SingletonAction<JungleTimerSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private processedEventIds: Set<number> = new Set();
	private dialStates: Map<string, { objective: Objective }> = new Map();

	// ── Dragon state ──
	private dragonKillTime: number | null = null;
	private dragonCount = 0;
	private lastDragonType = "";
	private isElderPhase = false;
	private mapTerrain = "";

	// ── Voidgrubs (Horde) state ──
	private grubsKilled = 0;          // total grubs killed (max 6)
	private grubsWaveKills = 0;       // kills in current wave (max 3)
	private grubsLastKillTime: number | null = null;

	// ── Rift Herald state ──
	private heraldKillTime: number | null = null;
	private heraldAlive = false;

	// ── Baron state ──
	private baronKillTime: number | null = null;
	private baronAlive = false;

	// ─────────── Lifecycle ───────────

	override onWillAppear(ev: WillAppearEvent<JungleTimerSettings>): void | Promise<void> {
		this.startPolling();
		const obj = ev.payload.settings.objective ?? "dragon";
		if (ev.action.isDial()) {
			this.getDialObjective(ev.action.id, obj);
			return ev.action.setFeedback({
				obj_icon: "",
				title: objectiveLabel(obj),
				timer: "--:--",
				status: "Waiting...",
				progress: { value: 0 },
			});
		}
		return ev.action.setTitle(`${objectiveDisplayName(obj)}\n--:--`);
	}

	override onWillDisappear(ev: WillDisappearEvent<JungleTimerSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<JungleTimerSettings>): Promise<void> {
		const obj = ev.payload.settings.objective ?? "dragon";
		await this.manualTimer(obj);
	}

	override async onDialRotate(ev: DialRotateEvent<JungleTimerSettings>): Promise<void> {
		const ds = this.getDialObjective(ev.action.id);
		const idx = OBJECTIVE_CYCLE.indexOf(ds.objective);
		const next = (idx + ev.payload.ticks + OBJECTIVE_CYCLE.length * 100) % OBJECTIVE_CYCLE.length;
		ds.objective = OBJECTIVE_CYCLE[next];
		await this.updateAll();
	}

	override async onDialUp(ev: DialUpEvent<JungleTimerSettings>): Promise<void> {
		const ds = this.getDialObjective(ev.action.id);
		await this.manualTimer(ds.objective);
	}

	override async onTouchTap(_ev: TouchTapEvent<JungleTimerSettings>): Promise<void> {
		await this.updateAll();
	}

	// ─────────── Helpers ───────────

	private getDialObjective(actionId: string, initial?: string): { objective: Objective } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { objective: (initial as Objective) ?? "dragon" };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private async manualTimer(objective: Objective): Promise<void> {
		const gameTime = await gameClient.getGameTime();
		if (gameTime <= 0) return;

		switch (objective) {
			case "dragon":
				this.dragonKillTime = gameTime;
				logger.info(`Manual dragon timer at ${fmt(gameTime)}`);
				break;
			case "grubs":
				this.grubsLastKillTime = gameTime;
				this.grubsWaveKills = 0; // mark wave as cleared
				this.grubsKilled = Math.min(this.grubsKilled + 3, 6);
				logger.info(`Manual grubs wave cleared at ${fmt(gameTime)} (total: ${this.grubsKilled})`);
				break;
			case "herald":
				this.heraldKillTime = gameTime;
				this.heraldAlive = false;
				logger.info(`Manual herald timer at ${fmt(gameTime)}`);
				break;
			case "baron":
				this.baronKillTime = gameTime;
				this.baronAlive = false;
				logger.info(`Manual baron timer at ${fmt(gameTime)}`);
				break;
		}
		await this.updateAll();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.resetState();
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 1000);
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
		this.mapTerrain = "";
		this.grubsKilled = 0;
		this.grubsWaveKills = 0;
		this.grubsLastKillTime = null;
		this.heraldKillTime = null;
		this.heraldAlive = false;
		this.baronKillTime = null;
		this.baronAlive = false;
	}

	// ─────────── Main update loop ───────────

	private async updateAll(): Promise<void> {
		// TFT has no jungle objectives / Live Client Data API
		if (gameMode.isTFT()) {
			await this.renderIdle("N/A TFT");
			return;
		}

		const allData = await gameClient.getAllData();

		if (!allData) {
			await this.renderIdle();
			return;
		}

		const gameTime = allData.gameData.gameTime;
		if (allData.gameData.mapTerrain && allData.gameData.mapTerrain !== "Default") {
			this.mapTerrain = allData.gameData.mapTerrain;
		}
		this.processEvents(allData.events.Events, gameTime);

		// Update spawn states based on game time
		if (!this.heraldAlive && gameTime >= HERALD_SPAWN_TIME && gameTime < HERALD_REMOVED_TIME && this.heraldKillTime === null) {
			this.heraldAlive = true;
		}
		if (!this.baronAlive && gameTime >= BARON_SPAWN_TIME && this.baronKillTime === null) {
			this.baronAlive = true;
		}

		// Render each action
		for (const a of this.actions) {
			let objective: Objective;
			const isDial = a.isDial();

			if (isDial) {
				objective = this.getDialObjective(a.id).objective;
			} else {
				const settings = (await a.getSettings()) as JungleTimerSettings;
				objective = settings.objective ?? "dragon";
			}

			const icon = await this.getObjectiveIcon(objective, gameTime);

			if (isDial) {
				const data = this.getDialData(objective, gameTime);
				await a.setFeedback({
					obj_icon: icon ?? "",
					title: data.title,
					timer: data.timer,
					status: data.status,
					progress: {
						value: data.progress,
						bar_fill_c: data.alive ? "#2ECC71" : data.expired ? "#666666" : "#E67E22",
					},
				});
			} else {
				if (icon) await a.setImage(icon);
				await a.setTitle(this.getKeyDisplay(objective, gameTime));
			}
		}
	}

	// ─────────── Idle render (no game) ───────────

	private async renderIdle(statusOverride?: string): Promise<void> {
		const status = statusOverride ?? "No game";
		for (const a of this.actions) {
			if (a.isDial()) {
				const ds = this.getDialObjective(a.id);
				const icon = await this.getIdleIcon(ds.objective);
				await a.setFeedback({
					obj_icon: icon ?? "",
					title: objectiveLabel(ds.objective),
					timer: "--:--",
					status,
					progress: { value: 0 },
				});
			} else {
				const settings = (await a.getSettings()) as JungleTimerSettings;
				const obj = settings.objective ?? "dragon";
				const icon = await this.getIdleIcon(obj);
				if (icon) {
					await a.setImage(icon);
				} else {
					await a.setImage("");
				}
				await a.setTitle(`${objectiveDisplayName(obj)}\n${statusOverride ?? "--:--"}`);
			}
		}
	}

	// ─────────── Event processing ───────────

	private processEvents(events: GameEvent[], _gameTime: number): void {
		for (const ev of events) {
			if (this.processedEventIds.has(ev.EventID)) continue;
			this.processedEventIds.add(ev.EventID);

			switch (ev.EventName) {
				case "DragonKill":
					this.dragonKillTime = ev.EventTime;
					this.dragonCount++;
					this.lastDragonType = ev.DragonType ?? "";
					if (ev.DragonType === "Elder") this.isElderPhase = true;
					logger.info(`Dragon killed: ${ev.DragonType} at ${fmt(ev.EventTime)} (total: ${this.dragonCount})`);
					break;

				case "HordeKill":
					// Voidgrub killed (one at a time)
					this.grubsKilled = Math.min(this.grubsKilled + 1, 6);
					this.grubsWaveKills++;
					this.grubsLastKillTime = ev.EventTime;
					if (this.grubsWaveKills >= 3) {
						this.grubsWaveKills = 0; // wave cleared, next wave timer starts
					}
					logger.info(`Voidgrub killed at ${fmt(ev.EventTime)} (total: ${this.grubsKilled})`);
					break;

				case "HeraldKill":
					this.heraldKillTime = ev.EventTime;
					this.heraldAlive = false;
					logger.info(`Rift Herald killed at ${fmt(ev.EventTime)}`);
					break;

				case "BaronKill":
					this.baronKillTime = ev.EventTime;
					this.baronAlive = false;
					logger.info(`Baron killed at ${fmt(ev.EventTime)}`);
					break;
			}
		}
	}

	// ─────────── Icons ───────────

	private async getObjectiveIcon(objective: Objective, gameTime: number): Promise<string | null> {
		switch (objective) {
			case "dragon":
				if (this.lastDragonType) return getDragonIcon(this.lastDragonType);
				if (this.isElderPhase) return getDragonIcon("Elder");
				return getDragonIcon(this.getNextDragonType());
			case "grubs":
				if (gameTime >= GRUBS_REMOVED_TIME && this.grubsKilled >= 6) return getGrubsIcon();
				return getGrubsIcon();
			case "herald":
				return getHeraldIcon();
			case "baron":
				return getBaronIcon();
		}
	}

	private async getIdleIcon(objective: Objective): Promise<string | null> {
		switch (objective) {
			case "dragon": return getDragonIcon(this.isElderPhase ? "Elder" : "Fire");
			case "grubs": return getGrubsIcon();
			case "herald": return getHeraldIcon();
			case "baron": return getBaronIcon();
		}
	}

	/**
	 * Determine the next dragon type based on mapTerrain.
	 * mapTerrain values: "Mountain", "Infernal", "Ocean", "Cloud", "Hextech", "Chemtech", "Default"
	 * Maps to icon keys: "Earth", "Fire", "Water", "Air", "Hextech", "Chemtech"
	 */
	private getNextDragonType(): string {
		if (this.isElderPhase) return "Elder";
		const terrainMap: Record<string, string> = {
			Mountain: "Earth",
			Infernal: "Fire",
			Ocean: "Water",
			Cloud: "Air",
			Hextech: "Hextech",
			Chemtech: "Chemtech",
		};
		return terrainMap[this.mapTerrain] ?? "Fire";
	}

	// ─────────── Dial data ───────────

	private getDialData(objective: Objective, gameTime: number): DialData {
		switch (objective) {
			case "dragon": return this.getDragonData(gameTime);
			case "grubs": return this.getGrubsData(gameTime);
			case "herald": return this.getHeraldData(gameTime);
			case "baron": return this.getBaronData(gameTime);
		}
	}

	private getDragonData(gt: number): DialData {
		const label = "🐲 DRAGON";

		// Before first spawn
		if (gt < DRAGON_SPAWN_TIME && this.dragonKillTime === null) {
			const rem = DRAGON_SPAWN_TIME - gt;
			return { title: label, timer: formatTime(rem), status: "First spawn 5:00", progress: pct(DRAGON_SPAWN_TIME - rem, DRAGON_SPAWN_TIME), alive: false, expired: false };
		}

		// Respawning
		if (this.dragonKillTime !== null) {
			const respawn = this.isElderPhase ? ELDER_RESPAWN : DRAGON_RESPAWN;
			const rem = (this.dragonKillTime + respawn) - gt;
			if (rem > 0) {
				const typeStr = this.lastDragonType ? (DRAGON_TYPE_SHORT[this.lastDragonType] ?? this.lastDragonType.substring(0, 3)) : "";
				return { title: label, timer: formatTime(rem), status: `${typeStr} #${this.dragonCount} · Respawn`, progress: pct(respawn - rem, respawn), alive: false, expired: false };
			}
			this.dragonKillTime = null;
		}

		return { title: label, timer: "ALIVE", status: `#${this.dragonCount + 1} · Kill it!`, progress: 100, alive: true, expired: false };
	}

	private getGrubsData(gt: number): DialData {
		const label = "🪲 GRUBS";

		// Grubs removed after 14:00
		if (gt >= GRUBS_REMOVED_TIME) {
			return { title: label, timer: "GONE", status: `${this.grubsKilled}/6 killed`, progress: 0, alive: false, expired: true };
		}

		// All 6 killed
		if (this.grubsKilled >= 6) {
			return { title: label, timer: "DONE", status: "6/6 killed ✅", progress: 100, alive: false, expired: true };
		}

		// Before first spawn
		if (gt < GRUBS_SPAWN_TIME) {
			const rem = GRUBS_SPAWN_TIME - gt;
			return { title: label, timer: formatTime(rem), status: "Spawns at 5:00", progress: pct(GRUBS_SPAWN_TIME - rem, GRUBS_SPAWN_TIME), alive: false, expired: false };
		}

		// Wave cleared, next wave respawning
		if (this.grubsLastKillTime !== null && this.grubsWaveKills === 0 && this.grubsKilled < 6 && this.grubsKilled > 0) {
			const spawnAt = this.grubsLastKillTime + GRUBS_RESPAWN;
			const rem = spawnAt - gt;
			if (rem > 0) {
				return { title: label, timer: formatTime(rem), status: `${this.grubsKilled}/6 · Next wave`, progress: pct(GRUBS_RESPAWN - rem, GRUBS_RESPAWN), alive: false, expired: false };
			}
		}

		// Grubs alive — show how many remain in wave
		const waveRemaining = 3 - this.grubsWaveKills;
		return { title: label, timer: "ALIVE", status: `${this.grubsKilled}/6 · ${waveRemaining} up`, progress: 100, alive: true, expired: false };
	}

	private getHeraldData(gt: number): DialData {
		const label = "🦀 HERALD";

		// Herald removed after 19:45
		if (gt >= HERALD_REMOVED_TIME) {
			return { title: label, timer: "GONE", status: "Baron pit now", progress: 0, alive: false, expired: true };
		}

		// Before herald spawns (< 14:00)
		if (gt < HERALD_SPAWN_TIME) {
			const rem = HERALD_SPAWN_TIME - gt;
			return { title: label, timer: formatTime(rem), status: "Spawns at 14:00", progress: pct(HERALD_SPAWN_TIME - rem, HERALD_SPAWN_TIME), alive: false, expired: false };
		}

		// Herald killed — no respawn in current patches
		if (this.heraldKillTime !== null) {
			return { title: label, timer: "DEAD", status: `Killed at ${fmt(this.heraldKillTime)}`, progress: 0, alive: false, expired: true };
		}

		// Herald alive
		if (this.heraldAlive) {
			const despawnIn = HERALD_REMOVED_TIME - gt;
			return { title: label, timer: "ALIVE", status: `Gone in ${formatTime(despawnIn)}`, progress: 100, alive: true, expired: false };
		}

		// Waiting to spawn
		const rem = HERALD_SPAWN_TIME - gt;
		return { title: label, timer: formatTime(Math.max(0, rem)), status: "Spawns at 14:00", progress: pct(HERALD_SPAWN_TIME - rem, HERALD_SPAWN_TIME), alive: false, expired: false };
	}

	private getBaronData(gt: number): DialData {
		const label = "👑 BARON";

		// Before baron spawns
		if (gt < BARON_SPAWN_TIME && this.baronKillTime === null) {
			const rem = BARON_SPAWN_TIME - gt;
			return { title: label, timer: formatTime(rem), status: "Spawns at 20:00", progress: pct(BARON_SPAWN_TIME - rem, BARON_SPAWN_TIME), alive: false, expired: false };
		}

		// Baron respawning
		if (this.baronKillTime !== null) {
			const rem = (this.baronKillTime + BARON_RESPAWN) - gt;
			if (rem > 0) {
				return { title: label, timer: formatTime(rem), status: "Respawning...", progress: pct(BARON_RESPAWN - rem, BARON_RESPAWN), alive: false, expired: false };
			}
			this.baronKillTime = null;
			this.baronAlive = true;
		}

		if (this.baronAlive) {
			return { title: label, timer: "ALIVE", status: "Fight now!", progress: 100, alive: true, expired: false };
		}

		// Fallback: waiting for spawn
		const rem = BARON_SPAWN_TIME - gt;
		return { title: label, timer: formatTime(Math.max(0, rem)), status: "Spawns at 20:00", progress: pct(BARON_SPAWN_TIME - rem, BARON_SPAWN_TIME), alive: false, expired: false };
	}

	// ─────────── Key display ───────────

	private getKeyDisplay(objective: Objective, gt: number): string {
		const data = this.getDialData(objective, gt);
		return `${objectiveDisplayName(objective)}\n${data.timer}`;
	}
}

// ─────────── Types & helpers ───────────

interface DialData {
	title: string;
	timer: string;
	status: string;
	progress: number;
	alive: boolean;
	expired: boolean;
}

type JungleTimerSettings = {
	objective?: Objective;
};

function objectiveLabel(obj: Objective): string {
	switch (obj) {
		case "dragon": return "🐲 DRAGON";
		case "grubs": return "🪲 GRUBS";
		case "herald": return "🦀 HERALD";
		case "baron": return "👑 BARON";
	}
}

function objectiveDisplayName(obj: Objective): string {
	switch (obj) {
		case "dragon": return "Dragon";
		case "grubs": return "Grubs";
		case "herald": return "Herald";
		case "baron": return "Baron";
	}
}

function formatTime(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	const m = Math.floor(s / 60);
	const sec = s % 60;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

function pct(elapsed: number, total: number): number {
	if (total <= 0) return 0;
	return Math.round(Math.min(100, Math.max(0, (elapsed / total) * 100)));
}

function fmt(seconds: number): string {
	return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
