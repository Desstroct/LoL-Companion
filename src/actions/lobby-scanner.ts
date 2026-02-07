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
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { dataDragon } from "../services/data-dragon";
import type { LcuChampSelectSession, PlayerCardData } from "../types/lol";

const logger = streamDeck.logger.createScope("LobbyScan");

const POSITIONS: Record<string, string> = {
	top: "TOP",
	jungle: "JGL",
	middle: "MID",
	bottom: "BOT",
	utility: "SUP",
	"": "?",
};

/**
 * Lobby Scanner action — displays player information during champion select.
 * Each instance is configured to show a specific slot (1-5 for ally, 6-10 for enemy).
 * Shows: Champion, Rank, Win Rate.
 */
@action({ UUID: "com.desstroct.lol-api.lobby-scanner" })
export class LobbyScannerAction extends SingletonAction<LobbyScannerSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-dial state: which slot (1-10) the dial is viewing */
	private dialStates: Map<string, { currentSlot: number }> = new Map();

	override onWillAppear(ev: WillAppearEvent<LobbyScannerSettings>): void | Promise<void> {
		const slot = ev.payload.settings.slot ?? 1;
		const team = slot <= 5 ? "Ally" : "Enemy";
		const index = slot <= 5 ? slot : slot - 5;
		this.startPolling();
		if (ev.action.isDial()) {
			this.getDialSlot(ev.action.id, slot);
			return ev.action.setFeedback({
				title: `${team} #${index}`,
				champion: "Waiting...",
				rank: "",
				wr_text: "",
				wr_bar: { value: 0 },
			});
		}
		return ev.action.setTitle(`${team}\n#${index}`);
	}

	override onWillDisappear(ev: WillDisappearEvent<LobbyScannerSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<LobbyScannerSettings>): Promise<void> {
		await this.updateLobby();
	}

	/** Dial rotation: cycle through player slots 1-10 */
	override async onDialRotate(ev: DialRotateEvent<LobbyScannerSettings>): Promise<void> {
		const ds = this.getDialSlot(ev.action.id);
		ds.currentSlot = ((ds.currentSlot - 1 + ev.payload.ticks + 100) % 10) + 1;
		await this.updateLobby();
	}

	/** Dial press: force refresh */
	override async onDialUp(_ev: DialUpEvent<LobbyScannerSettings>): Promise<void> {
		await this.updateLobby();
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<LobbyScannerSettings>): Promise<void> {
		await this.updateLobby();
	}

	private getDialSlot(actionId: string, initial?: number): { currentSlot: number } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { currentSlot: initial ?? 1 };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private startPolling(): void {
		if (this.pollInterval) return;

		this.updateLobby();
		this.pollInterval = setInterval(() => this.updateLobby(), 2000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateLobby(): Promise<void> {
		if (!lcuConnector.isConnected()) return;

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			// Reset display when not in champ select
			for (const a of this.actions) {
				if (a.isDial()) {
					const ds = this.getDialSlot(a.id);
					const slot = ds.currentSlot;
					const team = slot <= 5 ? "Ally" : "Enemy";
					const index = slot <= 5 ? slot : slot - 5;
					await a.setFeedback({
						title: `${team} #${index}`,
						champion: "Waiting...",
						rank: "",
						wr_text: "",
						wr_bar: { value: 0 },
					});
				} else {
					const settings = (await a.getSettings()) as LobbyScannerSettings;
					const slot = settings.slot ?? 1;
					const team = slot <= 5 ? "Ally" : "Enemy";
					const index = slot <= 5 ? slot : slot - 5;
					await a.setTitle(`${team}\n#${index}`);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		for (const a of this.actions) {
			let slot: number;
			const isDial = a.isDial();

			if (isDial) {
				slot = this.getDialSlot(a.id).currentSlot;
			} else {
				const settings = (await a.getSettings()) as LobbyScannerSettings;
				slot = settings.slot ?? 1;
			}

			const isAlly = slot <= 5;
			const index = (isAlly ? slot : slot - 5) - 1; // 0-based

			const team = isAlly ? session.myTeam : session.theirTeam;
			const player = team[index];

			if (!player) {
				if (isDial) {
					await a.setFeedback({
						title: isAlly ? `Ally #${index + 1}` : `Enemy #${index + 1}`,
						champion: "No data",
						rank: "",
						wr_text: "",
						wr_bar: { value: 0 },
					});
				} else {
					await a.setTitle(isAlly ? "Ally\nNo data" : "Enemy\nNo data");
				}
				continue;
			}

			// Get champion name
			let champName = "???";
			if (player.championId > 0) {
				const champ = dataDragon.getChampionByKey(String(player.championId));
				champName = champ?.name ?? `#${player.championId}`;
			} else if (player.championPickIntent > 0) {
				const champ = dataDragon.getChampionByKey(String(player.championPickIntent));
				champName = champ ? `(${champ.name})` : "...";
			}

			// Get position
			const pos = POSITIONS[player.assignedPosition] ?? "?";

			// Try to get ranked info
			let rankStr = "";
			let wrPct = 0;
			if (player.puuid && player.puuid !== "") {
				const ranked = await lcuApi.getRankedStats(player.puuid);
				if (ranked?.queueMap?.RANKED_SOLO_5x5) {
					const solo = ranked.queueMap.RANKED_SOLO_5x5;
					const tier = solo.tier ? solo.tier.charAt(0) + solo.tier.slice(1).toLowerCase() : "?";
					const div = solo.division ?? "";
					wrPct = solo.wins + solo.losses > 0
						? Math.round((solo.wins / (solo.wins + solo.losses)) * 100)
						: 0;
					rankStr = `${tier} ${div}`;
				}
			}

			if (isDial) {
				const teamLabel = isAlly ? "Ally" : "Enemy";
				const barColor = wrPct >= 55 ? "#2ECC71" : wrPct >= 50 ? "#F1C40F" : wrPct > 0 ? "#E74C3C" : "#666666";
				await a.setFeedback({
					title: `${pos} · ${teamLabel} #${index + 1}`,
					champion: champName,
					rank: rankStr || "Unranked",
					wr_text: wrPct > 0 ? `${wrPct}% WR` : "",
					wr_bar: { value: wrPct || 50, bar_fill_c: barColor },
				});
			} else {
				const title = rankStr
					? `${champName}\n${rankStr} ${wrPct}%`
					: `${pos}\n${champName}`;
				await a.setTitle(title);
			}
		}
	}
}

type LobbyScannerSettings = {
	slot?: number; // 1-5 ally, 6-10 enemy
};
