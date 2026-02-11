import {
	action,
	type DialAction,
	DialRotateEvent,
	DialUpEvent,
	type KeyAction,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import { getChampionIconByName, getItemIcon } from "../services/lol-icons";
import type { GamePlayer, GameItem } from "../types/lol";

const logger = streamDeck.logger.createScope("EnemyBuilds");

/**
 * Enemy Build Tracker action — shows enemy items in real-time during the game.
 *
 * Key display: Shows selected enemy's items (scrollable)
 * Dial display: Enemy champion icon, items, gold value
 *   - Rotate: Cycle through enemies
 *   - Press/Touch: Refresh
 */
@action({ UUID: "com.desstroct.lol-api.enemy-builds" })
export class EnemyBuilds extends SingletonAction<EnemyBuildsSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-dial state: which enemy (0-4) the dial is viewing */
	private dialStates: Map<string, { enemyIndex: number }> = new Map();
	/** Cache previous items to detect new purchases */
	private previousItems: Map<string, number[]> = new Map();

	override onWillAppear(ev: WillAppearEvent<EnemyBuildsSettings>): void | Promise<void> {
		this.startPolling();
		const initialEnemy = ev.payload.settings.enemyIndex ?? 0;
		if (ev.action.isDial()) {
			this.getDialState(ev.action.id, initialEnemy);
			return ev.action.setFeedback({
				champ_icon: "",
				enemy_name: "Waiting...",
				items_text: "",
				gold_text: "",
				new_item: "",
			});
		}
		return ev.action.setTitle("Enemy\nBuilds");
	}

	override onWillDisappear(ev: WillDisappearEvent<EnemyBuildsSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<EnemyBuildsSettings>): Promise<void> {
		// Cycle to next enemy on key press
		const settings = ev.payload.settings;
		const newIndex = ((settings.enemyIndex ?? 0) + 1) % 5;
		await ev.action.setSettings({ ...settings, enemyIndex: newIndex });
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<EnemyBuildsSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		ds.enemyIndex = ((ds.enemyIndex + ev.payload.ticks + 100) % 5);
		await this.updateAll();
	}

	override async onDialUp(_ev: DialUpEvent<EnemyBuildsSettings>): Promise<void> {
		await this.updateAll();
	}

	override async onTouchTap(_ev: TouchTapEvent<EnemyBuildsSettings>): Promise<void> {
		await this.updateAll();
	}

	private getDialState(actionId: string, initial = 0): { enemyIndex: number } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { enemyIndex: initial };
			this.dialStates.set(actionId, ds);
		}
		return ds;
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
		// TFT not supported
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", enemy_name: "N/A in TFT", items_text: "", gold_text: "", new_item: "" });
				} else {
					await a.setImage("");
					await a.setTitle("Builds\nN/A TFT");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();
		if (!allData) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", enemy_name: "No game", items_text: "Waiting for game...", gold_text: "", new_item: "" });
				} else {
					await a.setImage("");
					await a.setTitle("Builds\nNo game");
				}
			}
			return;
		}

		// Find active player and their team
		const activeName = allData.activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) => p.riotIdGameName === activeName || p.summonerName === activeName,
		);

		if (!me) {
			return;
		}

		// Get enemies (opposite team)
		const myTeam = me.team;
		const enemies = allData.allPlayers.filter((p) => p.team !== myTeam);

		if (enemies.length === 0) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", enemy_name: "No enemies", items_text: "", gold_text: "", new_item: "" });
				} else {
					await a.setTitle("No\nenemies");
				}
			}
			return;
		}

		// Update each action
		for (const a of this.actions) {
			let enemyIndex = 0;

			if (a.isDial()) {
				const ds = this.getDialState(a.id);
				enemyIndex = ds.enemyIndex % enemies.length;
			} else {
				const settings = await a.getSettings() as EnemyBuildsSettings;
				enemyIndex = (settings.enemyIndex ?? 0) % enemies.length;
			}

			const enemy = enemies[enemyIndex];
			await this.updateForEnemy(a, enemy, enemyIndex, enemies.length);
		}
	}

	private async updateForEnemy(
		action: DialAction<EnemyBuildsSettings> | KeyAction<EnemyBuildsSettings>,
		enemy: GamePlayer,
		index: number,
		totalEnemies: number,
	): Promise<void> {
		const champIcon = enemy.championName
			? await getChampionIconByName(enemy.championName)
			: null;

		// Get completed items (slot 0-5, exclude consumables and wards if possible)
		const items = enemy.items.filter((item) => 
			item.itemID > 0 && 
			!item.consumable &&
			item.slot <= 5
		);

		// Calculate total gold spent on items
		const totalGold = items.reduce((sum, item) => sum + item.price * item.count, 0);
		const goldStr = totalGold >= 1000 ? `${(totalGold / 1000).toFixed(1)}k` : `${totalGold}`;

		// Detect new items
		const currentItemIds = items.map((i) => i.itemID).sort();
		const prevItemIds = this.previousItems.get(enemy.riotId) ?? [];
		const newItems = currentItemIds.filter((id) => !prevItemIds.includes(id));
		this.previousItems.set(enemy.riotId, currentItemIds);

		// Format items display
		const itemNames = items
			.slice(0, 4)  // Show max 4 items for readability
			.map((i) => this.shortenItemName(i.displayName))
			.join(" | ");

		// Get icon for the newest completed item if there's a new purchase
		let newItemText = "";
		if (newItems.length > 0) {
			const newestItem = items.find((i) => i.itemID === newItems[newItems.length - 1]);
			if (newestItem) {
				newItemText = `NEW: ${newestItem.displayName}`;
			}
		}

		const enemyLabel = `${enemy.championName ?? "?"} (${index + 1}/${totalEnemies})`;
		const positionLabel = enemy.position ? ` [${enemy.position}]` : "";

		if (action.isDial()) {
			// For dial: show richer info
			await action.setFeedback({
				champ_icon: champIcon ?? "",
				enemy_name: `${enemy.championName}${positionLabel}`,
				items_text: itemNames || "No items",
				gold_text: `${goldStr} gold`,
				new_item: newItemText,
			});
		} else {
			// For key: compact display
			if (champIcon) await action.setImage(champIcon);
			const shortItems = items.slice(0, 3).map((i) => this.shortenItemName(i.displayName, 6)).join("\n");
			await action.setTitle(`${enemy.championName?.substring(0, 6) ?? "?"}\n${shortItems || "..."}`);
		}
	}

	/**
	 * Shorten item names for display
	 */
	private shortenItemName(name: string, maxLen = 12): string {
		if (!name) return "";
		// Remove common prefixes
		const cleaned = name
			.replace(/^(Hextech|Trinity|Infinity|Rapid|Phantom|Runaan's|Blade of the|The) /i, "")
			.replace(" Edge", "")
			.replace(" Dancer", "");
		return cleaned.length > maxLen
			? cleaned.substring(0, maxLen - 1) + "…"
			: cleaned;
	}
}

type EnemyBuildsSettings = {
	enemyIndex?: number;
};
