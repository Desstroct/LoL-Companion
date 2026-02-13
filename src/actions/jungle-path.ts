import {
	action,
	DialRotateEvent,
	DialUpEvent,
	KeyDownEvent,
	SingletonAction,
	TouchTapEvent,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { lcuConnector } from "../services/lcu-connector";
import { lcuApi } from "../services/lcu-api";
import { gameMode } from "../services/game-mode";
import { gameClient } from "../services/game-client";
import { dataDragon } from "../services/data-dragon";
import { getChampionIconByKey, getChampionIconByName, getCampIcon } from "../services/lol-icons";

const logger = streamDeck.logger.createScope("JunglePath");

// ──────────── Camp names & short labels ────────────
type Camp = "blue" | "gromp" | "wolves" | "raptors" | "red" | "krugs" | "scuttle" | "gank";
const CAMP_LABEL: Record<Camp, string> = {
	blue: "Blue",
	gromp: "Gromp",
	wolves: "Wolves",
	raptors: "Raptors",
	red: "Red",
	krugs: "Krugs",
	scuttle: "Scuttle",
	gank: "Gank",
};
// ──────────── Path definitions ────────────
interface JunglePathRoute {
	name: string;
	shortName: string;
	description: string;
	/** Camp sequence — same regardless of map side (the action flips labels contextually) */
	camps: Camp[];
}

/**
 * Predefined jungle paths.
 * "blue" / "red" refer to the BUFF COLOR, not the map side.
 * The action will contextualise labels (e.g. "Bot Blue" vs "Top Blue") based on team side.
 */
const PATHS: Record<string, JunglePathRoute> = {
	fullClearBlue: {
		name: "Full Clear (Blue start)",
		shortName: "Full Blue",
		description: "Optimal 6-camp clear starting blue side",
		camps: ["blue", "gromp", "wolves", "raptors", "red", "krugs", "scuttle"],
	},
	fullClearRed: {
		name: "Full Clear (Red start)",
		shortName: "Full Red",
		description: "Optimal 6-camp clear starting red side",
		camps: ["red", "krugs", "raptors", "wolves", "blue", "gromp", "scuttle"],
	},
	threeCampBlue: {
		name: "3-Camp Gank (Blue start)",
		shortName: "3C Blue",
		description: "Fast 3-camp into gank — Blue→Gromp→Red→Gank",
		camps: ["blue", "gromp", "red", "gank"],
	},
	threeCampRed: {
		name: "3-Camp Gank (Red start)",
		shortName: "3C Red",
		description: "Fast 3-camp into gank — Red→Blue→Gromp→Gank",
		camps: ["red", "blue", "gromp", "gank"],
	},
	threeCampRedKrugs: {
		name: "3-Camp Gank (Red+Krugs)",
		shortName: "3C RedK",
		description: "Red→Krugs→Raptors→Gank (bot-focused early)",
		camps: ["red", "krugs", "raptors", "gank"],
	},
	fiveCampBlue: {
		name: "5-Camp Skip Krugs",
		shortName: "5C SkipK",
		description: "Blue→Gromp→Wolves→Raptors→Red→Scuttle (skip krugs for tempo)",
		camps: ["blue", "gromp", "wolves", "raptors", "red", "scuttle"],
	},
	fiveCampRed: {
		name: "5-Camp Skip Gromp",
		shortName: "5C SkipG",
		description: "Red→Krugs→Raptors→Wolves→Blue→Scuttle (skip gromp for tempo)",
		camps: ["red", "krugs", "raptors", "wolves", "blue", "scuttle"],
	},
	reverseFullBlue: {
		name: "Reverse Full (Blue→Top)",
		shortName: "Rev Blue",
		description: "Blue→Wolves→Raptors→Red→Krugs→Gromp (reverse path for flex gank)",
		camps: ["blue", "wolves", "raptors", "red", "krugs", "scuttle"],
	},
};

// ──────────── Champion → recommended paths ────────────
/** Maps lowercase champion alias → array of path keys (preferred order). */
type PathStyle = "powerFarmer" | "ganker" | "invader" | "flexible";

interface ChampionPathInfo {
	style: PathStyle;
	/** Path keys in order of recommendation */
	paths: string[];
	/** Optional short tip */
	tip?: string;
}

const STYLE_DEFAULTS: Record<PathStyle, string[]> = {
	powerFarmer: ["fullClearBlue", "fullClearRed", "fiveCampBlue"],
	ganker: ["threeCampBlue", "threeCampRed", "threeCampRedKrugs"],
	invader: ["threeCampRed", "threeCampBlue", "fullClearRed"],
	flexible: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"],
};

/**
 * Champion-specific jungle path database.
 * Keys = DDragon champion IDs lowercased.
 */
const CHAMPION_PATHS: Record<string, ChampionPathInfo> = {
	// ── Power farmers ──
	masteryi: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Full clear always, scale hard" },
	karthus: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue"], tip: "Red start preferred, AoE clear" },
	shyvana: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Farm to 6, prioritize drakes" },
	diana: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Fast AoE clear, look for dives at 6" },
	lillia: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "fullClearRed"], tip: "Fastest full clear, invade enemy camps" },
	udyr: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Very fast clear, contest scuttles" },
	nocturne: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Farm to 6, then R-gank" },
	kindred: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue", "threeCampRed"], tip: "Track marks, invade for them" },
	belveth: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue"], tip: "Farm heavy, scale with resets" },
	kayn: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "fullClearRed"], tip: "Raptor start optional for AoE form stacking" },
	viego: { style: "flexible", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "Flexible clear, strong skirmisher" },
	graves: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue"], tip: "Kite camps, healthy full clears" },
	hecarim: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "fullClearRed"], tip: "Fast clear with Q AoE, strong post-6 ganks" },
	amumu: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "AoE clear, strong post-6 ganks" },
	fiddlesticks: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "W-drain AoE clears, avoid early fights" },
	mordekaiser: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Passive AoE clears, strong 1v1 at 6" },
	gwen: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Scale-heavy, look for dives at 6" },
	briar: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue", "fiveCampRed"], tip: "Very healthy clear with W sustain" },
	zyra: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Plant-based AoE clear" },
	brand: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Passive burn clears camps fast" },
	taliyah: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Hard AoE clear, roam with R" },

	// ── Gankers ──
	leesin: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Early gank power, ward-hop plays" },
	elise: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "threeCampRedKrugs"], tip: "Level 3 power spike, tower dive queen" },
	jarvaniv: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Strong level 2-3 ganks with E-Q" },
	xinzhao: { style: "ganker", paths: ["threeCampRed", "threeCampRedKrugs", "fullClearRed"], tip: "Early duelist, gank at 3" },
	reksai: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Tunnel ganks, strong early pressure" },
	nidalee: { style: "ganker", paths: ["threeCampBlue", "threeCampRed"], tip: "Must gank/invade early, falls off" },
	nunu: { style: "ganker", paths: ["threeCampBlue", "threeCampRed", "fullClearBlue"], tip: "Snowball ganks from level 2-3" },
	zac: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "fiveCampBlue"], tip: "Long-range E ganks at level 4-5" },
	sejuani: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "threeCampRed"], tip: "Strong CC ganks, play for lanes" },
	rammus: { style: "ganker", paths: ["fullClearBlue", "threeCampRed", "threeCampBlue"], tip: "Q-roll ganks, look for overextended lanes" },
	volibear: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Strong early duel, tower dive at 6" },
	warwick: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Blood trail ganks, invade when enemies are low" },
	pantheon: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "threeCampRedKrugs"], tip: "Early lane dominant, roam with R at 6" },
	twistedfate: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue"], tip: "Farm to 6, global R ganks" },
	talon: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Wall-hop ganks, invade weak junglers" },
	qiyana: { style: "ganker", paths: ["threeCampRed", "threeCampBlue"], tip: "Strong level 3 burst, terrain-based plays" },
	vi: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Q ganks, point-and-click R at 6" },
	wukong: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Strong level 2-3, team fight at 6" },
	ivern: { style: "ganker", paths: ["threeCampBlue", "threeCampRed"], tip: "Mark & leave camps, perma-gank with Daisy" },
	poppy: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "threeCampRed"], tip: "Wall-stun ganks, anti-dash" },
	maokai: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue"], tip: "Sapling vision, root ganks" },
	rell: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Strong CC ganks, engage heavy" },
	sylas: { style: "ganker", paths: ["threeCampBlue", "fullClearBlue", "threeCampRed"], tip: "Steal ults, flexible duelist" },
	gragas: { style: "ganker", paths: ["threeCampBlue", "fullClearBlue", "threeCampRed"], tip: "E-flash ganks, body slam CC" },

	// ── Invaders ──
	khazix: { style: "invader", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Isolate & delete, invade weak junglers" },
	rengar: { style: "invader", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Bush-leap ganks, invade at 3" },
	shaco: { style: "invader", paths: ["threeCampRedKrugs", "threeCampRed"], tip: "Box-trap start, invade & cheese" },
	evelynn: { style: "flexible", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Farm to 6, perma-stealth ganks" },

	// ── Flexible ──
	ekko: { style: "flexible", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "Flex between farm and ganks, strong at 6" },
	yone: { style: "flexible", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Scale 6, E-engage ganks" },
	aurora: { style: "flexible", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "R-zoning, flexible clear" },
	ambessa: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Strong early pressure, dash-heavy ganks" },
	naafiri: { style: "ganker", paths: ["threeCampRed", "fullClearRed"], tip: "Pack hunter, walls for gank angles" },
	skarner: { style: "flexible", paths: ["fullClearBlue", "threeCampBlue", "fullClearRed"], tip: "Strong CC, E-stun ganks" },
	trundle: { style: "invader", paths: ["fullClearRed", "threeCampRed", "fullClearBlue"], tip: "Pillar ganks, steal stats with R" },
	olaf: { style: "invader", paths: ["fullClearRed", "threeCampRed", "fullClearBlue"], tip: "Healthy clear, run-down ganks" },
	jax: { style: "flexible", paths: ["fullClearBlue", "fullClearRed", "threeCampRed"], tip: "Scale hard, strong at 2 items" },
};

// ── Jungle camp position context based on map side ──
function campContext(camp: Camp, side: "blue" | "red"): string {
	// Blue side: Blue buff = bot, Red buff = top
	// Red side: Blue buff = top, Red buff = bot
	if (camp === "blue") return side === "blue" ? "Bot Blue" : "Top Blue";
	if (camp === "red") return side === "blue" ? "Top Red" : "Bot Red";
	if (camp === "gromp") return side === "blue" ? "Bot Gromp" : "Top Gromp";
	if (camp === "krugs") return side === "blue" ? "Top Krugs" : "Bot Krugs";
	if (camp === "wolves") return "Wolves";
	if (camp === "raptors") return "Raptors";
	if (camp === "scuttle") return "Scuttle";
	return "Gank";
}

// ──────────── Settings ────────────
type JunglePathSettings = {
	/** Override side manually ("auto" | "blue" | "red") */
	side?: "auto" | "blue" | "red";
};

// ──────────── Action ────────────
@action({ UUID: "com.desstroct.lol-api.jungle-path" })
export class JunglePath extends SingletonAction<JunglePathSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private dialStates = new Map<string, { pathIndex: number; stepIndex: number }>();

	// Cached state
	private currentChampAlias = "";
	private currentChampName = "";
	private currentSide: "blue" | "red" = "blue";
	private currentPaths: JunglePathRoute[] = [];
	private currentTip = "";
	private enemyJunglerName = "";
	private enemyJunglerAlias = "";
	private enemyJunglerStyle: PathStyle | "" = "";

	// ─────────── Lifecycle ───────────

	override async onWillAppear(ev: WillAppearEvent<JunglePathSettings>): Promise<void> {
		// Always reset interval on appear (handles SD restart cleanly)
		this.stopPolling();
		this.startPolling();

		if (ev.action.isDial()) {
			this.getDialState(ev.action.id);
			await ev.action.setFeedback({
				champ_icon: "",
				title: "Jungle Path",
				path_name: "Waiting...",
				camp_route: "",
				step_bar: { value: 0 },
			});
		} else {
			await ev.action.setTitle("JGL Path\nWaiting...");
		}
	}

	override onWillDisappear(ev: WillDisappearEvent<JunglePathSettings>): void | Promise<void> {
		this.dialStates.delete(ev.action.id);
		if (this.actions.length === 0) {
			this.stopPolling();
			this.resetState();
		}
	}

	override async onKeyDown(ev: KeyDownEvent<JunglePathSettings>): Promise<void> {
		// Cycle to next recommended path
		const ds = this.getDialState(ev.action.id);
		if (this.currentPaths.length > 0) {
			ds.pathIndex = (ds.pathIndex + 1) % this.currentPaths.length;
			ds.stepIndex = 0;
		}
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<JunglePathSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		if (this.currentPaths.length === 0) return;
		const path = this.currentPaths[ds.pathIndex];
		if (!path) return;
		// Rotate = scroll through camps in the path
		ds.stepIndex = ((ds.stepIndex + ev.payload.ticks) + path.camps.length * 100) % path.camps.length;
		await this.updateAll();
	}

	override async onDialUp(ev: DialUpEvent<JunglePathSettings>): Promise<void> {
		// Press = switch path
		const ds = this.getDialState(ev.action.id);
		if (this.currentPaths.length > 0) {
			ds.pathIndex = (ds.pathIndex + 1) % this.currentPaths.length;
			ds.stepIndex = 0;
		}
		await this.updateAll();
	}

	override async onTouchTap(_ev: TouchTapEvent<JunglePathSettings>): Promise<void> {
		await this.updateAll();
	}

	// ─────────── Polling ───────────

	private startPolling(): void {
		if (this.pollInterval) return;
		this.updateAll().catch((e) => logger.error(`JunglePath poll error: ${e}`));
		this.pollInterval = setInterval(
			() => this.updateAll().catch((e) => logger.error(`JunglePath poll error: ${e}`)),
			4000,
		);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
		// Clear stale dial states on stop so restart is clean
		this.dialStates.clear();
	}

	private getDialState(actionId: string): { pathIndex: number; stepIndex: number } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { pathIndex: 0, stepIndex: 0 };
			this.dialStates.set(actionId, ds);
		}
		return ds;
	}

	// ─────────── Main update ───────────

	private async updateAll(): Promise<void> {
		// 1. Detect champion + side + enemy jungler
		await this.detectState();

		// 2. Resolve paths for this champion (considering enemy)
		this.resolvePaths();

		// 3. Render
		for (const a of this.actions) {
			const settings = (await a.getSettings()) as JunglePathSettings;
			const ds = this.getDialState(a.id);

			// Clamp indices if paths changed
			if (this.currentPaths.length > 0) {
				ds.pathIndex = ds.pathIndex % this.currentPaths.length;
			}
			const path = this.currentPaths[ds.pathIndex];

			if (!this.currentChampAlias || this.currentPaths.length === 0) {
				if (a.isDial()) {
					await a.setFeedback({
						champ_icon: "",
						title: "Jungle Path",
						path_name: !lcuConnector.isConnected() ? "Offline" : "Pick a JGL champ",
						camp_route: "",
						step_bar: { value: 0 },
					});
				} else {
					await a.setImage("");
					await a.setTitle(!lcuConnector.isConnected() ? "JGL Path\nOffline" : "JGL Path\nPick JGL");
				}
				continue;
			}

			const side = settings.side && settings.side !== "auto" ? settings.side : this.currentSide;

			if (a.isDial() && path) {
				await this.renderDial(a, ds, path, side);
			} else if (path) {
				await this.renderKey(a, ds, path, side);
			}
		}
	}

	/** Render the dial/encoder touchscreen */
	private async renderDial(
		a: any,
		ds: { pathIndex: number; stepIndex: number },
		path: JunglePathRoute,
		side: "blue" | "red",
	): Promise<void> {
		if (!a.isDial()) return;

		const camp = path.camps[ds.stepIndex];
		const stepNum = ds.stepIndex + 1;
		const totalSteps = path.camps.length;
		const progress = Math.round((stepNum / totalSteps) * 100);

		// Icon: camp icon for current step, champion icon as fallback
		const campIcon = camp !== "gank" ? await getCampIcon(camp) : null;
		const champIcon = await this.getChampIcon();
		const displayIcon = campIcon ?? champIcon;

		// Line 1 (title): "Hecarim · Blue Side" or "Hecarim vs Lee Sin"
		const sideLabel = side === "blue" ? "Blue" : "Red";
		const enemyPart = this.enemyJunglerName ? ` vs ${this.enemyJunglerName}` : "";
		const titleLine = `${this.currentChampName}${enemyPart} · ${sideLabel}`;

		// Line 2 (path_name): "▸ 3/7  Red Buff" — clear current step
		const campName = campContext(camp, side);
		const pathNameLine = `▸ ${stepNum}/${totalSteps}  ${campName}`;

		// Line 3 (camp_route): compact route with current step highlighted
		// e.g. "Full Blue:  Blue → Gromp → [Wolves] → Raptors → Red → Krugs → Scuttle"
		const routeParts = path.camps.map((c, i) => {
			const label = CAMP_LABEL[c];
			return i === ds.stepIndex ? `[${label}]` : label;
		});
		const routeLine = `${path.shortName}: ${routeParts.join(" → ")}`;

		// Tip override if we have one from enemy analysis
		const detailLine = this.currentTip || routeLine;

		const barColor = this.getBarColor(camp);

		await a.setFeedback({
			champ_icon: displayIcon ?? "",
			title: titleLine,
			path_name: pathNameLine,
			camp_route: detailLine,
			step_bar: { value: progress, bar_fill_c: barColor },
		});
	}

	/** Render the key (button) display */
	private async renderKey(
		a: any,
		ds: { pathIndex: number; stepIndex: number },
		path: JunglePathRoute,
		side: "blue" | "red",
	): Promise<void> {
		const camp = path.camps[ds.stepIndex];

		// Show camp icon on key (visually identifies where to go)
		const campIcon = camp !== "gank" ? await getCampIcon(camp) : null;
		const champIcon = await this.getChampIcon();
		if (campIcon) {
			await a.setImage(campIcon);
		} else if (champIcon) {
			await a.setImage(champIcon);
		}

		// Simple and readable title:
		// Line 1: "Full Blue 3/7"
		// Line 2: "→ Wolves"
		const stepNum = ds.stepIndex + 1;
		const totalSteps = path.camps.length;
		const campName = campContext(camp, side);

		await a.setTitle(`${path.shortName} ${stepNum}/${totalSteps}\n→ ${campName}`);
	}

	/** Return a contextual bar color based on the camp type */
	private getBarColor(camp: Camp): string {
		switch (camp) {
			case "blue": return "#3498DB";    // blue
			case "red": return "#E74C3C";     // red
			case "gromp": return "#2ECC71";   // green
			case "wolves": return "#95A5A6";  // grey
			case "raptors": return "#E67E22"; // orange
			case "krugs": return "#8B4513";   // brown
			case "scuttle": return "#1ABC9C"; // teal
			case "gank": return "#F1C40F";    // gold
			default: return "#2ECC71";
		}
	}

	// ─────────── State detection ───────────

	private async detectState(): Promise<void> {
		// ── Always try the Live Game Client first (works without LCU) ──
		// This is critical when SD starts mid-game or LCU hasn't connected yet.
		const gameData = await gameClient.getAllData();
		if (gameData?.activePlayer) {
			await this.detectFromGame();
			return;
		}

		// ── Fallback to LCU for champ-select detection ──
		if (!lcuConnector.isConnected()) {
			// Neither game client nor LCU available
			if (!this.currentChampAlias) this.resetState();
			return;
		}

		if (gameMode.isTFT() || gameMode.isARAM()) {
			this.resetState();
			return;
		}

		const phase = await lcuApi.getGameflowPhase();

		if (phase === "ChampSelect") {
			await this.detectFromChampSelect();
		} else if (phase === "InProgress" || phase === "GameStart" || phase === "Reconnect") {
			// In case game client didn't respond above, retry from LCU context
			await this.detectFromGame();
		} else {
			// Keep previous state if we had one (e.g. during loading screen)
			if (!this.currentChampAlias) this.resetState();
		}
	}

	private async detectFromChampSelect(): Promise<void> {
		const session = await lcuApi.getChampSelectSession();
		if (!session) return;

		const me = session.myTeam.find((p) => p.cellId === session.localPlayerCellId);
		if (!me) return;

		// Check if assigned to jungle
		if (me.assignedPosition !== "jungle") {
			this.resetState();
			return;
		}

		// Get champion
		const champId = me.championId || me.championPickIntent;
		if (!champId) return;

		const champ = dataDragon.getChampionByKey(String(champId));
		if (champ) {
			this.currentChampAlias = champ.id.toLowerCase().replace(/['\s.]/g, "");
			this.currentChampName = champ.name;
		}

		// Detect side from team order (team 1 = blue side, team 2 = red side)
		this.currentSide = session.localPlayerCellId < 5 ? "blue" : "red";

		// Detect enemy jungler from theirTeam
		this.enemyJunglerName = "";
		this.enemyJunglerAlias = "";
		this.enemyJunglerStyle = "";
		const enemyJungler = session.theirTeam.find((p) => p.assignedPosition === "jungle");
		if (enemyJungler) {
			const enemyChampId = enemyJungler.championId || enemyJungler.championPickIntent;
			if (enemyChampId) {
				const enemyChamp = dataDragon.getChampionByKey(String(enemyChampId));
				if (enemyChamp) {
					this.enemyJunglerName = enemyChamp.name;
					this.enemyJunglerAlias = enemyChamp.id.toLowerCase().replace(/['\s.]/g, "");
					const enemyInfo = CHAMPION_PATHS[this.enemyJunglerAlias];
					this.enemyJunglerStyle = enemyInfo?.style ?? "";
				}
			}
		}
	}

	private async detectFromGame(): Promise<void> {
		// Ensure DataDragon is loaded (might have failed at plugin boot)
		if (!dataDragon.isReady()) {
			await dataDragon.init();
		}

		const allData = await gameClient.getAllData();
		if (!allData) return;

		const activePlayer = allData.activePlayer;
		if (!activePlayer) return;

		// Find the active player in the player list
		const me = allData.allPlayers?.find(
			(p) => p.summonerName === activePlayer.summonerName || p.riotIdGameName === activePlayer.summonerName,
		);
		if (!me) {
			logger.warn("detectFromGame: could not find active player in allPlayers list");
			return;
		}

		// Check if the player has Smite or is assigned Jungle position
		const spell1 = (me.summonerSpells?.summonerSpellOne?.displayName ?? "").toLowerCase();
		const spell2 = (me.summonerSpells?.summonerSpellTwo?.displayName ?? "").toLowerCase();
		const hasSmite = spell1.includes("smite") || spell2.includes("smite");
		const isJungle = hasSmite || (me.position ?? "").toUpperCase() === "JUNGLE";

		if (!isJungle) {
			// Keep state if already set from champ select
			if (!this.currentChampAlias) this.resetState();
			return;
		}

		logger.info(`detectFromGame: JGL detected — ${me.championName}, team=${me.team}`);

		const champName = me.championName;
		if (champName) {
			const champ = dataDragon.getChampionByName(champName);
			if (champ) {
				this.currentChampAlias = champ.id.toLowerCase().replace(/['\s.]/g, "");
				this.currentChampName = champ.name;
			} else {
				this.currentChampAlias = champName.toLowerCase().replace(/['\s.]/g, "");
				this.currentChampName = champName;
			}
		}

		// Detect side from team (ORDER = blue side, CHAOS = red side)
		this.currentSide = me.team === "ORDER" ? "blue" : "red";

		// Detect enemy jungler from allPlayers (enemy team with Smite)
		const myTeam = me.team;
		const enemies = allData.allPlayers?.filter((p) => p.team !== myTeam) ?? [];
		const enemyJgl = enemies.find((p) => {
			const s1 = (p.summonerSpells?.summonerSpellOne?.displayName ?? "").toLowerCase();
			const s2 = (p.summonerSpells?.summonerSpellTwo?.displayName ?? "").toLowerCase();
			return s1.includes("smite") || s2.includes("smite") || (p.position ?? "").toUpperCase() === "JUNGLE";
		});
		if (enemyJgl?.championName) {
			this.enemyJunglerName = enemyJgl.championName;
			const enemyChamp = dataDragon.getChampionByName(enemyJgl.championName);
			if (enemyChamp) {
				this.enemyJunglerAlias = enemyChamp.id.toLowerCase().replace(/['\s.]/g, "");
				const enemyInfo = CHAMPION_PATHS[this.enemyJunglerAlias];
				this.enemyJunglerStyle = enemyInfo?.style ?? "";
			}
		}
	}

	private resetState(): void {
		this.currentChampAlias = "";
		this.currentChampName = "";
		this.currentPaths = [];
		this.currentTip = "";
		this.enemyJunglerName = "";
		this.enemyJunglerAlias = "";
		this.enemyJunglerStyle = "";
	}

	// ─────────── Path resolution ───────────

	private resolvePaths(): void {
		if (!this.currentChampAlias) {
			this.currentPaths = [];
			this.currentTip = "";
			return;
		}

		const info = CHAMPION_PATHS[this.currentChampAlias];
		let paths: string[];
		let tip: string;

		if (info) {
			paths = [...info.paths];
			tip = info.tip ?? "";
		} else {
			paths = [...STYLE_DEFAULTS.flexible];
			tip = "Default paths (champion not in DB)";
		}

		// ── Enemy-aware path adjustment ──
		if (this.enemyJunglerStyle) {
			const myStyle = info?.style ?? "flexible";

			if (this.enemyJunglerStyle === "invader" || this.enemyJunglerStyle === "ganker") {
				// Enemy is aggressive early — prefer starting opposite side to avoid invade
				// Boost paths that start on the OPPOSITE buff (away from likely invade)
				if (myStyle === "powerFarmer") {
					// Power farmer vs invader: try to avoid them, full clear on safe side
					tip = `⚠️ ${this.enemyJunglerName} invades early! Start away`;
					// Prioritize paths that start redside (krugs→safe) if enemy comes blue
					if (!paths.includes("fiveCampBlue")) paths.push("fiveCampBlue");
					if (!paths.includes("fiveCampRed")) paths.push("fiveCampRed");
				}
			} else if (this.enemyJunglerStyle === "powerFarmer" && myStyle === "ganker") {
				// They farm, we gank — highlight 3-camp aggression
				tip = `${this.enemyJunglerName} farms → gank early for lead!`;
				// Ensure 3-camp paths are first
				const threeCamps = paths.filter((p) => p.startsWith("threeCamp"));
				const rest = paths.filter((p) => !p.startsWith("threeCamp"));
				paths = [...threeCamps, ...rest];
			} else if (this.enemyJunglerStyle === "powerFarmer" && myStyle === "invader") {
				// They farm, we invade — highlight invade paths
				tip = `${this.enemyJunglerName} farms → invade their jungle!`;
			}
		}

		this.currentPaths = paths
			.map((key) => PATHS[key])
			.filter((p): p is JunglePathRoute => !!p);
		this.currentTip = tip;
	}

	// ─────────── Icon helper ───────────

	private async getChampIcon(): Promise<string | null> {
		if (!this.currentChampAlias) return null;
		const ddId = this.currentChampAlias;
		// Try by alias first (works from champ select)
		for (const champ of dataDragon.getAllChampions()) {
			const champLower = champ.id.toLowerCase().replace(/['\s.]/g, "");
			if (champLower === ddId) {
				return getChampionIconByKey(champ.key);
			}
		}
		// Fallback by name
		return getChampionIconByName(this.currentChampName);
	}
}
