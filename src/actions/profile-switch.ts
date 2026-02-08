import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import type { GameflowPhase } from "../types/lol";

const logger = streamDeck.logger.createScope("ProfileSwitch");

/**
 * Maps game phases to the bundled profile names.
 * null = don't switch (stay on current profile).
 *
 * The three LoL profiles are distributed with the plugin and registered
 * in the manifest's Profiles array.  Readonly: false so users can
 * rearrange the keys however they like after installation.
 */
const PHASE_TO_PROFILE: Record<string, string | null> = {
	None: null, // Don't switch — user returns to their default manually
	Lobby: "LoL Lobby",
	Matchmaking: "LoL Lobby",
	ReadyCheck: "LoL Lobby",
	ChampSelect: "LoL Champ Select",
	GameStart: "LoL In Game",
	InProgress: "LoL In Game",
	Reconnect: "LoL In Game",
	WaitingForStats: "LoL Lobby",
	EndOfGame: "LoL Lobby",
};

/**
 * TFT has no meaningful "Champ Select" — the phase is used for loading.
 * Lobby is the same, In Game is the same, skip the Champ Select profile.
 */
const TFT_PHASE_TO_PROFILE: Record<string, string | null> = {
	None: null,
	Lobby: "LoL Lobby",
	Matchmaking: "LoL Lobby",
	ReadyCheck: "LoL Lobby",
	ChampSelect: "LoL In Game",  // TFT ChampSelect = loading into game
	GameStart: "LoL In Game",
	InProgress: "LoL In Game",
	Reconnect: "LoL In Game",
	WaitingForStats: "LoL Lobby",
	EndOfGame: "LoL Lobby",
};

const PHASE_LABELS: Record<string, string> = {
	None: "Offline",
	Lobby: "Lobby",
	Matchmaking: "Queue",
	ReadyCheck: "Found!",
	ChampSelect: "Champ Sel",
	GameStart: "Loading",
	InProgress: "In Game",
	WaitingForStats: "Stats",
	EndOfGame: "End",
	Reconnect: "Reconn",
};

/**
 * Profile Auto-Switch — automatically switches Stream Deck profiles based on
 * the current League of Legends game phase.
 *
 * - Lobby/Queue/ReadyCheck  → "LoL Lobby" profile
 * - Champion Select         → "LoL Champ Select" profile
 * - In Game / Loading       → "LoL In Game" profile
 * - Client closed (None)    → stays on current profile (no switch)
 *
 * Key press toggles auto-switching on/off.
 */
@action({ UUID: "com.desstroct.lol-api.profile-switch" })
export class ProfileSwitch extends SingletonAction<ProfileSwitchSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private currentPhase: GameflowPhase = "None";
	private enabled = true;
	private lastSwitchedProfile: string | null = null;

	override async onWillAppear(ev: WillAppearEvent<ProfileSwitchSettings>): Promise<void> {
		this.enabled = ev.payload.settings.enabled ?? true;
		this.startPolling();
		await this.updateDisplay();
	}

	override onWillDisappear(_ev: WillDisappearEvent<ProfileSwitchSettings>): void | Promise<void> {
		this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<ProfileSwitchSettings>): Promise<void> {
		this.enabled = !this.enabled;
		await ev.action.setSettings({ ...ev.payload.settings, enabled: this.enabled });
		logger.info(`Auto-switch ${this.enabled ? "enabled" : "disabled"}`);
		await this.updateDisplay();

		// If re-enabled, immediately switch to the right profile
		if (this.enabled) {
			await this.switchProfile();
		}
	}

	// ── Polling ─────────────────────────────────────────────────

	private startPolling(): void {
		if (this.pollInterval) return;
		this.checkPhase().catch((e) => logger.error(`Phase check error: ${e}`));
		this.pollInterval = setInterval(
			() => this.checkPhase().catch((e) => logger.error(`Phase check error: ${e}`)),
			2000,
		);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	// ── Core logic ──────────────────────────────────────────────

	private async checkPhase(): Promise<void> {
		let phase: GameflowPhase = "None";
		if (lcuConnector.isConnected()) {
			phase = await lcuApi.getGameflowPhase();
		}

		if (phase !== this.currentPhase) {
			const oldPhase = this.currentPhase;
			this.currentPhase = phase;
			logger.info(`Phase transition: ${oldPhase} → ${phase}`);
			await this.updateDisplay();

			if (this.enabled) {
				await this.switchProfile();
			}
		}
	}

	private async switchProfile(): Promise<void> {
		const profileMap = gameMode.isTFT() ? TFT_PHASE_TO_PROFILE : PHASE_TO_PROFILE;
		const targetProfile = profileMap[this.currentPhase] ?? null;

		// Don't switch if target is null (phase=None) or if we're already on the right profile
		if (!targetProfile || targetProfile === this.lastSwitchedProfile) {
			return;
		}

		// Collect unique device IDs from all visible instances of this action
		const deviceIds = new Set<string>();
		for (const a of this.actions) {
			deviceIds.add(a.device.id);
		}

		for (const deviceId of deviceIds) {
			try {
				logger.info(`Switching to profile "${targetProfile}" on device ${deviceId}`);
				await streamDeck.profiles.switchToProfile(deviceId, targetProfile);
				this.lastSwitchedProfile = targetProfile;
			} catch (e) {
				logger.error(`Failed to switch profile on ${deviceId}: ${e}`);
			}
		}
	}

	// ── Display ─────────────────────────────────────────────────

	private async updateDisplay(): Promise<void> {
		const indicator = this.enabled ? "ON" : "OFF";
		const label = PHASE_LABELS[this.currentPhase] ?? "???";
		const prefix = gameMode.isTFT() ? "TFT" : "Auto";
		const title = `${prefix}\n${label}\n${indicator}`;

		for (const a of this.actions) {
			await a.setTitle(title);
		}
	}
}

type ProfileSwitchSettings = {
	enabled?: boolean;
};
