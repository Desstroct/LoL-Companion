import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	type KeyAction,
	type DialAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { Buffer } from "node:buffer";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";

const logger = streamDeck.logger.createScope("CsTracker");

const GOLD = "#C89B3C";
const DARK_BLUE = "#0A1428";
const GREEN = "#2ECC71";
const RED = "#E74C3C";
const ORANGE = "#E67E22";
const YELLOW = "#F1C40F";

/** Approximate gold value per CS (lane minion average across game phases) */
const GOLD_PER_CS = 20;

type Verdict = "ahead" | "slight_lead" | "even" | "slight_deficit" | "behind";

function getVerdict(delta: number): Verdict {
	if (delta >= 15) return "ahead";
	if (delta >= 7)  return "slight_lead";
	if (delta >= -6) return "even";
	if (delta >= -14) return "slight_deficit";
	return "behind";
}

function verdictColor(v: Verdict): string {
	if (v === "ahead")          return GREEN;
	if (v === "slight_lead")    return "#7DCEA0";
	if (v === "even")           return "#FFFFFF";
	if (v === "slight_deficit") return ORANGE;
	return RED;
}

function verdictLabel(v: Verdict): string {
	if (v === "ahead")          return "AHEAD";
	if (v === "slight_lead")    return "LEADING";
	if (v === "even")           return "EVEN";
	if (v === "slight_deficit") return "DEFICIT";
	return "BEHIND";
}

/** Bar value 0-100 centered at 50 (50 = even) */
function csBar(myCs: number, enemyCs: number): number {
	const total = myCs + enemyCs;
	if (total === 0) return 50;
	return Math.round((myCs / total) * 100);
}

function fmt(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

@action({ UUID: "com.desstroct.lol-api.cs-tracker" })
export class CsTracker extends SingletonAction {
	private pollInterval: ReturnType<typeof setInterval> | null = null;

	override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "CS TRACKER",
				cs_line: "—",
				delta_text: "",
				cs_bar: { value: 50 },
				info_text: "Waiting for game...",
			});
		}
		return ev.action.setTitle("CS\nTracker");
	}

	override onWillDisappear(_ev: WillDisappearEvent): void | Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll: ${e}`));
		this.pollInterval = setInterval(
			() => this.updateAll().catch((e) => logger.error(`updateAll: ${e}`)),
			3000,
		);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: "CS TRACKER", cs_line: "N/A in TFT", delta_text: "", cs_bar: { value: 50 }, info_text: "" });
				} else {
					await a.setTitle("CS\nN/A");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();

		if (!allData) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: "CS TRACKER", cs_line: "No game", delta_text: "", cs_bar: { value: 50 }, info_text: "" });
				} else {
					await a.setImage("");
					await a.setTitle("CS\nNo game");
				}
			}
			return;
		}

		const activeName = allData.activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) => p.riotIdGameName === activeName || p.summonerName === activeName || p.riotId === activeName,
		);
		if (!me) return;

		const myCs = me.scores.minionsKilled + me.scores.neutralMinionsKilled;
		const myPosition = me.position; // "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"
		const gameTime = allData.gameData.gameTime;

		// Find enemy in same position
		const enemy = allData.allPlayers.find(
			(p) => p.team !== me.team && p.position === myPosition && myPosition !== "",
		);

		if (!enemy) {
			// Position not assigned yet (loading screen / very early game)
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						title: `CS · ${fmt(gameTime)}`,
						cs_line: `You: ${myCs} CS`,
						delta_text: "Finding laner...",
						cs_bar: { value: 50 },
						info_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle(`CS: ${myCs}\n—`);
				}
			}
			return;
		}

		const enemyCs = enemy.scores.minionsKilled + enemy.scores.neutralMinionsKilled;
		const delta = myCs - enemyCs;
		const goldDiff = Math.abs(delta) * GOLD_PER_CS;
		const verdict = getVerdict(delta);
		const color = verdictColor(verdict);
		const label = verdictLabel(verdict);
		const bar = csBar(myCs, enemyCs);

		const deltaSign = delta > 0 ? "+" : "";
		const deltaStr = `${deltaSign}${delta} CS (${delta > 0 ? "+" : delta < 0 ? "-" : ""}${goldDiff}g)`;
		const posLabel = myPosition ? myPosition.charAt(0) + myPosition.slice(1).toLowerCase() : "?";

		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					title: `CS · ${posLabel} · ${fmt(gameTime)}`,
					cs_line: `${myCs} vs ${enemyCs}  (${enemy.championName})`,
					delta_text: `${label}  ${deltaStr}`,
					cs_bar: { value: bar, bar_fill_c: color },
					info_text: `~${goldDiff}g ${delta >= 0 ? "lead" : "deficit"} on ${enemy.championName}`,
				});
			} else {
				const img = this.composeKeyImage(myCs, enemyCs, delta, verdict, color, posLabel);
				if (img) {
					await a.setImage(img);
					await a.setTitle("");
				} else {
					await a.setTitle(`${myCs} / ${enemyCs}\n${deltaSign}${delta}`);
				}
			}
		}
	}

	private composeKeyImage(
		myCs: number,
		enemyCs: number,
		delta: number,
		verdict: Verdict,
		color: string,
		posLabel: string,
	): string | null {
		const S = 144;
		const cx = S / 2;

		const deltaSign = delta > 0 ? "+" : "";
		const deltaText = `${deltaSign}${delta}`;
		const goldDiff = Math.abs(delta) * GOLD_PER_CS;
		const goldText = delta === 0 ? "even" : `${delta > 0 ? "+" : "-"}${goldDiff}g`;

		// Bar dimensions
		const barY = 100;
		const barH = 10;
		const barW = S - 16;
		const barX = 8;
		const filledW = Math.round((csBar(myCs, enemyCs) / 100) * barW);

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="14" fill="${DARK_BLUE}"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="12" fill="none" stroke="${GOLD}" stroke-width="1.5" opacity="0.3"/>

			<!-- Position label top-left -->
			<text x="8" y="16" font-size="11" fill="${GOLD}" font-weight="600" font-family="sans-serif">${posLabel}</text>

			<!-- Delta (big center) -->
			<text x="${cx}" y="56" font-size="38" fill="${color}" text-anchor="middle" font-weight="800" font-family="sans-serif">${deltaText}</text>

			<!-- CS label below delta -->
			<text x="${cx}" y="72" font-size="11" fill="#888" text-anchor="middle" font-family="sans-serif">CS diff</text>

			<!-- my CS / enemy CS -->
			<text x="${cx}" y="90" font-size="14" fill="#DDD" text-anchor="middle" font-weight="600" font-family="sans-serif">${myCs} / ${enemyCs}</text>

			<!-- Gold bar background -->
			<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="5" fill="${RED}" opacity="0.6"/>
			<!-- Gold bar fill (mine) -->
			<rect x="${barX}" y="${barY}" width="${filledW}" height="${barH}" rx="5" fill="${GREEN}" opacity="0.85"/>

			<!-- Gold diff at bottom -->
			<text x="${cx}" y="128" font-size="12" fill="${color}" text-anchor="middle" font-weight="700" font-family="sans-serif">${goldText}</text>
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}
}
