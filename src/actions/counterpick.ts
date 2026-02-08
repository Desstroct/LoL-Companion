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
import { championStats, ChampionStats, MatchupData } from "../services/champion-stats";
import { getChampionIcon, prefetchChampionIcons } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("Counterpick");

/**
 * Counterpick action — suggests the best counter for your lane opponent.
 * Detects the enemy champion on the configured lane during ChampSelect
 * and shows the top counterpick(s) against them.
 *
 * Settings:
 * - role: "top" | "jungle" | "middle" | "bottom" | "utility"
 */
@action({ UUID: "com.desstroct.lol-api.counterpick" })
export class Counterpick extends SingletonAction<CounterpickSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-action instance state (supports multiple keys with different roles) */
	private actionStates = new Map<string, CounterpickState>();

	override onWillAppear(ev: WillAppearEvent<CounterpickSettings>): void | Promise<void> {
		this.startPolling();
		const role = ev.payload.settings.role ?? "top";
		if (ev.action.isDial()) {
			this.getState(ev.action.id);
			return ev.action.setFeedback({
				champ_icon: "",
				title: `Counter · ${role.toUpperCase()}`,
				pick_name: "Waiting...",
				pick_info: "",
				wr_bar: { value: 0 },
			});
		}
		return ev.action.setTitle(`Counter\n${role.toUpperCase()}`);
	}

	override onWillDisappear(ev: WillDisappearEvent<CounterpickSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<CounterpickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.lastEnemyChamp = "";
		await this.updateCounterpick();
	}

	/** Dial rotation: scroll through counter picks */
	override async onDialRotate(ev: DialRotateEvent<CounterpickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		if (state.lastPicks.length === 0) return;
		state.viewIndex = ((state.viewIndex + ev.payload.ticks) + state.lastPicks.length * 100) % state.lastPicks.length;
		await this.renderDialPick(ev.action, state);
	}

	/** Dial press: force refresh */
	override async onDialUp(ev: DialUpEvent<CounterpickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.lastEnemyChamp = "";
		await this.updateCounterpick();
	}

	/** Touch: force refresh */
	override async onTouchTap(ev: TouchTapEvent<CounterpickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.lastEnemyChamp = "";
		await this.updateCounterpick();
	}

	private getState(actionId: string): CounterpickState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { viewIndex: 0, lastEnemyChamp: "", lastPicks: [], lastEnemyName: "" };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private async renderDialPick(
		a: { setFeedback: (payload: any) => Promise<void> },
		state: CounterpickState,
	): Promise<void> {
		const pick = state.lastPicks[state.viewIndex];
		if (!pick) return;

		const gamesStr = pick.games >= 1000 ? `${(pick.games / 1000).toFixed(1)}k` : `${pick.games}`;
		const barColor = pick.winRateVs >= 54 ? "#2ECC71" : pick.winRateVs >= 50 ? "#F1C40F" : "#E74C3C";
		const champIcon = await getChampionIcon(pick.alias);

		await a.setFeedback({
			champ_icon: champIcon ?? "",
			title: `vs ${state.lastEnemyName}`,
			pick_name: `#${state.viewIndex + 1} ${pick.name}`,
			pick_info: `${pick.winRateVs}% WR · ${gamesStr} games`,
			wr_bar: { value: pick.winRateVs, bar_fill_c: barColor },
		});
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateCounterpick().catch((e) => logger.error(`updateCounterpick error: ${e}`));
		this.pollInterval = setInterval(() => this.updateCounterpick().catch((e) => logger.error(`updateCounterpick error: ${e}`)), 3000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateCounterpick(): Promise<void> {
		if (!lcuConnector.isConnected()) return;

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			for (const s of this.actionStates.values()) {
				s.lastEnemyChamp = "";
				s.lastPicks = [];
			}
			for (const a of this.actions) {
				const settings = (await a.getSettings()) as CounterpickSettings;
				const role = settings.role ?? "top";
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						title: `Counter · ${role.toUpperCase()}`,
						pick_name: "Waiting...",
						pick_info: "",
						wr_bar: { value: 0 },
					});
				} else {
					await a.setImage("");
					await a.setTitle(`Counter\n${role.toUpperCase()}`);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		for (const a of this.actions) {
			const settings = (await a.getSettings()) as CounterpickSettings;
			const role = settings.role ?? "top";
			const state = this.getState(a.id);

			const enemy = session.theirTeam.find(
				(p) => p.assignedPosition === role && p.championId > 0,
			);

			if (!enemy) {
				if (a.isDial()) {
					await a.setFeedback({ title: `Counter · ${role.toUpperCase()}`, pick_name: "No enemy yet", pick_info: "", champ_icon: "", wr_bar: { value: 0 } });
				} else {
					await a.setTitle(`Counter\nNo enemy`);
				}
				continue;
			}

			const enemyChamp = dataDragon.getChampionByKey(String(enemy.championId));
			if (!enemyChamp) continue;

			const enemyAlias = ChampionStats.toLolalytics(enemyChamp.id);
			if (enemyAlias === state.lastEnemyChamp) {
				// Already processed — just re-render dials at their current index
				if (a.isDial()) {
					await this.renderDialPick(a, state);
				}
				continue;
			}

			if (a.isDial()) {
				await a.setFeedback({ title: `vs ${enemyChamp.name}`, pick_name: "Searching...", pick_info: "", champ_icon: "", wr_bar: { value: 0 } });
			} else {
				await a.setTitle(`vs ${enemyChamp.name}\nSearching...`);
			}

			try {
				const lane = ChampionStats.toLolalyticsLane(role);
				const picks = await championStats.getBestCounterpicks(enemyAlias, lane);

				state.lastPicks = picks;
				state.lastEnemyName = enemyChamp.name;

				// Prefetch icons for top picks
				prefetchChampionIcons(picks.slice(0, 5).map((p) => p.alias));

				if (picks.length === 0) {
					if (a.isDial()) {
						await a.setFeedback({ title: `vs ${enemyChamp.name}`, pick_name: "No data", pick_info: "", champ_icon: "", wr_bar: { value: 0 } });
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
					await a.setTitle(`vs ${enemyChamp.name}\n${best.name} ${best.winRateVs}%`);
				}

				state.lastEnemyChamp = enemyAlias;
			} catch (e) {
				logger.error(`Counterpick error: ${e}`);
				if (a.isDial()) {
					await a.setFeedback({ title: `vs ${enemyChamp.name}`, pick_name: "Error", pick_info: "", champ_icon: "", wr_bar: { value: 0 } });
				} else {
					await a.setTitle(`vs ${enemyChamp.name}\nError`);
				}
			}
		}
	}
}

interface CounterpickState {
	viewIndex: number;
	lastEnemyChamp: string;
	lastPicks: MatchupData[];
	lastEnemyName: string;
}

type CounterpickSettings = {
	role?: string;
};
