import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	KeyDownEvent,
	DialRotateEvent,
	type DialAction,
	type KeyAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import { getDragonIcon, getBaronIcon, getHeraldIcon, prefetchObjectiveIcons } from "../services/lol-icons";
import type { GameEvent } from "../types/lol";

const logger = streamDeck.logger.createScope("ObjectiveTimer");

// ── Objective definitions (Season 2025 timers) ──

/** Dragon respawn: 5 min, Elder Dragon: 6 min */
const DRAGON_RESPAWN = 5 * 60;
const ELDER_RESPAWN = 6 * 60;
/** First dragon spawn at 5:00 */
const DRAGON_FIRST_SPAWN = 5 * 60;

/** Baron respawn: 6 min */
const BARON_RESPAWN = 6 * 60;
/** Baron spawns at 20:00 */
const BARON_SPAWN_TIME = 20 * 60;

/** Rift Herald spawns at 14:00, respawns after 4 min, despawns at 19:45 */
const HERALD_FIRST_SPAWN = 14 * 60;
const HERALD_RESPAWN = 4 * 60;
const HERALD_DESPAWN_TIME = 19 * 60 + 45;

/** Atakhan spawns at 20:00 */
const ATAKHAN_SPAWN_TIME = 20 * 60;

// Dragon types that count for soul
const ELEMENTAL_DRAKES = new Set(["Fire", "Earth", "Water", "Air", "Hextech", "Chemtech"]);

/** mapTerrain (from gameData) → DragonType (from kill events) */
const TERRAIN_TO_DRAKE: Record<string, string> = {
	Infernal:  "Fire",
	Ocean:     "Water",
	Mountain:  "Earth",
	Cloud:     "Air",
	Hextech:   "Hextech",
	Chemtech:  "Chemtech",
};

type ObjectiveType = "dragon" | "baron" | "herald" | "atakhan";

interface ObjectiveState {
	/** Which objective tab we're currently viewing (dial rotate) */
	viewIndex: number;
	/** Number of dragons killed so far (both teams) */
	dragonCount: number;
	/** Last dragon type killed (event DragonType value, e.g. "Fire") */
	lastDragonType: string;
	/** Current map terrain from gameData (e.g. "Infernal", "Ocean") — tracks active drake type */
	currentMapTerrain: string;
	/** Whether Elder Dragon phase has started (after soul) */
	isElderPhase: boolean;
	/** Spawn time of each objective (0 = not yet spawned, >0 = spawn timestamp) */
	dragonSpawnAt: number;
	baronSpawnAt: number;
	heraldSpawnAt: number;
	/** Herald killed count (max 2) */
	heraldKillCount: number;
	/** Whether Atakhan has spawned */
	atakhanSpawned: boolean;
	/** Track processed event IDs to avoid double-counting */
	processedEventIds: Set<number>;
	/** Game time of last update (detect new game) */
	lastGameTime: number;
	/** Cached CDragon icon data URIs */
	iconCache: Map<string, string>;
}

const OBJECTIVE_VIEWS: ObjectiveType[] = ["dragon", "baron", "herald"];

const DRAKE_EMOJI: Record<string, string> = {
	Fire: "🔥",
	Earth: "🌍",
	Water: "🌊",
	Air: "🌪️",
	Hextech: "⚡",
	Chemtech: "☣️",
	Elder: "👑",
};

type ObjectiveTimerSettings = Record<string, never>;

/**
 * Objective Timer — tracks Dragon, Baron, and Rift Herald respawn timers
 * using the Live Client Data API game events.
 *
 * Key: shows most urgent objective + countdown
 * Dial:
 *   - Rotate: cycle between Dragon / Baron / Herald views
 *   - Press: cycle view
 *   - Touch: refresh
 */
