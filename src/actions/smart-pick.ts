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
	type FeedbackPayload,
	type KeyAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { championStats, ChampionStats, MatchupData } from "../services/champion-stats";
import { getChampionIcon, prefetchChampionIcons } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("SmartPick");

type PickMode = "counter" | "best";

interface SmartPickState {
	mode: PickMode;
	viewIndex: number;
	lastHash: string;
	lastPicks: { alias: string; name: string; score: number; details: string; winRateVs?: number; games?: number }[];
	lastInfo: string;
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

	override onWillAppear(ev: WillAppearEvent<SmartPickSettings>): void | Promise<void> {
		this.startPolling();
		const role = ev.payload.settings.role ?? "auto";
		const roleLabel = role === "auto" ? "AUTO" : role.toUpperCase();
		const mode = ev.payload.settings.defaultMode ?? "counter";
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
			s = { mode: defaultMode, viewIndex: 0, lastHash: "", lastPicks: [], lastInfo: "" };
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

		const modeIndicator = state.mode === "counter" ? "⚔️" : "★";
		await a.setFeedback({
			champ_icon: champIcon ?? "",
			title: `${modeIndicator} ${state.lastInfo}`,
			pick_name: `#${state.viewIndex + 1} ${pick.name}`,
			pick_info: pick.details,
			score_bar: { value: score, bar_fill_c: barColor },
		});
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateSmartPick().catch((e) => logger.error(`updateSmartPick error: ${e}`));
		this.pollInterval = setInterval(() => this.updateSmartPick().catch((e) => logger.error(`updateSmartPick error: ${e}`)), 4000);
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
			for (const s of this.actionStates.values()) {
				s.lastHash = "";
				s.lastPicks = [];
			}
			for (const a of this.actions) {
				const settings = (await a.getSettings()) as SmartPickSettings;
				const role = settings.role ?? "auto";
				const roleLabel = role === "auto" ? "AUTO" : role.toUpperCase();
				const state = this.getState(a.id, settings.defaultMode);
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

		const localCell = session.localPlayerCellId;
		const me = session.myTeam.find((p) => p.cellId === localCell);

		for (const a of this.actions) {
			const settings = (await a.getSettings()) as SmartPickSettings;
			// Auto-detect role from champ select assigned position
			const role = (settings.role && settings.role !== "auto" ? settings.role : null)
				?? me?.assignedPosition
				?? "top";
			const lane = ChampionStats.toLolalyticsLane(role);
			const state = this.getState(a.id, settings.defaultMode);

			if (state.mode === "counter") {
				await this.updateCounterMode(a, session, role, lane, state);
			} else {
				await this.updateBestMode(a, session, role, lane, state);
			}
		}
	}

	/**
	 * Collect all champion aliases that are unavailable (banned or already picked).
	 */
	private getUnavailableAliases(session: NonNullable<Awaited<ReturnType<typeof lcuApi.getChampSelectSession>>>): Set<string> {
		const unavailable = new Set<string>();
		const allActions = session.actions.flat();

		for (const act of allActions) {
			if (act.championId <= 0) continue;
			// Banned champions (completed bans)
			if (act.type === "ban" && act.completed) {
				const champ = dataDragon.getChampionByKey(String(act.championId));
				if (champ) unavailable.add(ChampionStats.toLolalytics(champ.id));
			}
			// Already-picked champions (completed picks)
			if (act.type === "pick" && act.completed) {
				const champ = dataDragon.getChampionByKey(String(act.championId));
				if (champ) unavailable.add(ChampionStats.toLolalytics(champ.id));
			}
		}
		return unavailable;
	}

	private async updateCounterMode(
		a: DialAction<SmartPickSettings> | KeyAction<SmartPickSettings>,
		session: Awaited<ReturnType<typeof lcuApi.getChampSelectSession>>,
		role: string,
		lane: string,
		state: SmartPickState,
	): Promise<void> {
		if (!session) return;

		// Find enemy laner using smart heuristics
		const enemyResult = this.findEnemyLaner(session, role);
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

		const enemyAlias = ChampionStats.toLolalytics(enemyChamp.id);
		const hash = `counter:${enemyAlias}`;

		if (hash === state.lastHash) {
			if (a.isDial()) await this.renderDialPick(a, state);
			return;
		}

		if (a.isDial()) {
			await a.setFeedback({ title: `vs ${enemyChamp.name}`, pick_name: "Searching...", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
		} else {
			await a.setTitle(`vs ${enemyChamp.name}\nSearching...`);
		}

		try {
			const allPicks = await championStats.getBestCounterpicks(enemyAlias, lane);

			// Filter out banned and already-picked champions
			const unavailable = this.getUnavailableAliases(session);
			const picks = allPicks.filter((p) => !unavailable.has(p.alias));

			state.lastPicks = picks.map((p) => ({
				alias: p.alias,
				name: p.name,
				score: p.winRateVs,
				winRateVs: p.winRateVs,
				games: p.games,
				details: `${p.winRateVs}% WR · ${p.games >= 1000 ? `${(p.games / 1000).toFixed(1)}k` : p.games} games`,
			}));
			state.lastInfo = `vs ${enemyChamp.name}`;
			state.lastHash = hash;

			prefetchChampionIcons(picks.slice(0, 5).map((p) => p.alias));

			if (picks.length === 0) {
				if (a.isDial()) {
					await a.setFeedback({ title: `⚔️ vs ${enemyChamp.name}`, pick_name: "No data", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`vs ${enemyChamp.name}\nNo data`);
				}
			} else if (a.isDial()) {
				state.viewIndex = 0;
				await this.renderDialPick(a, state);
			} else {
				const best = picks[0];
				const bestIcon = await getChampionIcon(best.alias);
				if (bestIcon) await a.setImage(bestIcon);
				await a.setTitle(`Counter\n${best.name} ${best.winRateVs}%`);
			}
		} catch (e) {
			logger.error(`Counter mode error: ${e}`);
			if (a.isDial()) {
				await a.setFeedback({ title: `vs ${enemyChamp.name}`, pick_name: "Error", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
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
	): Promise<void> {
		if (!session) return;

		const directEnemyAliases: string[] = [];
		const allEnemyAliases: string[] = [];
		const myLane = ChampionStats.toLolalyticsLane(role);
		for (const enemy of session.theirTeam) {
			if (enemy.championId > 0) {
				const champ = dataDragon.getChampionByKey(String(enemy.championId));
				if (champ) {
					const alias = ChampionStats.toLolalytics(champ.id);
					allEnemyAliases.push(alias);
					// Direct match: same assigned position
					if (enemy.assignedPosition === role) {
						directEnemyAliases.push(alias);
					} else if (!enemy.assignedPosition || enemy.assignedPosition === "") {
						// No position assigned yet — use tag-based lane inference
						if (this.championMatchesLane(champ, myLane)) {
							directEnemyAliases.push(alias);
						}
					}
				}
			}
		}

		const allyChampionKeys: string[] = [];
		for (const ally of session.myTeam) {
			if (ally.championId > 0 && ally.cellId !== session.localPlayerCellId) {
				allyChampionKeys.push(String(ally.championId));
			}
		}

		if (allEnemyAliases.length === 0) {
			if (a.isDial()) {
				await a.setFeedback({ title: `★ Best · ${role.toUpperCase()}`, pick_name: "No enemy yet", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
			} else {
				await a.setTitle(`Best\nNo enemy`);
			}
			return;
		}

		const enemyAliasesForMatchup = directEnemyAliases.length > 0
			? directEnemyAliases
			: allEnemyAliases;

		const hash = `best:${allEnemyAliases.sort().join(",")}|${allyChampionKeys.sort().join(",")}`;
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
			);

			// Filter out banned and already-picked champions
			const unavailable = this.getUnavailableAliases(session);
			const picks = allPicks.filter((p) => !unavailable.has(p.alias));

			state.lastPicks = picks;
			state.lastInfo = allyChampionKeys.length > 0
				? `vs${enemyAliasesForMatchup.length} +syn${allyChampionKeys.length}`
				: `vs${enemyAliasesForMatchup.length} · ${role.toUpperCase()}`;
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
				const bestIcon = await getChampionIcon(best.alias);
				if (bestIcon) await a.setImage(bestIcon);
				await a.setTitle(`Best Pick\n${best.name} ${best.score}%`);
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

	// ---- Enemy Laner Detection ----

	/**
	 * Find the enemy laner for a given role using smart heuristics:
	 *   1. Match by assignedPosition (when LCU exposes it)
	 *   2. Infer from champion tags / default lane
	 *   3. If only one enemy has picked, use them (early draft)
	 */
	private findEnemyLaner(
		session: NonNullable<Awaited<ReturnType<typeof lcuApi.getChampSelectSession>>>,
		myPosition: string,
	): { player: (typeof session.theirTeam)[0]; alias: string; name: string } | null {
		if (!myPosition) return null;

		// Strategy 1: Direct assignedPosition match
		const directMatch = session.theirTeam.find(
			(p) => p.assignedPosition === myPosition && p.championId > 0,
		);
		if (directMatch) {
			const champ = dataDragon.getChampionByKey(String(directMatch.championId));
			if (champ) {
				return { player: directMatch, alias: ChampionStats.toLolalytics(champ.id), name: champ.name };
			}
		}

		// Strategy 2: Infer from champion's primary role via Data Dragon tags
		const myLane = ChampionStats.toLolalyticsLane(myPosition);
		for (const enemy of session.theirTeam) {
			if (enemy.championId <= 0) continue;
			const champ = dataDragon.getChampionByKey(String(enemy.championId));
			if (!champ) continue;
			if (this.championMatchesLane(champ, myLane)) {
				return { player: enemy, alias: ChampionStats.toLolalytics(champ.id), name: champ.name };
			}
		}

		// Strategy 3: If only one enemy has picked so far, use them (early draft)
		const pickedEnemies = session.theirTeam.filter((p) => p.championId > 0);
		if (pickedEnemies.length === 1) {
			const champ = dataDragon.getChampionByKey(String(pickedEnemies[0].championId));
			if (champ) {
				return { player: pickedEnemies[0], alias: ChampionStats.toLolalytics(champ.id), name: champ.name };
			}
		}

		return null;
	}

	/**
	 * Heuristic: does this champion likely play in the given lane?
	 * Uses Data Dragon tags as a rough signal.
	 */
	private championMatchesLane(champ: { tags: string[]; name: string }, lane: string): boolean {
		const tags = champ.tags;
		switch (lane) {
			case "top":
				return tags.includes("Fighter") || (tags.includes("Tank") && !tags.includes("Support"));
			case "jungle":
				return false; // Hard to infer from tags; assignedPosition should handle jungle
			case "middle":
				return tags.includes("Mage") || tags.includes("Assassin");
			case "bottom":
				return tags.includes("Marksman");
			case "support":
				return tags.includes("Support");
			default:
				return false;
		}
	}
}
