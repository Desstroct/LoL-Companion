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
import { dataDragon } from "../services/data-dragon";
import { getChampionIcon } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("AutoPick");

/**
 * Auto Pick/Ban action — automatically picks and/or bans your preferred champions.
 *
 * Settings:
 * - pickChampion: champion name to auto-pick (e.g. "Aatrox")
 * - banChampion:  champion name to auto-ban  (e.g. "Yasuo")
 * - autoLock:     also lock-in (complete the action) — default true
 *
 * During ChampSelect:
 * 1. When it's your ban turn → bans the configured champion
 * 2. When it's your pick turn → picks the configured champion
 *
 * Press key to toggle auto-pick on/off.
 */
@action({ UUID: "com.desstroct.lol-api.auto-pick" })
export class AutoPick extends SingletonAction<AutoPickSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private enabled = true;
	private hasPicked = false;
	private hasBanned = false;
	private lastPhaseTimer = "";

	override async onWillAppear(ev: WillAppearEvent<AutoPickSettings>): Promise<void> {
		const settings = ev.payload.settings;
		this.enabled = settings.enabled !== false;
		this.startPolling();
		await this.renderAll(settings);
	}

	override onWillDisappear(_ev: WillDisappearEvent<AutoPickSettings>): void | Promise<void> {
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<AutoPickSettings>): Promise<void> {
		this.enabled = !this.enabled;
		await ev.action.setSettings({ ...ev.payload.settings, enabled: this.enabled });
		logger.info(`Auto-pick ${this.enabled ? "enabled" : "disabled"}`);
		await this.renderAll(ev.payload.settings);
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.pollInterval = setInterval(() => this.updateState().catch((e) => logger.error(`updateState error: ${e}`)), 1000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async renderAll(settings: AutoPickSettings): Promise<void> {
		const pickName = settings.pickChampion || "???";
		const banName = settings.banChampion || "—";

		for (const a of this.actions) {
			if (this.enabled) {
				// Try to show the pick champion icon
				const pickChamp = dataDragon.getChampionByName(pickName);
				if (pickChamp) {
					const icon = await getChampionIcon(pickChamp.id);
					if (icon) await a.setImage(icon);
				}
				await a.setTitle(`Pick: ${pickName}\nBan: ${banName}\nON`);
			} else {
				await a.setImage("");
				await a.setTitle(`Auto Pick\nOFF`);
			}
		}
	}

	private async updateState(): Promise<void> {
		if (!this.enabled) return;
		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				await a.setTitle("Auto Pick\nOffline");
			}
			return;
		}

		// TFT has no pick/ban phase
		if (gameMode.isTFT()) return;

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			// Reset for next champ select
			if (this.hasPicked || this.hasBanned) {
				this.hasPicked = false;
				this.hasBanned = false;
				this.lastPhaseTimer = "";
				for (const a of this.actions) {
					const s = (await a.getSettings()) as AutoPickSettings;
					await this.renderAll(s);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const localCell = session.localPlayerCellId;

		// Find our pending actions (ban or pick)
		const allActions = session.actions.flat();
		const myActions = allActions.filter((act) => act.actorCellId === localCell);

		for (const a of this.actions) {
			const settings = (await a.getSettings()) as AutoPickSettings;

			// ── Auto-ban ──
			if (!this.hasBanned && settings.banChampion) {
				const banAction = myActions.find(
					(act) => act.type === "ban" && act.isInProgress && !act.completed,
				);

				if (banAction) {
					const champToBan = this.resolveChampionId(settings.banChampion);
					if (champToBan) {
						logger.info(`Auto-banning ${settings.banChampion} (ID: ${champToBan})`);
						await this.performAction(banAction.id, champToBan, settings.autoLock !== false);
						this.hasBanned = true;

						await a.setTitle(`Banned!\n${settings.banChampion}`);
					}
				}
			}

			// ── Auto-pick ──
			if (!this.hasPicked && settings.pickChampion) {
				const pickAction = myActions.find(
					(act) => act.type === "pick" && act.isInProgress && !act.completed,
				);

				if (pickAction) {
					const champToPick = this.resolveChampionId(settings.pickChampion);
					if (champToPick) {
						logger.info(`Auto-picking ${settings.pickChampion} (ID: ${champToPick})`);
						await this.performAction(pickAction.id, champToPick, settings.autoLock !== false);
						this.hasPicked = true;

						const champ = dataDragon.getChampionByKey(String(champToPick));
						const icon = champ ? await getChampionIcon(champ.id) : null;
						if (icon) await a.setImage(icon);
						await a.setTitle(`Picked!\n${settings.pickChampion}`);
					}
				}
			}
		}
	}

	/**
	 * Resolve a champion name/id to the numeric key.
	 */
	private resolveChampionId(nameOrId: string): number | null {
		// Try name match (case-insensitive)
		const byName = dataDragon.getChampionByName(nameOrId);
		if (byName) return parseInt(byName.key, 10);

		// Try exact ID match (e.g. "Aatrox")
		const byId = dataDragon.getChampion(nameOrId);
		if (byId) return parseInt(byId.key, 10);

		// Try key match (numeric string like "266")
		const num = parseInt(nameOrId, 10);
		if (!isNaN(num)) {
			const byKey = dataDragon.getChampionByKey(nameOrId);
			if (byKey) return num;
		}

		logger.warn(`Could not resolve champion: ${nameOrId}`);
		return null;
	}

	/**
	 * Execute a champ select action (pick or ban) via LCU API.
	 */
	private async performAction(actionId: number, championId: number, complete: boolean): Promise<void> {
		try {
			await lcuApi.patch(`/lol-champ-select/v1/session/actions/${actionId}`, {
				championId,
				completed: complete,
			});
		} catch (e) {
			logger.error(`performAction error: ${e}`);
		}
	}
}

type AutoPickSettings = {
	enabled?: boolean;
	pickChampion?: string;
	banChampion?: string;
	/** Whether to auto-lock (complete the action). Default true. */
	autoLock?: boolean;
};
