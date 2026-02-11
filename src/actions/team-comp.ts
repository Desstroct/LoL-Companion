import {
	action,
	DialRotateEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { dataDragon } from "../services/data-dragon";
import type { LcuChampSelectSession, DdChampion } from "../types/lol";

const logger = streamDeck.logger.createScope("TeamComp");

/**
 * Champion role/tag classifications for analysis.
 */
const ROLE_WEIGHTS = {
	tank: ["Tank"],
	fighter: ["Fighter", "Bruiser"],
	assassin: ["Assassin"],
	mage: ["Mage"],
	marksman: ["Marksman"],
	support: ["Support"],
};

/**
 * Team Comp Analyzer action — analyzes team compositions during champion select.
 * Shows damage distribution (AD vs AP), role balance, and team strengths/weaknesses.
 *
 * Key display: Brief team summary
 * Dial display:
 *   - Rotate: Switch between ally/enemy view
 *   - Shows damage split, roles, scaling rating
 */
@action({ UUID: "com.desstroct.lol-api.team-comp" })
export class TeamComp extends SingletonAction<TeamCompSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-dial state: viewing ally (0) or enemy (1) team */
	private dialStates: Map<string, { teamView: 0 | 1 }> = new Map();

	override onWillAppear(ev: WillAppearEvent<TeamCompSettings>): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			this.getDialState(ev.action.id);
			return ev.action.setFeedback({
				team_label: "ALLY TEAM",
				damage_split: "AD: -% | AP: -%",
				roles_text: "Waiting...",
				strengths: "",
				weaknesses: "",
			});
		}
		return ev.action.setTitle("Team\nComp");
	}

	override onWillDisappear(ev: WillDisappearEvent<TeamCompSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	override async onKeyDown(_ev: KeyDownEvent<TeamCompSettings>): Promise<void> {
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<TeamCompSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		ds.teamView = ds.teamView === 0 ? 1 : 0;
		await this.updateAll();
	}

	override async onTouchTap(_ev: TouchTapEvent<TeamCompSettings>): Promise<void> {
		await this.updateAll();
	}

	private getDialState(actionId: string): { teamView: 0 | 1 } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { teamView: 0 };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 3000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		// TFT not supported
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ team_label: "", damage_split: "N/A in TFT", roles_text: "", strengths: "", weaknesses: "" });
				} else {
					await a.setTitle("Comp\nN/A TFT");
				}
			}
			return;
		}

		// Only works in champ select
		const phase = await lcuApi.getGameflowPhase();
		if (phase !== "ChampSelect") {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						team_label: "TEAM COMP",
						damage_split: "",
						roles_text: "Enter Champ Select",
						strengths: "",
						weaknesses: "",
					});
				} else {
					await a.setTitle("Team\nNo CS");
				}
			}
			return;
		}

		const session = await lcuApi.getChampSelectSession();
		if (!session) {
			return;
		}

		// Analyze both teams
		const allyAnalysis = await this.analyzeTeam(session.myTeam.map((p) => p.championId));
		const enemyAnalysis = await this.analyzeTeam(session.theirTeam.map((p) => p.championId));

		for (const a of this.actions) {
			if (a.isDial()) {
				const ds = this.getDialState(a.id);
				const analysis = ds.teamView === 0 ? allyAnalysis : enemyAnalysis;
				const teamLabel = ds.teamView === 0 ? "ALLY TEAM" : "ENEMY TEAM";

				await a.setFeedback({
					team_label: teamLabel,
					damage_split: `AD: ${analysis.adPercent}% | AP: ${analysis.apPercent}%`,
					roles_text: analysis.rolesSummary,
					strengths: analysis.strengths.length > 0 ? `✓ ${analysis.strengths.join(", ")}` : "",
					weaknesses: analysis.weaknesses.length > 0 ? `✗ ${analysis.weaknesses.join(", ")}` : "",
				});
			} else {
				// Key: show compact comparison
				const adDiff = allyAnalysis.adPercent - enemyAnalysis.adPercent;
				const apDiff = allyAnalysis.apPercent - enemyAnalysis.apPercent;
				
				let summary = "";
				if (Math.abs(adDiff) > 20) {
					summary += adDiff > 0 ? "AD+" : "AD-";
				}
				if (Math.abs(apDiff) > 20) {
					summary += apDiff > 0 ? " AP+" : " AP-";
				}
				
				await a.setTitle(`Comp\n${summary || "Balanced"}`);
			}
		}
	}

	/**
	 * Analyze a team composition.
	 */
	private async analyzeTeam(championIds: number[]): Promise<TeamAnalysis> {
		const result: TeamAnalysis = {
			adPercent: 50,
			apPercent: 50,
			rolesSummary: "",
			strengths: [],
			weaknesses: [],
			tanks: 0,
			fighters: 0,
			assassins: 0,
			mages: 0,
			marksmen: 0,
			supports: 0,
		};

		// Filter out 0 (no champion picked yet)
		const validChampIds = championIds.filter((id) => id > 0);
		if (validChampIds.length === 0) {
			result.rolesSummary = "No picks yet";
			return result;
		}

		let totalAd = 0;
		let totalAp = 0;

		for (const champId of validChampIds) {
			const champ = dataDragon.getChampionByKey(String(champId));
			if (!champ) continue;

			// Damage type from info stats
			const ad = champ.info.attack;
			const ap = champ.info.magic;
			totalAd += ad;
			totalAp += ap;

			// Count roles
			for (const tag of champ.tags) {
				if (ROLE_WEIGHTS.tank.includes(tag)) result.tanks++;
				if (ROLE_WEIGHTS.fighter.includes(tag)) result.fighters++;
				if (ROLE_WEIGHTS.assassin.includes(tag)) result.assassins++;
				if (ROLE_WEIGHTS.mage.includes(tag)) result.mages++;
				if (ROLE_WEIGHTS.marksman.includes(tag)) result.marksmen++;
				if (ROLE_WEIGHTS.support.includes(tag)) result.supports++;
			}
		}

		// Calculate damage percentages
		const totalDmg = totalAd + totalAp;
		if (totalDmg > 0) {
			result.adPercent = Math.round((totalAd / totalDmg) * 100);
			result.apPercent = 100 - result.adPercent;
		}

		// Build role summary
		const roles: string[] = [];
		if (result.tanks > 0) roles.push(`${result.tanks}T`);
		if (result.fighters > 0) roles.push(`${result.fighters}F`);
		if (result.assassins > 0) roles.push(`${result.assassins}A`);
		if (result.mages > 0) roles.push(`${result.mages}M`);
		if (result.marksmen > 0) roles.push(`${result.marksmen}ADC`);
		if (result.supports > 0) roles.push(`${result.supports}S`);
		result.rolesSummary = roles.join(" ") || "?";

		// Determine strengths
		if (result.tanks >= 2) result.strengths.push("Frontline");
		if (result.assassins >= 2) result.strengths.push("Burst");
		if (result.mages >= 2 || result.apPercent >= 60) result.strengths.push("AP Heavy");
		if (result.marksmen >= 1 && result.tanks >= 1) result.strengths.push("Protected ADC");
		if (result.fighters >= 2) result.strengths.push("Skirmish");

		// Determine weaknesses
		if (result.tanks === 0) result.weaknesses.push("No Tank");
		if (result.marksmen === 0) result.weaknesses.push("No ADC");
		if (result.apPercent <= 15) result.weaknesses.push("Full AD");
		if (result.adPercent <= 15) result.weaknesses.push("Full AP");
		if (result.supports === 0 && validChampIds.length >= 4) result.weaknesses.push("No Enchanter");

		// Limit to top 2 each
		result.strengths = result.strengths.slice(0, 2);
		result.weaknesses = result.weaknesses.slice(0, 2);

		return result;
	}
}

type TeamCompSettings = {
	// No settings needed for now
};

interface TeamAnalysis {
	adPercent: number;
	apPercent: number;
	rolesSummary: string;
	strengths: string[];
	weaknesses: string[];
	tanks: number;
	fighters: number;
	assassins: number;
	mages: number;
	marksmen: number;
	supports: number;
}
