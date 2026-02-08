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
import { getSpellIcon } from "../services/lol-icons";
import {
	SUMMONER_SPELL_COOLDOWNS,
	SUMMONER_SPELL_DISPLAY_NAMES,
	SPELL_DISPLAY_TO_KEY,
	type GamePlayer,
	type SummonerSpellState,
} from "../types/lol";

const logger = streamDeck.logger.createScope("SumTracker");

/**
 * Summoner Tracker action — tracks an enemy's summoner spells on the Stream Deck.
 *
 * Configuration: The user selects which enemy slot (1-5 by position) and which spell (1 or 2).
 *
 * Behavior:
 * - When a game is active, displays the enemy's spell icon + remaining cooldown.
 * - Press the key to mark the spell as "used" → starts the cooldown timer.
 * - Long press (or second press while on cooldown) to reset the timer.
 * - Shows the remaining seconds as a countdown on the key title.
 */
@action({ UUID: "com.desstroct.lol-api.summoner-tracker" })
export class SummonerTracker extends SingletonAction<SummonerTrackerSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private trackedSpells: Map<string, SpellTrackingState> = new Map();
	/** Per-dial instance state: current enemy/spell selection */
	private dialStates: Map<string, DialInstanceState> = new Map();

	override onWillAppear(ev: WillAppearEvent<SummonerTrackerSettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			// Initialize dial state with defaults
			const ds = this.getDialState(ev.action.id);
			return ev.action.setFeedback({
				title: `Enemy ${ds.enemySlot}`,
				spell_info: ds.spellSlot === 1 ? "Spell D" : "Spell F",
				cd_text: "Waiting...",
				cd_bar: { value: 0 },
			});
		}
		const settings = ev.payload.settings;
		const enemySlot = settings.enemySlot ?? 1;
		const spellSlot = settings.spellSlot ?? 1;
		return ev.action.setTitle(`Enemy ${enemySlot}\n${spellSlot === 1 ? "Spell D" : "Spell F"}`);
	}

	override onWillDisappear(ev: WillDisappearEvent<SummonerTrackerSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<SummonerTrackerSettings>): Promise<void> {
		const settings = ev.payload.settings;
		await this.toggleSpellState(settings.enemySlot ?? 1, settings.spellSlot ?? 1);
		await this.updateAll();
	}

	/** Dial rotation: cycle through enemy slots 1-5 */
	override async onDialRotate(ev: DialRotateEvent<SummonerTrackerSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		ds.enemySlot = ((ds.enemySlot - 1 + ev.payload.ticks + 50) % 5) + 1;
		await this.updateAll();
	}

	/** Dial press release: mark spell as used / reset */
	override async onDialUp(ev: DialUpEvent<SummonerTrackerSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		await this.toggleSpellState(ds.enemySlot, ds.spellSlot);
		await this.updateAll();
	}

	/** Touch tap: toggle spell D ↔ F. Long touch: reset cooldown */
	override async onTouchTap(ev: TouchTapEvent<SummonerTrackerSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);

		if (ev.payload.hold) {
			// Long touch: reset the current spell timer
			const key = `e${ds.enemySlot}_s${ds.spellSlot}`;
			const state = this.trackedSpells.get(key);
			if (state) {
				state.isOnCooldown = false;
				state.usedAtGameTime = null;
				state.remainingCooldown = 0;
				logger.info(`Long touch reset: ${state.spellName}`);
			}
		} else {
			// Short tap: toggle between spell 1 and 2
			ds.spellSlot = ds.spellSlot === 1 ? 2 : 1;
		}
		await this.updateAll();
	}

	private getDialState(actionId: string): DialInstanceState {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { enemySlot: 1, spellSlot: 1 };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private async toggleSpellState(enemySlot: number, spellSlot: number): Promise<void> {
		const key = `e${enemySlot}_s${spellSlot}`;
		const state = this.trackedSpells.get(key);

		if (!state || !state.spellKey) return;

		if (state.isOnCooldown) {
			state.isOnCooldown = false;
			state.usedAtGameTime = null;
			state.remainingCooldown = 0;
			logger.info(`Reset timer for ${state.spellName}`);
		} else {
			const gameTime = await gameClient.getGameTime();
			state.usedAtGameTime = gameTime;
			state.isOnCooldown = true;
			state.remainingCooldown = state.cooldown;
			logger.info(`Marked ${state.spellName} as used at ${Math.floor(gameTime)}s (CD: ${state.cooldown}s)`);
		}
	}

	private startPolling(): void {
		if (this.pollInterval) return;

		this.updateAll();
		this.pollInterval = setInterval(() => this.updateAll(), 1000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private getTrackingKey(enemySlot: number, spellSlot: number): string {
		return `e${enemySlot}_s${spellSlot}`;
	}

	private async updateAll(): Promise<void> {
		const allData = await gameClient.getAllData();
		if (!allData) {
			// Not in game: show idle state
			for (const a of this.actions) {
				if (a.isDial()) {
					const ds = this.getDialState(a.id);
					await a.setFeedback({
						spell_icon: "",
						title: `Enemy ${ds.enemySlot}`,
						spell_info: ds.spellSlot === 1 ? "Spell D" : "Spell F",
						cd_text: "No game",
						cd_bar: { value: 0 },
					});
				} else {
					const settings = (await a.getSettings()) as SummonerTrackerSettings;
					await a.setImage("");
					await a.setTitle(`Enemy ${settings.enemySlot ?? 1}\nNo game`);
				}
			}
			return;
		}

		// Find active player's team
		const activePlayerName = allData.activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) => p.riotIdGameName === activePlayerName || p.summonerName === activePlayerName,
		);
		if (!me) return;

		// Get enemy players sorted by position
		const enemies = allData.allPlayers
			.filter((p) => p.team !== me.team)
			.sort((a, b) => positionOrder(a.position) - positionOrder(b.position));

		const gameTime = allData.gameData.gameTime;

		for (const a of this.actions) {
			// Determine enemy/spell slot from dial state or key settings
			let enemySlot: number;
			let spellSlot: number;
			const isDial = a.isDial();

			if (isDial) {
				const ds = this.getDialState(a.id);
				enemySlot = ds.enemySlot;
				spellSlot = ds.spellSlot;
			} else {
				const settings = (await a.getSettings()) as SummonerTrackerSettings;
				enemySlot = settings.enemySlot ?? 1;
				spellSlot = settings.spellSlot ?? 1;
			}

			const enemyIndex = enemySlot - 1;
			const enemy = enemies[enemyIndex];
			if (!enemy) {
				if (isDial) {
					await a.setFeedback({ title: `Enemy ${enemySlot}`, spell_info: "---", cd_text: "---", cd_bar: { value: 0 } });
				} else {
					await a.setTitle("---");
				}
				continue;
			}

			// Identify the spell
			const spellInfo = spellSlot === 1
				? enemy.summonerSpells.summonerSpellOne
				: enemy.summonerSpells.summonerSpellTwo;

			const spellKey = SPELL_DISPLAY_TO_KEY[spellInfo.displayName] ?? "Unknown";
			const spellName = spellInfo.displayName;
			const baseCooldown = SUMMONER_SPELL_COOLDOWNS[spellKey] ?? 300;

			const trackingKey = this.getTrackingKey(enemySlot, spellSlot);
			let state = this.trackedSpells.get(trackingKey);

			if (!state || state.spellKey !== spellKey) {
				state = {
					spellKey,
					spellName,
					cooldown: baseCooldown,
					usedAtGameTime: null,
					isOnCooldown: false,
					remainingCooldown: 0,
					enemyChampion: enemy.championName,
				};
				this.trackedSpells.set(trackingKey, state);
			}

			// Update cooldown if active
			if (state.isOnCooldown && state.usedAtGameTime !== null) {
				const elapsed = gameTime - state.usedAtGameTime;
				state.remainingCooldown = Math.max(0, state.cooldown - elapsed);

				if (state.remainingCooldown <= 0) {
					state.isOnCooldown = false;
					state.usedAtGameTime = null;
					state.remainingCooldown = 0;
				}
			}

			if (isDial) {
				await this.renderDial(a, state, enemySlot, spellSlot);
			} else {
				await this.renderKey(a, state);
			}
		}
	}

	private async renderDial(
		a: { setFeedback: (payload: any) => Promise<void> },
		state: SpellTrackingState,
		enemySlot: number,
		spellSlot: number,
	): Promise<void> {
		const champName = state.enemyChampion || "???";
		const spellLabel = spellSlot === 1 ? "(D)" : "(F)";
		const spellIconUri = await getSpellIcon(state.spellKey);

		if (state.isOnCooldown) {
			const remaining = Math.ceil(state.remainingCooldown);
			const minutes = Math.floor(remaining / 60);
			const seconds = remaining % 60;
			const timeStr = minutes > 0
				? `${minutes}:${String(seconds).padStart(2, "0")}`
				: `${seconds}s`;
			const pct = Math.round((state.remainingCooldown / state.cooldown) * 100);

			await a.setFeedback({
				spell_icon: spellIconUri ?? "",
				title: `E${enemySlot} ${champName}`,
				spell_info: `${state.spellName} ${spellLabel} · ${state.cooldown}s`,
				cd_text: timeStr,
				cd_bar: { value: pct, bar_fill_c: "#E74C3C" },
			});
		} else {
			await a.setFeedback({
				spell_icon: spellIconUri ?? "",
				title: `E${enemySlot} ${champName}`,
				spell_info: `${state.spellName} ${spellLabel} · ${state.cooldown}s`,
				cd_text: "✅ READY",
				cd_bar: { value: 0, bar_fill_c: "#2ECC71" },
			});
		}
	}

	private async renderKey(
		a: { setTitle: (title: string) => Promise<void>; setImage: (image: string) => Promise<void> },
		state: SpellTrackingState,
	): Promise<void> {
		const spellShort = SUMMONER_SPELL_DISPLAY_NAMES[state.spellKey] ?? state.spellName ?? "?";
		const spellIconUri = await getSpellIcon(state.spellKey);
		if (spellIconUri) await a.setImage(spellIconUri);

		if (state.isOnCooldown) {
			const remaining = Math.ceil(state.remainingCooldown);
			const minutes = Math.floor(remaining / 60);
			const seconds = remaining % 60;
			const timeStr = minutes > 0
				? `${minutes}:${String(seconds).padStart(2, "0")}`
				: `${seconds}s`;

			await a.setTitle(`${spellShort}\n${timeStr}`);
		} else {
			await a.setTitle(`${spellShort}\nReady`);
		}
	}
}

interface SpellTrackingState {
	spellKey: string;
	spellName: string;
	cooldown: number;
	usedAtGameTime: number | null;
	isOnCooldown: boolean;
	remainingCooldown: number;
	enemyChampion: string;
}

interface DialInstanceState {
	enemySlot: number; // 1-5
	spellSlot: number; // 1 or 2
}

type SummonerTrackerSettings = {
	enemySlot?: number; // 1-5 (enemy position) — used by Keypad
	spellSlot?: number; // 1 or 2 — used by Keypad
};

function positionOrder(pos: string): number {
	const order: Record<string, number> = {
		TOP: 1,
		JUNGLE: 2,
		MIDDLE: 3,
		BOTTOM: 4,
		UTILITY: 5,
	};
	return order[pos] ?? 99;
}
