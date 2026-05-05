import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	KeyDownEvent,
	DialRotateEvent,
	DialUpEvent,
	TouchTapEvent,
	type KeyAction,
	type DialAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { Buffer } from "node:buffer";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";

const logger = streamDeck.logger.createScope("WaveClock");

const GOLD = "#C89B3C";
const DARK_BLUE = "#0A1428";
const GREEN = "#2ECC71";
const BLUE = "#3498DB";
const ORANGE = "#E67E22";
const RED = "#E74C3C";

// Minion spawn at 1:05, every 30s after
const FIRST_SPAWN = 65;
const WAVE_INTERVAL = 30;
// Approximate travel time from base spawn to lane collision point (seconds)
const TRAVEL = { top: 18, mid: 12, bot: 18 } as const;

type Lane = "top" | "mid" | "bot";

interface WaveInfo {
	waveNumber: number;
	isCannon: boolean;
	/** Seconds from now until this wave arrives at the collision point */
	eta: number;
}

/** Cannon interval: every N waves */
function cannonInterval(gameTime: number): number {
	if (gameTime >= 35 * 60) return 1;
	if (gameTime >= 25 * 60) return 2;
	return 3;
}

/**
 * Returns the next `count` wave infos from the current game time.
 */
function getUpcomingWaves(gameTime: number, lane: Lane, count = 3): WaveInfo[] {
	if (gameTime < FIRST_SPAWN) {
		// Pre-game — first wave is special
		const eta = FIRST_SPAWN + TRAVEL[lane] - gameTime;
		return [{ waveNumber: 1, isCannon: false, eta }];
	}

	const travel = TRAVEL[lane];
	const ci = cannonInterval(gameTime);
	const timeSinceSpawn = gameTime - FIRST_SPAWN;
	// Which wave number is currently in transit or just spawned
	const currentWave = Math.floor(timeSinceSpawn / WAVE_INTERVAL) + 1;

	const waves: WaveInfo[] = [];
	let w = currentWave;
	while (waves.length < count) {
		const spawnTime = FIRST_SPAWN + (w - 1) * WAVE_INTERVAL;
		const arrivalTime = spawnTime + travel;
		const eta = arrivalTime - gameTime;
		// Only include waves that haven't arrived yet (eta > -5s grace)
		if (eta > -5) {
			waves.push({ waveNumber: w, isCannon: w % ci === 0, eta });
		}
		w++;
	}
	return waves;
}

/** Advice string based on upcoming cannon and objective state */
function getAdvice(waves: WaveInfo[]): { text: string; color: string } | null {
	const cannon = waves.find((w) => w.isCannon);
	if (!cannon) return null;

	if (cannon.eta <= 0) {
		return { text: "PUSH NOW →", color: GREEN };
	}
	if (cannon.eta <= 10) {
		return { text: "WAIT FOR CANNON", color: ORANGE };
	}
	if (cannon.eta <= 35) {
		return { text: "PUSH + RECALL", color: GREEN };
	}
	if (cannon.eta > 35 && waves[0] && !waves[0].isCannon) {
		return { text: "FREEZE", color: BLUE };
	}
	return null;
}

