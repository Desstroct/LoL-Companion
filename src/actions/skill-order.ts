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
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import { ChampionStats } from "../services/champion-stats";
import { lolaBuild, type SkillPriorityData, type SkillOrderData, type BuildPageData } from "../services/lolalytics-build";

const logger = streamDeck.logger.createScope("SkillOrder");

// Skill digit → letter
const SKILL_LETTER = ["", "Q", "W", "E", "R"];

// Skill colors for SVG rendering
const SKILL_COLORS: Record<string, string> = {
	Q: "#3498DB", // Blue
	W: "#2ECC71", // Green
	E: "#E67E22", // Orange
	R: "#E74C3C", // Red
};

const GOLD = "#C89B3C";
const DARK_BLUE = "#0A1428";

interface SkillOrderState {
	lastChampKey: string;
	/** Skill max priority data (e.g., "QEW") */
	priority: SkillPriorityData[];
	/** Full 15-level skill order */
	fullOrder: SkillOrderData[];
	/** 0 = most common, 1 = highest WR */
	selectedIndex: number;
	/** Whether showing full level-by-level order (true) or just priority (false) */
	detailView: boolean;
}

type SkillOrderSettings = {
	role?: string;
};

/**
 * Skill Order action — displays the recommended skill max order and
 * level-by-level skill sequence during champion select.
 *
 * Key: shows "Q > E > W" style priority, press to toggle detail view
 * Dial:
 *   - Rotate: switch between Most Common and Highest WR
 *   - Press: toggle priority vs full order
 *   - Touch: refresh
 */
