import {
	action,
	DialRotateEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import { getChampionIconByName } from "../services/lol-icons";
import type { GamePlayer } from "../types/lol";

const logger = streamDeck.logger.createScope("PowerSpike");

/**
 * Important level thresholds for power spikes.
 */
const POWER_SPIKE_LEVELS = [6, 11, 16];

/**
 * Major items worth tracking (by itemID).
 * These are high-impact items that significantly change a champion's power.
 */
const MAJOR_ITEM_IDS = new Set([
	// Mythic-tier items (S14+ legendaries)
	3031, // Infinity Edge
	3153, // Blade of the Ruined King
	3089, // Rabadon's Deathcap
	3124, // Guinsoo's Rageblade
	3142, // Youmuu's Ghostblade
	3046, // Phantom Dancer
	3094, // Rapid Firecannon
	3072, // Bloodthirster
	3033, // Mortal Reminder
	3036, // Lord Dominik's Regards
	6672, // Kraken Slayer
	6673, // Immortal Shieldbow
	6675, // Navori Quickblades
	3161, // Spear of Shojin
	6676, // The Collector
	3074, // Ravenous Hydra
	3748, // Titanic Hydra
	3053, // Sterak's Gage
	3026, // Guardian Angel
	3156, // Maw of Malmortius
	3139, // Mercurial Scimitar
	4005, // Imperial Mandate
	6656, // Everfrost
	3157, // Zhonya's Hourglass
	3165, // Morellonomicon
	6655, // Luden's Companion
	6653, // Liandry's Torment
	4628, // Horizon Focus
	4633, // Riftmaker
	3100, // Lich Bane
	6657, // Rod of Ages
	3068, // Sunfire Aegis
	3075, // Thornmail
	3143, // Randuin's Omen
	3110, // Frozen Heart
	3742, // Dead Man's Plate
	3193, // Gargoyle Stoneplate
	3065, // Spirit Visage
	3083, // Warmog's Armor
	3190, // Locket of the Iron Solari
	3222, // Mikael's Blessing
	3504, // Ardent Censer
	3107, // Redemption
	3011, // Chemtech Putrifier
]);

/**
 * Power Spike Alerts action — notifies when enemies hit level 6/11/16 or complete major items.
 *
 * Key display: Shows latest spike event
 * Dial display:
 *   - Rotate: Scroll through recent events
 *   - Shows champion, spike type, time since
 */
@action({ UUID: "com.desstroct.lol-api.power-spike" })
export class PowerSpike extends SingletonAction<PowerSpikeSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Track previous state to detect changes */
	private previousLevels: Map<string, number> = new Map();
	private previousItems: Map<string, Set<number>> = new Map();
	/** Recent spike events (newest first) */
	private spikeEvents: SpikeEvent[] = [];
	/** Per-dial state: which event index to show */
	private dialStates: Map<string, { eventIndex: number }> = new Map();
	/** Last game time for calculating "time since" */
	private lastGameTime = 0;

	override onWillAppear(ev: WillAppearEvent<PowerSpikeSettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			this.getDialState(ev.action.id);
			return ev.action.setFeedback({
				champ_icon: "",
				spike_type: "POWER SPIKE",
				spike_detail: "Waiting for game...",
				time_ago: "",
			});
		}
		return ev.action.setTitle("Power\nSpikes");
	}

	override onWillDisappear(ev: WillDisappearEvent<PowerSpikeSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(_ev: KeyDownEvent<PowerSpikeSettings>): Promise<void> {
		// Clear all events on key press
		this.spikeEvents = [];
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<PowerSpikeSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		if (this.spikeEvents.length > 0) {
			ds.eventIndex = ((ds.eventIndex + ev.payload.ticks + 100) % this.spikeEvents.length);
		}
		await this.updateAll();
	}

	override async onTouchTap(_ev: TouchTapEvent<PowerSpikeSettings>): Promise<void> {
		await this.updateAll();
	}

	private getDialState(actionId: string): { eventIndex: number } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { eventIndex: 0 };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 1500);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		// TFT not supported
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", spike_type: "", spike_detail: "N/A in TFT", time_ago: "" });
				} else {
					await a.setTitle("Spikes\nN/A TFT");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();
		if (!allData) {
			// No game — reset tracking
			if (this.previousLevels.size > 0) {
				this.previousLevels.clear();
				this.previousItems.clear();
				this.spikeEvents = [];
				logger.debug("Game ended, reset spike tracking");
			}
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", spike_type: "POWER SPIKE", spike_detail: "No game", time_ago: "" });
				} else {
					await a.setTitle("Spikes\nNo game");
				}
			}
			return;
		}

		this.lastGameTime = allData.gameData.gameTime;

		// Find my team to identify enemies
		const activeName = allData.activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) => p.riotIdGameName === activeName || p.summonerName === activeName,
		);
		if (!me) return;

		const enemies = allData.allPlayers.filter((p) => p.team !== me.team);

		// Check for new spikes
		const newSpikes: SpikeEvent[] = [];

		for (const enemy of enemies) {
			const playerId = enemy.riotId;
			const prevLevel = this.previousLevels.get(playerId) ?? 1;
			const prevItems = this.previousItems.get(playerId) ?? new Set<number>();

			// Check level spikes
			for (const spikeLevel of POWER_SPIKE_LEVELS) {
				if (prevLevel < spikeLevel && enemy.level >= spikeLevel) {
					newSpikes.push({
						championName: enemy.championName,
						type: "level",
						detail: `Level ${spikeLevel}`,
						gameTime: this.lastGameTime,
						importance: spikeLevel === 6 ? 3 : spikeLevel === 11 ? 2 : 1,
					});
					logger.info(`${enemy.championName} hit level ${spikeLevel}`);
				}
			}

			// Check item completions
			const currentItemIds = new Set(enemy.items.map((i) => i.itemID).filter((id) => id > 0));
			for (const itemId of currentItemIds) {
				if (!prevItems.has(itemId) && MAJOR_ITEM_IDS.has(itemId)) {
					const item = enemy.items.find((i) => i.itemID === itemId);
					newSpikes.push({
						championName: enemy.championName,
						type: "item",
						detail: item?.displayName ?? `Item ${itemId}`,
						gameTime: this.lastGameTime,
						importance: 2,
					});
					logger.info(`${enemy.championName} completed ${item?.displayName}`);
				}
			}

			// Update tracking
			this.previousLevels.set(playerId, enemy.level);
			this.previousItems.set(playerId, currentItemIds);
		}

		// Add new spikes to the front of the list
		if (newSpikes.length > 0) {
			this.spikeEvents.unshift(...newSpikes);
			// Keep only last 10 events
			this.spikeEvents = this.spikeEvents.slice(0, 10);

			// Trigger alert for high-importance spikes
			const highPriority = newSpikes.some((s) => s.importance >= 2);
			if (highPriority) {
				await this.triggerAlert();
			}
		}

		// Update displays
		for (const a of this.actions) {
			if (a.isDial()) {
				const ds = this.getDialState(a.id);
				if (this.spikeEvents.length === 0) {
					await a.setFeedback({
						champ_icon: "",
						spike_type: "POWER SPIKE",
						spike_detail: "No spikes yet",
						time_ago: "",
					});
				} else {
					const event = this.spikeEvents[ds.eventIndex % this.spikeEvents.length];
					const champIcon = event.championName
						? await getChampionIconByName(event.championName)
						: null;
					const timeAgo = this.formatTimeAgo(event.gameTime);

					await a.setFeedback({
						champ_icon: champIcon ?? "",
						spike_type: event.type === "level" ? "⬆ LEVEL UP" : "🛒 NEW ITEM",
						spike_detail: `${event.championName}: ${event.detail}`,
						time_ago: timeAgo,
					});
				}
			} else {
				// Key: show count and latest
				if (this.spikeEvents.length === 0) {
					await a.setTitle("Spikes\n0");
				} else {
					const latest = this.spikeEvents[0];
					const shortName = latest.championName?.substring(0, 5) ?? "?";
					await a.setTitle(`${this.spikeEvents.length} Spike\n${shortName}`);
				}
			}
		}
	}

	/**
	 * Trigger visual/haptic alert for power spike.
	 */
	private async triggerAlert(): Promise<void> {
		// Flash the action briefly
		for (const a of this.actions) {
			if (a.isDial()) {
				// Trigger haptic feedback on Stream Deck+
				try {
					await a.setFeedback({
						spike_type: "⚠️ SPIKE!",
					});
				} catch (e) {
					// Haptic may not be available on all devices
				}
			} else {
				// Flash the key
				const originalTitle = await a.getSettings();
				await a.setTitle("⚠️ SPIKE!");
				setTimeout(async () => {
					await this.updateAll();
				}, 1500);
			}
		}
	}

	/**
	 * Format time difference as "Xs ago" or "Xm ago".
	 */
	private formatTimeAgo(eventTime: number): string {
		const diff = this.lastGameTime - eventTime;
		if (diff < 60) {
			return `${Math.round(diff)}s ago`;
		}
		return `${Math.floor(diff / 60)}m ago`;
	}
}

type PowerSpikeSettings = {
	// No settings needed
};

interface SpikeEvent {
	championName: string;
	type: "level" | "item";
	detail: string;
	gameTime: number;
	importance: number;  // 1-3, higher = more important
}
