import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	KeyDownEvent,
	DialRotateEvent,
	DialUpEvent,
	TouchTapEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { dataDragon } from "../services/data-dragon";
import { getRankedEmblemIcon } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("SessionStats");

// LoL color palette
const GREEN = "#2ECC71";
const RED = "#E74C3C";

const QUEUE_KEYS = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"] as const;
const QUEUE_LABELS: Record<string, string> = {
	RANKED_SOLO_5x5: "Solo/Duo",
	RANKED_FLEX_SR: "Flex",
};

const TIER_SHORT: Record<string, string> = {
	IRON: "Iron", BRONZE: "Bronze", SILVER: "Silver", GOLD: "Gold",
	PLATINUM: "Plat", EMERALD: "Emerald", DIAMOND: "Dia",
	MASTER: "Master", GRANDMASTER: "GM", CHALLENGER: "Chall",
};

/** Numeric rank value for LP delta calculations across tiers */
function tierToLp(tier: string, div: string, lp: number): number {
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

interface SessionState {
	queueIndex: number;
	lastDisplay: string;
	/** Baseline captured at session start (per queue) */
	baselines: Map<string, { tier: string; div: string; lp: number; totalLp: number; wins: number; losses: number }>;
	/** Session start timestamp */
	sessionStart: number;
}

type SessionStatsSettings = {
	queue?: string;
};

/**
 * Session Stats action — tracks wins, losses, LP delta, and streaks
 * across your current gaming session.
 *
 * Key: W/L record, LP delta, streak
 * Dial: Rich layout with session overview
 * Rotate: Toggle Solo/Duo vs Flex
 * Press key: Reset session
 * Dial press: Reset session
 *
 * Data sources: LCU API (ranked stats + match history) — 100% TOS compliant.
 */
@action({ UUID: "com.desstroct.lol-api.session-stats" })
export class SessionStats extends SingletonAction<SessionStatsSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, SessionState>();
	/** Cached match history to avoid refetching every 15s */
	private matchCache: { data: MatchEntry[]; fetchedAt: number } | null = null;
	private static readonly MATCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

	private getState(id: string): SessionState {
		let s = this.actionStates.get(id);
		if (!s) {
			s = {
				queueIndex: 0,
				lastDisplay: "",
				baselines: new Map(),
				sessionStart: Date.now(),
			};
			this.actionStates.set(id, s);
		}
		return s;
	}

	override onWillAppear(ev: WillAppearEvent<SessionStatsSettings>): void | Promise<void> {
		this.getState(ev.action.id);
		this.startPolling();
		if (ev.action.isDial()) {
			ev.action.setFeedbackLayout("layouts/session-stats.json");
			return ev.action.setFeedback({
				title: "Session Stats",
				record_text: "",
				lp_text: "Loading...",
				streak_text: "",
				winrate_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("Session\nStats");
	}

	override onWillDisappear(ev: WillDisappearEvent<SessionStatsSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	/** Key press: reset session */
	override async onKeyDown(ev: KeyDownEvent<SessionStatsSettings>): Promise<void> {
		this.resetSession(ev.action.id);
		await ev.action.setTitle("Session\nReset!");
		await this.updateAll();
	}

	/** Dial rotate: cycle queue */
	override async onDialRotate(ev: DialRotateEvent<SessionStatsSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.queueIndex = (state.queueIndex + (ev.payload.ticks > 0 ? 1 : -1) + QUEUE_KEYS.length) % QUEUE_KEYS.length;
		state.lastDisplay = "";
		await this.updateAll();
	}

	/** Dial press: reset session */
	override async onDialUp(ev: DialUpEvent<SessionStatsSettings>): Promise<void> {
		this.resetSession(ev.action.id);
		await this.updateAll();
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<SessionStatsSettings>): Promise<void> {
		await this.updateAll();
	}

	private resetSession(actionId: string): void {
		const state = this.getState(actionId);
		state.baselines.clear();
		state.lastDisplay = "";
		state.sessionStart = Date.now();
		logger.info(`Session reset for action ${actionId}`);
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(
			() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)),
			15_000, // 15s — don't need fast polling for session stats
		);
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
						title: "Session Stats",
						record_text: "",
						lp_text: "Offline",
						streak_text: "",
						winrate_bar: { value: 0 },
					});
				} else {
					await a.setImage("");
					await a.setTitle("Session\nOffline");
				}
			}
			return;
		}

		let ranked: Awaited<ReturnType<typeof lcuApi.getCurrentRankedStats>> | null = null;
		try {
			ranked = await lcuApi.getCurrentRankedStats();
		} catch (e) {
			logger.warn(`Failed to fetch ranked stats: ${e}`);
		}
		if (!ranked) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: "Session Stats", record_text: "", lp_text: "No Data", streak_text: "", winrate_bar: { value: 0 } });
				} else {
					await a.setImage("");
					await a.setTitle("Session\nNo Data");
				}
			}
			return;
		}

		// Fetch recent match history for W/L tracking
		const matches = await this.fetchRecentMatches();

		for (const a of this.actions) {
			const state = this.getState(a.id);
			const queueKey = QUEUE_KEYS[state.queueIndex];
			const entry = ranked.queueMap?.[queueKey];
			const qLabel = QUEUE_LABELS[queueKey] ?? queueKey;

			if (!entry || !entry.tier || entry.tier === "" || entry.tier === "NONE") {
				if (a.isDial()) {
					await a.setFeedback({ title: qLabel, record_text: "", lp_text: "Unranked", streak_text: "", winrate_bar: { value: 0 } });
				} else {
					await a.setImage("");
					await a.setTitle(`${qLabel}\nUnranked`);
				}
				continue;
			}

			const currentLp = tierToLp(entry.tier, entry.division, entry.leaguePoints ?? 0);

			// Capture baseline on first poll for this queue
			if (!state.baselines.has(queueKey)) {
				state.baselines.set(queueKey, {
					tier: entry.tier,
					div: entry.division,
					lp: entry.leaguePoints ?? 0,
					totalLp: currentLp,
					wins: entry.wins ?? 0,
					losses: entry.losses ?? 0,
				});
				logger.info(`Session baseline for ${queueKey}: ${entry.tier} ${entry.division} ${entry.leaguePoints}LP`);
			}

			const baseline = state.baselines.get(queueKey)!;

			// Calculate session W/L from ranked stats delta
			const sessionWins = (entry.wins ?? 0) - baseline.wins;
			const sessionLosses = (entry.losses ?? 0) - baseline.losses;
			const totalGames = sessionWins + sessionLosses;
			const sessionWR = totalGames > 0 ? Math.round((sessionWins / totalGames) * 100) : 0;

			// LP delta
			const lpDelta = currentLp - baseline.totalLp;
			let lpStr: string;
			if (lpDelta > 0) lpStr = `+${lpDelta} LP`;
			else if (lpDelta < 0) lpStr = `${lpDelta} LP`;
			else lpStr = "±0 LP";

			// Calculate streak from match history (scoped to session)
			const queueId = queueKey === "RANKED_SOLO_5x5" ? 420 : 440;
			const streak = this.calculateStreak(matches, queueId, state.sessionStart);
			let streakStr = "";
			if (streak > 0) streakStr = `🔥 ${streak}W`;
			else if (streak < 0) streakStr = `💀 ${Math.abs(streak)}L`;

			// Most-played champion + avg KDA this session
			const champStats = this.getSessionChampStats(matches, queueId, state.sessionStart);
			const champLine = champStats
				? `${champStats.name} ${champStats.avgKda} KDA`
				: "";

			// Current rank info
			const tierLabel = TIER_SHORT[entry.tier] ?? entry.tier;
			// Dedup
			const displayKey = `${queueKey}|${entry.tier}|${entry.division}|${entry.leaguePoints}|${entry.wins}|${entry.losses}|${streak}|${champStats?.name}`;
			if (displayKey === state.lastDisplay) continue;
			state.lastDisplay = displayKey;

			const rankIcon = await getRankedEmblemIcon(entry.tier);

			const streakColor = streak > 0 ? GREEN : streak < 0 ? RED : "#888888";
			if (a.isDial()) {
				await a.setFeedback({
					title: `${qLabel} · ${tierLabel} ${entry.division}`,
					record_text: totalGames > 0
						? `${sessionWins}W ${sessionLosses}L (${sessionWR}%)`
						: "No games yet",
					lp_text: lpStr,
					streak_text: { value: streakStr, color: streakColor },
					winrate_bar: {
						value: totalGames > 0 ? sessionWR : 50,
						bar_fill_c: totalGames > 0 ? (sessionWR >= 50 ? GREEN : RED) : "#555",
					},
					rank_icon: rankIcon ?? "",
					champ_text: champLine,
				});
			} else {
				if (rankIcon) await a.setImage(rankIcon);
				const lines: string[] = [];
				if (totalGames > 0) {
					lines.push(`${sessionWins}W ${sessionLosses}L`);
				} else {
					lines.push("No games");
				}
				lines.push(lpStr);
				if (streakStr) lines.push(streakStr);
				await a.setTitle(lines.join("\n"));
			}
		}
	}

	/**
	 * Fetch recent match history from LCU API.
	 * Cached for 2 minutes to avoid excessive LCU load — match history
	 * only changes after a game ends (25+ min).
	 */
	private async fetchRecentMatches(): Promise<MatchEntry[]> {
		const now = Date.now();
		if (this.matchCache && (now - this.matchCache.fetchedAt) < SessionStats.MATCH_CACHE_TTL) {
			return this.matchCache.data;
		}
		try {
			const data = await lcuApi.get<{ games: { games: MatchEntry[] } }>(
				"/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20",
			);
			const matches = data?.games?.games ?? [];
			this.matchCache = { data: matches, fetchedAt: now };
			return matches;
		} catch (e) {
			logger.warn(`Failed to fetch match history: ${e}`);
			return this.matchCache?.data ?? [];
		}
	}

	/**
	 * Get the most-played champion + average KDA this session for a queue.
	 */
	private getSessionChampStats(
		matches: MatchEntry[],
		queueId: number,
		sessionStart: number,
	): { name: string; avgKda: string; games: number } | null {
		const queueMatches = matches.filter(
			(m) => m.queueId === queueId && m.gameCreation >= sessionStart,
		);
		if (queueMatches.length === 0) return null;

		// Count games per champion
		const champCounts = new Map<number, { games: number; kills: number; deaths: number; assists: number }>();
		for (const m of queueMatches) {
			const p = m.participants?.[0];
			if (!p) continue;
			const cid = p.championId;
			const existing = champCounts.get(cid) ?? { games: 0, kills: 0, deaths: 0, assists: 0 };
			existing.games++;
			existing.kills += p.stats?.kills ?? 0;
			existing.deaths += p.stats?.deaths ?? 0;
			existing.assists += p.stats?.assists ?? 0;
			champCounts.set(cid, existing);
		}

		// Find most-played
		let best: { cid: number; data: { games: number; kills: number; deaths: number; assists: number } } | null = null;
		for (const [cid, data] of champCounts) {
			if (!best || data.games > best.data.games) {
				best = { cid, data };
			}
		}
		if (!best) return null;

		const champ = dataDragon.getChampionByKey(String(best.cid));
		const name = champ?.name ?? `#${best.cid}`;
		const avgKda = best.data.deaths > 0
			? ((best.data.kills + best.data.assists) / best.data.deaths).toFixed(1)
			: "Perfect";

		return { name, avgKda, games: best.data.games };
	}

	/**
	 * Calculate current streak from match history for a specific queue.
	 * Returns positive for win streak, negative for loss streak.
	 */
	private calculateStreak(matches: MatchEntry[], queueId: number, sessionStart: number): number {
		const queueMatches = matches
			.filter((m) => m.queueId === queueId && m.gameCreation >= sessionStart)
			.sort((a, b) => b.gameCreation - a.gameCreation);

		if (queueMatches.length === 0) return 0;

		const firstResult = queueMatches[0].participants?.[0]?.stats?.win;
		if (firstResult === undefined) return 0;

		let streak = 0;
		for (const match of queueMatches) {
			const won = match.participants?.[0]?.stats?.win;
			if (won === firstResult) {
				streak++;
			} else {
				break;
			}
		}

		return firstResult ? streak : -streak;
	}
}

interface MatchEntry {
	gameId: number;
	gameCreation: number;
	queueId: number;
	participants: Array<{
		championId: number;
		stats: {
			win: boolean;
			kills: number;
			deaths: number;
			assists: number;
		};
	}>;
}