function fmt(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

@action({ UUID: "com.desstroct.lol-api.wave-clock" })
export class WaveClock extends SingletonAction {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private lane: Lane = "top";

	override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "WAVE CLOCK",
				next_wave: "—",
				wave_bar: { value: 0 },
				upcoming: "",
				advice: "",
			});
		}
		return ev.action.setTitle(`Wave\n${this.lane.toUpperCase()}`);
	}

	override onWillDisappear(_ev: WillDisappearEvent): void | Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	/** Key press / dial press: cycle lane */
	override async onKeyDown(_ev: KeyDownEvent): Promise<void> {
		this.cycleLane();
		await this.updateAll();
	}

	override async onDialUp(_ev: DialUpEvent): Promise<void> {
		this.cycleLane();
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent): Promise<void> {
		const lanes: Lane[] = ["top", "mid", "bot"];
		const idx = lanes.indexOf(this.lane);
		this.lane = lanes[((idx + ev.payload.ticks) % 3 + 3) % 3];
		await this.updateAll();
	}

	override async onTouchTap(_ev: TouchTapEvent): Promise<void> {
		this.cycleLane();
		await this.updateAll();
	}

	private cycleLane(): void {
		this.lane = this.lane === "top" ? "mid" : this.lane === "mid" ? "bot" : "top";
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll: ${e}`));
		this.pollInterval = setInterval(
			() => this.updateAll().catch((e) => logger.error(`updateAll: ${e}`)),
			1000,
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
					await a.setFeedback({ title: "WAVE CLOCK", next_wave: "N/A in TFT", wave_bar: { value: 0 }, upcoming: "", advice: "" });
				} else {
					await a.setTitle("Wave\nN/A");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();

		if (!allData) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ title: `WAVE · ${this.lane.toUpperCase()}`, next_wave: "No game", wave_bar: { value: 0 }, upcoming: "", advice: "" });
				} else {
					await a.setTitle(`Wave\n${this.lane.toUpperCase()}`);
				}
			}
			return;
		}

		// Auto-detect lane from Live Client API
		const activeName = allData.activePlayer.summonerName;
		const me = allData.allPlayers.find(
			(p) => p.riotIdGameName === activeName || p.summonerName === activeName || p.riotId === activeName,
		);
		if (me?.position) {
			const pos = me.position.toLowerCase();
			if (pos === "top") this.lane = "top";
			else if (pos === "jungle" || pos === "middle") this.lane = "mid";
			else if (pos === "bottom" || pos === "utility") this.lane = "bot";
		}

		const gameTime = allData.gameData.gameTime;
		const waves = getUpcomingWaves(gameTime, this.lane);
		const next = waves[0];
		const advice = getAdvice(waves);

		// Progress to next cannon wave (0-100)
		const ci = cannonInterval(gameTime);
		const timeSinceSpawn = Math.max(0, gameTime - FIRST_SPAWN);
		const currentWave = Math.floor(timeSinceSpawn / WAVE_INTERVAL) + 1;
		const lastCannon = Math.floor(currentWave / ci) * ci;
		const nextCannon = lastCannon + ci;
		const lastCannonTime = FIRST_SPAWN + (lastCannon - 1) * WAVE_INTERVAL;
		const nextCannonTime = FIRST_SPAWN + (nextCannon - 1) * WAVE_INTERVAL;
		const cannonProgress = nextCannonTime > lastCannonTime
			? Math.round(((gameTime - lastCannonTime) / (nextCannonTime - lastCannonTime)) * 100)
			: 100;

		const upcomingStr = waves.slice(1).map((w) => `${w.isCannon ? "C" : "R"} ${fmt(w.eta)}`).join("  ");
		const laneLabel = this.lane.toUpperCase();

		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					title: `WAVE · ${laneLabel} · ${fmt(gameTime)}`,
					next_wave: `${next.isCannon ? "Cannon" : "Regular"} in ${fmt(next.eta)}`,
					wave_bar: { value: Math.max(0, Math.min(100, cannonProgress)), bar_fill_c: next.isCannon ? GOLD : BLUE },
					upcoming: upcomingStr,
					advice: advice ? advice.text : "",
				});
			} else {
				const img = this.composeKeyImage(next, advice, cannonProgress);
				if (img) {
					await a.setImage(img);
					await a.setTitle("");
				} else {
					await a.setTitle(`${next.isCannon ? "C" : "R"}\n${fmt(next.eta)}`);
				}
			}
		}
	}

	private composeKeyImage(
		next: WaveInfo,
		advice: { text: string; color: string } | null,
		cannonProgress: number,
	): string | null {
		const S = 144;
		const cx = S / 2;
		const cy = 50;
		const r = 38;
		const strokeW = 7;

		const circumference = 2 * Math.PI * r;
		const dashOffset = circumference * (1 - Math.min(1, cannonProgress / 100));

		const ringColor = next.isCannon ? GOLD : BLUE;
		const etaText = fmt(next.eta);
		const typeLabel = next.isCannon ? "CANNON" : "REGULAR";
		const typeColor = next.isCannon ? GOLD : "#AAA";

		const adviceText = advice ? advice.text : "";
		const adviceColor = advice ? advice.color : "#AAA";
		const laneText = this.lane.toUpperCase();

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="14" fill="${DARK_BLUE}"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="12" fill="none" stroke="${GOLD}" stroke-width="1.5" opacity="0.3"/>

			<!-- Progress ring toward next cannon -->
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#333" stroke-width="${strokeW}"/>
			<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ringColor}" stroke-width="${strokeW}"
				stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
				stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})" opacity="0.9"/>

			<!-- Lane label top-left -->
			<text x="8" y="14" font-size="11" fill="${GOLD}" font-weight="600" font-family="sans-serif">${laneText}</text>

			<!-- ETA countdown inside ring -->
			<text x="${cx}" y="${cy - 4}" font-size="22" fill="#FFF" text-anchor="middle" font-weight="700" font-family="sans-serif">${etaText}</text>
			<!-- Wave type below ETA -->
			<text x="${cx}" y="${cy + 14}" font-size="10" fill="${typeColor}" text-anchor="middle" font-weight="600" font-family="sans-serif">${typeLabel}</text>

			<!-- Advice at bottom -->
			${adviceText
				? `<text x="${cx}" y="${cy + r + 22}" font-size="12" fill="${adviceColor}" text-anchor="middle" font-weight="700" font-family="sans-serif">${adviceText}</text>`
				: `<text x="${cx}" y="${cy + r + 22}" font-size="11" fill="#666" text-anchor="middle" font-family="sans-serif">Wave ${next.waveNumber}</text>`}
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}
}
