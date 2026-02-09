import {
	action,
	DialRotateEvent,
	DialUpEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
	type DialAction,
	type KeyAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { runeData, RunePageData } from "../services/rune-data";
import { ChampionStats } from "../services/champion-stats";

const logger = streamDeck.logger.createScope("AutoRune");

// ─── Image caches ───
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const keystoneCache = new Map<number, string>(); // keystoneId → raw base64
const treeCache = new Map<number, string>(); // treeStyleId → raw base64
const composedCache = new Map<string, string>(); // "keystoneId:treeId" → data URI

/** Load a keystone icon from disk as raw base64 (cached) */
function getKeystoneBase64(keystoneId: number): string | null {
	if (keystoneCache.has(keystoneId)) return keystoneCache.get(keystoneId)!;
	try {
		const imgPath = join(PLUGIN_DIR, "imgs", "actions", "auto-rune", "keystones", `${keystoneId}@2x.png`);
		const b64 = readFileSync(imgPath).toString("base64");
		keystoneCache.set(keystoneId, b64);
		return b64;
	} catch {
		return null;
	}
}

/** Load a rune tree style icon from disk as raw base64 (cached) */
function getTreeBase64(treeStyleId: number): string | null {
	if (treeCache.has(treeStyleId)) return treeCache.get(treeStyleId)!;
	try {
		const imgPath = join(PLUGIN_DIR, "imgs", "actions", "auto-rune", "trees", `${treeStyleId}@2x.png`);
		const b64 = readFileSync(imgPath).toString("base64");
		treeCache.set(treeStyleId, b64);
		return b64;
	} catch {
		return null;
	}
}

// LoL color palette (must match generate-icons.mjs)
const GOLD = "#C89B3C";
const DARK_BLUE = "#0A1428";

/**
 * Compose an SVG key image with primary keystone (large, centered) and
 * secondary tree icon (small badge, bottom-right corner).
 * Returns a data:image/svg+xml;base64 URI ready for setImage().
 */
function composeRuneImage(keystoneId: number, subStyleId: number): string | null {
	const cacheKey = `${keystoneId}:${subStyleId}`;
	if (composedCache.has(cacheKey)) return composedCache.get(cacheKey)!;

	const ksB64 = getKeystoneBase64(keystoneId);
	if (!ksB64) return null;
	const treeB64 = getTreeBase64(subStyleId);

	const S = 144; // @2x key size
	const br = 3; // border width
	const cr = 14; // corner radius
	const pad = 14; // inner padding for keystone
	const ksSize = S - pad * 2; // keystone icon area

	// Secondary tree badge position (bottom-right)
	const badgeSize = 44;
	const badgeX = S - badgeSize - 6;
	const badgeY = S - badgeSize - 6;
	const badgeCx = badgeX + badgeSize / 2;
	const badgeCy = badgeY + badgeSize / 2;
	const badgeR = badgeSize / 2;

	const treeBadge = treeB64
		? `<circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR + 3}" fill="${DARK_BLUE}" stroke="${GOLD}" stroke-width="1.5"/>
		   <clipPath id="tc"><circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR}"/></clipPath>
		   <image href="data:image/png;base64,${treeB64}" x="${badgeX}" y="${badgeY}" width="${badgeSize}" height="${badgeSize}" clip-path="url(#tc)"/>`
		: "";

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
		<rect width="${S}" height="${S}" rx="${cr}" fill="${DARK_BLUE}"/>
		<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
			<stop offset="0%" stop-color="${GOLD}" stop-opacity="0.22"/>
			<stop offset="55%" stop-color="${GOLD}" stop-opacity="0.07"/>
			<stop offset="100%" stop-color="${GOLD}" stop-opacity="0"/>
		</radialGradient></defs>
		<circle cx="72" cy="72" r="55" fill="url(#g)"/>
		<rect x="${br}" y="${br}" width="${S - br * 2}" height="${S - br * 2}" rx="${cr - br}" stroke="${GOLD}" stroke-width="${br}" fill="none"/>
		<image href="data:image/png;base64,${ksB64}" x="${pad}" y="${pad}" width="${ksSize}" height="${ksSize}"/>
		${treeBadge}
	</svg>`;

	const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	composedCache.set(cacheKey, dataUri);
	return dataUri;
}

/** Legacy helper: keystone-only data URI (for dial feedback that needs just the icon) */
function getKeystoneImage(keystoneId: number): string | null {
	const b64 = getKeystoneBase64(keystoneId);
	return b64 ? `data:image/png;base64,${b64}` : null;
}

/** Name used for the managed rune page in the client */
const RUNE_PAGE_NAME = "LoL Companion";

@action({ UUID: "com.desstroct.lol-api.auto-rune" })
export class AutoRune extends SingletonAction<AutoRuneSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-action instance state (supports multiple keys with different roles) */
	private actionStates = new Map<string, AutoRuneState>();

	override onWillAppear(ev: WillAppearEvent<AutoRuneSettings>): void | Promise<void> {
		this.startPolling();
		const role = ev.payload.settings.role ?? "auto";
		const roleLabel = role === "auto" ? "AUTO" : role.toUpperCase();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: `Auto Rune · ${roleLabel}`,
				rune_name: "Waiting...",
				rune_info: "",
				wr_bar: { value: 0 },
			});
		}
		return ev.action.setTitle(`Auto Rune\n${roleLabel}`);
	}

	override onWillDisappear(ev: WillDisappearEvent<AutoRuneSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	/** Key press: apply the currently selected runes to the client */
	override async onKeyDown(ev: KeyDownEvent<AutoRuneSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		await this.applyRunesForAction(ev.action, state, ev.payload.settings);
	}

	/** Dial rotation: toggle between "Highest WR" and "Most Common" builds */
	override async onDialRotate(ev: DialRotateEvent<AutoRuneSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		if (state.lastRunes.length < 2) return;
		state.selectedIndex = (state.selectedIndex + 1) % state.lastRunes.length;
		state.applied = false;
		await this.renderAction(ev.action, state, ev.payload.settings);
	}

	/** Dial press: apply runes */
	override async onDialUp(ev: DialUpEvent<AutoRuneSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		await this.applyRunesForAction(ev.action, state, ev.payload.settings);
	}

	/** Touch tap: apply runes */
	override async onTouchTap(ev: TouchTapEvent<AutoRuneSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		await this.applyRunesForAction(ev.action, state, ev.payload.settings);
	}

	private getState(actionId: string): AutoRuneState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { lastChampKey: "", lastRunes: [], selectedIndex: 0, applied: false };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	// ---- Polling loop ----

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

	/**
	 * Core polling logic: detect champion select, fetch rune recommendations.
	 * Only auto-applies runes when champion is actually locked, not just hovered.
	 */
	private async updateState(): Promise<void> {
		if (!lcuConnector.isConnected()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ keystone_icon: "", title: "Auto Rune", rune_name: "Offline", rune_info: "", wr_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Runes\nOffline");
				}
			}
			return;
		}

		// TFT doesn't use rune pages
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ keystone_icon: "", title: "Auto Rune", rune_name: "N/A in TFT", rune_info: "", wr_bar: { value: 0 } });
				} else {
					await a.setImage(""); await a.setTitle("Runes\nN/A TFT");
				}
			}
			return;
		}

		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			let hadState = false;
			for (const s of this.actionStates.values()) {
				if (s.lastChampKey !== "") hadState = true;
				s.lastChampKey = "";
				s.lastRunes = [];
				s.selectedIndex = 0;
				s.applied = false;
			}
			if (hadState) {
				for (const a of this.actions) {
					const s = (await a.getSettings()) as AutoRuneSettings;
					const role = s.role ?? "auto";
					const roleLabel = role === "auto" ? "AUTO" : role.toUpperCase();
					if (a.isDial()) {
						await a.setFeedback({
							keystone_icon: "",
							title: `Auto Rune · ${roleLabel}`,
							rune_name: "Waiting...",
							rune_info: "",
							wr_bar: { value: 0 },
						});
					} else {
						await a.setImage("");
						await a.setTitle(`Auto Rune\n${roleLabel}`);
					}
				}
			}
			return;
		}

		// We're in champ select — find our champion
		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const localCell = session.localPlayerCellId;
		const me = session.myTeam.find((p) => p.cellId === localCell);
		if (!me || me.championId <= 0) return;

		const champKey = String(me.championId);
		const champ = dataDragon.getChampionByKey(champKey);
		if (!champ) return;

		// Check if our pick is locked (completed), not just hovered
		const isLocked = session.actions.flat().some(
			(act) => act.actorCellId === localCell && act.type === "pick" && act.completed && act.championId > 0,
		);

		const champAlias = ChampionStats.toLolalytics(champ.id);

		for (const a of this.actions) {
			const s = (await a.getSettings()) as AutoRuneSettings;
			const state = this.getState(a.id);

			if (champKey === state.lastChampKey) {
				// Same champion — check if just locked for auto-apply
				if (isLocked && s.autoApply && !state.applied && state.lastRunes.length > 0) {
					await this.applyRunesForAction(a, state, s);
				}
				continue;
			}

			// New champion detected
			state.lastChampKey = champKey;
			state.selectedIndex = 0;
			state.applied = false;

			// Show loading state
			if (a.isDial()) {
				await a.setFeedback({
					title: champ.name,
					rune_name: "Searching...",
					rune_info: "",
					wr_bar: { value: 0 },
				});
			} else {
				await a.setTitle(`${champ.name}\nSearching...`);
			}

			const lane = gameMode.isARAM()
				? "aram"
				: ChampionStats.toLolalyticsLane(
						(s.role && s.role !== "auto" ? s.role : null) ?? me.assignedPosition ?? "top",
				  );

			try {
				const runes = await runeData.getRecommendedRunes(champAlias, lane);
				state.lastRunes = runes;

				if (runes.length > 0) {
					logger.info(`Runes for ${champ.name} ${lane}: ${runes[0].keystoneName} (${runes[0].winRate}%)`);

					// Auto-apply only when champion is locked, not just hovered
					if (isLocked && s.autoApply) {
						await this.applyRunesForAction(a, state, s);
					}
				}

				await this.renderAction(a, state, s);
			} catch (e) {
				logger.error(`Failed to get runes: ${e}`);
			}
		}
	}

	// ---- Rendering ----

	private async renderAction(
		a: DialAction<AutoRuneSettings> | KeyAction<AutoRuneSettings>,
		state: AutoRuneState,
		_settings: AutoRuneSettings,
	): Promise<void> {
		const rune = state.lastRunes[state.selectedIndex];
		const champ = state.lastChampKey ? dataDragon.getChampionByKey(state.lastChampKey) : null;
		const champName = champ?.name ?? "?";

		if (!rune) {
			if (a.isDial()) {
				await a.setFeedback({
					keystone_icon: "",
					title: champName,
					rune_name: "No data",
					rune_info: "",
					wr_bar: { value: 0 },
				});
			} else {
				await a.setImage("");
				await a.setTitle(`${champName}\nNo rune data`);
			}
			return;
		}

		const label = rune.source === "highest_wr" ? "Best WR" : "Popular";
		const appliedMark = state.applied ? " ✅" : "";
		const gamesStr = rune.games >= 1000 ? `${(rune.games / 1000).toFixed(1)}k` : `${rune.games}`;
		const barColor = rune.winRate >= 54 ? "#2ECC71" : rune.winRate >= 50 ? "#F1C40F" : "#E74C3C";

		// Get the keystone icon for the detected rune
		const keystoneId = rune.selectedPerkIds[0];
		const keystoneImg = getKeystoneImage(keystoneId);

		const shortChamp = champName.length > 10 ? champName.slice(0, 9) + "…" : champName;
		if (a.isDial()) {
			await a.setFeedback({
				keystone_icon: keystoneImg ?? "",
				title: `${shortChamp} · ${label}${appliedMark}`,
				rune_name: rune.keystoneName,
				rune_info: `${rune.winRate}% WR · ${gamesStr} games`,
				wr_bar: { value: rune.winRate, bar_fill_c: barColor },
			});
		} else {
			// Set key image: primary keystone + secondary tree badge
			const composedImg = composeRuneImage(keystoneId, rune.subStyleId);
			if (composedImg) {
				await a.setImage(composedImg);
			} else if (keystoneImg) {
				await a.setImage(keystoneImg);
			}
			await a.setTitle(
				`${champName}${appliedMark}`,
			);
		}
	}

	// ---- Rune application ----

	/**
	 * Apply the selected rune page to the League Client for a specific action instance.
	 * Strategy: find or create an editable page named RUNE_PAGE_NAME, then update it.
	 */
	private async applyRunesForAction(
		a: DialAction<AutoRuneSettings> | KeyAction<AutoRuneSettings>,
		state: AutoRuneState,
		settings: AutoRuneSettings,
	): Promise<void> {
		const rune = state.lastRunes[state.selectedIndex];
		if (!rune) {
			logger.warn("No rune data to apply");
			return;
		}

		if (!lcuConnector.isConnected()) {
			logger.warn("Not connected to LCU");
			return;
		}

		try {
			// Find our managed page (or any editable page)
			const pages = await lcuApi.getRunePages();
			let targetPage = pages.find((p) => p.name === RUNE_PAGE_NAME && p.isEditable);

			if (!targetPage) {
				// Find any editable page to overwrite
				targetPage = pages.find((p) => p.isEditable && p.isDeletable);
			}

			const pagePayload = {
				name: RUNE_PAGE_NAME,
				primaryStyleId: rune.primaryStyleId,
				subStyleId: rune.subStyleId,
				selectedPerkIds: rune.selectedPerkIds,
				current: true,
			};

			if (targetPage) {
				// Update existing page
				const result = await lcuApi.updateRunePage(targetPage.id, pagePayload);
				if (result) {
					logger.info(`Updated rune page ${targetPage.id} → ${rune.keystoneName}`);
					state.applied = true;
				} else {
					// If update fails, try delete + create
					logger.debug("Update failed, trying delete + create");
					await lcuApi.deleteRunePage(targetPage.id);
					const created = await lcuApi.createRunePage(pagePayload);
					if (created) {
						logger.info(`Recreated rune page → ${rune.keystoneName}`);
						state.applied = true;
					} else {
						logger.error("Failed to create rune page");
					}
				}
			} else {
				// No editable pages — try to make room by deleting the oldest editable one
				const editable = pages.filter((p) => p.isDeletable);
				if (editable.length > 0) {
					// Delete last one to make room
					const toDelete = editable[editable.length - 1];
					await lcuApi.deleteRunePage(toDelete.id);
				}

				const created = await lcuApi.createRunePage(pagePayload);
				if (created) {
					logger.info(`Created new rune page → ${rune.keystoneName}`);
					state.applied = true;
				} else {
					logger.error("Failed to create rune page after cleanup");
				}
			}

			// Re-render to show the ✅ mark
			await this.renderAction(a, state, settings);
		} catch (e) {
			logger.error(`applyRunes error: ${e}`);
		}
	}
}

interface AutoRuneState {
	lastChampKey: string;
	lastRunes: RunePageData[];
	selectedIndex: number;
	applied: boolean;
}

type AutoRuneSettings = {
	role?: string;
	/** When true, runes are applied automatically when a champion is locked */
	autoApply?: boolean;
};
