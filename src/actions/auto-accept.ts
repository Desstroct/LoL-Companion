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
import type { GameflowPhase } from "../types/lol";

const logger = streamDeck.logger.createScope("AutoAccept");

/**
 * Auto-Accept action — automatically accepts the ready check when a match is found.
 *
 * Press the key to toggle auto-accept on/off.
 * When enabled, polls for ReadyCheck phase and sends accept request via LCU API.
 *
 * Display:
 *   ON  → green checkmark + "Auto\nAccept\nON"
 *   OFF → "Auto\nAccept\nOFF"
 *   Accepting → "Match!\nAccepted"
 */
@action({ UUID: "com.desstroct.lol-api.auto-accept" })
export class AutoAccept extends SingletonAction<AutoAcceptSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private renderTimeout: ReturnType<typeof setTimeout> | null = null;
	private enabled = true; // On by default
	private lastPhase: GameflowPhase = "None";
	private hasAcceptedCurrent = false;

	override async onWillAppear(ev: WillAppearEvent<AutoAcceptSettings>): Promise<void> {
		const settings = ev.payload.settings;
		this.enabled = settings.enabled !== false; // default true
		// Always keep polling alive — auto-accept must work even when
		// the user navigates to a different Stream Deck page.
		this.startPolling();
		await this.renderAll();
	}

	override onWillDisappear(_ev: WillDisappearEvent<AutoAcceptSettings>): void | Promise<void> {
		if (this.renderTimeout) {
			clearTimeout(this.renderTimeout);
			this.renderTimeout = null;
		}
		// Do NOT stop polling here — we want auto-accept to keep running
		// even when the action is not visible (user on another page).
	}

	override async onKeyDown(ev: KeyDownEvent<AutoAcceptSettings>): Promise<void> {
		this.enabled = !this.enabled;
		await ev.action.setSettings({ enabled: this.enabled });
		logger.info(`Auto-accept ${this.enabled ? "enabled" : "disabled"}`);
		await this.renderAll();
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.pollInterval = setInterval(() => this.checkReadyCheck().catch((e) => logger.error(`checkReadyCheck error: ${e}`)), 500);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async checkReadyCheck(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			if (this.lastPhase !== "None") {
				this.lastPhase = "None";
				await this.renderAll();
			}
			return;
		}

		const phase = await lcuApi.getGameflowPhase();

		if (phase !== this.lastPhase) {
			// Reset accept flag when leaving ReadyCheck
			if (this.lastPhase === "ReadyCheck" && phase !== "ReadyCheck") {
				this.hasAcceptedCurrent = false;
			}
			this.lastPhase = phase;
			await this.renderAll();
		}

		if (this.enabled && phase === "ReadyCheck" && !this.hasAcceptedCurrent) {
			logger.info("Ready check detected! Auto-accepting...");
			const ok = await lcuApi.post("/lol-matchmaking/v1/ready-check/accept");
			if (ok) {
				this.hasAcceptedCurrent = true;
				logger.info("Ready check accepted!");
				// Flash "Accepted" briefly
				for (const a of this.actions) {
					await a.setTitle("Accepted\n✅");
				}
				// Reset display after 2 seconds
				this.renderTimeout = setTimeout(() => {
					this.renderTimeout = null;
					this.renderAll().catch((e) => logger.error(`renderAll error: ${e}`));
				}, 2000);
			} else {
				logger.warn("Failed to accept ready check");
			}
		}
	}

	private async renderAll(): Promise<void> {
		for (const a of this.actions) {
			if (this.lastPhase === "ReadyCheck" && !this.enabled) {
				await a.setTitle("MATCH!\nManual");
			} else if (this.enabled) {
				await a.setTitle("Accept\nON");
			} else {
				await a.setTitle("Accept\nOFF");
			}
		}
	}
}

type AutoAcceptSettings = {
	enabled?: boolean;
};
