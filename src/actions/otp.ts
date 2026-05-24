import {
	action,
	DialRotateEvent,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { championStats, ChampionStats } from "../services/champion-stats";
import type { MatchupData } from "../services/champion-stats";
import { findEnemyLaner } from "../services/champ-select-utils";
import { getChampionIcon } from "../services/lol-icons";
import type { GameflowPhase } from "../types/lol";

const logger = streamDeck.logger.createScope("OTP");

/**
 * OTP (One Trick Pony) action — provides ban suggestions and matchup info
 * for a player's main champion.
 *
 * Settings: champion name + lane
 *
 * Phases:
 * - Idle: shows OTP champion icon + overall WR/games from Lolalytics
 * - Ban phase: shows BEST BAN (strongest counter to your OTP)
 * - Champ Select (enemy visible): shows matchup WR vs enemy laner
 * - In Game: shows matchup info if enemy was detected
 *
 * Key press: cycles through top bans
 * Dial rotate: scrolls through ban suggestions / matchup list
 */
@action({ UUID: "com.desstroct.lol-api.otp" })
export class OTP extends SingletonAction<OtpSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;

	/** Cached counter data for the OTP champion */
	private counters: MatchupData[] = [];
	private countersFetchedFor = ""; // "alias:lane" key
	private countersFetchFailed = 0;

	/** Current state tracking */
	private lastPhase: GameflowPhase | "__disconnected" = "None";
	private lastRenderedKey = "";

	/** Detected enemy laner during champ select */
	private enemyAlias = "";
	private enemyName = "";

	/** Dial/key browse index for scrolling through bans */
	private browseIndex = 0;

	/** How many bans to display */
	private readonly MAX_BANS = 5;

	override onWillAppear(ev: WillAppearEvent<OtpSettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "OTP",
				champ_name: "Setup...",
				info_text: "Set champion in settings",
				matchup_bar: { value: 50 },
				status_text: "",
			});
		}
		return ev.action.setTitle("OTP\nSetup...");
	}

	override onWillDisappear(_ev: WillDisappearEvent<OtpSettings>): void | Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	override onKeyDown(_ev: KeyDownEvent<OtpSettings>): void | Promise<void> {
		// Cycle through ban suggestions
		if (this.counters.length > 0) {
			this.browseIndex = (this.browseIndex + 1) % Math.min(this.counters.length, this.MAX_BANS);
			this.updateState().catch((e) => logger.error(`updateState error: ${e}`));
		}
	}

	override onDialRotate(ev: DialRotateEvent<OtpSettings>): void | Promise<void> {
		const max = Math.min(this.counters.length, this.MAX_BANS);
		if (max === 0) return;

		this.browseIndex += ev.payload.ticks > 0 ? 1 : -1;
		if (this.browseIndex >= max) this.browseIndex = 0;
		if (this.browseIndex < 0) this.browseIndex = max - 1;

		this.updateState().catch((e) => logger.error(`updateState error: ${e}`));
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateState().catch((e) => logger.error(`updateState error: ${e}`));
		this.pollInterval = setInterval(() => this.updateState().catch((e) => logger.error(`updateState error: ${e}`)), 3000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateState(): Promise<void> {
		// ── Read settings from first visible action ──
		let settings: OtpSettings | undefined;
		for (const a of this.actions) {
			settings = await a.getSettings() as OtpSettings;
			break;
		}
		const champName = settings?.champion?.trim();
		const lane = settings?.lane || "top";

		if (!champName) {
			await this.renderNoConfig();
			return;
		}

		if (!dataDragon.isReady()) return;

		// Resolve champion from settings
		const champ = dataDragon.getChampionByName(champName);
		if (!champ) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ champ_name: "Unknown", info_text: `"${champName}" not found`, status_text: "" });
				} else {
					await a.setTitle(`OTP\n"${champName}"?`);
				}
			}
			return;
		}

		const alias = ChampionStats.toLolalytics(champ.id);
		const lolLane = ChampionStats.toLolalyticsLane(lane);

		// ── Fetch counters if not loaded ──
		const fetchKey = `${alias}:${lolLane}`;
		if (fetchKey !== this.countersFetchedFor && Date.now() > this.countersFetchFailed) {
			try {
				this.counters = await championStats.getCounters(alias, lolLane);
				this.countersFetchedFor = fetchKey;
				this.browseIndex = 0;
				logger.info(`Loaded ${this.counters.length} counters for ${alias} ${lolLane}`);
			} catch (e) {
				logger.error(`Failed to fetch counters: ${e}`);
				this.countersFetchFailed = Date.now() + 30_000;
			}
		}

		// ── Disconnected ──
		if (!lcuConnector.isConnected()) {
			await this.renderIdle(champ, alias, "offline");
			this.lastPhase = "__disconnected";
			return;
		}

		if (gameMode.isTFT()) {
			await this.renderIdle(champ, alias, "tft");
			return;
		}

		const phase = await lcuApi.getGameflowPhase();

		// ── Champ Select: detect enemy + show matchup or ban ──
		if (phase === "ChampSelect") {
			const session = await lcuApi.getChampSelectSession();
			if (!session) {
				await this.renderBanSuggestion(champ, alias);
				this.lastPhase = phase;
				return;
			}

			// Detect current phase: ban or pick
			const localCell = session.localPlayerCellId;
			const isBanPhase = session.actions.flat().some(
				(act) => act.actorCellId === localCell && act.type === "ban" && !act.completed,
			);

			// Try to find enemy laner
			const myPos = session.myTeam.find((p) => p.cellId === localCell)?.assignedPosition ?? lane;
			const enemy = findEnemyLaner(session, myPos, true);

			if (enemy) {
				this.enemyAlias = enemy.alias;
				this.enemyName = enemy.name;
			}

			if (isBanPhase || !enemy) {
				// Ban phase or no enemy visible yet → show ban suggestion
				await this.renderBanSuggestion(champ, alias);
			} else {
				// Enemy visible → show matchup
				await this.renderMatchup(champ, alias, enemy.alias, enemy.name);
			}

			this.lastPhase = phase;
			return;
		}

		// ── In Game: show matchup if we detected enemy ──
		if (phase === "InProgress" || phase === "GameStart") {
			if (this.enemyAlias) {
				await this.renderMatchup(champ, alias, this.enemyAlias, this.enemyName);
			} else {
				await this.renderIdle(champ, alias, "ingame");
			}
			this.lastPhase = phase;
			return;
		}

		// ── Lobby / None: show idle with ban preview ──
		if (phase !== this.lastPhase) {
			this.enemyAlias = "";
			this.enemyName = "";
		}
		await this.renderIdle(champ, alias, phase === "Lobby" ? "lobby" : "idle");
		this.lastPhase = phase;
	}

	// ════════════════════════════════════════════════════════
	//  Renderers
	// ════════════════════════════════════════════════════════

	private async renderNoConfig(): Promise<void> {
		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					champ_icon: "",
					title: "OTP",
					champ_name: "No champion",
					info_text: "Set in settings",
					matchup_bar: { value: 50, bar_fill_c: "#555555" },
					status_text: "",
				});
			} else {
				await a.setImage("");
				await a.setTitle("OTP\nSetup...");
			}
		}
	}

	/**
	 * Idle view: OTP icon + top ban suggestion preview
	 */
	private async renderIdle(
		champ: { id: string; name: string; key: string },
		alias: string,
		context: "idle" | "lobby" | "offline" | "tft" | "ingame",
	): Promise<void> {
		const renderKey = `idle:${alias}:${context}:${this.browseIndex}`;
		if (renderKey === this.lastRenderedKey) return;
		this.lastRenderedKey = renderKey;

		const icon = await getChampionIcon(alias);
		const topBan = this.counters[this.browseIndex];

		let statusLabel: string;
		switch (context) {
			case "offline": statusLabel = "Offline"; break;
			case "tft": statusLabel = "N/A TFT"; break;
			case "lobby": statusLabel = "Lobby"; break;
			case "ingame": statusLabel = "In Game"; break;
			default: statusLabel = "Ready"; break;
		}

		for (const a of this.actions) {
			if (a.isDial()) {
				const banInfo = topBan
					? `Ban: ${topBan.name} (${topBan.winRateVs.toFixed(1)}%)`
					: "Loading bans...";
				await a.setFeedback({
					champ_icon: icon ?? "",
					title: `OTP · ${statusLabel}`,
					champ_name: champ.name,
					info_text: banInfo,
					matchup_bar: {
						value: topBan ? Math.round(topBan.winRateVs) : 50,
						bar_fill_c: "#555555",
					},
					status_text: topBan ? `#${this.browseIndex + 1} ban` : "",
				});
			} else {
				if (topBan && (context === "idle" || context === "lobby")) {
					await a.setImage(
						await this.composeBanKey(icon, champ.name, topBan, this.browseIndex),
					);
					await a.setTitle("");
				} else {
					await a.setImage(
						await this.composeIdleKey(icon, champ.name, statusLabel),
					);
					await a.setTitle("");
				}
			}
		}
	}

	/**
	 * Ban phase: highlight the best ban with red styling
	 */
	private async renderBanSuggestion(
		champ: { id: string; name: string; key: string },
		_alias: string,
	): Promise<void> {
		const topBan = this.counters[this.browseIndex];
		if (!topBan) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						title: "OTP · BAN",
						champ_name: "No data",
						info_text: "Counter data unavailable",
						matchup_bar: { value: 50, bar_fill_c: "#555555" },
						status_text: "",
					});
				} else {
					await a.setTitle("OTP\nNo data");
				}
			}
			return;
		}

		const banIcon = await getChampionIcon(topBan.alias);

		const renderKey = `ban:${topBan.alias}:${this.browseIndex}`;
		if (renderKey === this.lastRenderedKey) return;
		this.lastRenderedKey = renderKey;

		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					champ_icon: banIcon ?? "",
					title: { value: "BAN THIS", color: "#E74C3C" },
					champ_name: topBan.name,
					info_text: `${champ.name} has ${topBan.winRateVs.toFixed(1)}% WR vs`,
					matchup_bar: {
						value: Math.round(100 - topBan.winRateVs),
						bar_fill_c: getMatchupColor(topBan.winRateVs),
					},
					status_text: `#${this.browseIndex + 1}/${Math.min(this.counters.length, this.MAX_BANS)}`,
				});
			} else {
				await a.setImage(
					await this.composeBanKey(banIcon, champ.name, topBan, this.browseIndex),
				);
				await a.setTitle("");
			}
		}
	}

	/**
	 * Matchup view: show WR against specific enemy laner
	 */
	private async renderMatchup(
		champ: { id: string; name: string; key: string },
		alias: string,
		enemyAlias: string,
		enemyName: string,
	): Promise<void> {
		const renderKey = `matchup:${alias}:${enemyAlias}`;
		if (renderKey === this.lastRenderedKey) return;
		this.lastRenderedKey = renderKey;

		// Find the matchup data for the specific enemy
		const matchup = this.counters.find((c) => c.alias === enemyAlias);
		const enemyIcon = await getChampionIcon(enemyAlias);

		const wr = matchup ? matchup.winRateVs : null;
		const wrDisplay = wr !== null ? `${wr.toFixed(1)}%` : "?";
		const verdict = wr !== null ? getMatchupVerdict(wr) : "Unknown";

		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					champ_icon: enemyIcon ?? "",
					title: { value: `vs ${enemyName}`, color: wr !== null ? getMatchupColor(wr) : "#AAAAAA" },
					champ_name: `${champ.name}: ${wrDisplay}`,
					info_text: verdict,
					matchup_bar: {
						value: wr !== null ? Math.round(wr) : 50,
						bar_fill_c: wr !== null ? getMatchupColor(wr) : "#555555",
					},
					status_text: matchup ? `${matchup.games} games` : "",
				});
			} else {
				await a.setImage(
					this.composeMatchupKey(enemyIcon, champ.name, enemyName, wr, verdict),
				);
				await a.setTitle("");
			}
		}
	}

	// ════════════════════════════════════════════════════════
	//  SVG Key Composers
	// ════════════════════════════════════════════════════════

	private async composeIdleKey(
		icon: string | null,
		champName: string,
		statusLabel: string,
	): Promise<string> {
		const S = 144;
		const cr = 12;
		const GOLD = "#C89B3C";
		const iconSvg = icon
			? `<clipPath id="ci"><rect x="22" y="10" width="100" height="100" rx="8"/></clipPath>
			   <image href="${icon}" x="22" y="10" width="100" height="100" clip-path="url(#ci)"/>`
			: `<rect x="22" y="10" width="100" height="100" rx="8" fill="#1a2a3a"/>`;

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="${cr}" fill="#0A1428"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 2}" fill="none" stroke="${GOLD}" stroke-width="2"/>
			${iconSvg}
			<text x="${S / 2}" y="126" font-size="11" fill="white" text-anchor="middle" font-family="sans-serif" font-weight="600">${escapeXml(champName)}</text>
			<text x="${S / 2}" y="140" font-size="9" fill="#888888" text-anchor="middle" font-family="sans-serif">${escapeXml(statusLabel)}</text>
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}

	private async composeBanKey(
		banIcon: string | null,
		otpName: string,
		ban: MatchupData,
		index: number,
	): Promise<string> {
		const S = 144;
		const cr = 12;
		const RED = "#E74C3C";
		const wrColor = getMatchupColor(ban.winRateVs);

		const iconSvg = banIcon
			? `<clipPath id="bi"><rect x="22" y="8" width="80" height="80" rx="8"/></clipPath>
			   <image href="${banIcon}" x="22" y="8" width="80" height="80" clip-path="url(#bi)"/>`
			: `<rect x="22" y="8" width="80" height="80" rx="8" fill="#1a2a3a"/>`;

		// Red cross overlay on the ban icon
		const crossSvg = `
			<line x1="28" y1="14" x2="96" y2="82" stroke="${RED}" stroke-width="4" stroke-opacity="0.7"/>
			<line x1="96" y1="14" x2="28" y2="82" stroke="${RED}" stroke-width="4" stroke-opacity="0.7"/>`;

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="${cr}" fill="#0A1428"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 2}" fill="none" stroke="${RED}" stroke-width="3"/>
			${iconSvg}
			${crossSvg}
			<text x="${S / 2}" y="104" font-size="10" fill="${RED}" text-anchor="middle" font-family="sans-serif" font-weight="700">BAN #${index + 1}</text>
			<text x="${S / 2}" y="118" font-size="12" fill="white" text-anchor="middle" font-family="sans-serif" font-weight="600">${escapeXml(ban.name)}</text>
			<text x="${S / 2}" y="134" font-size="10" fill="${wrColor}" text-anchor="middle" font-family="sans-serif">${otpName}: ${ban.winRateVs.toFixed(1)}% WR</text>
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}

	private composeMatchupKey(
		enemyIcon: string | null,
		_otpName: string,
		enemyName: string,
		wr: number | null,
		verdict: string,
	): string {
		const S = 144;
		const cr = 12;
		const wrColor = wr !== null ? getMatchupColor(wr) : "#888888";

		const iconSvg = enemyIcon
			? `<clipPath id="ei"><rect x="22" y="6" width="80" height="80" rx="8"/></clipPath>
			   <image href="${enemyIcon}" x="22" y="6" width="80" height="80" clip-path="url(#ei)"/>`
			: `<rect x="22" y="6" width="80" height="80" rx="8" fill="#1a2a3a"/>`;

		const wrText = wr !== null ? `${wr.toFixed(1)}%` : "?";

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="${cr}" fill="#0A1428"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 2}" fill="none" stroke="${wrColor}" stroke-width="3"/>
			${iconSvg}
			<text x="${S / 2}" y="102" font-size="10" fill="#AAAAAA" text-anchor="middle" font-family="sans-serif">vs ${escapeXml(enemyName)}</text>
			<text x="${S / 2}" y="118" font-size="14" fill="${wrColor}" text-anchor="middle" font-family="sans-serif" font-weight="700">${wrText}</text>
			<text x="${S / 2}" y="134" font-size="10" fill="${wrColor}" text-anchor="middle" font-family="sans-serif">${escapeXml(verdict)}</text>
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}
}

// ── Helpers ──

function escapeXml(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Get a color based on your champion's WR in the matchup.
 * Lower WR = worse for you (red), higher = better (green).
 */
function getMatchupColor(wr: number): string {
	if (wr >= 52) return "#2ECC71"; // Favorable
	if (wr >= 48) return "#F1C40F"; // Skill matchup
	return "#E74C3C";                // Unfavorable
}

/**
 * Human-readable matchup verdict.
 */
function getMatchupVerdict(wr: number): string {
	if (wr >= 54) return "Easy matchup";
	if (wr >= 52) return "Favorable";
	if (wr >= 48) return "Skill matchup";
	if (wr >= 46) return "Unfavorable";
	return "Hard counter";
}

type OtpSettings = {
	champion?: string;
	lane?: string;
};
