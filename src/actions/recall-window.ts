import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	type KeyAction,
	type DialAction,
	DialRotateEvent,
	DialUpEvent,
	TouchTapEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { Buffer } from "node:buffer";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { itemBuilds, ItemBuilds } from "../services/item-builds";
import { getItemIcon } from "../services/lol-icons";
import type { GamePlayer, GameEvent } from "../types/lol";

const logger = streamDeck.logger.createScope("RecallWindow");

// LoL color palette
const GOLD = "#C89B3C";
const DARK_BLUE = "#0A1428";
const GREEN = "#2ECC71";
const BLUE = "#3498DB";
const YELLOW = "#F1C40F";
const RED = "#E74C3C";
const ORANGE = "#E67E22";

/** Recall channel time (8 seconds base in SR, 4.5 in ARAM) */
const RECALL_TIME_SR = 8;
const RECALL_TIME_ARAM = 4.5;

// ── Cannon wave timing ──
// Minions spawn at 1:05. Waves every 30s. Cannon every 3rd wave (first cannon = wave 3 at ~2:05).
// After 25:00 cannon every 2 waves. After 35:00 every wave.
const MINION_FIRST_SPAWN = 65; // 1:05
const WAVE_INTERVAL = 30; // seconds between waves

/** Objective spawn timings (approximate) */
const DRAGON_FIRST_SPAWN = 5 * 60; // 5:00
const DRAGON_RESPAWN = 5 * 60; // 5 min respawn
const HERALD_FIRST_SPAWN = 14 * 60; // 14:00
const HERALD_RESPAWN = 4 * 60; // ~4 min between 1st and 2nd herald
const VOIDGRUB_FIRST_SPAWN = 5 * 60; // 5:00 (same as dragon side)
const VOIDGRUB_RESPAWN = 4 * 60; // ~4 min respawn
const ATAKHAN_SPAWN = 20 * 60; // 20:00 (spawns when enough blood is spilled)
const BARON_SPAWN = 20 * 60; // 20:00
const BARON_RESPAWN = 6 * 60; // 6 min respawn

/** Timing quality rating */
type TimingQuality = "great" | "good" | "neutral" | "bad";

interface TimingSignal {
	quality: TimingQuality;
	reason: string;
	/** Short label for key display */
	shortReason: string;
}

interface RecallState {
	/** Current gold */
	currentGold: number;
	/** Target gold for next meaningful purchase */
	targetGold: number;
	/** Label for the target item/component */
	targetLabel: string;
	/** Whether we have enough gold for the target */
	goldReady: boolean;
	/** Combined recommendation: should we recall? */
	shouldRecall: boolean;
	/** Timing quality signals */
	timing: TimingSignal;
	/** Gold per minute estimate */
	goldPerMin: number;
	/** Estimated seconds until target gold */
	etaSeconds: number;
	/** Game time in seconds */
	gameTime: number;
	/** Player's champion name */
	champName: string;
	/** Player's lane position */
	lane: string;
	/** Recommended build items (for dynamic breakpoints) */
	buildItems: number[];
	/** Gold history for GPM calculation */
	goldHistory: { gold: number; time: number }[];
	/** Enemy laner champion name (detected) */
	enemyLanerName: string;
	/** Whether enemy laner is currently dead */
	enemyDead: boolean;
	/** Upcoming component breakpoints */
	componentBreakpoints: { gold: number; label: string; itemId: number }[];
	/** Current player level (from Live Client API) */
	playerLevel: number;
	/** Track last objective kill times for respawn calculations */
	lastDragonKill: number;
	lastBaronKill: number;
	lastHeraldKill: number;
	lastVoidgrubKill: number;
	voidgrubKillCount: number;
	/** Champion name the current build was loaded for */
	buildChamp: string;
	/** Guard flag to prevent concurrent build item loads */
	buildItemsLoading: boolean;
	/** Dial browse offset into upcoming breakpoints (0 = current target) */
	browseOffset: number;
	/** Item ID of the currently displayed target (for icon fetch) */
	nextItemId: number | null;
	/** Fetched icon data URI for the current target item */
	nextItemIcon: string | null;
	/** True when gold was already sufficient last tick (avoids re-fetching icon on every tick) */
	wasGoldReady: boolean;
}