@action({ UUID: "com.desstroct.lol-api.skill-order" })
export class SkillOrder extends SingletonAction<SkillOrderSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, SkillOrderState>();

	override onWillAppear(ev: WillAppearEvent<SkillOrderSettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "Skill Order",
				skill_order: "Waiting...",
				skill_info: "",
				wr_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("Skill\nOrder");
	}

	override onWillDisappear(ev: WillDisappearEvent<SkillOrderSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(ev: KeyDownEvent<SkillOrderSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.detailView = !state.detailView;
		await this.renderAction(ev.action, state);
	}

	override async onDialRotate(ev: DialRotateEvent<SkillOrderSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		const maxIdx = Math.max(0, state.priority.length - 1);
		state.selectedIndex = Math.max(0, Math.min(maxIdx, state.selectedIndex + (ev.payload.ticks > 0 ? 1 : -1)));
		await this.renderAction(ev.action, state);
	}

	override async onDialUp(ev: DialUpEvent<SkillOrderSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		state.detailView = !state.detailView;
		await this.renderAction(ev.action, state);
	}

	override async onTouchTap(ev: TouchTapEvent<SkillOrderSettings>): Promise<void> {
		const state = this.getState(ev.action.id);
		// Force refresh: clear champion so it re-fetches
		state.lastChampKey = "";
		await this.updateState();
	}

	private getState(actionId: string): SkillOrderState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = {
				lastChampKey: "",
				priority: [],
				fullOrder: [],
				selectedIndex: 0,
				detailView: false,
			};
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateState().catch((e) => logger.error(`updateState error: ${e}`));
		this.pollInterval = setInterval(
			() => this.updateState().catch((e) => logger.error(`updateState error: ${e}`)),
			3000,
		);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	// ── State update ──

	private async updateState(): Promise<void> {
		if (this.actions.length === 0) return;

		const phase = lcuConnector.isConnected() ? await lcuApi.getGameflowPhase() : null;

		// Only active in champ select
		if (phase !== "ChampSelect") {
			for (const a of this.actions) {
				const state = this.getState(a.id);
				if (state.lastChampKey) {
					state.lastChampKey = "";
					state.priority = [];
					state.fullOrder = [];
					state.selectedIndex = 0;
					if (a.isDial()) {
						await a.setFeedback({
							title: "Skill Order",
							skill_order: "Waiting...",
							skill_info: "",
							wr_bar: { value: 0 },
						});
					} else {
						await a.setImage("");
						await a.setTitle("Skill\nOrder");
					}
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const localCell = session.localPlayerCellId;
		const me = session.myTeam.find((p) => p.cellId === localCell);
		if (!me || me.championId <= 0) return;

		const champKey = String(me.championId);
		const champ = dataDragon.getChampionByKey(champKey);
		if (!champ) return;

		const champAlias = ChampionStats.toLolalytics(champ.id);

		for (const a of this.actions) {
			const s = (await a.getSettings()) as SkillOrderSettings;
			const state = this.getState(a.id);

			if (champKey === state.lastChampKey && state.priority.length > 0) continue;

			// New champion or first time
			state.lastChampKey = champKey;
			state.selectedIndex = 0;
			state.priority = [];
			state.fullOrder = [];
			state.detailView = false;

			// Show loading
			if (a.isDial()) {
				await a.setFeedback({
					title: champ.name,
					skill_order: "Loading...",
					skill_info: "",
					wr_bar: { value: 0 },
				});
			} else {
				await a.setTitle(`${champ.name}\nLoading...`);
			}

			const lane = gameMode.isARAM()
				? "aram"
				: ChampionStats.toLolalyticsLane(
						(s.role && s.role !== "auto" ? s.role : null) ?? me.assignedPosition ?? "top",
				  );

			try {
				const buildData = await lolaBuild.getBuildData(champAlias, lane);
				if (buildData) {
					state.priority = buildData.skillPriority;
					state.fullOrder = buildData.skillOrder;
					if (state.priority.length > 0) {
						logger.info(`Skills for ${champ.name} ${lane}: ${state.priority[0].order} (${state.priority[0].winRate}% WR)`);
					}
				}
				await this.renderAction(a, state);
			} catch (e) {
				logger.error(`Failed to get skill data: ${e}`);
				if (a.isDial()) {
					await a.setFeedback({
						title: champ.name,
						skill_order: "Error",
						skill_info: "",
						wr_bar: { value: 0 },
					});
				} else {
					await a.setTitle(`${champ.name}\nNo data`);
				}
			}
		}
	}

	// ── Rendering ──

	private async renderAction(
		a: DialAction<SkillOrderSettings> | KeyAction<SkillOrderSettings>,
		state: SkillOrderState,
	): Promise<void> {
		const champ = state.lastChampKey ? dataDragon.getChampionByKey(state.lastChampKey) : null;
		const champName = champ?.name ?? "?";
		const prio = state.priority[state.selectedIndex];

		if (!prio) {
			if (a.isDial()) {
				await a.setFeedback({
					title: champName,
					skill_order: "No data",
					skill_info: "",
					wr_bar: { value: 0 },
				});
			} else {
				await a.setImage("");
				await a.setTitle(`${champName}\nNo skill data`);
			}
			return;
		}

		const label = prio.source === "highest_wr" ? "Best WR" : "Popular";
		const orderStr = prio.order.split("").join(" > "); // "QEW" → "Q > E > W"
		const gamesStr = prio.games >= 1000 ? `${(prio.games / 1000).toFixed(1)}k` : `${prio.games}`;
		const barColor = prio.winRate >= 54 ? "#2ECC71" : prio.winRate >= 50 ? "#F1C40F" : "#E74C3C";

		if (a.isDial()) {
			const shortChamp = champName.length > 10 ? champName.slice(0, 9) + "…" : champName;
			await a.setFeedback({
				title: `${shortChamp} · ${label}`,
				skill_order: state.detailView ? this.formatFullOrder(state) : orderStr,
				skill_info: `${prio.winRate}% WR · ${prio.pickRate}% PR · ${gamesStr}`,
				wr_bar: { value: prio.winRate, bar_fill_c: barColor },
			});
		} else {
			// Compose SVG key image showing skill priority
			const img = this.composeSkillImage(prio, state.detailView ? state.fullOrder[state.selectedIndex] : null);
			if (img) {
				await a.setImage(img);
			}
			await a.setTitle(state.detailView ? "" : `${champName}`);
		}
	}

	/**
	 * Format the full 15-level skill order for dial display.
	 * e.g., "Q W E Q Q R Q E Q E R E W W W"
	 */
	private formatFullOrder(state: SkillOrderState): string {
		const order = state.fullOrder[state.selectedIndex];
		if (!order) return "N/A";
		const digits = String(order.sequence);
		return digits
			.split("")
			.map((d) => SKILL_LETTER[parseInt(d)] || "?")
			.join(" ");
	}

	/**
	 * Compose an SVG key image showing the skill max order.
	 * Shows "Q > E > W" with colored skill letters.
	 * If fullOrder is given, also shows the level-by-level grid.
	 */
	private composeSkillImage(
		prio: SkillPriorityData,
		fullOrder?: SkillOrderData | null,
	): string | null {
		const S = 144;
		const cr = 14;

		const skills = prio.order.split(""); // e.g., ["Q", "E", "W"]

		let content: string;

		if (fullOrder) {
			// Detail view: level-by-level grid
			const digits = String(fullOrder.sequence).split("");
			const cellW = 9;
			const cellH = 14;
			const startX = 4;
			const startY = 24;
			const rowGap = 2;
			const colGap = 0;

			let grid = "";
			const skillRows = ["Q", "W", "E", "R"];

			// Header: level numbers 1-15
			for (let lvl = 0; lvl < 15; lvl++) {
				const x = startX + lvl * (cellW + colGap) + cellW / 2;
				grid += `<text x="${x}" y="${startY - 4}" font-size="7" fill="#888" text-anchor="middle" font-family="sans-serif">${lvl + 1}</text>`;
			}

			for (let row = 0; row < 4; row++) {
				const skill = skillRows[row];
				const y = startY + row * (cellH + rowGap);
				const color = SKILL_COLORS[skill] ?? "#FFF";

				// Skill label
				grid += `<text x="${startX - 1}" y="${y + cellH - 3}" font-size="10" fill="${color}" font-weight="bold" text-anchor="end" font-family="sans-serif">${skill}</text>`;

				for (let lvl = 0; lvl < digits.length && lvl < 15; lvl++) {
					const skillAtLevel = SKILL_LETTER[parseInt(digits[lvl])];
					const x = startX + lvl * (cellW + colGap);
					const isActive = skillAtLevel === skill;

					if (isActive) {
						grid += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="2" fill="${color}" opacity="0.85"/>`;
						grid += `<text x="${x + cellW / 2}" y="${y + cellH - 3}" font-size="8" fill="#FFF" text-anchor="middle" font-weight="bold" font-family="sans-serif">●</text>`;
					} else {
						grid += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="2" fill="#1a1a2e" stroke="#333" stroke-width="0.5"/>`;
					}
				}
			}

			// Win rate at bottom
			grid += `<text x="${S / 2}" y="${startY + 4 * (cellH + rowGap) + 16}" font-size="11" fill="${GOLD}" text-anchor="middle" font-family="sans-serif">${fullOrder.winRate}% WR</text>`;

			content = grid;
		} else {
			// Simple view: Q > E > W
			const orderStr = skills
				.map((s) => {
					const color = SKILL_COLORS[s] ?? "#FFF";
					return `<tspan fill="${color}" font-weight="bold">${s}</tspan>`;
				})
				.join(`<tspan fill="#888"> › </tspan>`);

			content = `
				<text x="${S / 2}" y="52" font-size="28" text-anchor="middle" font-family="sans-serif">${orderStr}</text>
				<text x="${S / 2}" y="78" font-size="13" fill="${GOLD}" text-anchor="middle" font-family="sans-serif">${prio.winRate}% WR</text>
				<text x="${S / 2}" y="98" font-size="11" fill="#888" text-anchor="middle" font-family="sans-serif">${prio.pickRate}% Pick Rate</text>
			`;
		}

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="${cr}" fill="${DARK_BLUE}"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 1}" fill="none" stroke="${GOLD}" stroke-width="1.5" opacity="0.4"/>
			${content}
		</svg>`;

		const b64 = Buffer.from(svg).toString("base64");
		return `data:image/svg+xml;base64,${b64}`;
	}
}
