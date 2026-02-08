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
import { getChampionIcon, prefetchChampionIcons } from "../services/champion-icons";

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
	private lastEnemyChamp = "";
	/** Cached counter picks for dial browsing */
	private lastPicks: MatchupData[] = [];
	private lastEnemyName = "";
	/** Per-dial state: which counter index to view */
	private dialStates: Map<string, { viewIndex: number }> = new Map();

	override onWillAppear(ev: WillAppearEvent<CounterpickSettings>): void | Promise<void> {
		this.startPolling();
		const role = ev.payload.settings.role ?? "top";
		if (ev.action.isDial()) {
			this.getDialView(ev.action.id);
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
		this.dialStates.delete(ev.action.id);
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<CounterpickSettings>): Promise<void> {
		this.lastEnemyChamp = "";
		await this.updateCounterpick();
	}

	/** Dial rotation: scroll through counter picks */
	override async onDialRotate(ev: DialRotateEvent<CounterpickSettings>): Promise<void> {
		if (this.lastPicks.length === 0) return;
		const ds = this.getDialView(ev.action.id);
		ds.viewIndex = ((ds.viewIndex + ev.payload.ticks) + this.lastPicks.length * 100) % this.lastPicks.length;
		await this.renderDialPick(ev.action, ds.viewIndex);
	}

	/** Dial press: force refresh */
	override async onDialUp(_ev: DialUpEvent<CounterpickSettings>): Promise<void> {
		this.lastEnemyChamp = "";
		await this.updateCounterpick();
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<CounterpickSettings>): Promise<void> {
		this.lastEnemyChamp = "";
		await this.updateCounterpick();
	}

	private getDialView(actionId: string): { viewIndex: number } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { viewIndex: 0 };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private async renderDialPick(
		a: { setFeedback: (payload: any) => Promise<void> },
		index: number,
	): Promise<void> {
		const pick = this.lastPicks[index];
		if (!pick) return;

		const gamesStr = pick.games >= 1000 ? `${(pick.games / 1000).toFixed(1)}k` : `${pick.games}`;
		const barColor = pick.winRateVs >= 54 ? "#2ECC71" : pick.winRateVs >= 50 ? "#F1C40F" : "#E74C3C";
		const champIcon = await getChampionIcon(pick.alias);

		await a.setFeedback({
			champ_icon: champIcon ?? "",
			title: `vs ${this.lastEnemyName}`,
			pick_name: `#${index + 1} ${pick.name}`,
			pick_info: `${pick.winRateVs}% WR · ${gamesStr} games`,
			wr_bar: { value: pick.winRateVs, bar_fill_c: barColor },
		});
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateCounterpick();
		this.pollInterval = setInterval(() => this.updateCounterpick(), 3000);
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
			this.lastEnemyChamp = "";
			this.lastPicks = [];
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
			if (enemyAlias === this.lastEnemyChamp) {
				// Already processed — just re-render dials at their current index
				if (a.isDial()) {
					const ds = this.getDialView(a.id);
					await this.renderDialPick(a, ds.viewIndex);
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

				this.lastPicks = picks;
				this.lastEnemyName = enemyChamp.name;

				// Prefetch icons for top picks
				prefetchChampionIcons(picks.slice(0, 5).map((p) => p.alias));

				if (picks.length === 0) {
					if (a.isDial()) {
						await a.setFeedback({ title: `vs ${enemyChamp.name}`, pick_name: "No data", pick_info: "", champ_icon: "", wr_bar: { value: 0 } });
					} else {
						await a.setTitle(`vs ${enemyChamp.name}\nNo data`);
					}
				} else if (a.isDial()) {
					const ds = this.getDialView(a.id);
					ds.viewIndex = 0; // Reset to #1 on new enemy
					await this.renderDialPick(a, 0);
				} else {
					const best = picks[0];
					const bestIcon = await getChampionIcon(best.alias);
					if (bestIcon) await a.setImage(bestIcon);
					await a.setTitle(`vs ${enemyChamp.name}\n${best.name} ${best.winRateVs}%`);
				}

				this.lastEnemyChamp = enemyAlias;
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

type CounterpickSettings = {
	role?: string;
};
