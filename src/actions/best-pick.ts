import {
	action,
	DialRotateEvent,
	DialUpEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
	type FeedbackPayload,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { championStats, ChampionStats } from "../services/champion-stats";
import { getChampionIcon, prefetchChampionIcons } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("BestPick");

interface BestPickState {
	viewIndex: number;
	lastHash: string;
	lastPicks: { alias: string; name: string; score: number; details: string }[];
	lastInfo: string;
}

type BestPickSettings = {
	role?: string;
};

/**
 * Best Pick action — suggests the best overall champion pick
 * considering all visible enemy champion selections + ally synergy.
 *
 * Key: shows top 3. Dial: rotate to scroll through all picks, touch strip shows rich detail.
 */
@action({ UUID: "com.desstroct.lol-api.best-pick" })
export class BestPick extends SingletonAction<BestPickSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-action instance state (supports multiple keys with different roles) */
	private actionStates = new Map<string, BestPickState>();

	override onWillAppear(ev: WillAppearEvent<BestPickSettings>): void | Promise<void> {
		this.startPolling();
		const role = ev.payload.settings.role ?? "top";
		if (ev.action.isDial()) {
			this.getState(ev.action.id);
			return ev.action.setFeedback({
				champ_icon: "",
				title: `Best · ${role.toUpperCase()}`,
				pick_name: "Waiting...",
				pick_info: "",
				score_bar: { value: 0 },
			});
		}
		return ev.action.setTitle(`Best\n${role.toUpperCase()}`);
	}

	override onWillDisappear(ev: WillDisappearEvent<BestPickSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<BestPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.lastHash = "";
		await this.updateBestPick();
	}

	/** Dial rotation: scroll through best picks */
	override async onDialRotate(ev: DialRotateEvent<BestPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		if (state.lastPicks.length === 0) return;
		state.viewIndex = ((state.viewIndex + ev.payload.ticks) + state.lastPicks.length * 100) % state.lastPicks.length;
		await this.renderDialPick(ev.action, state);
	}

	/** Dial press: force refresh */
	override async onDialUp(ev: DialUpEvent<BestPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.lastHash = "";
		await this.updateBestPick();
	}

	/** Touch: force refresh */
	override async onTouchTap(ev: TouchTapEvent<BestPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.lastHash = "";
		await this.updateBestPick();
	}

	private getState(actionId: string): BestPickState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { viewIndex: 0, lastHash: "", lastPicks: [], lastInfo: "" };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private async renderDialPick(
		a: { setFeedback: (payload: FeedbackPayload) => Promise<void> },
		state: BestPickState,
	): Promise<void> {
		const pick = state.lastPicks[state.viewIndex];
		if (!pick) return;

		const barColor = pick.score >= 54 ? "#2ECC71" : pick.score >= 50 ? "#F1C40F" : "#E74C3C";
		const champIcon = await getChampionIcon(pick.alias);

		await a.setFeedback({
			champ_icon: champIcon ?? "",
			title: state.lastInfo,
			pick_name: `#${state.viewIndex + 1} ${pick.name}`,
			pick_info: `${pick.score}% · ${pick.details}`,
			score_bar: { value: pick.score, bar_fill_c: barColor },
		});
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateBestPick().catch((e) => logger.error(`updateBestPick error: ${e}`));
		this.pollInterval = setInterval(() => this.updateBestPick().catch((e) => logger.error(`updateBestPick error: ${e}`)), 5000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateBestPick(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "Best Pick", pick_name: "Offline", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Best\nOffline");
				}
			}
			return;
		}

		// TFT has no traditional champion select
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "Best Pick", pick_name: "N/A in TFT", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Best\nN/A TFT");
				}
			}
			return;
		}

		// ARAM has no per-lane matchup data
		if (gameMode.isARAM()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "Best Pick", pick_name: "N/A in ARAM", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Best\nN/A ARAM");
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
				const settings = (await a.getSettings()) as BestPickSettings;
				const role = settings.role ?? "top";
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						title: `Best · ${role.toUpperCase()}`,
						pick_name: "Waiting...",
						pick_info: "",
						score_bar: { value: 0 },
					});
				} else {
					await a.setImage("");
					await a.setTitle(`Best\n${role.toUpperCase()}`);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		for (const a of this.actions) {
			const settings = (await a.getSettings()) as BestPickSettings;
			const role = settings.role ?? "top";
			const lane = ChampionStats.toLolalyticsLane(role);
			const state = this.getState(a.id);

			// Identify direct lane opponent (highest priority for matchup data)
			const directEnemyAliases: string[] = [];
			const allEnemyAliases: string[] = [];
			for (const enemy of session.theirTeam) {
				if (enemy.championId > 0) {
					const champ = dataDragon.getChampionByKey(String(enemy.championId));
					if (champ) {
						const alias = ChampionStats.toLolalytics(champ.id);
						allEnemyAliases.push(alias);
						// Direct lane opponent: matching position or unassigned
						if (
							enemy.assignedPosition === role ||
							enemy.assignedPosition === "" ||
							!enemy.assignedPosition
						) {
							directEnemyAliases.push(alias);
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
					await a.setFeedback({ title: `Best · ${role.toUpperCase()}`, pick_name: "No enemy yet", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`Best Pick\nNo enemy`);
				}
				continue;
			}

			// Use direct lane opponent for matchup data; fall back to all enemies
			const enemyAliasesForMatchup = directEnemyAliases.length > 0
				? directEnemyAliases
				: allEnemyAliases;

			const hash = allEnemyAliases.sort().join(",") + "|" + allyChampionKeys.sort().join(",");
			if (hash === state.lastHash) {
				if (a.isDial()) {
					await this.renderDialPick(a, state);
				}
				continue;
			}

			if (a.isDial()) {
				await a.setFeedback({ title: `Best · ${role.toUpperCase()}`, pick_name: "Searching...", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
			} else {
				await a.setTitle(`Best Pick\nSearching...`);
			}

			try {
				const picks = await championStats.getBestOverallPick(
					enemyAliasesForMatchup,
					lane,
					allyChampionKeys.length > 0 ? allyChampionKeys : undefined,
				);

				state.lastPicks = picks;
				state.lastInfo = allyChampionKeys.length > 0
					? `vs${enemyAliasesForMatchup.length} +syn${allyChampionKeys.length} · ${role.toUpperCase()}`
					: `vs${enemyAliasesForMatchup.length} · ${role.toUpperCase()}`;

				// Prefetch icons for top picks
				prefetchChampionIcons(picks.slice(0, 5).map((p) => p.alias));

				if (picks.length === 0) {
					if (a.isDial()) {
						await a.setFeedback({ title: state.lastInfo, pick_name: "No data", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
					} else {
						await a.setTitle(`Best Pick\nNo data`);
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

				state.lastHash = hash;
			} catch (e) {
				logger.error(`BestPick error: ${e}`);
				if (a.isDial()) {
					await a.setFeedback({ title: `Best · ${role.toUpperCase()}`, pick_name: "Error", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`Best Pick\nError`);
				}
			}
		}
	}
}