type RecallWindowSettings = Record<string, never>;

/**
 * Recall Window action — smart recall advisor.
 *
 * Combines **gold readiness** with **timing quality** to give you
 * the best recall signal. Considers:
 * - Champion-specific item component breakpoints (from build data)
 * - Cannon wave timing (recall when cannon is pushing)
 * - Enemy laner state (dead = safe window)
 * - Objective timing (don't recall right before dragon/baron)
 * - Matchup context (shown on display)
 *
 * Key press: force refresh
 * Dial rotate: adjust gold target manually
 */
@action({ UUID: "com.desstroct.lol-api.recall-window" })
export class RecallWindow extends SingletonAction<RecallWindowSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, RecallState>();

	override onWillAppear(ev: WillAppearEvent<RecallWindowSettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "RECALL",
				status_text: "Waiting...",
				gold_text: "",
				gold_bar: { value: 0 },
				info_text: "",
			});
		}
		return ev.action.setTitle("Recall\nWindow");
	}

	override onWillDisappear(ev: WillDisappearEvent<RecallWindowSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	/** Key press: force refresh */
	override async onKeyDown(_ev: KeyDownEvent<RecallWindowSettings>): Promise<void> {
		await this.updateAll();
	}

	/** Dial rotate: browse upcoming items in build path */
	override async onDialRotate(ev: DialRotateEvent<RecallWindowSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		const total = state.componentBreakpoints.length;
		if (total === 0) return;
		state.browseOffset = ((state.browseOffset + ev.payload.ticks) % total + total) % total;
		await this.updateAll();
	}

	/** Dial press: jump back to current target */
	override async onDialUp(_ev: DialUpEvent<RecallWindowSettings>): Promise<void> {
		for (const a of this.actions) this.getState(a.id).browseOffset = 0;
		await this.updateAll();
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<RecallWindowSettings>): Promise<void> {
		await this.updateAll();
	}

	private getState(actionId: string): RecallState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = {
				currentGold: 0,
				targetGold: 1100,
				targetLabel: "Component",
				goldReady: false,
				shouldRecall: false,
				timing: { quality: "neutral", reason: "", shortReason: "" },
				goldPerMin: 0,
				etaSeconds: 0,
				gameTime: 0,
				champName: "",
				lane: "",
				buildItems: [],
				goldHistory: [],
				enemyLanerName: "",
				enemyDead: false,
				componentBreakpoints: [],
				playerLevel: 0,
				lastDragonKill: 0,
				lastBaronKill: 0,
				lastHeraldKill: 0,
				lastVoidgrubKill: 0,
				voidgrubKillCount: 0,
				buildChamp: "",
				buildItemsLoading: false,
				browseOffset: 0,
				nextItemId: null,
				nextItemIcon: null,
				wasGoldReady: false,
			};
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(
			() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)),
			1500,
		);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: "RECALL", status_text: "N/A in TFT", gold_text: "", gold_bar: { value: 0 }, info_text: "" });
				} else {
					await a.setImage(""); await a.setTitle("Recall\nN/A TFT");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();

		if (!allData) {
			for (const s of this.actionStates.values()) {
				s.goldHistory = [];
				s.buildItems = [];
				s.buildItemsLoading = false;
				s.champName = "";
				s.enemyLanerName = "";
				s.componentBreakpoints = [];
				s.playerLevel = 0;
				s.lastDragonKill = 0;
				s.lastBaronKill = 0;
				s.lastHeraldKill = 0;
				s.lastVoidgrubKill = 0;
				s.voidgrubKillCount = 0;
				s.buildChamp = "";
			}
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						recall_icon: "",
						title: "RECALL",
						status_text: "No game",
						gold_text: "",
						gold_bar: { value: 0 },
						info_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle("Recall\nNo game");
				}
			}
			return;
		}

		const activePlayer = allData.activePlayer;
		const activeName = activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) =>
				p.riotIdGameName === activeName ||
				p.summonerName === activeName ||
				p.riotId === activeName ||
				p.riotIdGameName === activeName.split("#")[0],
		);
		if (!me) return;

		const gameTime = allData.gameData.gameTime;
		const currentGold = activePlayer.currentGold;
		const champName = me.championName;
		const myTeam = me.team;
		const playerItemIds = new Set(me.items.map((i) => i.itemID));
		const events = allData.events?.Events ?? [];

		// Detect enemy laner
		const myPosition = me.position; // "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"
		const enemyLaner = this.findEnemyLaner(allData.allPlayers, myTeam, myPosition);

		for (const a of this.actions) {
			const state = this.getState(a.id);

			state.currentGold = currentGold;
			state.gameTime = gameTime;
			state.champName = champName;
			state.lane = myPosition;
			state.playerLevel = activePlayer.level;

			// Track enemy laner
			if (enemyLaner) {
				state.enemyLanerName = enemyLaner.championName;
				state.enemyDead = enemyLaner.isDead;
			} else {
				state.enemyLanerName = "";
				state.enemyDead = false;
			}

			// Track objective kills from events
			this.trackObjectiveEvents(state, events);

			// Fetch build items if we don't have them yet OR champion changed (ARAM reroll)
			const needBuildReload = (state.buildItems.length === 0 || state.buildChamp !== champName) && champName && !state.buildItemsLoading;
			if (needBuildReload) {
				state.buildItemsLoading = true;
				try {
					const lane = gameMode.isARAM() ? "aram" : ItemBuilds.toLolalyticsLane(myPosition);
					const alias = ItemBuilds.toAlias(champName);
					const build = await itemBuilds.getBuild(alias, lane);
					if (build && build.fullBuild.length > 0) {
						state.buildItems = build.fullBuild;
						state.buildChamp = champName;
						// Build component breakpoints from the build path
						state.componentBreakpoints = this.buildComponentBreakpoints(build.fullBuild, build.startingItems);
						logger.info(`Recall: loaded ${state.componentBreakpoints.length} breakpoints for ${champName}`);
					}
				} catch (e) {
					logger.warn(`Failed to load build for recall: ${e}`);
				} finally {
					state.buildItemsLoading = false;
				}
			}

			// Calculate GPM
			this.updateGoldRate(state, currentGold, gameTime);

			// Find next gold target (champion + build aware)
			const { target, label, itemId } = this.findNextTarget(state, playerItemIds);
			state.targetGold = target;
			state.targetLabel = label;

			// Fetch item icon when target changes
			if (itemId !== state.nextItemId) {
				state.nextItemId = itemId;
				state.nextItemIcon = itemId ? (await getItemIcon(itemId) ?? null) : null;
			}

			// Gold readiness
			state.goldReady = currentGold >= target;

			// Evaluate timing quality
			state.timing = this.evaluateTiming(state, gameTime);

			// Combined recall signal: gold ready + timing at least neutral
			state.shouldRecall = state.goldReady && state.timing.quality !== "bad";

			// ETA calculation
			if (state.goldPerMin > 0 && !state.goldReady) {
				const goldNeeded = target - currentGold;
				const farmTime = Math.round((goldNeeded / state.goldPerMin) * 60);
				const recallTime = gameMode.isARAM() ? RECALL_TIME_ARAM : RECALL_TIME_SR;
				state.etaSeconds = farmTime + recallTime;
			} else {
				state.etaSeconds = 0;
			}

			await this.renderAction(a, state);
		}
	}

	// ── Enemy detection ──

	private findEnemyLaner(
		allPlayers: GamePlayer[],
		myTeam: string,
		myPosition: string,
	): GamePlayer | null {
		// Direct position match on enemy team
		const directMatch = allPlayers.find(
			(p) => p.team !== myTeam && p.position === myPosition && p.position !== "",
		);
		if (directMatch) return directMatch;

		// Fallback: any enemy
		return allPlayers.find((p) => p.team !== myTeam) ?? null;
	}

	// ── Objective tracking ──

	private trackObjectiveEvents(state: RecallState, events: GameEvent[]): void {
		for (const ev of events) {
			if (ev.EventName === "DragonKill") {
				state.lastDragonKill = ev.EventTime;
			} else if (ev.EventName === "BaronKill") {
				state.lastBaronKill = ev.EventTime;
			} else if (ev.EventName === "HeraldKill") {
				state.lastHeraldKill = ev.EventTime;
			} else if (ev.EventName === "HordeKill") {
				// Voidgrubs ("Horde" in the API)
				if (ev.EventTime > state.lastVoidgrubKill) {
					state.lastVoidgrubKill = ev.EventTime;
					state.voidgrubKillCount++;
				}
			}
		}
	}

	// ── Timing evaluation ──

	/**
	 * Evaluate the current timing quality for a recall.
	 * Returns a signal with quality rating and reason.
	 */
	private evaluateTiming(state: RecallState, gameTime: number): TimingSignal {
		const isARAM = gameMode.isARAM();
		const signals: { quality: TimingQuality; reason: string; shortReason: string; priority: number }[] = [];

		// 1. Enemy laner is dead → great timing
		if (state.enemyDead && !isARAM) {
			signals.push({
				quality: "great",
				reason: `${state.enemyLanerName} is dead`,
				shortReason: `${state.enemyLanerName} dead`,
				priority: 10,
			});
		}

		// 2. Objective timing — don't recall right before objectives
		if (!isARAM) {
			const objSignal = this.checkObjectiveTiming(state, gameTime);
			if (objSignal) signals.push(objSignal);
		}

		// 3. Cannon wave timing — best to recall right after pushing cannon wave
		if (!isARAM) {
			const cannonSignal = this.checkCannonTiming(gameTime);
			if (cannonSignal) signals.push(cannonSignal);
		}

		// 4. Level power spike — don't recall right before level 6/11/16
		if (state.gameTime > 0) {
			const lvlSignal = this.checkLevelSpike(state);
			if (lvlSignal) signals.push(lvlSignal);
		}

		// Pick highest priority signal
		if (signals.length === 0) {
			return { quality: "neutral", reason: "", shortReason: "" };
		}

		signals.sort((a, b) => b.priority - a.priority);
		return signals[0];
	}

	/**
	 * Check if an objective is about to spawn.
	 * Bad timing to recall 40s before dragon/baron/herald.
	 */
	private checkObjectiveTiming(state: RecallState, gameTime: number): TimingSignal & { priority: number } | null {
		// Dragon
		let nextDragon: number;
		if (state.lastDragonKill > 0) {
			nextDragon = state.lastDragonKill + DRAGON_RESPAWN;
		} else {
			nextDragon = DRAGON_FIRST_SPAWN;
		}
		const dragonDelta = nextDragon - gameTime;
		if (dragonDelta > 0 && dragonDelta < 45) {
			return {
				quality: "bad",
				reason: `Dragon in ${Math.round(dragonDelta)}s`,
				shortReason: `Drake ${Math.round(dragonDelta)}s`,
				priority: 8,
			};
		}

		// Baron
		if (gameTime >= BARON_SPAWN - 60) {
			let nextBaron: number;
			if (state.lastBaronKill > 0) {
				nextBaron = state.lastBaronKill + BARON_RESPAWN;
			} else {
				nextBaron = BARON_SPAWN;
			}
			const baronDelta = nextBaron - gameTime;
			if (baronDelta > 0 && baronDelta < 45) {
				return {
					quality: "bad",
					reason: `Baron in ${Math.round(baronDelta)}s`,
					shortReason: `Baron ${Math.round(baronDelta)}s`,
					priority: 9,
				};
			}
		}

		// Herald (spawns at 14:00, can respawn once ~4min later; replaced by Baron at 20:00)
		if (gameTime < BARON_SPAWN) {
			let nextHerald: number;
			if (state.lastHeraldKill > 0) {
				nextHerald = state.lastHeraldKill + HERALD_RESPAWN;
			} else {
				nextHerald = HERALD_FIRST_SPAWN;
			}
			if (nextHerald < BARON_SPAWN) {
				const heraldDelta = nextHerald - gameTime;
				if (heraldDelta > 0 && heraldDelta < 40) {
					return {
						quality: "bad",
						reason: `Herald in ${Math.round(heraldDelta)}s`,
						shortReason: `Herald ${Math.round(heraldDelta)}s`,
						priority: 7,
					};
				}
			}
		}

		// Voidgrubs (spawn at 5:00 on top side, up to 6 can be taken; respawn ~4min)
		if (gameTime < BARON_SPAWN && state.voidgrubKillCount < 6) {
			let nextVoidgrub: number;
			if (state.lastVoidgrubKill > 0) {
				nextVoidgrub = state.lastVoidgrubKill + VOIDGRUB_RESPAWN;
			} else {
				nextVoidgrub = VOIDGRUB_FIRST_SPAWN;
			}
			const voidDelta = nextVoidgrub - gameTime;
			if (voidDelta > 0 && voidDelta < 40) {
				return {
					quality: "bad",
					reason: `Voidgrubs in ${Math.round(voidDelta)}s`,
					shortReason: `Grubs ${Math.round(voidDelta)}s`,
					priority: 6,
				};
			}
		}

		// Atakhan (spawns at ~20:00 based on blood spilled; similar timing to Baron)
		if (gameTime >= ATAKHAN_SPAWN - 60 && gameTime < ATAKHAN_SPAWN + 30) {
			const atakhanDelta = ATAKHAN_SPAWN - gameTime;
			if (atakhanDelta > 0 && atakhanDelta < 45) {
				return {
					quality: "bad",
					reason: `Atakhan in ~${Math.round(atakhanDelta)}s`,
					shortReason: `Atakhan ~${Math.round(atakhanDelta)}s`,
					priority: 8,
				};
			}
		}

		return null;
	}

	/**
	 * Cannon wave timing heuristic.
	 * Cannon waves are best for recall — enemy tower focuses cannon, giving you time.
	 */
	private checkCannonTiming(gameTime: number): TimingSignal & { priority: number } | null {
		if (gameTime < MINION_FIRST_SPAWN) return null;

		const timeSinceSpawn = gameTime - MINION_FIRST_SPAWN;
		const waveNumber = Math.floor(timeSinceSpawn / WAVE_INTERVAL) + 1;

		// Determine cannon interval
		let cannonInterval: number;
		if (gameTime >= 35 * 60) {
			cannonInterval = 1; // every wave
		} else if (gameTime >= 25 * 60) {
			cannonInterval = 2; // every 2 waves
		} else {
			cannonInterval = 3; // every 3 waves
		}

		// Is current or next wave a cannon wave?
		const isCannonNow = waveNumber % cannonInterval === 0;
		const nextCannonWave = isCannonNow
			? waveNumber
			: waveNumber + (cannonInterval - (waveNumber % cannonInterval));
		const nextCannonTime = MINION_FIRST_SPAWN + (nextCannonWave - 1) * WAVE_INTERVAL;

		// Time until cannon wave arrives at lane (~15s travel)
		const cannonArrival = nextCannonTime + 15;
		const delta = cannonArrival - gameTime;

		if (delta >= -5 && delta <= 20) {
			// Cannon wave is arriving or just arrived — good time to push and recall
			return {
				quality: "good",
				reason: "Cannon wave — push & recall",
				shortReason: "Cannon wave",
				priority: 5,
			};
		}

		return null;
	}

	/**
	 * Check if player is close to a level power spike.
	 * Don't recall right before hitting level 6/11/16 — ultimate unlocks/upgrades.
	 */
	private checkLevelSpike(state: RecallState): TimingSignal & { priority: number } | null {
		if (state.playerLevel <= 0) return null;

		// Power spike levels: 6 (R unlock), 11 (R rank 2), 16 (R rank 3)
		const SPIKE_LEVELS = [6, 11, 16];

		for (const spikeLevel of SPIKE_LEVELS) {
			if (state.playerLevel === spikeLevel - 1) {
				return {
					quality: "bad",
					reason: `Almost level ${spikeLevel} — don't lose XP`,
					shortReason: `Lvl ${spikeLevel} soon`,
					priority: 7,
				};
			}
		}

		// Just hit a spike level — good time to recall with a power advantage
		if (SPIKE_LEVELS.includes(state.playerLevel) && state.goldReady) {
			return {
				quality: "good",
				reason: `Hit level ${state.playerLevel} — buy and fight`,
				shortReason: `Lvl ${state.playerLevel} spike`,
				priority: 4,
			};
		}

		return null;
	}

	// ── Component breakpoints ──

	/**
	 * Build a list of component-level gold breakpoints from the recommended build.
	 * Instead of just "2600g for Trinity Force", produces:
	 *   350g Boots, 400g Sheen, 700g Phage, 800g Stinger, etc.
	 */
	private buildComponentBreakpoints(
		fullBuild: number[],
		startingItems: number[],
	): { gold: number; label: string; itemId: number }[] {
		const breakpoints: { gold: number; label: string; itemId: number }[] = [];
		const seen = new Set<number>();

		// Starting items as first breakpoint (itemId 0 = composite entry)
		if (startingItems.length > 0) {
			const startCost = startingItems.reduce((sum, id) => sum + dataDragon.getItemCost(id), 0);
			const startName = startingItems.map((id) => dataDragon.getItemName(id)).join(" + ");
			if (startCost > 0) {
				breakpoints.push({ gold: startCost, label: startName.length > 20 ? startName.slice(0, 18) + "…" : startName, itemId: startingItems[0] });
			}
		}

		// For each build item, add its components then the full item
		for (const itemId of fullBuild) {
			if (seen.has(itemId)) continue;
			seen.add(itemId);

			const components = dataDragon.getItemComponents(itemId);
			const itemCost = dataDragon.getItemCost(itemId);

			if (components.length > 0) {
				// Add each component that costs real gold and isn't trivial
				for (const compId of components) {
					if (seen.has(compId)) continue;
					const compCost = dataDragon.getItemCost(compId);
					const compName = dataDragon.getItemName(compId);
					if (compCost >= 300) {
						breakpoints.push({ gold: compCost, label: compName, itemId: compId });
						seen.add(compId);
					}
				}
			}

			// Full item
			if (itemCost > 0) {
				const itemName = dataDragon.getItemName(itemId);
				breakpoints.push({ gold: itemCost, label: itemName, itemId });
			}
		}

		// Sort by gold cost
		breakpoints.sort((a, b) => a.gold - b.gold);

		// Deduplicate by gold cost (keep first label)
		const deduped: { gold: number; label: string; itemId: number }[] = [];
		for (const bp of breakpoints) {
			if (deduped.length === 0 || deduped[deduped.length - 1].gold !== bp.gold) {
				deduped.push(bp);
			}
		}

		return deduped;
	}

	// ── Gold rate tracking ──

	/**
	 * Track gold income rate using a sliding window of samples.
	 */
	private updateGoldRate(state: RecallState, currentGold: number, gameTime: number): void {
		if (gameTime < 90) {
			state.goldPerMin = 0;
			return;
		}

		const lastSample = state.goldHistory[state.goldHistory.length - 1];
		if (!lastSample || gameTime - lastSample.time >= 3) {
			state.goldHistory.push({ gold: currentGold, time: gameTime });
			const cutoff = gameTime - 60;
			state.goldHistory = state.goldHistory.filter((s) => s.time >= cutoff);
		}

		if (state.goldHistory.length >= 2) {
			const oldest = state.goldHistory[0];
			const newest = state.goldHistory[state.goldHistory.length - 1];
			const timeDelta = newest.time - oldest.time;
			if (timeDelta > 5) {
				let minGold = Infinity;
				let minTime = oldest.time;
				for (const s of state.goldHistory) {
					if (s.gold < minGold) {
						minGold = s.gold;
						minTime = s.time;
					}
				}
				const sinceMin = newest.time - minTime;
				if (sinceMin > 10 && newest.gold > minGold) {
					state.goldPerMin = ((newest.gold - minGold) / sinceMin) * 60;
				} else {
					state.goldPerMin = gameTime < 600 ? 250 : 320;
				}
			}
		}
	}

	// ── Target finding ──

	private findNextTarget(
		state: RecallState,
		playerItemIds: Set<number>,
	): { target: number; label: string; itemId: number | null } {
		if (state.componentBreakpoints.length > 0) {
			const unbought = state.componentBreakpoints.filter((bp) => !playerItemIds.has(bp.itemId));

			if (unbought.length > 0) {
				// Browse mode: show the item at the browse offset
				if (state.browseOffset > 0) {
					const idx = Math.min(state.browseOffset, unbought.length - 1);
					const bp = unbought[idx];
					return { target: bp.gold, label: bp.label, itemId: bp.itemId };
				}

				// Normal mode: most expensive affordable item, or next saving target
				const affordable = unbought.filter((bp) => state.currentGold >= bp.gold);
				if (affordable.length > 0) {
					const best = affordable[affordable.length - 1];
					return { target: best.gold, label: best.label, itemId: best.itemId };
				}
				const next = unbought.find((bp) => bp.gold > state.currentGold);
				if (next) return { target: next.gold, label: next.label, itemId: next.itemId };
			}
		}

		// Build not loaded yet
		if (state.buildItemsLoading || (state.champName && !state.buildChamp)) {
			return { target: 0, label: "Loading build…", itemId: null };
		}

		// No build data — show plain gold thresholds as last resort
		const fallbacks: { gold: number; label: string }[] = [
			{ gold: 350, label: "Boots" },
			{ gold: 875, label: "Component" },
			{ gold: 1300, label: "Component+" },
			{ gold: 2600, label: "Full Item" },
		];
		const next = fallbacks.find((bp) => state.currentGold < bp.gold);
		return next
			? { target: next.gold, label: next.label, itemId: null }
			: { target: state.currentGold, label: "Full buy", itemId: null };
	}

	// ── Rendering ──

	private async renderAction(
		a: DialAction<RecallWindowSettings> | KeyAction<RecallWindowSettings>,
		state: RecallState,
	): Promise<void> {
		const progress = state.targetGold > 0
			? Math.min(100, Math.round((state.currentGold / state.targetGold) * 100))
			: 100;

		const goldStr = formatGold(state.currentGold);
		const targetStr = formatGold(state.targetGold);
		const gameTimeStr = formatTime(state.gameTime);

		// Timing emoji indicator
		const timingEmoji = state.timing.quality === "great" ? "🟢"
			: state.timing.quality === "good" ? "🔵"
			: state.timing.quality === "bad" ? "🔴"
			: "";

		// Matchup label for display
		const vsLabel = state.enemyLanerName ? `vs ${state.enemyLanerName}` : "";

		if (state.shouldRecall) {
			// ─── RECALL NOW ───
			const timingNote = state.timing.reason ? ` · ${state.timing.shortReason}` : "";

			if (a.isDial()) {
				await a.setFeedback({
					title: `${state.champName || "RECALL"} · ${gameTimeStr}`,
					status_text: `RECALL NOW ${timingEmoji}`,
					gold_text: `${goldStr}g → ${state.targetLabel}`,
					gold_bar: { value: 100, bar_fill_c: GREEN },
					info_text: vsLabel ? `${vsLabel}${timingNote}` : state.timing.reason || "Gold ready!",
				});
			} else {
				const img = this.composeKeyImage(state, state.nextItemIcon);
				if (img) await a.setImage(img);
				await a.setTitle("");
			}
		} else if (state.goldReady && state.timing.quality === "bad") {
			// ─── GOLD READY BUT BAD TIMING ───
			if (a.isDial()) {
				await a.setFeedback({
					title: `${state.champName || "RECALL"} · ${gameTimeStr}`,
					status_text: `WAIT ${timingEmoji}`,
					gold_text: `${goldStr}g ✓ · ${state.targetLabel}`,
					gold_bar: { value: 100, bar_fill_c: ORANGE },
					info_text: state.timing.reason,
				});
			} else {
				const img = this.composeKeyImage(state, state.nextItemIcon);
				if (img) await a.setImage(img);
				await a.setTitle("");
			}
		} else {
			// ─── FARMING ───
			const etaStr = state.etaSeconds > 0 ? `~${formatTime(state.etaSeconds)}` : "";
			const goldNeeded = state.targetGold - state.currentGold;
			const barColor = progress >= 80 ? YELLOW : BLUE;
			const timingInfo = state.timing.reason ? ` · ${state.timing.shortReason}` : "";

			if (a.isDial()) {
				await a.setFeedback({
					title: `${state.champName || "RECALL"} · ${gameTimeStr}`,
					status_text: `Need ${formatGold(goldNeeded)}g`,
					gold_text: `${goldStr}g / ${targetStr}g`,
					gold_bar: { value: progress, bar_fill_c: barColor },
					info_text: `${state.targetLabel}${etaStr ? ` · ${etaStr}` : ""}${timingInfo}`,
				});
			} else {
				const img = this.composeKeyImage(state, state.nextItemIcon);
				if (img) await a.setImage(img);
				await a.setTitle("");
			}
		}
	}

	/**
	 * Compose an SVG key image with progress ring, gold info, timing, and matchup.
	 */
	private composeKeyImage(state: RecallState, iconUri: string | null = null): string | null {
		const S = 144;
		const cx = S / 2;
		const cy = 52;
		const r = 40;
		const strokeW = 7;

		const progress = state.targetGold > 0
			? Math.min(1, state.currentGold / state.targetGold)
			: 1;

		const circumference = 2 * Math.PI * r;
		const dashOffset = circumference * (1 - progress);

		const goldStr = formatGold(state.currentGold);
		const targetStr = formatGold(state.targetGold);

		// Determine overall status
		const showRecall = state.shouldRecall;
		const showWait = state.goldReady && state.timing.quality === "bad";

		// Ring and status colors
		let ringColor: string;
		let statusText: string;
		let statusColor: string;

		if (showRecall) {
			ringColor = GREEN;
			statusText = "NOW";
			statusColor = GREEN;
		} else if (showWait) {
			ringColor = ORANGE;
			statusText = "WAIT";
			statusColor = ORANGE;
		} else {
			ringColor = progress >= 0.8 ? YELLOW : BLUE;
			statusText = `${Math.round(progress * 100)}%`;
			statusColor = "#FFF";
		}

		const statusSize = showRecall || showWait ? 28 : 22;

		// Bottom line: timing reason or target label (pick the most useful)
		let bottomText = "";
		let bottomColor = "#AAA";
		if (state.timing.quality !== "neutral" && state.timing.shortReason) {
			bottomText = truncate(state.timing.shortReason, 12);
			bottomColor = state.timing.quality === "great" ? GREEN
				: state.timing.quality === "good" ? BLUE
				: state.timing.quality === "bad" ? RED : "#AAA";
		} else {
			bottomText = truncate(state.targetLabel, 12);
			if (state.etaSeconds > 0 && !state.goldReady) {
				bottomText += ` ${formatTime(state.etaSeconds)}`;
			}
		}

		const innerR = r - strokeW - 2;
		const iconOpacity = showRecall ? "0.35" : "0.2";

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<defs>
				<clipPath id="ic"><circle cx="${cx}" cy="${cy}" r="${innerR}"/></clipPath>
			</defs>
			<rect width="${S}" height="${S}" rx="14" fill="${DARK_BLUE}"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="12" fill="none" stroke="${GOLD}" stroke-width="1.5" opacity="0.3"/>

			<!-- Progress ring background -->
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#333" stroke-width="${strokeW}"/>
			<!-- Progress ring -->
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ringColor}" stroke-width="${strokeW}"
				stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
				stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"
				opacity="0.9"/>

			${showRecall
				? `<circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="none" stroke="${GREEN}" stroke-width="2" opacity="0.3"/>`
				: ""}

			${iconUri
				? `<image href="${iconUri}" x="${cx - innerR}" y="${cy - innerR}" width="${innerR * 2}" height="${innerR * 2}" clip-path="url(#ic)" preserveAspectRatio="xMidYMid slice" opacity="${iconOpacity}"/>`
				: ""}

			<!-- Status text inside ring -->
			<text x="${cx}" y="${cy + 9}" font-size="${statusSize}" fill="${statusColor}" text-anchor="middle" font-weight="bold" font-family="sans-serif">${statusText}</text>

			<!-- Gold info -->
			<text x="${cx}" y="${cy + r + 24}" font-size="18" fill="${GOLD}" text-anchor="middle" font-weight="700" font-family="sans-serif">${goldStr} / ${targetStr}</text>

			<!-- Bottom info -->
			<text x="${cx}" y="${cy + r + 44}" font-size="14" fill="${bottomColor}" text-anchor="middle" font-weight="600" font-family="sans-serif">${escapeXml(bottomText)}</text>
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}
}

// ── Helpers ──

function formatGold(gold: number): string {
	if (gold >= 10000) return `${(gold / 1000).toFixed(1)}k`;
	return String(Math.round(gold));
}

function formatTime(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function truncate(str: string, max: number): string {
	return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function escapeXml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
