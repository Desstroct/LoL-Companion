import {
	action,
	DialRotateEvent,
	DialUpEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
	type DialAction,
	type KeyAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { getChampionIconByKey } from "../services/lol-icons";
import type { LcuChampSelectSession } from "../types/lol";

const logger = streamDeck.logger.createScope("LobbyScan");

const POSITIONS: Record<string, string> = {
	top: "TOP",
	jungle: "JGL",
	middle: "MID",
	bottom: "BOT",
	utility: "SUP",
	"": "?",
};

/** Canonical lane order for sorting teams by role instead of pick order */
const ROLE_ORDER: string[] = ["top", "jungle", "middle", "bottom", "utility"];

/** Lane labels matching ROLE_ORDER indices */
const ROLE_LABELS: string[] = ["TOP", "JGL", "MID", "BOT", "SUP"];

/**
 * Friendly label for a slot number (1-5 ally, 6-10 enemy).
 * Uses lane names: slot 1/6 = TOP, 2/7 = JGL, 3/8 = MID, 4/9 = BOT, 5/10 = SUP.
 */
function slotLabel(slot: number): string {
	const index = (slot <= 5 ? slot : slot - 5) - 1;
	return ROLE_LABELS[index] ?? `#${index + 1}`;
}

/**
 * Sort a team array by assigned position (lane order) when positions are available.
 * Falls back to original (pick) order when assignedPosition is empty.
 * Returns true if sorting was applied (positions were available).
 */
function sortTeamByRole<T extends { assignedPosition: string }>(team: T[]): { sorted: T[]; hasRoles: boolean } {
	const hasRoles = team.some((p) => p.assignedPosition && p.assignedPosition !== "");
	if (!hasRoles) return { sorted: [...team], hasRoles: false };

	const sorted = [...team].sort((a, b) => {
		const ia = ROLE_ORDER.indexOf(a.assignedPosition);
		const ib = ROLE_ORDER.indexOf(b.assignedPosition);
		// Unknown positions go to end
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
	});
	return { sorted, hasRoles: true };
}

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
		const label = slotLabel(slot);
		this.startPolling();
		if (ev.action.isDial()) {
			this.getDialSlot(ev.action.id, slot);
			return ev.action.setFeedback({
				title: `${team} ${label}`,
				champion: "Waiting...",
				rank: "",
				wr_text: "",
				wr_bar: { value: 0 },
			});
		}
		return ev.action.setTitle(`${team}\n${label}`);
	}

	override onWillDisappear(ev: WillDisappearEvent<LobbyScannerSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
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

		this.updateLobby().catch((e) => logger.error(`updateLobby error: ${e}`));
		this.pollInterval = setInterval(() => this.updateLobby().catch((e) => logger.error(`updateLobby error: ${e}`)), 2000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateLobby(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "Lobby Scan", champion: "Offline", rank: "", wr_text: "", wr_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Lobby\nOffline");
				}
			}
			return;
		}

		// TFT has no traditional champion select lobby
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "Lobby Scan", champion: "N/A in TFT", rank: "", wr_text: "", wr_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Lobby\nN/A TFT");
				}
			}
			return;
		}

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			// Reset display when not in champ select
			for (const a of this.actions) {
				if (a.isDial()) {
					const ds = this.getDialSlot(a.id);
					const slot = ds.currentSlot;
					const team = slot <= 5 ? "Ally" : "Enemy";
					const label = slotLabel(slot);
					await a.setFeedback({
						champ_icon: "",
						title: `${team} ${label}`,
						champion: "Waiting...",
						rank: "",
						wr_text: "",
						wr_bar: { value: 0 },
					});
				} else {
					const settings = (await a.getSettings()) as LobbyScannerSettings;
					const slot = settings.slot ?? 1;
					const team = slot <= 5 ? "Ally" : "Enemy";
					const label = slotLabel(slot);
					await a.setImage("");
					await a.setTitle(`${team}\n${label}`);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		// Sort teams by assigned lane (TOP→JGL→MID→BOT→SUP) when positions are available,
		// otherwise fall back to pick order.
		const allyResult = sortTeamByRole(session.myTeam);
		const enemyResult = sortTeamByRole(session.theirTeam);

		// ---- Pre-compute slots for all actions ----
		type ActionRef = DialAction<LobbyScannerSettings> | KeyAction<LobbyScannerSettings>;
		const actionSlots: { action: ActionRef; slot: number; isDial: boolean }[] = [];
		for (const a of this.actions) {
			const isDial = a.isDial();
			const slot = isDial
				? this.getDialSlot(a.id).currentSlot
				: ((await a.getSettings()) as LobbyScannerSettings).slot ?? 1;
			actionSlots.push({ action: a, slot, isDial });
		}

		// ---- Collect unique champion keys & puuids to fetch in parallel ----
		const champKeysNeeded = new Set<string>();
		const puuidsNeeded = new Set<string>();
		const slotPlayers: Map<number, (typeof session.myTeam)[0] | undefined> = new Map();

		for (const { slot } of actionSlots) {
			if (slotPlayers.has(slot)) continue;
			const isAlly = slot <= 5;
			const index = (isAlly ? slot : slot - 5) - 1;
			const teamResult = isAlly ? allyResult : enemyResult;
			const player = teamResult.sorted[index];
			slotPlayers.set(slot, player);
			if (!player) continue;
			const champKey = player.championId > 0
				? String(player.championId)
				: player.championPickIntent > 0 ? String(player.championPickIntent) : null;
			if (champKey) champKeysNeeded.add(champKey);
			if (player.puuid && player.puuid !== "") puuidsNeeded.add(player.puuid);
		}

		// Parallel fetch: champion icons + ranked stats
		const [iconResults, rankedResults] = await Promise.all([
			Promise.all(
				[...champKeysNeeded].map(async (key) => [key, await getChampionIconByKey(key)] as const),
			),
			Promise.all(
				[...puuidsNeeded].map(async (puuid) => [puuid, await lcuApi.getRankedStats(puuid)] as const),
			),
		]);
		const iconMap = new Map(iconResults);
		const rankedMap = new Map(rankedResults);

		// ---- Render all actions from pre-fetched data ----
		for (const { action: a, slot, isDial } of actionSlots) {
			const isAlly = slot <= 5;
			const index = (isAlly ? slot : slot - 5) - 1;

			const teamResult = isAlly ? allyResult : enemyResult;
			const player = slotPlayers.get(slot);

			// Build a friendly slot label: "TOP" / "JGL" etc. when roles are known, else "#1" / "#2"
			const slotLabel = teamResult.hasRoles
				? (POSITIONS[player?.assignedPosition ?? ""] ?? `#${index + 1}`)
				: `#${index + 1}`;
			const teamLabel = isAlly ? "Ally" : "Enemy";

			if (!player) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						title: `${teamLabel} ${slotLabel}`,
						champion: "No data",
						rank: "",
						wr_text: "",
						wr_bar: { value: 0 },
					});
				} else {
					await a.setImage("");
					await a.setTitle(`${teamLabel}\n${slotLabel}`);
				}
				continue;
			}

			// Get champion name + icon
			let champName = "???";
			let champIcon: string | null = null;
			const champKey = player.championId > 0
				? String(player.championId)
				: player.championPickIntent > 0 ? String(player.championPickIntent) : null;

			if (champKey) {
				const champ = dataDragon.getChampionByKey(champKey);
				if (player.championId > 0) {
					champName = champ?.name ?? `#${player.championId}`;
				} else {
					champName = champ ? `(${champ.name})` : "...";
				}
				champIcon = iconMap.get(champKey) ?? null;
			}

			// Get position
			const pos = POSITIONS[player.assignedPosition] ?? "?";

			// Ranked info from pre-fetched results
			let rankStr = "";
			let wrPct = 0;
			let totalGames = 0;
			let isPrevSeason = false;
			if (player.puuid && player.puuid !== "") {
				const ranked = rankedMap.get(player.puuid) ?? null;
				const solo = ranked?.queueMap?.RANKED_SOLO_5x5;
				if (solo && solo.tier) {
					const tier = solo.tier.charAt(0) + solo.tier.slice(1).toLowerCase();
					const div = solo.division ?? "";
					totalGames = (solo.wins ?? 0) + (solo.losses ?? 0);
					wrPct = totalGames > 0
						? Math.round((solo.wins / totalGames) * 100)
						: 0;
					rankStr = `${tier} ${div}`;
				}
				// Fallback: show previous season rank for unranked players
				if (!rankStr && solo?.previousSeasonHighestTier) {
					const prevTier = solo.previousSeasonHighestTier.charAt(0) + solo.previousSeasonHighestTier.slice(1).toLowerCase();
					const prevDiv = solo.previousSeasonHighestDivision ?? "";
					rankStr = `S14 ${prevTier} ${prevDiv}`;
					isPrevSeason = true;
				}
				// Fallback: check Flex queue
				if (!rankStr) {
					const flex = ranked?.queueMap?.RANKED_FLEX_SR;
					if (flex && flex.tier) {
						const tier = flex.tier.charAt(0) + flex.tier.slice(1).toLowerCase();
						const div = flex.division ?? "";
						totalGames = (flex.wins ?? 0) + (flex.losses ?? 0);
						wrPct = totalGames > 0
							? Math.round((flex.wins / totalGames) * 100)
							: 0;
						rankStr = `Flex ${tier} ${div}`;
					}
				}
			}

			if (a.isDial()) {
				const barColor = isPrevSeason ? "#888888"
					: wrPct >= 55 ? "#2ECC71" : wrPct >= 50 ? "#F1C40F" : wrPct > 0 ? "#E74C3C" : "#666666";
				const wrLabel = isPrevSeason ? "prev season"
					: wrPct > 0 ? `${wrPct}% WR · ${totalGames}g` : "";
				await a.setFeedback({
					champ_icon: champIcon ?? "",
					title: `${pos} · ${teamLabel} ${slotLabel}`,
					champion: champName,
					rank: rankStr || "Unranked",
					wr_text: wrLabel,
					wr_bar: { value: wrPct || 50, bar_fill_c: barColor },
				});
			} else {
				if (champIcon) await a.setImage(champIcon);
				const title = rankStr
					? `${champName}\n${rankStr}${isPrevSeason ? "" : ` ${wrPct}%`}${totalGames > 0 && !isPrevSeason ? `\n${totalGames}g` : ""}`
					: `${pos}\n${champName}`;
				await a.setTitle(title);
			}
		}
	}
}

type LobbyScannerSettings = {
	slot?: number; // 1-5 ally, 6-10 enemy
};