@action({ UUID: "com.desstroct.lol-api.objective-timer" })
export class ObjectiveTimer extends SingletonAction<ObjectiveTimerSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, ObjectiveState>();

	private getState(id: string): ObjectiveState {
		let s = this.actionStates.get(id);
		if (!s) {
			s = {
				viewIndex: 0,
				dragonCount: 0,
				lastDragonType: "",
				currentMapTerrain: "",
				isElderPhase: false,
				dragonSpawnAt: DRAGON_FIRST_SPAWN,
				baronSpawnAt: BARON_SPAWN_TIME,
				heraldSpawnAt: HERALD_FIRST_SPAWN,
				heraldKillCount: 0,
				atakhanSpawned: false,
				processedEventIds: new Set(),
				lastGameTime: 0,
				iconCache: new Map(),
			};
			this.actionStates.set(id, s);
		}
		return s;
	}

	private resetState(s: ObjectiveState): void {
		s.dragonCount = 0;
		s.lastDragonType = "";
		s.currentMapTerrain = "";
		s.isElderPhase = false;
		s.dragonSpawnAt = DRAGON_FIRST_SPAWN;
		s.baronSpawnAt = BARON_SPAWN_TIME;
		s.heraldSpawnAt = HERALD_FIRST_SPAWN;
		s.heraldKillCount = 0;
		s.atakhanSpawned = false;
		s.processedEventIds.clear();
		s.lastGameTime = 0;
		s.iconCache.clear();
	}

	override onWillAppear(ev: WillAppearEvent<ObjectiveTimerSettings>): void | Promise<void> {
		this.getState(ev.action.id);
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				obj_icon: "🐉",
				title: "Objective Timer",
				timer_text: "Waiting...",
				next_text: "",
				timer_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("Obj\nTimer");
	}

	override onWillDisappear(ev: WillDisappearEvent<ObjectiveTimerSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(_ev: KeyDownEvent<ObjectiveTimerSettings>): Promise<void> {
		// Cycle view on key press
		for (const state of this.actionStates.values()) {
			state.viewIndex = (state.viewIndex + 1) % OBJECTIVE_VIEWS.length;
		}
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<ObjectiveTimerSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.viewIndex = ((state.viewIndex + ev.payload.ticks) + OBJECTIVE_VIEWS.length * 100) % OBJECTIVE_VIEWS.length;
		await this.updateAll();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 1000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private objectiveIconsPrefetched = false;

	private async updateAll(): Promise<void> {
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ obj_icon: "", title: "Objectives", timer_text: "N/A TFT", next_text: "", timer_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Obj\nN/A TFT");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();
		if (!allData) {
			this.objectiveIconsPrefetched = false;
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ obj_icon: "", title: "Objective Timer", timer_text: "No game", next_text: "", timer_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Obj\nNo game");
				}
			}
			return;
		}

		const gameTime = allData.gameData.gameTime;
		const events = allData.events?.Events ?? [];

		// Prefetch all objective icons on first game detection
		if (!this.objectiveIconsPrefetched) {
			this.objectiveIconsPrefetched = true;
			prefetchObjectiveIcons();
		}

		for (const a of this.actions) {
			const state = this.getState(a.id);

			// Detect new game (gameTime resets)
			if (gameTime < state.lastGameTime - 10) {
				this.resetState(state);
			}
			state.lastGameTime = gameTime;
			state.currentMapTerrain = allData.gameData.mapTerrain ?? "";

			// Process new events
			this.processEvents(state, events, gameTime);

			// Render the view
			if (a.isDial()) {
				await this.renderDial(a, state, gameTime);
			} else {
				await this.renderKey(a, state, gameTime);
			}
		}
	}

	private processEvents(state: ObjectiveState, events: GameEvent[], _gameTime: number): void {
		for (const ev of events) {
			if (state.processedEventIds.has(ev.EventID)) continue;
			state.processedEventIds.add(ev.EventID);

			switch (ev.EventName) {
				case "DragonKill": {
					const drakeType = ev.DragonType ?? "";
					if (ELEMENTAL_DRAKES.has(drakeType)) {
						state.dragonCount++;
						state.lastDragonType = drakeType;
						// After 4 drakes per team (typically at 8 total dragons), Elder can spawn
						// Actually, each team's 4th drake gives soul, then Elder replaces dragons
						// The API fires "Elder" as DragonType for Elder kills
						state.dragonSpawnAt = ev.EventTime + DRAGON_RESPAWN;
					} else if (drakeType === "Elder") {
						state.isElderPhase = true;
						state.dragonSpawnAt = ev.EventTime + ELDER_RESPAWN;
					}
					break;
				}
				case "BaronKill":
					state.baronSpawnAt = ev.EventTime + BARON_RESPAWN;
					break;
				case "HeraldKill":
					state.heraldKillCount++;
					if (state.heraldKillCount >= 2) {
						// No more heralds after 2 kills
						state.heraldSpawnAt = 0;
					} else {
						const nextSpawn = ev.EventTime + HERALD_RESPAWN;
						// Herald despawns at 19:45 — don't set timer if it's past
						state.heraldSpawnAt = nextSpawn < HERALD_DESPAWN_TIME ? nextSpawn : 0;
					}
					break;
			}
		}

		// Atakhan spawns at 20:00 (replaces Herald area)
		if (_gameTime >= ATAKHAN_SPAWN_TIME && !state.atakhanSpawned) {
			state.atakhanSpawned = true;
			state.heraldSpawnAt = 0; // Herald is gone
		}
	}

	private getObjectiveInfo(type: ObjectiveType, state: ObjectiveState, gameTime: number): {
		iconKey: string; // key for CDragon fetch (e.g. "dragon:Fire", "baron", "herald")
		emoji: string; // fallback emoji for key title / next_text
		label: string;
		countdown: number; // seconds until spawn (negative = alive/available)
		barPct: number;
		barColor: string;
		detail: string;
	} {
		switch (type) {
			case "dragon": {
				const spawnAt = state.dragonSpawnAt;
				const remaining = spawnAt - gameTime;
				const respawnDuration = state.isElderPhase ? ELDER_RESPAWN : DRAGON_RESPAWN;
				// mapTerrain ("Infernal", "Ocean"…) is the most accurate signal for the
				// currently alive drake; fall back to last killed type when terrain is unknown
				const terrainDrake = TERRAIN_TO_DRAKE[state.currentMapTerrain] ?? "";
				const drakeKey = state.isElderPhase ? "Elder" : (terrainDrake || state.lastDragonType);
				const typeLabel = drakeKey || "Drake";
				const emoji = DRAKE_EMOJI[drakeKey] ?? "🐉";
				const iconKey = drakeKey ? `dragon:${drakeKey}` : "dragon:Fire";

				if (remaining <= 0) {
					return {
						iconKey,
						emoji,
						label: `${typeLabel} ALIVE`,
						countdown: 0,
						barPct: 100,
						barColor: "#E74C3C",
						detail: state.dragonCount > 0 ? `${state.dragonCount} drake${state.dragonCount > 1 ? "s" : ""} killed` : "First spawn",
					};
				}
				return {
					iconKey,
					emoji,
					label: `${typeLabel} in`,
					countdown: remaining,
					barPct: Math.round(((respawnDuration - remaining) / respawnDuration) * 100),
					barColor: state.isElderPhase ? "#9B59B6" : "#F1C40F",
					detail: `${state.dragonCount} drake${state.dragonCount > 1 ? "s" : ""} killed`,
				};
			}

			case "baron": {
				const spawnAt = state.baronSpawnAt;
				const remaining = spawnAt - gameTime;

				if (gameTime < BARON_SPAWN_TIME) {
					const untilSpawn = BARON_SPAWN_TIME - gameTime;
					return {
						iconKey: "baron",
						emoji: "👾",
						label: "Baron spawns in",
						countdown: untilSpawn,
						barPct: Math.round(((BARON_SPAWN_TIME - untilSpawn) / BARON_SPAWN_TIME) * 100),
						barColor: "#9B59B6",
						detail: `Spawns at 20:00`,
					};
				}

				if (remaining <= 0) {
					return {
						iconKey: "baron",
						emoji: "👾",
						label: "Baron ALIVE",
						countdown: 0,
						barPct: 100,
						barColor: "#E74C3C",
						detail: "Contest or take!",
					};
				}
				return {
					iconKey: "baron",
					emoji: "👾",
					label: "Baron in",
					countdown: remaining,
					barPct: Math.round(((BARON_RESPAWN - remaining) / BARON_RESPAWN) * 100),
					barColor: "#9B59B6",
					detail: "Respawning...",
				};
			}

			case "herald": {
				if (state.heraldSpawnAt <= 0 || gameTime >= HERALD_DESPAWN_TIME) {
					if (state.atakhanSpawned) {
						return {
							iconKey: "herald",
							emoji: "⚔️",
							label: "Atakhan",
							countdown: 0,
							barPct: 100,
							barColor: "#E74C3C",
							detail: "Atakhan has spawned",
						};
					}
					return {
						iconKey: "herald",
						emoji: "🦀",
						label: "Herald",
						countdown: 0,
						barPct: 0,
						barColor: "#333333",
						detail: state.heraldKillCount >= 2 ? "No more heralds" : "Despawned",
					};
				}

				if (gameTime < HERALD_FIRST_SPAWN) {
					const untilSpawn = HERALD_FIRST_SPAWN - gameTime;
					return {
						iconKey: "herald",
						emoji: "🦀",
						label: "Herald spawns in",
						countdown: untilSpawn,
						barPct: Math.round(((HERALD_FIRST_SPAWN - untilSpawn) / HERALD_FIRST_SPAWN) * 100),
						barColor: "#F39C12",
						detail: "Spawns at 14:00",
					};
				}

				const remaining = state.heraldSpawnAt - gameTime;
				if (remaining <= 0) {
					return {
						iconKey: "herald",
						emoji: "🦀",
						label: "Herald ALIVE",
						countdown: 0,
						barPct: 100,
						barColor: "#E74C3C",
						detail: `${state.heraldKillCount}/2 killed`,
					};
				}
				return {
					iconKey: "herald",
					emoji: "🦀",
					label: "Herald in",
					countdown: remaining,
					barPct: Math.round(((HERALD_RESPAWN - remaining) / HERALD_RESPAWN) * 100),
					barColor: "#F39C12",
					detail: `${state.heraldKillCount}/2 killed`,
				};
			}

			case "atakhan": {
				return {
					iconKey: "herald",
					emoji: "⚔️",
					label: "Atakhan",
					countdown: 0,
					barPct: state.atakhanSpawned ? 100 : 0,
					barColor: "#E74C3C",
					detail: state.atakhanSpawned ? "Active" : `Spawns at 20:00`,
				};
			}
		}
	}

	/** Find the most urgent objective to display on key */
	private getMostUrgent(state: ObjectiveState, gameTime: number): ObjectiveType {
		let best: ObjectiveType = "dragon";
		let bestCountdown = Infinity;

		for (const type of OBJECTIVE_VIEWS) {
			const info = this.getObjectiveInfo(type, state, gameTime);
			// "ALIVE" objectives are most urgent (countdown = 0)
			// Then closest spawning
			const urgency = info.countdown <= 0 && info.barPct > 0 ? -1 : info.countdown;
			if (urgency < bestCountdown) {
				bestCountdown = urgency;
				best = type;
			}
		}
		return best;
	}

	private formatTime(seconds: number): string {
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${m}:${String(s).padStart(2, "0")}`;
	}

	/** Fetch a CDragon icon by iconKey, caching the result in the state. */
	private async fetchObjIcon(state: ObjectiveState, iconKey: string): Promise<string | null> {
		const cached = state.iconCache.get(iconKey);
		if (cached) return cached;

		let dataUri: string | null = null;
		if (iconKey.startsWith("dragon:")) {
			const drakeType = iconKey.slice(7); // e.g. "Fire", "Elder"
			dataUri = await getDragonIcon(drakeType);
		} else if (iconKey === "baron") {
			dataUri = await getBaronIcon();
		} else if (iconKey === "herald") {
			dataUri = await getHeraldIcon();
		}

		if (dataUri) state.iconCache.set(iconKey, dataUri);
		return dataUri;
	}

	private async renderDial(a: DialAction<ObjectiveTimerSettings>, state: ObjectiveState, gameTime: number): Promise<void> {
		const viewType = OBJECTIVE_VIEWS[state.viewIndex];
		const info = this.getObjectiveInfo(viewType, state, gameTime);

		// Fetch CDragon icon (async, cached after first fetch)
		const iconDataUri = await this.fetchObjIcon(state, info.iconKey);

		// Build summary of other objectives for the detail line
		const others = OBJECTIVE_VIEWS
			.filter((t) => t !== viewType)
			.map((t) => {
				const o = this.getObjectiveInfo(t, state, gameTime);
				return o.countdown > 0 ? `${o.emoji}${this.formatTime(o.countdown)}` : `${o.emoji}UP`;
			})
			.join(" · ");

		const timerStr = info.countdown > 0 ? this.formatTime(info.countdown) : (info.barPct > 0 ? "UP!" : "—");

		await a.setFeedback({
			obj_icon: iconDataUri ?? "",
			title: info.label,
			timer_text: timerStr,
			next_text: others || info.detail,
			timer_bar: { value: info.barPct, bar_fill_c: info.barColor },
		});
	}

	private async renderKey(a: KeyAction<ObjectiveTimerSettings>, state: ObjectiveState, gameTime: number): Promise<void> {
		const urgent = this.getMostUrgent(state, gameTime);
		const info = this.getObjectiveInfo(urgent, state, gameTime);
		const iconDataUri = await this.fetchObjIcon(state, info.iconKey);

		await a.setImage(iconDataUri ?? "");

		if (info.countdown > 0) {
			await a.setTitle(this.formatTime(info.countdown));
		} else if (info.barPct > 0) {
			await a.setTitle("UP!");
		} else {
			await a.setTitle("—");
		}
	}
}
