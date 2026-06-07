import {
	action,
	DidReceiveSettingsEvent,
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
import { championStats, ChampionStats } from "../services/champion-stats";
import { getChampionIcon, prefetchChampionIcons } from "../services/lol-icons";
import { findEnemyLaner, getUnavailableAliases } from "../services/champ-select-utils";
import { getPlayerTier } from "../services/lolalytics-tier";

const logger = streamDeck.logger.createScope("SmartPick");

interface SmartPickState {
	viewIndex: number;
	lastHash: string;
	lastPicks: { alias: string; name: string; score: number; details: string }[];
	lastInfo: string;
}

type SmartPickSettings = {
	/** "auto" = detect from champ select assigned position */
	role?: string;
};

/**
 * Smart Pick action — suggests the best champion to play considering:
 *   1. Counter strength vs your specific lane opponent
 *   2. Synergy with your allies
 *
 * If the lane opponent isn't identified yet, falls back to scoring
 * against all locked enemies. Picks refresh automatically as allies
 * and enemies lock in.
 *
 * Key / dial press: force refresh
 * Dial rotate: scroll through suggestions
 * Touch: refresh
 */
@action({ UUID: "com.desstroct.lol-api.smart-pick" })
export class SmartPick extends SingletonAction<SmartPickSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, SmartPickState>();
	private cachedRole?: string;

	override async onWillAppear(ev: WillAppearEvent<SmartPickSettings>): Promise<void> {
		if (!this.cachedRole) {
			const { role } = ev.payload.settings;
			if (role) {
				this.cachedRole = role;
			} else {
				const global = await streamDeck.settings.getGlobalSettings<{ smartPickRole?: string }>();
				this.cachedRole = global.smartPickRole;
			}
		}

		this.startPolling();
		const roleLabel = (this.cachedRole && this.cachedRole !== "auto") ? this.cachedRole.toUpperCase() : "AUTO";
		if (ev.action.isDial()) {
			ev.action.setFeedbackLayout("layouts/smart-pick.json");
			this.getState(ev.action.id);
			return ev.action.setFeedback({
				title: `Smart Pick · ${roleLabel}`,
				champ1_icon: "", champ1_name: "", champ1_wr: "",
				champ2_icon: "", champ2_name: "Waiting...", champ2_wr: "",
				champ3_icon: "", champ3_name: "", champ3_wr: "",
			});
		}
		return ev.action.setTitle(`Smart\n${roleLabel}`);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SmartPickSettings>): Promise<void> {
		const { role } = ev.payload.settings;
		if (role !== undefined) this.cachedRole = role;
		await streamDeck.settings.setGlobalSettings({ smartPickRole: this.cachedRole });
	}

	override onWillDisappear(ev: WillDisappearEvent<SmartPickSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<SmartPickSettings>): Promise<void> {
		this.getState(ev.action.id).lastHash = "";
		await this.updateSmartPick();
	}

	override async onDialRotate(ev: DialRotateEvent<SmartPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		if (state.lastPicks.length === 0) return;
		// Scroll by 1 champion at a time, clamped so 3 picks are always visible
		const maxStart = Math.max(0, state.lastPicks.length - 3);
		state.viewIndex = Math.max(0, Math.min(state.viewIndex + ev.payload.ticks, maxStart));
		await this.renderDialPick(ev.action, state);
	}

	override async onDialUp(ev: DialUpEvent<SmartPickSettings>): Promise<void> {
		this.getState(ev.action.id).lastHash = "";
		await this.updateSmartPick();
	}

	override async onTouchTap(ev: TouchTapEvent<SmartPickSettings>): Promise<void> {
		this.getState(ev.action.id).lastHash = "";
		await this.updateSmartPick();
	}

	private getState(actionId: string): SmartPickState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { viewIndex: 0, lastHash: "", lastPicks: [], lastInfo: "" };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private async renderDialPick(
		a: DialAction<SmartPickSettings> | KeyAction<SmartPickSettings>,
		state: SmartPickState,
	): Promise<void> {
		if (!a.isDial()) return;
		if (state.lastPicks.length === 0) return;

		const startIdx = state.viewIndex;
		const total = state.lastPicks.length;

		// Page indicator: "1-3 / 10"
		const endIdx = Math.min(startIdx + 3, total);
		const pageLabel = `${startIdx + 1}-${endIdx} / ${total}`;
		const titleStr = `${state.lastInfo}  ${pageLabel}`;

		// Resolve up to 3 visible picks
		const slots = await Promise.all(
			[0, 1, 2].map(async (col) => {
				const idx = startIdx + col;
				if (idx >= total) return { icon: "", name: "", wr: "" as string | { value: string; color: string } };
				const pick = state.lastPicks[idx];
				const wrColor = pick.score >= 54 ? "#2ECC71" : pick.score >= 50 ? "#F1C40F" : "#E74C3C";
				const icon = await getChampionIcon(pick.alias);
				const shortName = pick.name.length > 9 ? pick.name.slice(0, 8) + "…" : pick.name;
				return {
					icon: icon ?? "",
					name: shortName,
					wr: { value: `${getTier(pick.score)} ${pick.score.toFixed(1)}%`, color: wrColor } as string | { value: string; color: string },
				};
			}),
		);

		await a.setFeedback({
			title: titleStr,
			champ1_icon: slots[0].icon, champ1_name: slots[0].name, champ1_wr: slots[0].wr,
			champ2_icon: slots[1].icon, champ2_name: slots[1].name, champ2_wr: slots[1].wr,
			champ3_icon: slots[2].icon, champ3_name: slots[2].name, champ3_wr: slots[2].wr,
		});
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateSmartPick().catch((e) => logger.error(`updateSmartPick error: ${e}`));
		this.pollInterval = setInterval(() => this.updateSmartPick().catch((e) => logger.error(`updateSmartPick error: ${e}`)), 2000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateSmartPick(): Promise<void> {
		const emptySlots = { champ1_icon: "", champ1_name: "", champ1_wr: "", champ2_icon: "", champ2_wr: "", champ3_icon: "", champ3_name: "", champ3_wr: "" };

		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ ...emptySlots, title: "Smart Pick", champ2_name: "Offline" });
				} else {
					await a.setImage(""); await a.setTitle("Smart\nOffline");
				}
			}
			return;
		}

		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ ...emptySlots, title: "Smart Pick", champ2_name: "N/A in TFT" });
				} else {
					await a.setImage(""); await a.setTitle("Pick\nN/A TFT");
				}
			}
			return;
		}

		if (gameMode.isARAM()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ ...emptySlots, title: "Smart Pick", champ2_name: "N/A in ARAM" });
				} else {
					await a.setImage(""); await a.setTitle("Pick\nN/A ARAM");
				}
			}
			return;
		}

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			for (const s of this.actionStates.values()) {
				s.lastHash = "";
				s.lastPicks = [];
			}
			const roleLabel = (this.cachedRole && this.cachedRole !== "auto") ? this.cachedRole.toUpperCase() : "AUTO";
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						title: `Smart Pick · ${roleLabel}`,
						champ1_icon: "", champ1_name: "", champ1_wr: "",
						champ2_icon: "", champ2_name: "Waiting...", champ2_wr: "",
						champ3_icon: "", champ3_name: "", champ3_wr: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle(`Smart\n${roleLabel}`);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		// Shared cached tier — consistent elo bracket across Smart Pick / Auto Rune / Best Item
		const tier = await getPlayerTier();

		const localCell = session.localPlayerCellId;
		const me = session.myTeam.find((p) => p.cellId === localCell);

		for (const a of this.actions) {
			const role = (this.cachedRole && this.cachedRole !== "auto" ? this.cachedRole : null)
				?? me?.assignedPosition
				?? "top";
			const lane = ChampionStats.toLolalyticsLane(role);
			const state = this.getState(a.id);
			await this.updatePicks(a, session, role, lane, state, tier);
		}
	}

	private async updatePicks(
		a: DialAction<SmartPickSettings> | KeyAction<SmartPickSettings>,
		session: NonNullable<Awaited<ReturnType<typeof lcuApi.getChampSelectSession>>>,
		role: string,
		lane: string,
		state: SmartPickState,
		tier: string,
	): Promise<void> {
		const roleLabel = role.toUpperCase();
		const titleStr = `Smart · ${roleLabel}`;

		// Ally keys for synergy scoring — update as more allies lock in
		const allyChampionKeys = session.myTeam
			.filter((p) => p.championId > 0 && p.cellId !== session.localPlayerCellId)
			.map((p) => String(p.championId));

		// Strategy 1: score against the specific lane opponent (strict — no wrong-role fallback)
		const enemyResult = findEnemyLaner(session, role, true);

		let enemyAliases: string[];

		if (enemyResult) {
			enemyAliases = [enemyResult.alias];
		} else {
			// Strategy 2: fall back to all locked enemies until the lane opponent is identified
			const enemyCellIds = new Set(session.theirTeam.map((p) => p.cellId));
			const lockedEnemyChamps = session.actions.flat()
				.filter((act) => enemyCellIds.has(act.actorCellId) && act.type === "pick" && act.completed && act.championId > 0)
				.map((act) => dataDragon.getChampionByKey(String(act.championId)))
				.filter((c): c is NonNullable<typeof c> => c != null);

			if (lockedEnemyChamps.length === 0) {
				if (a.isDial()) {
					await a.setFeedback({
						title: titleStr,
						champ1_icon: "", champ1_name: "", champ1_wr: "",
						champ2_icon: "", champ2_name: "Waiting…", champ2_wr: "",
						champ3_icon: "", champ3_name: "", champ3_wr: "",
					});
				} else {
					await a.setTitle(`Smart\nWaiting...`);
				}
				return;
			}

			enemyAliases = lockedEnemyChamps.map((c) => ChampionStats.toLolalytics(c.id));
		}

		// Hash covers enemies + ally composition + tier — refetch whenever any changes
		const hash = `smart:${enemyAliases.join(",")}:${allyChampionKeys.sort().join(",")}:${tier}`;
		if (hash === state.lastHash) {
			if (a.isDial()) await this.renderDialPick(a, state);
			return;
		}

		if (a.isDial()) {
			await a.setFeedback({
				title: titleStr,
				champ1_icon: "", champ1_name: "", champ1_wr: "",
				champ2_icon: "", champ2_name: "Searching…", champ2_wr: "",
				champ3_icon: "", champ3_name: "", champ3_wr: "",
			});
		} else {
			await a.setTitle(`Smart\nSearching...`);
		}

		try {
			// Combined score: counter WR vs enemy(ies) + ally synergy bonus
			const allPicks = await championStats.getBestOverallPick(
				enemyAliases,
				lane,
				allyChampionKeys.length > 0 ? allyChampionKeys : undefined,
				tier,
			);

			const unavailable = getUnavailableAliases(session);
			const picks = allPicks.filter((p) => !unavailable.has(p.alias));

			const tierLabel = tierDisplayLabel(tier);
			state.lastPicks = picks.map((p) => ({
				...p,
				details: `${p.details} · ${tierLabel}`,
			}));
			state.lastInfo = titleStr;
			state.lastHash = hash;

			prefetchChampionIcons(picks.slice(0, 9).map((p) => p.alias));

			if (picks.length === 0) {
				if (a.isDial()) {
					await a.setFeedback({
						title: titleStr,
						champ1_icon: "", champ1_name: "", champ1_wr: "",
						champ2_icon: "", champ2_name: "No data", champ2_wr: "",
						champ3_icon: "", champ3_name: "", champ3_wr: "",
					});
				} else {
					await a.setTitle(`Smart\nNo data`);
				}
			} else if (a.isDial()) {
				state.viewIndex = 0;
				await this.renderDialPick(a, state);
			} else {
				const best = picks[0];
				const bestIcon = await getChampionIcon(best.alias);
				if (bestIcon) await a.setImage(bestIcon);
				await a.setTitle(`${getTier(best.score)} ${best.name}\n${best.score.toFixed(1)}%`);
			}
		} catch (e) {
			logger.error(`Smart Pick error: ${e}`);
			if (a.isDial()) {
				await a.setFeedback({
					title: titleStr,
					champ1_icon: "", champ1_name: "", champ1_wr: "",
					champ2_icon: "", champ2_name: "Error", champ2_wr: "",
					champ3_icon: "", champ3_name: "", champ3_wr: "",
				});
			} else {
				await a.setTitle(`Smart\nError`);
			}
		}
	}
}

function getTier(wr: number): string {
	if (wr >= 54) return "[S]";
	if (wr >= 52) return "[A]";
	if (wr >= 50) return "[B]";
	return "[C]";
}

/** Short display label shown in pick_info so the player knows which elo data is used. */
function tierDisplayLabel(tier: string): string {
	const labels: Record<string, string> = {
		iron:          "Iron",
		bronze:        "Brnz",
		silver:        "Silv",
		gold_plus:     "G+",
		platinum_plus: "P+",
		emerald_plus:  "E+",
		diamond_plus:  "D+",
		master_plus:   "M+",
	};
	return labels[tier] ?? "E+";
}
