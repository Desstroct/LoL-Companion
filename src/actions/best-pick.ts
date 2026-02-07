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
import { championStats, ChampionStats } from "../services/champion-stats";

const logger = streamDeck.logger.createScope("BestPick");

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
	private lastHash = "";
	/** Cached picks for dial browsing */
	private lastPicks: { alias: string; name: string; score: number; details: string }[] = [];
	private lastInfo = "";
	/** Per-dial state: which pick index to view */
	private dialStates: Map<string, { viewIndex: number }> = new Map();

	override onWillAppear(ev: WillAppearEvent<BestPickSettings>): void | Promise<void> {
		this.startPolling();
		const role = ev.payload.settings.role ?? "top";
		if (ev.action.isDial()) {
			this.getDialView(ev.action.id);
			return ev.action.setFeedback({
				title: `Best · ${role.toUpperCase()}`,
				pick_name: "Waiting...",
				pick_info: "",
				score_bar: { value: 0 },
			});
		}
		return ev.action.setTitle(`Best\n${role.toUpperCase()}`);
	}

	override onWillDisappear(ev: WillDisappearEvent<BestPickSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<BestPickSettings>): Promise<void> {
		this.lastHash = "";
		await this.updateBestPick();
	}

	/** Dial rotation: scroll through best picks */
	override async onDialRotate(ev: DialRotateEvent<BestPickSettings>): Promise<void> {
		if (this.lastPicks.length === 0) return;
		const ds = this.getDialView(ev.action.id);
		ds.viewIndex = ((ds.viewIndex + ev.payload.ticks) + this.lastPicks.length * 100) % this.lastPicks.length;
		await this.renderDialPick(ev.action, ds.viewIndex);
	}

	/** Dial press: force refresh */
	override async onDialUp(_ev: DialUpEvent<BestPickSettings>): Promise<void> {
		this.lastHash = "";
		await this.updateBestPick();
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<BestPickSettings>): Promise<void> {
		this.lastHash = "";
		await this.updateBestPick();
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

		const barColor = pick.score >= 54 ? "#2ECC71" : pick.score >= 50 ? "#F1C40F" : "#E74C3C";

		await a.setFeedback({
			title: this.lastInfo,
			pick_name: `#${index + 1} ${pick.name}`,
			pick_info: `${pick.score}% · ${pick.details}`,
			score_bar: { value: pick.score, bar_fill_c: barColor },
		});
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateBestPick();
		this.pollInterval = setInterval(() => this.updateBestPick(), 5000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateBestPick(): Promise<void> {
		if (!lcuConnector.isConnected()) return;

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			this.lastHash = "";
			this.lastPicks = [];
			for (const a of this.actions) {
				const settings = (await a.getSettings()) as BestPickSettings;
				const role = settings.role ?? "top";
				if (a.isDial()) {
					await a.setFeedback({
						title: `Best · ${role.toUpperCase()}`,
						pick_name: "Waiting...",
						pick_info: "",
						score_bar: { value: 0 },
					});
				} else {
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

			const enemyAliases: string[] = [];
			for (const enemy of session.theirTeam) {
				if (enemy.championId > 0) {
					const champ = dataDragon.getChampionByKey(String(enemy.championId));
					if (champ) enemyAliases.push(ChampionStats.toLolalytics(champ.id));
				}
			}

			const allyChampionKeys: string[] = [];
			for (const ally of session.myTeam) {
				if (ally.championId > 0 && ally.cellId !== session.localPlayerCellId) {
					allyChampionKeys.push(String(ally.championId));
				}
			}

			if (enemyAliases.length === 0) {
				if (a.isDial()) {
					await a.setFeedback({ title: `Best · ${role.toUpperCase()}`, pick_name: "No enemy yet", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`Best Pick\nNo enemy`);
				}
				continue;
			}

			const hash = enemyAliases.sort().join(",") + "|" + allyChampionKeys.sort().join(",");
			if (hash === this.lastHash) {
				if (a.isDial()) {
					const ds = this.getDialView(a.id);
					await this.renderDialPick(a, ds.viewIndex);
				}
				continue;
			}

			if (a.isDial()) {
				await a.setFeedback({ title: `Best · ${role.toUpperCase()}`, pick_name: "Searching...", pick_info: "", score_bar: { value: 0 } });
			} else {
				await a.setTitle(`Best Pick\nSearching...`);
			}

			try {
				const picks = await championStats.getBestOverallPick(
					enemyAliases,
					lane,
					allyChampionKeys.length > 0 ? allyChampionKeys : undefined,
				);

				this.lastPicks = picks;
				this.lastInfo = allyChampionKeys.length > 0
					? `vs${enemyAliases.length} +syn${allyChampionKeys.length} · ${role.toUpperCase()}`
					: `vs${enemyAliases.length} · ${role.toUpperCase()}`;

				if (picks.length === 0) {
					if (a.isDial()) {
						await a.setFeedback({ title: this.lastInfo, pick_name: "No data", pick_info: "", score_bar: { value: 0 } });
					} else {
						await a.setTitle(`Best Pick\nNo data`);
					}
				} else if (a.isDial()) {
					const ds = this.getDialView(a.id);
					ds.viewIndex = 0;
					await this.renderDialPick(a, 0);
				} else {
					const best = picks[0];
					await a.setTitle(`Best Pick\n${best.name} ${best.score}%`);
				}

				this.lastHash = hash;
			} catch (e) {
				logger.error(`BestPick error: ${e}`);
				if (a.isDial()) {
					await a.setFeedback({ title: `Best · ${role.toUpperCase()}`, pick_name: "Error", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`Best Pick\nError`);
				}
			}
		}
	}
}
