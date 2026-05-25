import {
	action,
	DidReceiveSettingsEvent,
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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const logger = streamDeck.logger.createScope("LpTracker");

const BASELINE_PATH = join(
	dirname(dirname(fileURLToPath(import.meta.url))),
	"..",
	"cache",
	"lp-baseline.json",
);

/** Queue types the user can cycle through */
const QUEUE_KEYS = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR", "RANKED_TFT", "RANKED_TFT_DOUBLE_UP"] as const;
const QUEUE_LABELS: Record<string, string> = {
	RANKED_SOLO_5x5: "Solo/Duo",
	RANKED_FLEX_SR: "Flex",
	RANKED_TFT: "TFT",
	RANKED_TFT_DOUBLE_UP: "TFT Duo",
};

/** Maps PI setting value → QUEUE_KEYS index */
const QUEUE_SETTING_INDEX: Record<string, number> = {
	solo: 0,
	flex: 1,
	tft: 2,
	tft_duo: 3,
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

interface LpBaseline {
	[queueKey: string]: { lp: number; tier: string; div: string; ts: number };
}

/** Max age for a persisted baseline: 24 hours */
const BASELINE_MAX_AGE = 24 * 60 * 60 * 1000;

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
	private savedBaselines: LpBaseline = {};
	private baselinesLoaded = false;

	private getState(id: string): LpState {
		let s = this.actionStates.get(id);
		if (!s) {
			s = { queueIndex: 0, lastDisplay: "", sessionStartLp: -1, sessionStartTier: "", sessionStartDiv: "", trackingStarted: false };
			this.actionStates.set(id, s);
		}
		return s;
	}

	private async loadBaselines(): Promise<void> {
		if (this.baselinesLoaded) return;
		try {
			const raw = await readFile(BASELINE_PATH, "utf-8");
			this.savedBaselines = JSON.parse(raw) as LpBaseline;
		} catch {
			this.savedBaselines = {};
		}
		this.baselinesLoaded = true;
	}

	private async saveBaselines(): Promise<void> {
		try {
			await mkdir(dirname(BASELINE_PATH), { recursive: true });
			await writeFile(BASELINE_PATH, JSON.stringify(this.savedBaselines), "utf-8");
		} catch (e) {
			logger.warn(`Failed to save LP baseline: ${e}`);
		}
	}

	override onWillAppear(ev: WillAppearEvent<LpTrackerSettings>): void | Promise<void> {
		const state = this.getState(ev.action.id);
		const q = ev.payload.settings.queue;
		if (q && q in QUEUE_SETTING_INDEX) state.queueIndex = QUEUE_SETTING_INDEX[q];
		this.startPolling();
		if (ev.action.isDial()) {
			ev.action.setFeedbackLayout("layouts/lp-tracker.json");
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

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LpTrackerSettings>): Promise<void> {
		const q = ev.payload.settings.queue;
		if (q && q in QUEUE_SETTING_INDEX) {
			const state = this.getState(ev.action.id);
			state.queueIndex = QUEUE_SETTING_INDEX[q];
			state.lastDisplay = "";
			await this.updateAll();
		}
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

			// Capture session baseline (restore from disk if plugin restarted)
			if (!state.trackingStarted) {
				await this.loadBaselines();
				const saved = this.savedBaselines[queueKey];
				if (saved && (Date.now() - saved.ts) < BASELINE_MAX_AGE) {
					state.sessionStartLp = saved.lp;
					state.sessionStartTier = saved.tier;
					state.sessionStartDiv = saved.div;
				} else {
					state.sessionStartLp = lp;
					state.sessionStartTier = tier;
					state.sessionStartDiv = div;
					this.savedBaselines[queueKey] = { lp, tier, div, ts: Date.now() };
					await this.saveBaselines();
				}
				state.trackingStarted = true;
			}

			// Calculate session LP delta using absolute LP for accurate cross-tier tracking
			let deltaStr = "";
			let deltaColor = "#888888";
			if (state.trackingStarted) {
				const currentAbsLp = tierToAbsoluteLp(tier, div, lp);
				const startAbsLp = tierToAbsoluteLp(state.sessionStartTier, state.sessionStartDiv, state.sessionStartLp);
				const diff = currentAbsLp - startAbsLp;
				if (diff > 0) { deltaStr = `+${diff} LP`; deltaColor = "#2ECC71"; }
				else if (diff < 0) { deltaStr = `${diff} LP`; deltaColor = "#E74C3C"; }
				else { deltaStr = "±0 LP"; }
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
					delta_text: { value: deltaStr, color: deltaColor },
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

/** Convert tier + division + LP to an absolute LP value for accurate delta tracking */
function tierToAbsoluteLp(tier: string, div: string, lp: number): number {
	const tierVals: Record<string, number> = {
		IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200,
		PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400,
		MASTER: 2800, GRANDMASTER: 2900, CHALLENGER: 3000,
	};
	const divVals: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };
	const base = tierVals[tier] ?? 0;
	if (base >= 2800) return base + lp; // Master+ LP adds directly
	return base + (divVals[div] ?? 0) + lp;
}

type LpTrackerSettings = {
	queue?: string;
};
