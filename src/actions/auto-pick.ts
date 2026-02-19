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
interface AutoPickState {
	enabled: boolean;
	hasPicked: boolean;
	hasBanned: boolean;
	lastPhaseTimer: string;
}

@action({ UUID: "com.desstroct.lol-api.auto-pick" })
export class AutoPick extends SingletonAction<AutoPickSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, AutoPickState>();

	private getState(id: string): AutoPickState {
		let s = this.actionStates.get(id);
		if (!s) {
			s = { enabled: true, hasPicked: false, hasBanned: false, lastPhaseTimer: "" };
			this.actionStates.set(id, s);
		}
		return s;
	}

	override async onWillAppear(ev: WillAppearEvent<AutoPickSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const state = this.getState(ev.action.id);
		state.enabled = settings.enabled !== false;
		this.startPolling();
		await this.renderAction(ev.action, settings, state);
	}

	override onWillDisappear(ev: WillDisappearEvent<AutoPickSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<AutoPickSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.enabled = !state.enabled;
		await ev.action.setSettings({ ...ev.payload.settings, enabled: state.enabled });
		logger.info(`Auto-pick ${state.enabled ? "enabled" : "disabled"}`);
		await this.renderAction(ev.action, ev.payload.settings, state);
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

	private async renderAction(a: WillAppearEvent<AutoPickSettings>["action"] | KeyDownEvent<AutoPickSettings>["action"], settings: AutoPickSettings, state: AutoPickState): Promise<void> {
		const pickName = settings.pickChampion || "???";
		const banName = settings.banChampion || "—";

		if (state.enabled) {
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

	private async updateState(): Promise<void> {
		// Check if any instance is enabled
		const anyEnabled = Array.from(this.actionStates.values()).some((s) => s.enabled);
		if (!anyEnabled) return;

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
			let anyReset = false;
			for (const s of this.actionStates.values()) {
				if (s.hasPicked || s.hasBanned) {
					s.hasPicked = false;
					s.hasBanned = false;
					s.lastPhaseTimer = "";
					anyReset = true;
				}
			}
			if (anyReset) {
				for (const a of this.actions) {
					const settings = (await a.getSettings()) as AutoPickSettings;
					const state = this.getState(a.id);
					await this.renderAction(a, settings, state);
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const timerPhase = session.timer?.phase;
		const localCell = session.localPlayerCellId;
		const allActions = session.actions.flat();
		const myActions = allActions.filter((act) => act.actorCellId === localCell);

		// ── PLANNING phase: pre-select pick champion as intent (hover only) ──
		if (timerPhase === "PLANNING") {
			for (const a of this.actions) {
				const settings = (await a.getSettings()) as AutoPickSettings;
				const state = this.getState(a.id);
				if (settings.pickChampion && !state.hasPicked && state.enabled) {
					const champId = this.resolveChampionId(settings.pickChampion);
					if (champId) {
						const pickAction = myActions.find((act) => act.type === "pick" && !act.completed);
						if (pickAction && pickAction.championId !== champId) {
							logger.info(`PLANNING: hovering ${settings.pickChampion} as intent`);
							await lcuApi.patch(`/lol-champ-select/v1/session/actions/${pickAction.id}`, {
								championId: champId,
							});
						}
					}
				}
			}
			return; // Don't ban/lock during PLANNING
		}

		// Debug: log what actions we have
		const banActions = myActions.filter((act) => act.type === "ban");
		const pickActions = myActions.filter((act) => act.type === "pick");
		if (banActions.length > 0 || pickActions.length > 0) {
			logger.debug(`My actions: bans=${JSON.stringify(banActions.map(a => ({ id: a.id, inProgress: a.isInProgress, completed: a.completed })))}, picks=${JSON.stringify(pickActions.map(a => ({ id: a.id, inProgress: a.isInProgress, completed: a.completed })))}`);
		}

		for (const a of this.actions) {
			const settings = (await a.getSettings()) as AutoPickSettings;
			const state = this.getState(a.id);
			if (!state.enabled) continue;

			// ── Auto-ban ──
			if (!state.hasBanned && settings.banChampion) {
				// Look for our ban action: either in progress OR not yet started but available
				const banAction = myActions.find(
					(act) => act.type === "ban" && !act.completed,
				);

				if (banAction) {
					logger.debug(`Found ban action: id=${banAction.id}, isInProgress=${banAction.isInProgress}, completed=${banAction.completed}`);

					// Only act if it's our turn (isInProgress)
					if (banAction.isInProgress) {
						const champToBan = this.resolveChampionId(settings.banChampion);
						if (champToBan) {
							logger.info(`Auto-banning ${settings.banChampion} (ID: ${champToBan})`);
							const autoLock = settings.autoLock !== false;
							const success = await this.performAction(banAction.id, champToBan, autoLock);
							if (success) {
								state.hasBanned = true;
								await a.setTitle(`Banned!\n${settings.banChampion}`);
							}
						} else {
							logger.warn(`Could not resolve ban champion: ${settings.banChampion}`);
						}
					}
				}
			} else if (!state.hasBanned && !settings.banChampion) {
				// No ban champion configured
			}

			// ── Auto-pick ──
			if (!state.hasPicked && settings.pickChampion) {
				// Check if pick champion was banned
				const champToPick = this.resolveChampionId(settings.pickChampion);
				if (champToPick) {
					const isBanned = allActions.some(
						(act) => act.type === "ban" && act.completed && act.championId === champToPick,
					);
					if (isBanned) {
						logger.warn(`${settings.pickChampion} was banned — cannot auto-pick`);
						await a.setTitle(`BANNED!\n${settings.pickChampion}`);
						state.hasPicked = true; // prevent retrying
						continue;
					}

					// Check if pick champion was already picked by a teammate
					const pickedByTeammate = allActions.some(
						(act) =>
							act.type === "pick" &&
							act.completed &&
							act.championId === champToPick &&
							act.actorCellId !== localCell,
					);
					if (pickedByTeammate) {
						logger.warn(`${settings.pickChampion} already picked by a teammate`);
						await a.setTitle(`TAKEN!\n${settings.pickChampion}`);
						state.hasPicked = true;
						continue;
					}
				}

				const pickAction = myActions.find(
					(act) => act.type === "pick" && !act.completed,
				);

				if (pickAction) {
					logger.debug(`Found pick action: id=${pickAction.id}, isInProgress=${pickAction.isInProgress}, completed=${pickAction.completed}`);

					// Only act if it's our turn (isInProgress)
					if (pickAction.isInProgress && champToPick) {
						logger.info(`Auto-picking ${settings.pickChampion} (ID: ${champToPick})`);
						const autoLock = settings.autoLock !== false;
						const success = await this.performAction(pickAction.id, champToPick, autoLock);
						if (success) {
							state.hasPicked = true;

							const champ = dataDragon.getChampionByKey(String(champToPick));
							const icon = champ ? await getChampionIcon(champ.id) : null;
							if (icon) await a.setImage(icon);
							await a.setTitle(`Picked!\n${settings.pickChampion}`);
						}
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
	 * Two-step: hover the champion, then POST /complete to lock-in.
	 */
	private async performAction(actionId: number, championId: number, complete: boolean): Promise<boolean> {
		try {
			// Step 1: Hover the champion
			await lcuApi.patch(`/lol-champ-select/v1/session/actions/${actionId}`, {
				championId,
			});
			logger.info(`Hover action ${actionId} with champion ${championId}: sent`);

			// Step 2: Lock-in via POST /complete (the correct LCU endpoint)
			if (complete) {
				await new Promise((r) => setTimeout(r, 600));
				const locked = await lcuApi.post(
					`/lol-champ-select/v1/session/actions/${actionId}/complete`,
					{},
				);
				logger.info(`Lock action ${actionId}: ${locked ? "success" : "failed"}`);
				if (!locked) {
					// Retry once after a short delay
					await new Promise((r) => setTimeout(r, 800));
					const retry = await lcuApi.post(
						`/lol-champ-select/v1/session/actions/${actionId}/complete`,
						{},
					);
					logger.info(`Lock retry action ${actionId}: ${retry ? "success" : "failed"}`);
					if (!retry) {
						logger.warn(`Failed to lock action ${actionId} after retry — will retry next poll`);
						return false;
					}
				}
			}
			return true;
		} catch (e) {
			logger.error(`performAction error: ${e}`);
			return false;
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
