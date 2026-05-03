import {
	action,
	DialRotateEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	type DialAction,
	type FeedbackPayload,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { duoSynergy } from "../services/duo-synergy";
import { ItemBuilds } from "../services/item-builds";
import { ChampionStats } from "../services/champion-stats";
import { getChampionIcon, getChampionIconByKey, prefetchChampionIcons } from "../services/lol-icons";
import { getUnavailableAliases } from "../services/champ-select-utils";

const logger = streamDeck.logger.createScope("DuoSynergy");

// ── Role pairing labels ──
const DUO_LABEL: Record<string, string> = {
	bottom: "Best Supp",
	support: "Best ADC",
	top: "Best Jungler",
	jungle: "Best Solo",
	middle: "Best Jungler",
};

interface DuoSynergyState {
	viewIndex: number;
	lastHash: string;
	lastPicks: { alias: string; name: string; winRate: number; synergy: number; games: number }[];
	lastLabel: string;
}

type DuoSynergySettings = {
	/** "auto" = detect from champ select assigned position */
	role?: string;
};

/**
 * Duo Synergy action — shows the best champion partner for your role.
 *
 * During champion select, once you have a champion + assigned role:
 *   ADC → best support partners
 *   Support → best ADC partners
 *   Top → best jungle partners
 *   Mid → best jungle partners
 *   Jungle → best top/mid partners
 *
 * Key: press to refresh
 * Dial: rotate to browse top synergy picks, press to refresh
 */
@action({ UUID: "com.desstroct.lol-api.duo-synergy" })
export class DuoSynergyAction extends SingletonAction<DuoSynergySettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, DuoSynergyState>();
	private fetchCooldown = 0;

	override onWillAppear(ev: WillAppearEvent<DuoSynergySettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				champ_icon: "",
				title: "DUO SYNERGY",
				pick_name: "Waiting...",
				pick_info: "",
				score_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("Duo\nSynergy");
	}

	override onWillDisappear(ev: WillDisappearEvent<DuoSynergySettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onDialRotate(ev: DialRotateEvent<DuoSynergySettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		if (state.lastPicks.length === 0) return;
		state.viewIndex = ((state.viewIndex + ev.payload.ticks) + state.lastPicks.length * 100) % state.lastPicks.length;
		await this.renderDial(ev.action, state);
	}

	private getState(actionId: string): DuoSynergyState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { viewIndex: 0, lastHash: "", lastPicks: [], lastLabel: "" };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 4000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async renderDial(a: DialAction<DuoSynergySettings>, state: DuoSynergyState): Promise<void> {
		if (!a.isDial()) return;
		const pick = state.lastPicks[state.viewIndex];
		if (!pick) return;

		const barColor = pick.synergy >= 1.5 ? "#2ECC71" : pick.synergy >= 0 ? "#F1C40F" : "#E74C3C";
		const champIcon = await getChampionIcon(pick.alias);

		// Map synergy to bar (range roughly -3 to +5 → 0-100)
		const barValue = Math.min(100, Math.max(0, Math.round((pick.synergy + 3) * 12.5)));

		const feedback: FeedbackPayload = {
			champ_icon: champIcon ?? "",
			title: state.lastLabel,
			pick_name: `#${state.viewIndex + 1} ${pick.name}`,
			pick_info: `${pick.winRate}% WR · +${pick.synergy.toFixed(1)} syn · ${pick.games >= 1000 ? `${(pick.games / 1000).toFixed(1)}k` : pick.games}`,
			score_bar: { value: barValue, bar_fill_c: barColor },
		};
		await a.setFeedback(feedback);
	}

	private async updateAll(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "DUO SYNERGY", pick_name: "Offline", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Duo\nOffline");
				}
			}
			return;
		}

		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: "DUO SYNERGY", pick_name: "N/A in TFT", pick_info: "", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Duo\nN/A TFT");
				}
			}
			return;
		}

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			// Reset for next champ select
			for (const s of this.actionStates.values()) {
				s.lastHash = "";
				s.lastPicks = [];
			}
			this.fetchCooldown = 0;
			for (const a of this.actions) {
				const settings = (await a.getSettings()) as DuoSynergySettings;
				const role = settings.role ?? "auto";
				const roleLabel = role === "auto" ? "AUTO" : role.toUpperCase();
				if (a.isDial()) {
					await a.setFeedback({ champ_icon: "", title: `DUO · ${roleLabel}`, pick_name: "Waiting...", pick_info: "Enter champ select", score_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle(`Duo\n${roleLabel}`);
				}
			}
			return;
		}

		// ── Champion Select active ──
		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const localCell = session.localPlayerCellId;
		const me = session.myTeam.find((p) => p.cellId === localCell);
		if (!me || me.championId <= 0) {
			// Haven't picked yet
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: "DUO SYNERGY", pick_name: "Pick a champion...", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle("Duo\nPick champ");
				}
			}
			return;
		}

		const myChamp = dataDragon.getChampionByKey(String(me.championId));
		if (!myChamp) return;

		for (const a of this.actions) {
			const settings = (await a.getSettings()) as DuoSynergySettings;
			const role = (settings.role && settings.role !== "auto" ? settings.role : null)
				?? me.assignedPosition
				?? "bottom";

			// Convert LCU position → Lolalytics lane
			const lane = ChampionStats.toLolalyticsLane(role);
			const alias = ItemBuilds.toAlias(myChamp.name);
			const hash = `${alias}:${lane}`;
			const state = this.getState(a.id);
			const duoLabel = DUO_LABEL[lane] ?? "Best Duo";

			if (hash === state.lastHash && state.lastPicks.length > 0) {
				// Already fetched this combo — just render
				if (a.isDial()) await this.renderDial(a, state);
				continue;
			}

			// Cooldown to avoid spamming on failure
			if (Date.now() < this.fetchCooldown) continue;

			// Show loading
			const myIcon = await getChampionIconByKey(String(me.championId));
			if (a.isDial()) {
				await a.setFeedback({
					champ_icon: myIcon ?? "",
					title: `${myChamp.name} · ${lane.toUpperCase()}`,
					pick_name: "Loading...",
					pick_info: `Finding ${duoLabel.toLowerCase()}...`,
					score_bar: { value: 0 },
				});
			} else {
				if (myIcon) await a.setImage(myIcon);
				await a.setTitle(`${myChamp.name}\nLoading...`);
			}

			try {
				const result = await duoSynergy.getSynergy(alias, lane);

				if (!result || result.entries.length === 0) {
					this.fetchCooldown = Date.now() + 60_000;
					state.lastHash = hash;
					state.lastPicks = [];
					if (a.isDial()) {
						await a.setFeedback({ title: `${myChamp.name} · ${lane.toUpperCase()}`, pick_name: "No data", pick_info: "", champ_icon: myIcon ?? "", score_bar: { value: 0 } });
					} else {
						await a.setTitle(`${myChamp.name}\nNo duo data`);
					}
					continue;
				}

				// Filter out banned and already-picked champions
				const unavailable = getUnavailableAliases(session);

				// Map entries to display picks
				state.lastPicks = result.entries
					.filter((e) => !unavailable.has(e.championId.toLowerCase()))
					.slice(0, 20)
					.map((e) => ({
					alias: e.championId.toLowerCase(),
					name: e.championName,
					winRate: e.winRate,
					synergy: e.synergy,
					games: e.games,
				}));
				state.lastLabel = `${duoLabel} for ${myChamp.name}`;
				state.lastHash = hash;
				state.viewIndex = 0;

				// Prefetch icons for top picks
				prefetchChampionIcons(state.lastPicks.slice(0, 5).map((p) => p.alias));

				if (a.isDial()) {
					await this.renderDial(a, state);
				} else {
					const best = state.lastPicks[0];
					const bestIcon = await getChampionIcon(best.alias);
					if (bestIcon) await a.setImage(bestIcon);
					await a.setTitle(`${duoLabel}\n${best.name} ${best.winRate}%`);
				}
			} catch (e) {
				logger.error(`Duo synergy error: ${e}`);
				this.fetchCooldown = Date.now() + 30_000;
				if (a.isDial()) {
					await a.setFeedback({ title: `${myChamp.name}`, pick_name: "Error", pick_info: "", champ_icon: "", score_bar: { value: 0 } });
				} else {
					await a.setTitle(`Duo\nError`);
				}
			}
		}
	}

}
