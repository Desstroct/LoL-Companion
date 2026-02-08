import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	KeyDownEvent,
	DialRotateEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { getRankedEmblemIcon } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("LpTracker");

/** Queue types the user can cycle through */
const QUEUE_KEYS = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR", "RANKED_TFT", "RANKED_TFT_TURBO", "RANKED_TFT_DOUBLE_UP"] as const;
const QUEUE_LABELS: Record<string, string> = {
	RANKED_SOLO_5x5: "Solo/Duo",
	RANKED_FLEX_SR: "Flex",
	RANKED_TFT: "TFT",
	RANKED_TFT_TURBO: "TFT Hyper",
	RANKED_TFT_DOUBLE_UP: "TFT Duo",
};

const TIER_SHORT: Record<string, string> = {
	IRON: "Iron",
	BRONZE: "Bronze",
	SILVER: "Silver",
	GOLD: "Gold",
	PLATINUM: "Plat",
	EMERALD: "Emerald",
	DIAMOND: "Dia",
	MASTER: "Master",
	GRANDMASTER: "GM",
	CHALLENGER: "Chall",
};

const TIER_COLORS: Record<string, string> = {
	IRON: "#7C7C7C",
	BRONZE: "#CD7F32",
	SILVER: "#C0C0C0",
	GOLD: "#FFD700",
	PLATINUM: "#4ECDC4",
	EMERALD: "#50C878",
	DIAMOND: "#B9F2FF",
	MASTER: "#9B59B6",
	GRANDMASTER: "#E74C3C",
	CHALLENGER: "#F1C40F",
};

interface LpState {
	queueIndex: number;       // 0 = Solo/Duo, 1 = Flex
	lastDisplay: string;      // dedup key rendering
	sessionStartLp: number;   // LP when the action first appeared (for session delta)
	sessionStartTier: string;
	sessionStartDiv: string;
	trackingStarted: boolean; // whether we've captured the baseline
}

/**
 * LP Tracker — shows current rank, LP, win rate, and LP delta for the session.
 *
 * Key: Rank + LP + W/L + session delta
 * Dial: Rich layout with rank emblem, LP bar, win rate, session delta
 * Rotate: cycle between Solo/Duo and Flex queues
 * Press: force refresh
 */
