import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import { getChampionIconByName } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("DeathTimer");

/**
 * Death Timer action — shows your respawn countdown when you die in-game.
 *
 * Key display:
 *   ALIVE → champion icon + "ALIVE"
 *   DEAD  → skull/red + "DEAD 23s"
 *   No game → "Death\nTimer"
 *
 * Dial display:
 *   Rich layout with champion icon, status, respawn bar
 */
@action({ UUID: "com.desstroct.lol-api.death-timer" })
export class DeathTimer extends SingletonAction {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private lastDead = false;

	override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				champ_icon: "",
				status_text: "Death Timer",
				timer_text: "Waiting...",
				respawn_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("Death\nTimer");
	}

	override onWillDisappear(_ev: WillDisappearEvent): void | Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		// Fast polling (1s) for accurate countdown
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 1000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		// TFT has no Live Client Data API
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", status_text: "N/A in TFT", timer_text: "", respawn_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Death\nN/A TFT");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();

		if (!allData) {
			if (this.lastDead) {
				this.lastDead = false;
			}
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						status_text: "Death Timer",
						timer_text: "No game",
						respawn_bar: { value: 0 },
					});
				} else {
					await a.setImage("");
					await a.setTitle("Death\nTimer");
				}
			}
			return;
		}

		const activeName = allData.activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) => p.riotIdGameName === activeName || p.summonerName === activeName,
		);

		if (!me) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ status_text: "?", timer_text: "", respawn_bar: { value: 0 } });
				} else {
					await a.setTitle("Death\n?");
				}
			}
			return;
		}

		const champIcon = me.championName
			? await getChampionIconByName(me.championName)
			: null;

		if (me.isDead) {
			this.lastDead = true;
			const respawnSec = Math.ceil(me.respawnTimer);
			const barValue = Math.min(100, Math.round((respawnSec / 60) * 100));

			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: champIcon ?? "",
						status_text: "💀 DEAD",
						timer_text: `${respawnSec}s`,
						respawn_bar: { value: barValue, bar_fill_c: "#E74C3C" },
					});
				} else {
					if (champIcon) await a.setImage(champIcon);
					await a.setTitle(`💀 DEAD\n${respawnSec}s`);
				}
			}
		} else {
			const wasJustDead = this.lastDead;
			this.lastDead = false;

			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: champIcon ?? "",
						status_text: wasJustDead ? "RESPAWNED!" : "ALIVE",
						timer_text: `Lvl ${me.level}`,
						respawn_bar: { value: 100, bar_fill_c: "#2ECC71" },
					});
				} else {
					if (champIcon) await a.setImage(champIcon);
					await a.setTitle(wasJustDead ? "ALIVE!\n✨" : `ALIVE\nLvl ${me.level}`);
				}
			}
		}
	}
}
