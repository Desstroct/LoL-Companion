import {
	action,
	DialRotateEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import { itemBuilds, ItemBuilds } from "../services/item-builds";
import type { ItemBuild } from "../services/item-builds";
import { dataDragon } from "../services/data-dragon";
import { getItemIcon } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("BestItem");

/** Tier-2 boots IDs — if any is owned, consider the "boots" slot filled */
const TIER2_BOOTS = new Set([
	3006, // Berserker's Greaves
	3009, // Boots of Swiftness
	3020, // Sorcerer's Shoes
	3047, // Plated Steelcaps
	3111, // Mercury's Treads
	3117, // Mobility Boots
	3158, // Ionian Boots of Lucidity
]);

/**
 * Best Item action — recommends the next item to buy based on live game data.
 *
 * Key display: item icon + name + cost
 * Dial display: item icon, name, cost, gold progress bar, BUY/SAVE status
 * Dial rotate: cycle through full recommended build
 */
@action({ UUID: "com.desstroct.lol-api.best-item" })
export class BestItem extends SingletonAction {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private currentBuild: ItemBuild | null = null;
	private currentChampion: string | null = null;
	private currentLane: string | null = null;
	/** Index into fullBuild for dial browsing (-1 = auto / next item) */
	private browseIndex = -1;
	private fetchingBuild = false;

	override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "BEST ITEM",
				item_name: "Waiting...",
				cost_text: "",
				gold_bar: { value: 0 },
				status_text: "",
			});
		}
		return ev.action.setTitle("Best Item\nWaiting...");
	}

	override onWillDisappear(_ev: WillDisappearEvent): void | Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	override onDialRotate(ev: DialRotateEvent): void | Promise<void> {
		if (!this.currentBuild || this.currentBuild.fullBuild.length === 0) return;

		const len = this.currentBuild.fullBuild.length;

		if (this.browseIndex === -1) {
			// First rotation: start at 0
			this.browseIndex = ev.payload.ticks > 0 ? 0 : len - 1;
		} else {
			this.browseIndex += ev.payload.ticks > 0 ? 1 : -1;
			// Wrap around
			if (this.browseIndex >= len) this.browseIndex = 0;
			if (this.browseIndex < 0) this.browseIndex = len - 1;
		}

		// Trigger immediate update
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 2000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		// TFT has a different item system / no Live Client Data API
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ item_icon: "", title: "BEST ITEM", item_name: "N/A in TFT", cost_text: "", gold_bar: { value: 0 }, status_text: "" });
				} else {
					await a.setImage(""); await a.setTitle("Best Item\nN/A TFT");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();

		// ── No game running ──
		if (!allData) {
			// Reset state for next game
			if (this.currentChampion) {
				this.currentChampion = null;
				this.currentLane = null;
				this.currentBuild = null;
				this.browseIndex = -1;
			}

			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						item_icon: "",
						title: "BEST ITEM",
						item_name: "No game",
						cost_text: "",
						gold_bar: { value: 0 },
						status_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle("Best Item\nNo game");
				}
			}
			return;
		}

		// ── Find active player ──
		const activeName = allData.activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) => p.riotIdGameName === activeName || p.summonerName === activeName,
		);

		if (!me) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ item_name: "Player?", cost_text: "", status_text: "" });
				} else {
					await a.setTitle("Best Item\n?");
				}
			}
			return;
		}

		// ── Fetch build if not loaded yet ──
		const champName = me.championName;
		const lane = gameMode.isARAM() ? "aram" : ItemBuilds.toLolalyticsLane(me.position);

		if (champName !== this.currentChampion || lane !== this.currentLane) {
			this.currentChampion = champName;
			this.currentLane = lane;
			this.currentBuild = null;
			this.browseIndex = -1;

			if (!this.fetchingBuild) {
				this.fetchingBuild = true;

				for (const a of this.actions) {
					if (a.isDial()) {
						await a.setFeedback({ item_name: "Loading build...", cost_text: "", status_text: "" });
					} else {
						await a.setTitle("Best Item\nLoading...");
					}
				}

				const alias = ItemBuilds.toAlias(champName);
				const build = await itemBuilds.getBuild(alias, lane);
				this.currentBuild = build;
				this.fetchingBuild = false;

				if (!build) {
					for (const a of this.actions) {
						if (a.isDial()) {
							await a.setFeedback({ item_name: "No data", cost_text: "", status_text: "" });
						} else {
							await a.setTitle("Best Item\nNo data");
						}
					}
					return;
				}
			}
		}

		if (!this.currentBuild || this.currentBuild.fullBuild.length === 0) return;

		// ── Determine which item to display ──
		const playerItemIds = new Set(me.items.map((i) => i.itemID));
		const playerGold = allData.activePlayer.currentGold;
		const build = this.currentBuild.fullBuild;

		let displayItemId: number;
		let displaySlotLabel: string;
		let isNextToBuy: boolean;

		if (this.browseIndex >= 0 && this.browseIndex < build.length) {
			// ── Browse mode: show the item at browseIndex ──
			displayItemId = build[this.browseIndex];
			displaySlotLabel = `Item ${this.browseIndex + 1}/${build.length}`;
			isNextToBuy = false;
		} else {
			// ── Auto mode: find next item to buy ──
			const nextIdx = this.findNextItemIndex(build, playerItemIds);

			if (nextIdx === -1) {
				// Full build complete!
				for (const a of this.actions) {
					if (a.isDial()) {
						await a.setFeedback({
							item_icon: "",
							title: "BUILD",
							item_name: "Complete!",
							cost_text: `${formatGold(playerGold)}g`,
							gold_bar: { value: 100, bar_fill_c: "#2ECC71" },
							status_text: "Full build ✓",
						});
					} else {
						await a.setImage("");
						await a.setTitle("Build\nComplete!");
					}
				}
				return;
			}

			displayItemId = build[nextIdx];
			displaySlotLabel = `NEXT (${nextIdx + 1}/${build.length})`;
			isNextToBuy = true;
		}

		// ── Get item info ──
		const itemName = dataDragon.getItemName(displayItemId);
		const itemCost = dataDragon.getItemCost(displayItemId);
		const itemIcon = await getItemIcon(displayItemId);

		const canAfford = playerGold >= itemCost;
		const owned = this.isItemOwned(displayItemId, playerItemIds);

		// Gold progress towards item (0-100%)
		const goldProgress = itemCost > 0
			? Math.min(100, Math.round((playerGold / itemCost) * 100))
			: 100;

		// Status text
		let statusText: string;
		let barColor: string;
		if (owned) {
			statusText = "Owned ✓";
			barColor = "#2ECC71";
		} else if (canAfford && isNextToBuy) {
			statusText = "BUY NOW!";
			barColor = "#2ECC71";
		} else if (isNextToBuy) {
			const needed = itemCost - playerGold;
			statusText = `Need ${formatGold(needed)}g`;
			barColor = "#F1C40F";
		} else {
			statusText = `${formatGold(itemCost)}g`;
			barColor = "#888888";
		}

		const costText = `${formatGold(itemCost)}g | ${formatGold(playerGold)}g`;

		// ── Update displays ──
		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					item_icon: itemIcon ?? "",
					title: displaySlotLabel,
					item_name: truncate(itemName, 18),
					cost_text: costText,
					gold_bar: {
						value: owned ? 100 : goldProgress,
						bar_fill_c: barColor,
					},
					status_text: statusText,
				});
			} else {
				if (itemIcon) await a.setImage(itemIcon);
				const keyStatus = owned ? "✓" : canAfford && isNextToBuy ? "BUY" : `${formatGold(itemCost)}g`;
				await a.setTitle(`${truncate(itemName, 12)}\n${keyStatus}`);
			}
		}
	}

	/**
	 * Find the index of the next item in the build that the player doesn't own.
	 * Returns -1 if all items are owned (build complete).
	 */
	private findNextItemIndex(build: number[], playerItemIds: Set<number>): number {
		for (let i = 0; i < build.length; i++) {
			if (!this.isItemOwned(build[i], playerItemIds)) {
				return i;
			}
		}
		return -1;
	}

	/**
	 * Check if an item (or its equivalent) is owned.
	 * Handles tier-2 boots substitution: any tier-2 boot fills the boots slot.
	 */
	private isItemOwned(itemId: number, playerItemIds: Set<number>): boolean {
		if (playerItemIds.has(itemId)) return true;

		// If the build item is tier-2 boots, check if player has ANY tier-2 boots
		if (TIER2_BOOTS.has(itemId)) {
			for (const bootId of TIER2_BOOTS) {
				if (playerItemIds.has(bootId)) return true;
			}
		}

		return false;
	}
}

// ── Helpers ──

function formatGold(gold: number): string {
	if (gold >= 1000) return `${(gold / 1000).toFixed(1)}k`;
	return String(gold);
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.substring(0, maxLen - 1) + "…";
}
