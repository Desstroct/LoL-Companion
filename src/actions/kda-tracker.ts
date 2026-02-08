import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { gameClient } from "../services/game-client";
import { getChampionIconByName } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("KdaTracker");

/**
 * KDA Tracker action — shows live KDA, CS/min, and gold.
 *
 * Key display: K/D/A, CS/min, KDA ratio
 * Dial display: rich dashboard with KDA bar, gold, CS on touch strip
 */
@action({ UUID: "com.desstroct.lol-api.kda-tracker" })
export class KdaTracker extends SingletonAction {
	private pollInterval: ReturnType<typeof setInterval> | null = null;

	override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				kda_line: "- / - / -",
				cs_line: "",
				gold_text: "",
				kda_bar: { value: 0 },
				ratio_text: "Waiting...",
			});
		}
		return ev.action.setTitle("KDA\nWaiting...");
	}

	override onWillDisappear(_ev: WillDisappearEvent): void | Promise<void> {
		this.stopPolling();
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
		const allData = await gameClient.getAllData();

		if (!allData) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						kda_line: "- / - / -",
						cs_line: "No game",
						gold_text: "",
						kda_bar: { value: 0 },
						ratio_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle("KDA\nNo game");
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
					await a.setFeedback({ kda_line: "???", cs_line: "", gold_text: "", kda_bar: { value: 0 }, ratio_text: "" });
				} else {
					await a.setTitle("KDA\n?");
				}
			}
			return;
		}

		const { kills, deaths, assists, creepScore } = me.scores;
		const gameTimeMinutes = allData.gameData.gameTime / 60;

		// Fetch champion icon for display (championName may be undefined during loading)
		const champIcon = me.championName
			? await getChampionIconByName(me.championName)
			: null;

		const kda = deaths === 0
			? (kills + assists)
			: parseFloat(((kills + assists) / deaths).toFixed(1));

		const csPerMin = gameTimeMinutes > 0.5
			? (creepScore / gameTimeMinutes).toFixed(1)
			: creepScore.toString();

		const gold = allData.activePlayer.currentGold;
		const goldStr = gold >= 1000 ? `${(gold / 1000).toFixed(1)}k` : `${gold}`;

		const kdaLine = `${kills}/${deaths}/${assists}`;
		const csLine = `${creepScore}cs ${csPerMin}/m`;
		const kdaRatio = deaths === 0 ? `Perfect ${kda}` : `${kda} KDA`;

		// KDA bar: map 0-10 KDA to 0-100%, cap at 100
		const kdaBarValue = Math.min(100, Math.round((kda / 10) * 100));
		// Color: green >=3, yellow >=1.5, red <1.5
		const barColor = kda >= 3.0 ? "#2ECC71" : kda >= 1.5 ? "#F1C40F" : "#E74C3C";

		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					champ_icon: champIcon ?? "",
					kda_line: kdaLine,
					cs_line: csLine,
					gold_text: `${goldStr}g`,
					kda_bar: { value: kdaBarValue, bar_fill_c: barColor },
					ratio_text: kdaRatio,
				});
			} else {
				if (champIcon) await a.setImage(champIcon);
				await a.setTitle(`${kdaLine}\n${kdaRatio}`);
			}
		}
	}
}
