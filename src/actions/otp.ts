import {
	action,
	type KeyAction,
	type DialAction,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	KeyDownEvent,
	DialRotateEvent,
	DialUpEvent,
	TouchTapEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { Buffer } from "node:buffer";
import type { JsonObject } from "@elgato/utils";
import { dataDragon } from "../services/data-dragon";
import { getChampionIcon } from "../services/lol-icons";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { ChampionStats } from "../services/champion-stats";

const logger = streamDeck.logger.createScope("OTP");

const GOLD = "#C89B3C";
const GREEN = "#27AE60";
const DARK_BLUE = "#0A1428";

/** Cache of composed key images: "{alias}:{0|1}" → data URI */
const champKeyCache = new Map<string, string>();

/**
 * Compose a champion portrait as an SVG key image.
 * When active=true the border turns green to indicate this champion is being picked.
 */
function composeChampKey(alias: string, iconDataUri: string | null, active: boolean): string | null {
	if (!iconDataUri) return null;
	const cacheKey = `${alias}:${active ? 1 : 0}`;
	if (champKeyCache.has(cacheKey)) return champKeyCache.get(cacheKey)!;

	const S = 144;
	const br = 3;
	const cr = 14;
	const borderColor = active ? GREEN : GOLD;
	const glowColor = active ? GREEN : GOLD;
	const glowOpacity = active ? "0.30" : "0.15";

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
		<defs>
			<radialGradient id="g" cx="50%" cy="50%" r="50%">
				<stop offset="0%" stop-color="${glowColor}" stop-opacity="${glowOpacity}"/>
				<stop offset="100%" stop-color="${glowColor}" stop-opacity="0"/>
			</radialGradient>
			<clipPath id="clip"><rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="${cr - 2}"/></clipPath>
		</defs>
		<rect width="${S}" height="${S}" rx="${cr}" fill="${DARK_BLUE}"/>
		<circle cx="72" cy="72" r="60" fill="url(#g)"/>
		<image href="${iconDataUri}" x="4" y="4" width="${S - 8}" height="${S - 8}" clip-path="url(#clip)" preserveAspectRatio="xMidYMid slice"/>
		<rect x="${br}" y="${br}" width="${S - br * 2}" height="${S - br * 2}" rx="${cr - br}" stroke="${borderColor}" stroke-width="${br}" fill="none"/>
	</svg>`;

	const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	champKeyCache.set(cacheKey, dataUri);
	return dataUri;
}

/**
 * OTP (One-Trick Pony) action — stores a list of main champions with
 * per-champion overrides (preferred lane, auto-rune, auto-spell) that other
 * actions (AutoRune, SmartPick, BestItem) consult to customize their behavior.
 *
 * Key:   press to cycle through saved champions
 * Dial:  rotate to browse, press/touch to jump to the active champion
 */
@action({ UUID: "com.desstroct.lol-api.otp" })
export class OTP extends SingletonAction<OTPSettings> {
	private otpChampions = new Map<string, OTPChampionConfig>();
	private selectedIndex = 0;
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Lolalytics alias of the champion currently being picked in champion select */
	private activeAlias: string | null = null;

	constructor() {
		super();
		// Live updates from the PI (setGlobalSettings triggers this)
		streamDeck.settings.onDidReceiveGlobalSettings<OTPSettings>((ev) => {
			const champs = ev.settings?.otpChampions;
			this.otpChampions = champs ? new Map(Object.entries(champs)) : new Map();
			champKeyCache.clear();
			this.renderCurrent().catch(() => {});
		});
	}

	override async onWillAppear(ev: WillAppearEvent<OTPSettings>): Promise<void> {
		try {
			const settings = await streamDeck.settings.getGlobalSettings<OTPSettings>();
			if (settings?.otpChampions) {
				this.otpChampions = new Map(Object.entries(settings.otpChampions));
			}
		} catch {}
		this.startPolling();
		await this.renderAction(ev.action);
	}

	override async onWillDisappear(_ev: WillDisappearEvent<OTPSettings>): Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(_ev: KeyDownEvent<OTPSettings>): Promise<void> {
		const champions = this.getChampionList();
		if (champions.length === 0) return;
		this.selectedIndex = (this.selectedIndex + 1) % champions.length;
		await this.renderCurrent();
	}

	override async onDialRotate(ev: DialRotateEvent<OTPSettings>): Promise<void> {
		const champions = this.getChampionList();
		if (champions.length === 0) return;
		const delta = ev.payload.ticks > 0 ? 1 : -1;
		this.selectedIndex = ((this.selectedIndex + delta) + champions.length * 100) % champions.length;
		await this.renderCurrent();
	}

	/** Dial press: jump to active champion (or cycle if none active) */
	override async onDialUp(_ev: DialUpEvent<OTPSettings>): Promise<void> {
		if (this.activeAlias) {
			const idx = this.getChampionList().indexOf(this.activeAlias);
			if (idx >= 0) {
				this.selectedIndex = idx;
				await this.renderCurrent();
				return;
			}
		}
		const champions = this.getChampionList();
		if (champions.length === 0) return;
		this.selectedIndex = (this.selectedIndex + 1) % champions.length;
		await this.renderCurrent();
	}

	/** Touch: jump to active champion */
	override async onTouchTap(_ev: TouchTapEvent<OTPSettings>): Promise<void> {
		if (this.activeAlias) {
			const idx = this.getChampionList().indexOf(this.activeAlias);
			if (idx >= 0) this.selectedIndex = idx;
		}
		await this.renderCurrent();
	}

	private getChampionList(): string[] {
		return Array.from(this.otpChampions.keys());
	}

	private async saveToSettings(): Promise<void> {
		try {
			const championsObj = Object.fromEntries(this.otpChampions);
			await streamDeck.settings.setGlobalSettings({ otpChampions: championsObj });
		} catch (e) {
			logger.warn(`Failed to save OTP settings: ${e}`);
		}
	}

	// ──────────────── LCU polling ────────────────

	private startPolling(): void {
		if (this.pollInterval) return;
		this.pollActive().catch(() => {});
		this.pollInterval = setInterval(() => this.pollActive().catch(() => {}), 3000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async pollActive(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			if (this.activeAlias !== null) {
				this.activeAlias = null;
				await this.renderCurrent();
			}
			return;
		}

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			if (this.activeAlias !== null) {
				this.activeAlias = null;
				await this.renderCurrent();
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const me = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
		if (!me || me.championId <= 0) {
			if (this.activeAlias !== null) {
				this.activeAlias = null;
				await this.renderCurrent();
			}
			return;
		}

		const champ = dataDragon.getChampionByKey(String(me.championId));
		if (!champ) return;

		const alias = ChampionStats.toLolalytics(champ.id);
		if (alias === this.activeAlias) return;

		this.activeAlias = alias;
		logger.info(`OTP: active champion = ${champ.name} (${alias})`);

		// Auto-scroll to the active champion if it's in the OTP list
		const idx = this.getChampionList().indexOf(alias);
		if (idx >= 0) this.selectedIndex = idx;

		await this.renderCurrent();
	}

	// ──────────────── Rendering ────────────────

	/** Render the current OTP state onto a single action instance. */
	private async renderAction(a: KeyAction<OTPSettings> | DialAction<OTPSettings>): Promise<void> {
		const champions = this.getChampionList();

		if (champions.length === 0) {
			if (a.isDial()) {
				await a.setFeedback({ champ_icon: "", title: "OTP", champion: "No champions", info: "Add via settings", status: "" });
			} else {
				await a.setImage(""); await a.setTitle("OTP\nAdd champ");
			}
			return;
		}

		if (this.selectedIndex >= champions.length) this.selectedIndex = champions.length - 1;

		const alias = champions[this.selectedIndex];
		const config = this.otpChampions.get(alias);
		if (!config) return;

		const champName = config.name ?? alias;
		const icon = await getChampionIcon(alias);
		const isActive = this.activeAlias === alias;

		const laneLabel = (config.preferredLane && config.preferredLane !== "auto")
			? config.preferredLane.charAt(0).toUpperCase() + config.preferredLane.slice(1)
			: "Any lane";
		const features: string[] = [];
		if (config.autoRune !== false) features.push("Rune");
		if (config.autoSpell !== false) features.push("Spell");
		const infoStr = `${laneLabel} · ${features.length > 0 ? features.join("+") : "No auto"}`;
		const countStr = `${this.selectedIndex + 1}/${champions.length}`;

		if (a.isDial()) {
			await a.setFeedback({
				champ_icon: icon ?? "",
				title: `OTP · ${countStr}`,
				champion: champName,
				info: infoStr,
				status: isActive ? "ACTIVE" : "",
			});
		} else {
			const composedImg = composeChampKey(alias, icon, isActive);
			if (composedImg) await a.setImage(composedImg);
			else if (icon) await a.setImage(icon);
			await a.setTitle(isActive ? `${champName}\nACTIVE` : champName);
		}
	}

	/** Re-render all visible instances. */
	private async renderCurrent(): Promise<void> {
		for (const a of this.actions) {
			await this.renderAction(a);
		}
	}

	// ──────────────── Public API ────────────────

	/**
	 * Get the OTP config for a specific champion by its Lolalytics alias.
	 * Called by AutoRune, SmartPick, BestItem to check per-champion overrides.
	 * Returns null if this champion is not in the OTP list.
	 */
	getOTPForChampion(alias: string): OTPChampionConfig | null {
		return this.otpChampions.get(alias) ?? null;
	}

	/**
	 * Get all saved OTP champions (alias → config).
	 */
	getAllOTP(): Map<string, OTPChampionConfig> {
		return new Map(this.otpChampions);
	}

	/**
	 * @deprecated Use getOTPForChampion(alias) to look up the active champion directly.
	 */
	getCurrentOTP(): { alias: string; config: OTPChampionConfig } | null {
		const champions = this.getChampionList();
		if (champions.length === 0) return null;
		const alias = champions[this.selectedIndex];
		const config = this.otpChampions.get(alias);
		return config ? { alias, config } : null;
	}

	async addChampion(alias: string, config?: Partial<OTPChampionConfig>): Promise<void> {
		const champ = dataDragon.getChampionByName(alias);
		if (!champ) {
			logger.warn(`Unknown champion: ${alias}`);
			return;
		}
		const key = ChampionStats.toLolalytics(champ.id);
		this.otpChampions.set(key, {
			enabled: true,
			autoRune: config?.autoRune ?? true,
			autoItem: config?.autoItem ?? true,
			autoSpell: config?.autoSpell ?? true,
			counterMode: config?.counterMode ?? true,
			bestMode: config?.bestMode ?? true,
			preferredLane: config?.preferredLane ?? "auto",
			name: champ.name,
			ddId: champ.id,
		});
		this.selectedIndex = this.getChampionList().indexOf(key);
		champKeyCache.clear();
		await this.renderCurrent();
		await this.saveToSettings();
		logger.info(`Added OTP champion: ${champ.name}`);
	}

	async removeChampion(alias: string): Promise<void> {
		this.otpChampions.delete(alias);
		const champions = this.getChampionList();
		if (this.selectedIndex >= champions.length) {
			this.selectedIndex = Math.max(0, champions.length - 1);
		}
		champKeyCache.clear();
		await this.renderCurrent();
		await this.saveToSettings();
	}

	async updateChampionConfig(alias: string, config: Partial<OTPChampionConfig>): Promise<void> {
		const existing = this.otpChampions.get(alias);
		if (existing) {
			this.otpChampions.set(alias, { ...existing, ...config });
			champKeyCache.clear();
			await this.renderCurrent();
			await this.saveToSettings();
		}
	}
}

export interface OTPChampionConfig extends JsonObject {
	enabled: boolean;
	autoRune: boolean;
	autoItem: boolean;
	autoSpell: boolean;
	counterMode: boolean;
	bestMode: boolean;
	preferredLane?: string;
	preferredRole?: string;
	/** Display name, stored for PI rendering */
	name?: string;
	/** DDragon champion ID (e.g. "MasterYi"), stored for PI image URLs */
	ddId?: string;
}

export interface OTPSettings extends JsonObject {
	otpChampions?: Record<string, OTPChampionConfig>;
}

export const otp = new OTP();