@action({ UUID: "com.desstroct.lol-api.lp-tracker" })
export class LpTracker extends SingletonAction<LpTrackerSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, LpState>();

	private getState(id: string): LpState {
		let s = this.actionStates.get(id);
		if (!s) {
			s = { queueIndex: 0, lastDisplay: "", sessionStartLp: -1, sessionStartTier: "", sessionStartDiv: "", trackingStarted: false };
			this.actionStates.set(id, s);
		}
		return s;
	}

	override onWillAppear(ev: WillAppearEvent<LpTrackerSettings>): void | Promise<void> {
		this.getState(ev.action.id);
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				rank_text: "LP Tracker",
				lp_text: "",
				winrate_text: "Connecting...",
				lp_bar: { value: 0 },
				delta_text: "",
			});
		}
		return ev.action.setTitle("LP\nTracker");
	}

	override onWillDisappear(ev: WillDisappearEvent<LpTrackerSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<LpTrackerSettings>): Promise<void> {
		// Cycle queue on key press
		const state = this.getState(ev.action.id);
		state.queueIndex = (state.queueIndex + 1) % QUEUE_KEYS.length;
		state.lastDisplay = ""; // force re-render
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<LpTrackerSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.queueIndex = (state.queueIndex + (ev.payload.ticks > 0 ? 1 : -1) + QUEUE_KEYS.length) % QUEUE_KEYS.length;
		state.lastDisplay = "";
		await this.updateAll();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 10_000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						rank_icon: "",
						rank_text: "Offline",
						lp_text: "",
						winrate_text: "",
						lp_bar: { value: 0 },
						delta_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle("LP\nOffline");
				}
			}
			return;
		}

		const ranked = await lcuApi.getCurrentRankedStats();
		if (!ranked) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						rank_icon: "",
						rank_text: "No Data",
						lp_text: "",
						winrate_text: "",
						lp_bar: { value: 0 },
						delta_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle("LP\nNo Data");
				}
			}
			return;
		}

		for (const a of this.actions) {
			const state = this.getState(a.id);
			const queueKey = QUEUE_KEYS[state.queueIndex];
			const entry = ranked.queueMap?.[queueKey];

			if (!entry || !entry.tier || entry.tier === "" || entry.tier === "NONE") {
				const qLabel = QUEUE_LABELS[queueKey] ?? queueKey;
				if (a.isDial()) {
					await a.setFeedback({
						rank_icon: "",
						rank_text: qLabel,
						lp_text: "Unranked",
						winrate_text: "",
						lp_bar: { value: 0 },
						delta_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle(`${qLabel}\nUnranked`);
				}
				continue;
			}

			const tier = entry.tier;
			const div = entry.division ?? "";
			const lp = entry.leaguePoints ?? 0;
			const wins = entry.wins ?? 0;
			const losses = entry.losses ?? 0;
			const total = wins + losses;
			const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
			const tierLabel = TIER_SHORT[tier] ?? tier;
			const tierColor = TIER_COLORS[tier] ?? "#FFFFFF";
			const qLabel = QUEUE_LABELS[queueKey] ?? queueKey;

			// Capture session baseline
			if (!state.trackingStarted) {
				state.sessionStartLp = lp;
				state.sessionStartTier = tier;
				state.sessionStartDiv = div;
				state.trackingStarted = true;
			}

			// Calculate session LP delta (simplified: same tier/div = lp diff)
			let deltaStr = "";
			if (state.trackingStarted && state.sessionStartTier === tier && state.sessionStartDiv === div) {
				const diff = lp - state.sessionStartLp;
				if (diff > 0) deltaStr = `+${diff} LP`;
				else if (diff < 0) deltaStr = `${diff} LP`;
				else deltaStr = "±0 LP";
			} else if (state.trackingStarted) {
				// Tier/div changed — promoted or demoted
				const tierVal = tierToValue(tier, div);
				const startVal = tierToValue(state.sessionStartTier, state.sessionStartDiv);
				if (tierVal > startVal) deltaStr = "▲ Promoted!";
				else if (tierVal < startVal) deltaStr = "▼ Demoted";
			}

			// Dedup: avoid flickering by skipping if nothing changed
			const displayKey = `${queueKey}|${tier}|${div}|${lp}|${wins}|${losses}`;
			if (displayKey === state.lastDisplay) continue;
			state.lastDisplay = displayKey;

			// Get rank emblem icon
			const emblemIcon = await getRankedEmblemIcon(tier);

			if (a.isDial()) {
				const lpBarValue = Math.min(100, lp);
				await a.setFeedback({
					rank_icon: emblemIcon ?? "",
					rank_text: `${tierLabel} ${div}`,
					lp_text: `${lp} LP`,
					winrate_text: `${wins}W ${losses}L (${winRate}%)`,
					lp_bar: { value: lpBarValue, bar_fill_c: tierColor },
					delta_text: deltaStr,
					queue_text: qLabel,
				});
			} else {
				if (emblemIcon) await a.setImage(emblemIcon);
				const lines = [`${tierLabel} ${div}`, `${lp} LP`, `${winRate}% WR`];
				if (deltaStr) lines.push(deltaStr);
				await a.setTitle(lines.join("\n"));
			}
		}
	}
}

/** Simple tier+div to numeric value for promotion/demotion detection */
function tierToValue(tier: string, div: string): number {
	const tierVals: Record<string, number> = {
		IRON: 0, BRONZE: 4, SILVER: 8, GOLD: 12,
		PLATINUM: 16, EMERALD: 20, DIAMOND: 24,
		MASTER: 28, GRANDMASTER: 29, CHALLENGER: 30,
	};
	const divVals: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };
	const base = tierVals[tier] ?? 0;
	if (base >= 28) return base;
	return base + (divVals[div] ?? 0);
}

type LpTrackerSettings = {
	queue?: string;
};
