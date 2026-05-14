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
import { findEnemyLaner, getUnavailableAliases, championMatchesLane } from "../services/champ-select-utils";

const logger = streamDeck.logger.createScope("SmartPick");

type PickMode = "counter" | "best";

interface SmartPickState {
	mode: PickMode;
	viewIndex: number;
	lastHash: string;
	lastPicks: { alias: string; name: string; score: number; details: string; winRateVs?: number; games?: number }[];
	lastInfo: string;
	autoSwitchedToCounter: boolean;
}

type SmartPickSettings = {
	/** "auto" = detect from champ select assigned position */
	role?: string;
	defaultMode?: PickMode;
};

/**
 * Smart Pick action — combines counterpick and best pick functionality.
 *
 * Modes:
 * - "counter": Finds the best counter for your lane opponent
 * - "best": Finds the best overall pick considering all enemies + ally synergy
 *
 * Key: press to toggle mode
 * Dial:
 *   - Rotate: scroll through picks
 *   - Press: toggle counter/best mode
 *   - Touch: refresh data
 */
@action({ UUID: "com.desstroct.lol-api.smart-pick" })
export class SmartPick extends SingletonAction<SmartPickSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, SmartPickState>();
	/** Persisted settings — per-action settings are broken, use global as backing store */
	private cachedRole?: string;
	private cachedDefaultMode?: PickMode;
	/** Player's rank tier converted to Lolalytics format — null = not yet fetched */
	private playerTier: string | null = null;

	override async onWillAppear(ev: WillAppearEvent<SmartPickSettings>): Promise<void> {
		// Bootstrap cached settings: per-action first, global fallback
		if (!this.cachedRole && !this.cachedDefaultMode) {
			const { role, defaultMode } = ev.payload.settings;
			if (role || defaultMode) {
				this.cachedRole = role;
				this.cachedDefaultMode = defaultMode;
			} else {
				const global = await streamDeck.settings.getGlobalSettings<{ smartPickRole?: string; smartPickDefaultMode?: PickMode }>();
				this.cachedRole = global.smartPickRole;
				this.cachedDefaultMode = global.smartPickDefaultMode;
			}
		}

		this.startPolling();
		const roleLabel = (this.cachedRole && this.cachedRole !== "auto") ? this.cachedRole.toUpperCase() : "AUTO";
		const mode = this.cachedDefaultMode ?? "counter";
		if (ev.action.isDial()) {
			this.getState(ev.action.id, mode);
			return ev.action.setFeedback({
				champ_icon: "",
				title: `${mode === "counter" ? "Counter" : "Best"} · ${roleLabel}`,
				pick_name: "Waiting...",
				pick_info: "",
				score_bar: { value: 0 },
			});
		}
		return ev.action.setTitle(`${mode === "counter" ? "Counter" : "Best"}\n${roleLabel}`);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SmartPickSettings>): Promise<void> {
		const { role, defaultMode } = ev.payload.settings;
		if (role !== undefined) this.cachedRole = role;
		if (defaultMode !== undefined) this.cachedDefaultMode = defaultMode;
		// Persist to global so settings survive Stream Deck restarts
		await streamDeck.settings.setGlobalSettings({
			smartPickRole: this.cachedRole,
			smartPickDefaultMode: this.cachedDefaultMode,
		});
	}

	override onWillDisappear(ev: WillDisappearEvent<SmartPickSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<SmartPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id, ev.payload.settings.defaultMode);
		state.mode = state.mode === "counter" ? "best" : "counter";
		state.lastHash = ""; // Force refresh
		await this.updateSmartPick();
	}

	override async onDialRotate(ev: DialRotateEvent<SmartPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		if (state.lastPicks.length === 0) return;
		state.viewIndex = ((state.viewIndex + ev.payload.ticks) + state.lastPicks.length * 100) % state.lastPicks.length;
		await this.renderDialPick(ev.action, state);
	}

	override async onDialUp(ev: DialUpEvent<SmartPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.mode = state.mode === "counter" ? "best" : "counter";
		state.lastHash = ""; // Force refresh
		await this.updateSmartPick();
	}

	override async onTouchTap(ev: TouchTapEvent<SmartPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.lastHash = ""; // Force refresh
		await this.updateSmartPick();
	}

	private getState(actionId: string, defaultMode: PickMode = "counter"): SmartPickState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { mode: defaultMode, viewIndex: 0, lastHash: "", lastPicks: [], lastInfo: "", autoSwitchedToCounter: false };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private async renderDialPick(
		a: DialAction<SmartPickSettings> | KeyAction<SmartPickSettings>,
		state: SmartPickState,
	): Promise<void> {
		if (!a.isDial()) return;
		const pick = state.lastPicks[state.viewIndex];
		if (!pick) return;

		const score = pick.winRateVs ?? pick.score;
		const barColor = score >= 54 ? "#2ECC71" : score >= 50 ? "#F1C40F" : "#E74C3C";
		const champIcon = await getChampionIcon(pick.alias);

		const modeIndicator = state.mode === "counter" ? "x" : "*";
		await a.setFeedback({
			champ_icon: champIcon ?? "",
			title: `${modeIndicator} ${state.lastInfo}`,
			pick_name: `#${state.viewIndex + 1} ${pick.name} ${getTier(score)}`,
			pick_info: pick.details,
			score_bar: { value: score, bar_fill_c: barColor },
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
		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				const state = this.getState(a.id);
				const label = state.mode === "counter" ? "Counter" : "Best";
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: label, pick_name: "Offline", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle(`${label}\nOffline`);
				}
			}
			return;
		}

		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "Smart Pick", pick_name: "N/A in TFT", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Pick\nN/A TFT");
				}
			}
			return;
		}

		if (gameMode.isARAM()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "Smart Pick", pick_name: "N/A in ARAM", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Pick\nN/A ARAM");
				}
			}
			return;
		}

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			this.playerTier = null; // reset so it's re-fetched next champ select
			for (const s of this.actionStates.values()) {
				s.lastHash = "";
				s.lastPicks = [];
				s.autoSwitchedToCounter = false;
				// Reset to default mode when leaving champ select
				s.mode = this.cachedDefaultMode ?? "counter";
			}
			const roleLabel = (this.cachedRole && this.cachedRole !== "auto") ? this.cachedRole.toUpperCase() : "AUTO";
			for (const a of this.actions) {
				const state = this.getState(a.id, this.cachedDefaultMode);
				const label = state.mode === "counter" ? "Counter" : "Best";
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						title: `${label} · ${roleLabel}`,
						pick_name: "Waiting...",
						pick_info: "Press dial to toggle mode",
						score_bar: { value: 0 },
					});
				} else {
					await a.setImage("");
					await a.setTitle(`${label}\n${roleLabel}`);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) {
			logger.debug("No champ select session available");
			return;
		}

		// Fetch the player's rank once per champ select for elo-aware recommendations
		if (this.playerTier === null) {
			try {
				const ranked = await lcuApi.getCurrentRankedStats();
				const solo = ranked?.queueMap?.RANKED_SOLO_5x5;
				this.playerTier = solo?.tier ? lolalalyticsTier(solo.tier) : "emerald_plus";
				logger.info(`Smart Pick elo filter: ${solo?.tier ?? "unranked"} → ${this.playerTier}`);
			} catch {
				this.playerTier = "emerald_plus";
			}
		}

		const localCell = session.localPlayerCellId;
		const me = session.myTeam.find((p) => p.cellId === localCell);

		for (const a of this.actions) {
			const role = (this.cachedRole && this.cachedRole !== "auto" ? this.cachedRole : null)
				?? me?.assignedPosition
				?? "top";
			const lane = ChampionStats.toLolalyticsLane(role);
			const state = this.getState(a.id, this.cachedDefaultMode);

			// Auto-switch to counter when the enemy laner locks in.
			// Use strict=true so we don't switch based on the first random enemy locker.
			if (!state.autoSwitchedToCounter && state.mode === "best") {
				const enemyResult = findEnemyLaner(session, role, true);
				if (enemyResult) {
					const enemyLocked = session.actions.flat().some(
						(act) => act.actorCellId === enemyResult.player.cellId
							&& act.type === "pick" && act.completed,
					);
					if (enemyLocked) {
						state.mode = "counter";
						state.autoSwitchedToCounter = true;
						state.lastHash = "";
					}
				}
			}

			if (state.mode === "counter") {
				await this.updateCounterMode(a, session, role, lane, state, this.playerTier ?? "emerald_plus");
			} else {
				await this.updateBestMode(a, session, role, lane, state, this.playerTier ?? "emerald_plus");
			}
		}
	}

	private async updateCounterMode(
		a: DialAction<SmartPickSettings> | KeyAction<SmartPickSettings>,
		session: Awaited<ReturnType<typeof lcuApi.getChampSelectSession>>,
		role: string,
		lane: string,
		state: SmartPickState,
		tier: string,
	): Promise<void> {
		if (!session) return;

		// Use strict mode — no Strategy 3 fallback that returns the wrong role
		const enemyResult = findEnemyLaner(session, role, true);
		const enemy = enemyResult?.player ?? null;

		if (!enemy) {
			if (a.isDial()) {
				await a.setFeedback({ title: `⚔️ Counter · ${role.toUpperCase()}`, pick_name: "No enemy yet", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
			} else {
				await a.setTitle(`Counter\nNo enemy`);
			}
			return;
		}

		const enemyChamp = dataDragon.getChampionByKey(String(enemy.championId));
		if (!enemyChamp) return;

		// Check if the enemy has actually locked in using their cell ID (same approach as auto-rune)
		const enemyIsLocked = session.actions.flat().some(
			(act) => act.actorCellId === enemy.cellId && act.type === "pick" && act.completed,
		);
		const enemyLabel = enemyIsLocked ? enemyChamp.name : `${enemyChamp.name}?`;

		const enemyAlias = ChampionStats.toLolalytics(enemyChamp.id);
		const hash = `counter:${enemyAlias}:${lane}:${tier}`;

		if (hash === state.lastHash) {
			if (a.isDial()) await this.renderDialPick(a, state);
			return;
		}

		if (a.isDial()) {
			await a.setFeedback({ title: `vs ${enemyLabel}`, pick_name: "Searching...", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
		} else {
			await a.setTitle(`vs ${enemyLabel}\nSearching...`);
		}

		try {
			const allPicks = await championStats.getBestCounterpicks(enemyAlias, lane, tier);

			const unavailable = getUnavailableAliases(session);
			const picks = allPicks.filter((p) => !unavailable.has(p.alias));

			const tierLabel = tierDisplayLabel(tier);
			state.lastPicks = picks.map((p) => {
				const pickTier = getTier(p.winRateVs);
				const sampleNote = p.games < 100 ? " ⚠" : "";
				const gamesStr = p.games >= 1000 ? `${(p.games / 1000).toFixed(1)}k` : String(p.games);
				const delta = p.allWr ? p.winRateVs - p.allWr : null;
				const deltaStr = delta !== null ? ` Δ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}` : "";
				return {
					alias: p.alias,
					name: p.name,
					score: p.winRateVs,
					winRateVs: p.winRateVs,
					games: p.games,
					details: `${pickTier} ${p.winRateVs}%${deltaStr} · ${gamesStr}g${sampleNote} · ${tierLabel}`,
				};
			});
			state.lastInfo = `vs ${enemyLabel}`;
			state.lastHash = hash;

			prefetchChampionIcons(picks.slice(0, 5).map((p) => p.alias));

			if (picks.length === 0) {
				if (a.isDial()) {
					await a.setFeedback({ title: `vs ${enemyLabel}`, pick_name: "No data", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`vs ${enemyLabel}\nNo data`);
				}
			} else if (a.isDial()) {
				state.viewIndex = 0;
				await this.renderDialPick(a, state);
			} else {
				const best = picks[0];
				const tier = getTier(best.winRateVs);
				const bestIcon = await getChampionIcon(best.alias);
				if (bestIcon) await a.setImage(bestIcon);
				await a.setTitle(`${tier} ${best.name}\n${best.winRateVs}% WR`);
			}
		} catch (e) {
			logger.error(`Counter mode error: ${e}`);
			if (a.isDial()) {
				await a.setFeedback({ title: `vs ${enemyLabel}`, pick_name: "Error", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
			} else {
				await a.setTitle(`Counter\nError`);
			}
		}
	}

	private async updateBestMode(
		a: DialAction<SmartPickSettings> | KeyAction<SmartPickSettings>,
		session: Awaited<ReturnType<typeof lcuApi.getChampSelectSession>>,
		role: string,
		lane: string,
		state: SmartPickState,
		tier: string,
	): Promise<void> {
		if (!session) return;

		// Only use locked enemy picks — hovering enemies cause noisy refetches and wrong results
		const lockedEnemyIds = new Set(
			session.actions.flat()
				.filter((act) => !act.isAllyAction && act.type === "pick" && act.completed && act.championId > 0)
				.map((act) => act.championId),
		);

		if (lockedEnemyIds.size === 0) {
			if (a.isDial()) {
				await a.setFeedback({ title: `★ Best · ${role.toUpperCase()}`, pick_name: "Waiting for locks...", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
			} else {
				await a.setTitle(`Best\nWaiting...`);
			}
			return;
		}

		// Resolve aliases — prefer lane-matched enemy, fall back to all locked
		const myLane = ChampionStats.toLolalyticsLane(role);
		const matchupAliases: string[] = [];
		const allLockedAliases: string[] = [];
		for (const enemy of session.theirTeam) {
			if (!lockedEnemyIds.has(enemy.championId)) continue;
			const champ = dataDragon.getChampionByKey(String(enemy.championId));
			if (!champ) continue;
			const alias = ChampionStats.toLolalytics(champ.id);
			allLockedAliases.push(alias);
			if (enemy.assignedPosition === role || (!enemy.assignedPosition && championMatchesLane(champ, myLane))) {
				matchupAliases.push(alias);
			}
		}
		const enemyAliasesForMatchup = matchupAliases.length > 0 ? matchupAliases : allLockedAliases;

		const allyChampionKeys: string[] = [];
		for (const ally of session.myTeam) {
			if (ally.championId > 0 && ally.cellId !== session.localPlayerCellId) {
				allyChampionKeys.push(String(ally.championId));
			}
		}

		// Hash on locked picks only — stable until someone new locks in
		const hash = `best:${allLockedAliases.sort().join(",")}|${allyChampionKeys.sort().join(",")}:${tier}`;
		if (hash === state.lastHash) {
			if (a.isDial()) await this.renderDialPick(a, state);
			return;
		}

		if (a.isDial()) {
			await a.setFeedback({ title: `★ Best · ${role.toUpperCase()}`, pick_name: "Searching...", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
		} else {
			await a.setTitle(`Best\nSearching...`);
		}

		try {
			const allPicks = await championStats.getBestOverallPick(
				enemyAliasesForMatchup,
				lane,
				allyChampionKeys.length > 0 ? allyChampionKeys : undefined,
				tier,
			);

			const unavailable = getUnavailableAliases(session);
			const picks = allPicks.filter((p) => !unavailable.has(p.alias));

			const tierLabel = tierDisplayLabel(tier);
			state.lastPicks = picks.map((p) => ({
				...p,
				details: `${getTier(p.score)} ${p.details} · ${tierLabel}`,
			}));
			state.lastInfo = `vs ${allLockedAliases.length} · ${role.toUpperCase()}`;
			state.lastHash = hash;

			prefetchChampionIcons(picks.slice(0, 5).map((p) => p.alias));

			if (picks.length === 0) {
				if (a.isDial()) {
					await a.setFeedback({ title: `★ ${state.lastInfo}`, pick_name: "No data", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`Best\nNo data`);
				}
			} else if (a.isDial()) {
				state.viewIndex = 0;
				await this.renderDialPick(a, state);
			} else {
				const best = picks[0];
				const tier = getTier(best.score);
				const bestIcon = await getChampionIcon(best.alias);
				if (bestIcon) await a.setImage(bestIcon);
				await a.setTitle(`${tier} ${best.name}\n${best.score}%`);
			}
		} catch (e) {
			logger.error(`Best mode error: ${e}`);
			if (a.isDial()) {
				await a.setFeedback({ title: `★ Best · ${role.toUpperCase()}`, pick_name: "Error", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
			} else {
				await a.setTitle(`Best\nError`);
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

/** Convert LCU rank tier to the Lolalytics tier URL parameter. */
function lolalalyticsTier(lcuTier: string): string {
	switch (lcuTier.toUpperCase()) {
		case "IRON":       return "iron";
		case "BRONZE":     return "bronze";
		case "SILVER":     return "silver";
		case "GOLD":       return "gold_plus";
		case "PLATINUM":   return "platinum_plus";
		case "EMERALD":    return "emerald_plus";
		case "DIAMOND":    return "diamond_plus";
		case "MASTER":
		case "GRANDMASTER":
		case "CHALLENGER": return "master_plus";
		default:           return "emerald_plus";
	}
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
