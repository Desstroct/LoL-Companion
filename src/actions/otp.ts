import {
	action,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	DidReceiveSettingsEvent,
	KeyDownEvent,
	DialRotateEvent,
	type DialAction,
	type KeyAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { dataDragon } from "../services/data-dragon";
import { getChampionIcon } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("OTP");

/**
 * OTP (One-Trick Pony) action — stores the user's main champion
 * and provides champion-specific settings that other actions can use.
 *
 * Key: press to cycle through saved OTP champions
 * Dial: rotate to browse saved champions
 * Long press: open property inspector to add/remove champions
 */
@action({ UUID: "com.desstroct.lol-api.otp" })
export class OTP extends SingletonAction<OTPSettings> {
	/** All saved OTP champions (alias → config) */
	private otpChampions = new Map<string, OTPChampionConfig>();
	/** Currently selected champion index */
	private selectedIndex = 0;

	override onWillAppear(ev: WillAppearEvent<OTPSettings>): void | Promise<void> {
		this.loadSavedChampions();
		return this.renderCurrent();
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<OTPSettings>): Promise<void> {
		await this.loadSavedChampions();
		await this.renderCurrent();
	}

	override onWillDisappear(ev: WillDisappearEvent<OTPSettings>): void {
		// Save to settings when disappearing
		this.saveToSettings();
	}

	override async onKeyDown(_ev: KeyDownEvent<OTPSettings>): Promise<void> {
		// Cycle to next champion on key press
		const champions = this.getChampionList();
		if (champions.length === 0) return;
		
		this.selectedIndex = (this.selectedIndex + 1) % champions.length;
		await this.renderCurrent();
		this.saveToSettings();
	}

	override async onDialRotate(ev: DialRotateEvent<OTPSettings>): Promise<void> {
		const champions = this.getChampionList();
		if (champions.length === 0) return;

		// Rotate through champions
		const delta = ev.payload.ticks > 0 ? 1 : -1;
		this.selectedIndex = ((this.selectedIndex + delta) + champions.length * 100) % champions.length;
		await this.renderCurrent();
		this.saveToSettings();
	}

	/**
	 * Get list of saved champion aliases
	 */
	private getChampionList(): string[] {
		return Array.from(this.otpChampions.keys());
	}

	/**
	 * Load saved champions from action settings
	 */
	private async loadSavedChampions(): Promise<void> {
		try {
			// Get settings from the first action instance
			const actionArray = [...this.actions];
			if (actionArray.length === 0) return;
			
			const firstAction = actionArray[0];
			const settings = await firstAction.getSettings() as OTPSettings;
			if (settings?.otpChampions) {
				this.otpChampions = new Map(Object.entries(settings.otpChampions));
			}
			if (settings?.selectedIndex !== undefined) {
				this.selectedIndex = settings.selectedIndex;
			}
		} catch (e) {
			logger.warn(`Failed to load OTP settings: ${e}`);
		}
	}

	/**
	 * Save champions to action settings
	 */
	private async saveToSettings(): Promise<void> {
		try {
			const championsObj = Object.fromEntries(this.otpChampions);
			for (const a of this.actions) {
				await a.setSettings({
					otpChampions: championsObj,
					selectedIndex: this.selectedIndex,
				} as OTPSettings);
			}
		} catch (e) {
			logger.warn(`Failed to save OTP settings: ${e}`);
		}
	}

	/**
	 * Render the current OTP champion
	 */
	private async renderCurrent(): Promise<void> {
		const champions = this.getChampionList();
		if (champions.length === 0) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						title: "OTP",
						champion: "No champions",
						info: "Press to add",
					});
				} else {
					await a.setTitle("OTP\nAdd champ");
				}
			}
			return;
		}

		const alias = champions[this.selectedIndex];
		const config = this.otpChampions.get(alias);
		if (!config) return;

		const champ = dataDragon.getChampionByName(alias);
		const champName = champ?.name ?? alias;
		const icon = await getChampionIcon(alias);

		// Build info string from enabled actions
		const enabledActions: string[] = [];
		if (config.autoRune) enabledActions.push("Rune");
		if (config.autoItem) enabledActions.push("Item");
		if (config.autoSpell) enabledActions.push("Spell");
		if (config.counterMode) enabledActions.push("Counter");
		if (config.bestMode) enabledActions.push("Best");
		const info = enabledActions.length > 0 ? enabledActions.join(" · ") : "All";

		for (const a of this.actions) {
			if (a.isDial()) {
				await a.setFeedback({
					champ_icon: icon ?? "",
					title: "OTP",
					champion: champName,
					info: info,
				});
			} else {
				await a.setImage(icon ?? "");
				await a.setTitle(`OTP\n${champName}`);
			}
		}
	}

	/**
	 * Add a champion to the OTP list
	 */
	async addChampion(alias: string, config?: Partial<OTPChampionConfig>): Promise<void> {
		const normalized = alias.toLowerCase().replace(/['\s.]/g, "");
		const champ = dataDragon.getChampionByName(normalized);
		if (!champ) {
			logger.warn(`Unknown champion: ${alias}`);
			return;
		}

		this.otpChampions.set(normalized, {
			enabled: true,
			autoRune: config?.autoRune ?? true,
			autoItem: config?.autoItem ?? true,
			autoSpell: config?.autoSpell ?? true,
			counterMode: config?.counterMode ?? true,
			bestMode: config?.bestMode ?? true,
			preferredLane: config?.preferredLane,
			preferredRole: config?.preferredRole,
		});

		// Select the newly added champion
		this.selectedIndex = this.getChampionList().indexOf(normalized);
		await this.renderCurrent();
		this.saveToSettings();
		logger.info(`Added OTP champion: ${champ.name}`);
	}

	/**
	 * Remove a champion from the OTP list
	 */
	async removeChampion(alias: string): Promise<void> {
		const normalized = alias.toLowerCase().replace(/['\s.]/g, "");
		this.otpChampions.delete(normalized);

		// Adjust selected index if needed
		const champions = this.getChampionList();
		if (this.selectedIndex >= champions.length) {
			this.selectedIndex = Math.max(0, champions.length - 1);
		}

		await this.renderCurrent();
		this.saveToSettings();
	}

	/**
	 * Get the current OTP champion config
	 */
	getCurrentOTP(): { alias: string; config: OTPChampionConfig } | null {
		const champions = this.getChampionList();
		if (champions.length === 0) return null;
		
		const alias = champions[this.selectedIndex];
		const config = this.otpChampions.get(alias);
		return config ? { alias, config } : null;
	}

	/**
	 * Get all saved OTP champions
	 */
	getAllOTP(): Map<string, OTPChampionConfig> {
		return new Map(this.otpChampions);
	}

	/**
	 * Update config for a specific champion
	 */
	async updateChampionConfig(alias: string, config: Partial<OTPChampionConfig>): Promise<void> {
		const normalized = alias.toLowerCase().replace(/['\s.]/g, "");
		const existing = this.otpChampions.get(normalized);
		if (existing) {
			this.otpChampions.set(normalized, { ...existing, ...config });
			await this.renderCurrent();
			this.saveToSettings();
		}
	}
}

export interface OTPChampionConfig extends JsonObject {
	/** Whether this champion is enabled for OTP */
	enabled: boolean;
	/** Auto-apply runes for this champion */
	autoRune: boolean;
	/** Auto-apply items for this champion */
	autoItem: boolean;
	/** Auto-apply summoner spells for this champion */
	autoSpell: boolean;
	/** Enable counter-pick mode for this champion */
	counterMode: boolean;
	/** Enable best-pick mode for this champion */
	bestMode: boolean;
	/** Preferred lane for this champion */
	preferredLane?: string;
	/** Preferred role for this champion */
	preferredRole?: string;
}

export interface OTPSettings extends JsonObject {
	/** Map of champion alias → config */
	otpChampions?: Record<string, OTPChampionConfig>;
	/** Currently selected champion index */
	selectedIndex?: number;
}

// Singleton instance for other actions to access
export const otp = new OTP();