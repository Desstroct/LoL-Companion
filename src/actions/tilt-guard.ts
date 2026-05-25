import {
	action,
	DialUpEvent,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";

const logger = streamDeck.logger.createScope("TiltGuard");

// ── Tilt levels ──

type TiltLevel = "fresh" | "warm" | "tilted" | "stop";

const TILT_CONFIG: Record<TiltLevel, { label: string; color: string; advice: string }> = {
	fresh:  { label: "FRESH",  color: "#2ECC71", advice: "Mental OK — keep going" },
	warm:   { label: "WARM",   color: "#F1C40F", advice: "Stay focused" },
	tilted: { label: "TILTED", color: "#E67E22", advice: "Take a break" },
	stop:   { label: "STOP",   color: "#E74C3C", advice: "Stop ranked now" },
};

// ── Constants ──

const QUEUE_MAP: Record<string, { key: string; id: number; label: string }> = {
	solo: { key: "RANKED_SOLO_5x5", id: 420, label: "Solo/Duo" },
	flex: { key: "RANKED_FLEX_SR",  id: 440, label: "Flex" },
};


function tierToLp(tier: string, div: string, lp: number): number {
	const tierVals: Record<string, number> = {
		IRON: 0, BRONZE: 400, SILVER: 800, GOLD: 1200,
		PLATINUM: 1600, EMERALD: 2000, DIAMOND: 2400,
		MASTER: 2800, GRANDMASTER: 2900, CHALLENGER: 3000,
	};
	const divVals: Record<string, number> = { IV: 0, III: 100, II: 200, I: 300 };
	const base = tierVals[tier] ?? 0;
	if (base >= 2800) return base + lp;
	return base + (divVals[div] ?? 0) + lp;
}

// ── State ──

interface TiltState {
	sessionStart: number;
	baseline: { tier: string; div: string; lp: number; totalLp: number; wins: number; losses: number } | null;
	lastDisplay: string;
}

type TiltGuardSettings = {
	queue?: string;
};

/**
 * Tilt Guard — monitors your mental state across a ranked session.
 *
 * Tracks loss streaks, LP delta, game count, and KDA trends to detect tilt.
 * Displays a clear signal: Fresh / Warm / Tilted / Stop.
 *
 * Key press / Dial press: Reset session baseline.
 */
@action({ UUID: "com.desstroct.lol-api.tilt-guard" })
export class TiltGuard extends SingletonAction<TiltGuardSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private states = new Map<string, TiltState>();
	private matchCache: { data: MatchEntry[]; fetchedAt: number } | null = null;
	private static readonly MATCH_CACHE_TTL = 2 * 60 * 1000;

	private getState(id: string): TiltState {
		let s = this.states.get(id);
		if (!s) {
			s = { sessionStart: Date.now(), baseline: null, lastDisplay: "" };
			this.states.set(id, s);
		}
		return s;
	}

	override async onWillAppear(ev: WillAppearEvent<TiltGuardSettings>): Promise<void> {
		this.getState(ev.action.id);
		this.startPolling();
		if (ev.action.isDial()) {
			await ev.action.setFeedbackLayout("layouts/tilt-guard.json");
			await ev.action.setFeedback({
				title: "TILT GUARD",
				record_text: "",
				lp_text: "Loading...",
				streak_text: "",
				advice_text: "",
				tilt_bar: { value: 0 },
			});
			return;
		}
		await ev.action.setTitle("Tilt\nGuard");
	}

	override onWillDisappear(ev: WillDisappearEvent<TiltGuardSettings>): void | Promise<void> {
		this.states.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<TiltGuardSettings>): Promise<void> {
		this.resetSession(ev.action.id);
		await ev.action.setTitle("Tilt Guard\nReset!");
		setTimeout(() => this.updateAll().catch(() => {}), 500);
	}

	override async onDialUp(ev: DialUpEvent<TiltGuardSettings>): Promise<void> {
		this.resetSession(ev.action.id);
		await this.updateAll();
	}

	private resetSession(actionId: string): void {
		const state = this.getState(actionId);
		state.baseline = null;
		state.lastDisplay = "";
		state.sessionStart = Date.now();
		this.matchCache = null;
		logger.info(`Session reset`);
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(
			() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)),
			15_000,
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
						title: { value: "TILT GUARD", color: "#555" },
						record_text: "", lp_text: "Offline",
						streak_text: "", advice_text: "",
						tilt_bar: { value: 0, bar_fill_c: "#555" },
					});
				} else {
					await a.setImage("");
					await a.setTitle("Tilt Guard\nOffline");
				}
			}
			return;
		}

		// Read queue setting from first action
		let queueSetting = "solo";
		for (const a of this.actions) {
			const s = (await a.getSettings()) as TiltGuardSettings;
			if (s.queue) queueSetting = s.queue;
			break;
		}
		const queue = QUEUE_MAP[queueSetting] ?? QUEUE_MAP.solo;

		// Fetch ranked stats
		const ranked = await lcuApi.getCurrentRankedStats().catch(() => null);
		if (!ranked) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: "TILT GUARD", lp_text: "No Data", record_text: "", streak_text: "", advice_text: "", tilt_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Tilt Guard\nNo Data");
				}
			}
			return;
		}

		const entry = ranked.queueMap?.[queue.key];
		if (!entry || !entry.tier || entry.tier === "NONE") {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: queue.label, lp_text: "Unranked", record_text: "", streak_text: "", advice_text: "", tilt_bar: { value: 0 } });
				} else {
					await a.setTitle(`${queue.label}\nUnranked`);
				}
			}
			return;
		}

		const matches = await this.fetchRecentMatches();

		for (const a of this.actions) {
			const state = this.getState(a.id);
			const currentLp = tierToLp(entry.tier, entry.division, entry.leaguePoints ?? 0);

			// Capture baseline
			if (!state.baseline) {
				state.baseline = {
					tier: entry.tier, div: entry.division,
					lp: entry.leaguePoints ?? 0, totalLp: currentLp,
					wins: entry.wins ?? 0, losses: entry.losses ?? 0,
				};
				logger.info(`Baseline: ${entry.tier} ${entry.division} ${entry.leaguePoints}LP`);
			}

			// ── Calculate session stats ──
			const sessionWins = (entry.wins ?? 0) - state.baseline.wins;
			const sessionLosses = (entry.losses ?? 0) - state.baseline.losses;
			const totalGames = sessionWins + sessionLosses;
			const lpDelta = currentLp - state.baseline.totalLp;

			// Streak from match history
			const streak = this.calculateStreak(matches, queue.id, state.sessionStart);

			// Session avg KDA
			const avgKda = this.getSessionAvgKda(matches, queue.id, state.sessionStart);

			// ── Calculate tilt score ──
			let tiltScore = 0;

			// Loss streak signal
			if (streak <= -2) tiltScore += 1;
			if (streak <= -3) tiltScore += 2; // cumulative: 3 losses = +3

			// LP delta signal
			if (lpDelta <= -15) tiltScore += 1;
			if (lpDelta <= -30) tiltScore += 1;
			if (lpDelta <= -50) tiltScore += 1;

			// Fatigue signal (many games played)
			if (totalGames >= 5) tiltScore += 1;
			if (totalGames >= 8) tiltScore += 1;

			// KDA signal
			if (avgKda !== null && totalGames >= 2) {
				if (avgKda < 2.0) tiltScore += 1;
				if (avgKda < 1.0) tiltScore += 1;
			}

			// Determine level
			const level = getTiltLevel(tiltScore);
			const config = TILT_CONFIG[level];

			// LP display
			let lpStr: string;
			if (lpDelta > 0) lpStr = `+${lpDelta} LP`;
			else if (lpDelta < 0) lpStr = `${lpDelta} LP`;
			else lpStr = "±0 LP";

			// Streak display
			let streakStr = "";
			if (streak > 0) streakStr = `${streak}W streak`;
			else if (streak < 0) streakStr = `${Math.abs(streak)}L streak`;

			// Record
			const recordStr = totalGames > 0
				? `${sessionWins}W ${sessionLosses}L`
				: "No games yet";

			// Dedup
			const displayKey = `${level}|${lpDelta}|${streak}|${totalGames}|${sessionWins}|${sessionLosses}`;
			if (displayKey === state.lastDisplay) continue;
			state.lastDisplay = displayKey;

			if (a.isDial()) {
				await a.setFeedback({
					title: { value: `${config.label} — ${queue.label}`, color: config.color },
					record_text: recordStr,
					lp_text: { value: lpStr, color: lpDelta >= 0 ? "#2ECC71" : "#E74C3C" },
					streak_text: { value: streakStr, color: streak >= 0 ? "#2ECC71" : "#E74C3C" },
					advice_text: { value: config.advice, color: config.color },
					tilt_bar: {
						value: Math.min(tiltScore, 10),
						bar_fill_c: config.color,
					},
				});
			} else {
				await a.setImage(this.composeTiltKey(level, config, lpStr, streakStr, recordStr, tiltScore));
				await a.setTitle("");
			}
		}
	}

	// ── Match history ──

	private async fetchRecentMatches(): Promise<MatchEntry[]> {
		const now = Date.now();
		if (this.matchCache && (now - this.matchCache.fetchedAt) < TiltGuard.MATCH_CACHE_TTL) {
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
			if (won === firstResult) streak++;
			else break;
		}
		return firstResult ? streak : -streak;
	}

	private getSessionAvgKda(matches: MatchEntry[], queueId: number, sessionStart: number): number | null {
		const sessionMatches = matches.filter(
			(m) => m.queueId === queueId && m.gameCreation >= sessionStart,
		);
		if (sessionMatches.length === 0) return null;

		let totalK = 0, totalD = 0, totalA = 0;
		for (const m of sessionMatches) {
			const p = m.participants?.[0];
			if (!p) continue;
			totalK += p.stats?.kills ?? 0;
			totalD += p.stats?.deaths ?? 0;
			totalA += p.stats?.assists ?? 0;
		}
		if (totalD === 0) return 99;
		return (totalK + totalA) / totalD;
	}

	// ── SVG Key ──

	private composeTiltKey(
		_level: TiltLevel,
		config: { label: string; color: string; advice: string },
		lpStr: string,
		streakStr: string,
		recordStr: string,
		tiltScore: number,
	): string {
		const S = 144;
		const cr = 12;
		const c = config.color;

		// Gauge: vertical bar on the left side
		const gaugeH = Math.round((Math.min(tiltScore, 10) / 10) * 90);
		const gaugeY = 12 + (90 - gaugeH);

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="${cr}" fill="#0A1428"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 2}" fill="none" stroke="${c}" stroke-width="3"/>

			<!-- Gauge background -->
			<rect x="12" y="12" width="14" height="90" rx="4" fill="#1E2328"/>
			<!-- Gauge fill (bottom-up) -->
			<rect x="12" y="${gaugeY}" width="14" height="${gaugeH}" rx="4" fill="${c}"/>

			<!-- Level label -->
			<text x="90" y="28" font-size="14" fill="${c}" text-anchor="middle" font-family="sans-serif" font-weight="700">${config.label}</text>

			<!-- Record -->
			<text x="90" y="48" font-size="11" fill="white" text-anchor="middle" font-family="sans-serif">${escapeXml(recordStr)}</text>

			<!-- LP -->
			<text x="90" y="66" font-size="12" fill="#C89B3C" text-anchor="middle" font-family="sans-serif" font-weight="600">${escapeXml(lpStr)}</text>

			<!-- Streak -->
			<text x="90" y="84" font-size="10" fill="${streakStr.includes("L") ? "#E74C3C" : "#2ECC71"}" text-anchor="middle" font-family="sans-serif">${escapeXml(streakStr || "—")}</text>

			<!-- Advice -->
			<text x="${S / 2}" y="106" font-size="9" fill="${c}" text-anchor="middle" font-family="sans-serif" font-weight="600">${escapeXml(config.advice)}</text>

			<!-- Dots for tilt score -->
			${composeTiltDots(tiltScore, S)}
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}
}

// ── Helpers ──

function getTiltLevel(score: number): TiltLevel {
	if (score <= 1) return "fresh";
	if (score <= 3) return "warm";
	if (score <= 5) return "tilted";
	return "stop";
}

function escapeXml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function composeTiltDots(score: number, S: number): string {
	const max = 10;
	const dotR = 3;
	const spacing = 11;
	const totalW = (max - 1) * spacing;
	const startX = Math.round((S - totalW) / 2);
	const y = 122;

	let dots = "";
	for (let i = 0; i < max; i++) {
		const cx = startX + i * spacing;
		const colors = ["#2ECC71", "#2ECC71", "#F1C40F", "#F1C40F", "#E67E22", "#E67E22", "#E74C3C", "#E74C3C", "#E74C3C", "#E74C3C"];
		if (i < score) {
			dots += `<circle cx="${cx}" cy="${y}" r="${dotR}" fill="${colors[i]}"/>`;
		} else {
			dots += `<circle cx="${cx}" cy="${y}" r="${dotR}" fill="none" stroke="#333" stroke-width="1"/>`;
		}
	}
	return dots;
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
