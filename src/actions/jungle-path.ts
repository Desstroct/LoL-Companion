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

// ──────────── Camp names, short labels & timing ────────────
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

/** Estimated time (seconds since game start) that each camp is typically CLEARED
 *  in a standard full-clear. Used for in-game auto-advance. */
const CAMP_CLEAR_TIMESTAMPS: Record<Camp, number> = {
	blue: 105,    // ~1:45
	gromp: 125,   // ~2:05
	wolves: 145,  // ~2:25
	raptors: 155, // ~2:35
	red: 165,     // ~2:45
	krugs: 175,   // ~2:55
	scuttle: 195, // ~3:15
	gank: 210,    // ~3:30
};

/** Compact emoji labels for camp reference in tight spaces */
const CAMP_EMOJI: Record<Camp, string> = {
	blue: "🔵", gromp: "🐸", wolves: "🐺", raptors: "🐔",
	red: "🔴", krugs: "🪨", scuttle: "🦀", gank: "⚔️",
};
// ──────────── Path definitions ────────────
interface JunglePathRoute {
	name: string;
	shortName: string;
	description: string;
	/** Camp sequence — same regardless of map side (the action flips labels contextually) */
	camps: Camp[];
	/** Message shown after the last camp is cleared */
	postClear?: string;
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
		postClear: "→ Gank or Drake",
	},
	fullClearRed: {
		name: "Full Clear (Red start)",
		shortName: "Full Red",
		description: "Optimal 6-camp clear starting red side",
		camps: ["red", "krugs", "raptors", "wolves", "blue", "gromp", "scuttle"],
		postClear: "→ Gank or Drake",
	},
	threeCampBlue: {
		name: "3-Camp Gank (Blue start)",
		shortName: "3C Blue",
		description: "Fast 3-camp into gank — Blue→Gromp→Red→Gank",
		camps: ["blue", "gromp", "red", "gank"],
		postClear: "→ Recall or Continue",
	},
	threeCampRed: {
		name: "3-Camp Gank (Red start)",
		shortName: "3C Red",
		description: "Fast 3-camp into gank — Red→Blue→Gromp→Gank",
		camps: ["red", "blue", "gromp", "gank"],
		postClear: "→ Recall or Continue",
	},
	threeCampRedKrugs: {
		name: "3-Camp Gank (Red+Krugs)",
		shortName: "3C RedK",
		description: "Red→Krugs→Raptors→Gank (bot-focused early)",
		camps: ["red", "krugs", "raptors", "gank"],
		postClear: "→ Recall or Bot lane",
	},
	fiveCampBlue: {
		name: "5-Camp Skip Krugs",
		shortName: "5C SkipK",
		description: "Blue→Gromp→Wolves→Raptors→Red→Scuttle (skip krugs for tempo)",
		camps: ["blue", "gromp", "wolves", "raptors", "red", "scuttle"],
		postClear: "→ Gank or Drake",
	},
	fiveCampRed: {
		name: "5-Camp Skip Gromp",
		shortName: "5C SkipG",
		description: "Red→Krugs→Raptors→Wolves→Blue→Scuttle (skip gromp for tempo)",
		camps: ["red", "krugs", "raptors", "wolves", "blue", "scuttle"],
		postClear: "→ Gank or Drake",
	},
	reverseFullBlue: {
		name: "Reverse Full (Blue→Top)",
		shortName: "Rev Blue",
		description: "Blue→Wolves→Raptors→Red→Krugs→Scuttle (reverse for flex gank)",
		camps: ["blue", "wolves", "raptors", "red", "krugs", "scuttle"],
		postClear: "→ Gank or Drake",
	},
	// ── New routes ──
	level2Gank: {
		name: "Level 2 Cheese Gank",
		shortName: "Lv2 Gank",
		description: "Red→Gank at level 2 for early kill pressure",
		camps: ["red", "gank"],
		postClear: "→ Recall then Full Clear",
	},
	level2GankBlue: {
		name: "Level 2 Cheese (Blue)",
		shortName: "Lv2 Blue",
		description: "Blue→Gank at level 2 (mid/top pressure)",
		camps: ["blue", "gank"],
		postClear: "→ Recall then Full Clear",
	},
	fourCampBlue: {
		name: "4-Camp Blue → Crab",
		shortName: "4C Blue",
		description: "Blue→Gromp→Wolves→Red→Scuttle (contest scuttle early)",
		camps: ["blue", "gromp", "wolves", "red", "scuttle"],
		postClear: "→ Gank or Drake",
	},
	fourCampRed: {
		name: "4-Camp Red → Crab",
		shortName: "4C Red",
		description: "Red→Raptors→Wolves→Blue→Scuttle (bot-side then crab)",
		camps: ["red", "raptors", "wolves", "blue", "scuttle"],
		postClear: "→ Gank or Drake",
	},
	invadeBlue: {
		name: "Invade (Enemy Blue)",
		shortName: "Inv Blue",
		description: "Red→Enemy Blue→Enemy Gromp→Gank (steal their blue side)",
		camps: ["red", "blue", "gromp", "gank"],
		postClear: "→ Back or Counter-jungle",
	},
	invadeRed: {
		name: "Invade (Enemy Red)",
		shortName: "Inv Red",
		description: "Blue→Enemy Red→Enemy Raptors→Gank (steal their red side)",
		camps: ["blue", "red", "raptors", "gank"],
		postClear: "→ Back or Counter-jungle",
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
	/** Skill order for first 3 levels (e.g. "Q→W→E") */
	skillOrder?: string;
	/** Starting ability (for display, e.g. "W" for Fiddlesticks) */
	startSkill?: string;
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
	masteryi: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Full clear always, scale hard", skillOrder: "Q→E→W", startSkill: "Q" },
	karthus: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue"], tip: "Red start preferred, AoE clear", skillOrder: "Q→E→W", startSkill: "Q" },
	shyvana: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Farm to 6, prioritize drakes", skillOrder: "W→E→Q", startSkill: "W" },
	diana: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Fast AoE clear, look for dives at 6", skillOrder: "W→Q→E", startSkill: "W" },
	lillia: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "fullClearRed"], tip: "Fastest full clear, invade enemy camps", skillOrder: "Q→W→E", startSkill: "Q" },
	udyr: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Very fast clear, contest scuttles", skillOrder: "Q→W→E", startSkill: "Q" },
	nocturne: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Farm to 6, then R-gank", skillOrder: "Q→W→E", startSkill: "Q" },
	kindred: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue", "threeCampRed"], tip: "Track marks, invade for them", skillOrder: "Q→W→E", startSkill: "Q" },
	belveth: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue"], tip: "Farm heavy, scale with resets", skillOrder: "E→Q→W", startSkill: "E" },
	kayn: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "fullClearRed"], tip: "Raptor start optional for AoE form stacking", skillOrder: "Q→W→E", startSkill: "Q" },
	viego: { style: "flexible", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "Flexible clear, strong skirmisher", skillOrder: "Q→W→E", startSkill: "Q" },
	graves: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue"], tip: "Kite camps, healthy full clears", skillOrder: "Q→E→W", startSkill: "Q" },
	hecarim: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "fullClearRed"], tip: "Fast clear with Q AoE, strong post-6 ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	amumu: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "AoE clear, strong post-6 ganks", skillOrder: "E→W→Q", startSkill: "E" },
	fiddlesticks: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "W-drain AoE clears, avoid early fights", skillOrder: "W→E→Q", startSkill: "W" },
	mordekaiser: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Passive AoE clears, strong 1v1 at 6", skillOrder: "Q→W→E", startSkill: "Q" },
	gwen: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Scale-heavy, look for dives at 6", skillOrder: "E→Q→W", startSkill: "E" },
	briar: { style: "powerFarmer", paths: ["fullClearRed", "fullClearBlue", "fiveCampRed"], tip: "Very healthy clear with W sustain", skillOrder: "Q→W→E", startSkill: "Q" },
	zyra: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Plant-based AoE clear", skillOrder: "Q→W→E", startSkill: "Q" },
	brand: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Passive burn clears camps fast", skillOrder: "W→E→Q", startSkill: "W" },
	taliyah: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Hard AoE clear, roam with R", skillOrder: "Q→W→E", startSkill: "Q" },

	// ── Gankers ──
	leesin: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Early gank power, ward-hop plays", skillOrder: "Q→E→W", startSkill: "Q" },
	elise: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "threeCampRedKrugs"], tip: "Level 3 power spike, tower dive queen", skillOrder: "W→Q→E", startSkill: "W" },
	jarvaniv: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Strong level 2-3 ganks with E-Q", skillOrder: "E→Q→W", startSkill: "E" },
	xinzhao: { style: "ganker", paths: ["threeCampRed", "threeCampRedKrugs", "fullClearRed"], tip: "Early duelist, gank at 3", skillOrder: "Q→W→E", startSkill: "Q" },
	reksai: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Tunnel ganks, strong early pressure", skillOrder: "Q→W→E", startSkill: "Q" },
	nidalee: { style: "ganker", paths: ["threeCampBlue", "threeCampRed", "level2Gank"], tip: "Must gank/invade early, falls off", skillOrder: "Q→W→E", startSkill: "Q" },
	nunu: { style: "ganker", paths: ["threeCampBlue", "threeCampRed", "level2GankBlue", "fullClearBlue"], tip: "Snowball ganks from level 2-3", skillOrder: "Q→W→E", startSkill: "Q" },
	zac: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "fiveCampBlue"], tip: "Long-range E ganks at level 4-5", skillOrder: "Q→W→E", startSkill: "Q" },
	sejuani: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "threeCampRed"], tip: "Strong CC ganks, play for lanes", skillOrder: "W→E→Q", startSkill: "W" },
	rammus: { style: "ganker", paths: ["fullClearBlue", "threeCampRed", "threeCampBlue"], tip: "Q-roll ganks, look for overextended lanes", skillOrder: "W→Q→E", startSkill: "W" },
	volibear: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Strong early duel, tower dive at 6", skillOrder: "Q→W→E", startSkill: "Q" },
	warwick: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Blood trail ganks, invade when enemies are low", skillOrder: "Q→W→E", startSkill: "Q" },
	pantheon: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "threeCampRedKrugs", "level2Gank"], tip: "Early lane dominant, roam with R at 6", skillOrder: "Q→E→W", startSkill: "Q" },
	twistedfate: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue"], tip: "Farm to 6, global R ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	talon: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Wall-hop ganks, invade weak junglers", skillOrder: "Q→W→E", startSkill: "Q" },
	qiyana: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "level2Gank"], tip: "Strong level 3 burst, terrain-based plays", skillOrder: "Q→W→E", startSkill: "Q" },
	vi: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Q ganks, point-and-click R at 6", skillOrder: "Q→E→W", startSkill: "Q" },
	wukong: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Strong level 2-3, team fight at 6", skillOrder: "Q→E→W", startSkill: "Q" },
	ivern: { style: "ganker", paths: ["threeCampBlue", "threeCampRed"], tip: "Mark & leave camps, perma-gank with Daisy", skillOrder: "Q→W→E", startSkill: "Q" },
	poppy: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "threeCampRed"], tip: "Wall-stun ganks, anti-dash", skillOrder: "Q→W→E", startSkill: "Q" },
	maokai: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue"], tip: "Sapling vision, root ganks", skillOrder: "E→Q→W", startSkill: "E" },
	rell: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Strong CC ganks, engage heavy", skillOrder: "Q→W→E", startSkill: "Q" },
	sylas: { style: "ganker", paths: ["threeCampBlue", "fullClearBlue", "threeCampRed"], tip: "Steal ults, flexible duelist", skillOrder: "Q→W→E", startSkill: "Q" },
	gragas: { style: "ganker", paths: ["threeCampBlue", "fullClearBlue", "threeCampRed"], tip: "E-flash ganks, body slam CC", skillOrder: "W→Q→E", startSkill: "W" },

	// ── Invaders ──
	khazix: { style: "invader", paths: ["threeCampRed", "fullClearRed", "threeCampBlue", "invadeRed"], tip: "Isolate & delete, invade weak junglers", skillOrder: "Q→W→E", startSkill: "Q" },
	rengar: { style: "invader", paths: ["threeCampRed", "fullClearRed", "threeCampBlue", "invadeBlue"], tip: "Bush-leap ganks, invade at 3", skillOrder: "Q→W→E", startSkill: "Q" },
	shaco: { style: "invader", paths: ["threeCampRedKrugs", "threeCampRed", "invadeRed", "level2Gank"], tip: "Box-trap start, invade & cheese", skillOrder: "W→Q→E", startSkill: "W" },
	evelynn: { style: "flexible", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Farm to 6, perma-stealth ganks", skillOrder: "Q→E→W", startSkill: "Q" },

	// ── Flexible ──
	ekko: { style: "flexible", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "Flex between farm and ganks, strong at 6", skillOrder: "Q→W→E", startSkill: "Q" },
	yone: { style: "flexible", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Scale 6, E-engage ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	aurora: { style: "flexible", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "R-zoning, flexible clear", skillOrder: "Q→W→E", startSkill: "Q" },
	ambessa: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Strong early pressure, dash-heavy ganks", skillOrder: "Q→E→W", startSkill: "Q" },
	naafiri: { style: "ganker", paths: ["threeCampRed", "fullClearRed"], tip: "Pack hunter, walls for gank angles", skillOrder: "Q→W→E", startSkill: "Q" },
	skarner: { style: "flexible", paths: ["fullClearBlue", "threeCampBlue", "fullClearRed"], tip: "Strong CC, E-stun ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	trundle: { style: "invader", paths: ["fullClearRed", "threeCampRed", "fullClearBlue", "invadeBlue"], tip: "Pillar ganks, steal stats with R", skillOrder: "Q→W→E", startSkill: "Q" },
	olaf: { style: "invader", paths: ["fullClearRed", "threeCampRed", "fullClearBlue"], tip: "Healthy clear, run-down ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	jax: { style: "flexible", paths: ["fullClearBlue", "fullClearRed", "threeCampRed"], tip: "Scale hard, strong at 2 items", skillOrder: "E→Q→W", startSkill: "E" },
	// ── Additional champions ──
	zed: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue", "level2Gank"], tip: "Shadow combos, invade weak junglers", skillOrder: "Q→W→E", startSkill: "Q" },
	drmundo: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Tanky clears, scale with HP", skillOrder: "Q→W→E", startSkill: "Q" },
	riven: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Animation cancel clears, early aggression", skillOrder: "Q→W→E", startSkill: "Q" },
	aatrox: { style: "ganker", paths: ["threeCampBlue", "fullClearBlue", "threeCampRed"], tip: "Q sweetspot clears, sustain heavy", skillOrder: "Q→E→W", startSkill: "Q" },
	camille: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "E-hookshot ganks, strong skirmisher", skillOrder: "Q→W→E", startSkill: "Q" },
	tahmkench: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "threeCampRed"], tip: "W-devour ganks, R for picks", skillOrder: "Q→W→E", startSkill: "Q" },
	monkeyking: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Clone+E engage, strong level 2-3", skillOrder: "Q→E→W", startSkill: "Q" },
	neeko: { style: "flexible", paths: ["fullClearBlue", "threeCampBlue", "fiveCampBlue"], tip: "Shapeshifter ganks, AoE R at 6", skillOrder: "Q→E→W", startSkill: "Q" },
	ksante: { style: "flexible", paths: ["fullClearBlue", "fullClearRed", "threeCampRed"], tip: "Tank with all-in R, scale late", skillOrder: "Q→W→E", startSkill: "Q" },

	// ── Extended roster ──
	fizz: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "level2Gank"], tip: "E-dodge engage, kill threat at 6", skillOrder: "Q→W→E", startSkill: "Q" },
	nautilus: { style: "ganker", paths: ["threeCampBlue", "threeCampRed", "fullClearBlue"], tip: "Hook ganks, massive CC chain", skillOrder: "Q→W→E", startSkill: "Q" },
	sett: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Strong early duelist, W shielded clears", skillOrder: "Q→W→E", startSkill: "Q" },
	irelia: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Stack passive on camps, mark-dive ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	katarina: { style: "ganker", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "Reset-heavy AoE clear, look for multi-kills", skillOrder: "W→Q→E", startSkill: "W" },
	twitch: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Farm to items, stealth ganks with Q", skillOrder: "Q→W→E", startSkill: "Q" },
	vayne: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Scale hard, tumble-kite clears", skillOrder: "Q→W→E", startSkill: "Q" },
	chogath: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Feast stacks on camps, tank scaling", skillOrder: "Q→W→E", startSkill: "Q" },
	malphite: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "threeCampRed"], tip: "Slow-but-healthy clears, R-gank at 6", skillOrder: "W→Q→E", startSkill: "W" },
	nasus: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Stack Q on camps, scale to late game", skillOrder: "Q→W→E", startSkill: "Q" },
	leona: { style: "ganker", paths: ["threeCampBlue", "threeCampRed", "fullClearBlue"], tip: "CC-heavy ganks, all-in with sunlight", skillOrder: "W→Q→E", startSkill: "W" },
	alistar: { style: "ganker", paths: ["threeCampBlue", "threeCampRed"], tip: "W-Q combo ganks, unstoppable with R", skillOrder: "W→Q→E", startSkill: "W" },
	blitzcrank: { style: "ganker", paths: ["threeCampBlue", "threeCampRed", "fullClearBlue"], tip: "Hook ganks from fog, one grab = kill", skillOrder: "Q→W→E", startSkill: "Q" },
	lux: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "threeCampBlue"], tip: "Snare ganks, nuke with R", skillOrder: "Q→E→W", startSkill: "Q" },
	viktor: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Slow early clear, snowball with items", skillOrder: "Q→W→E", startSkill: "Q" },
	swain: { style: "ganker", paths: ["threeCampBlue", "fullClearBlue", "threeCampRed"], tip: "E-root ganks, drain tank at 6", skillOrder: "E→Q→W", startSkill: "E" },
	rumble: { style: "powerFarmer", paths: ["fullClearBlue", "fiveCampBlue", "fullClearRed"], tip: "Overheat AoE clears, R for ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	teemo: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Blind clears safely, shroom vision", skillOrder: "Q→E→W", startSkill: "Q" },
	singed: { style: "invader", paths: ["invadeRed", "invadeBlue", "threeCampRed"], tip: "Run at enemies, proxy farm, fling into team", skillOrder: "Q→W→E", startSkill: "Q" },
	garen: { style: "ganker", paths: ["threeCampRed", "fullClearRed", "threeCampBlue"], tip: "Silence-spin clears, execute with R", skillOrder: "Q→W→E", startSkill: "Q" },
	darius: { style: "ganker", paths: ["threeCampRed", "threeCampBlue", "fullClearRed"], tip: "Bleed clears, dunk reset ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	fiora: { style: "invader", paths: ["threeCampRed", "fullClearRed", "threeCampBlue", "invadeBlue"], tip: "Parry camps, invade weak junglers", skillOrder: "Q→W→E", startSkill: "Q" },
	yasuo: { style: "flexible", paths: ["fullClearBlue", "threeCampBlue", "fiveCampBlue"], tip: "Q-tornado clears, knockup chain with team", skillOrder: "Q→W→E", startSkill: "Q" },
	ahri: { style: "ganker", paths: ["threeCampBlue", "fullClearBlue", "fiveCampBlue"], tip: "Charm ganks, R-dash engage", skillOrder: "Q→W→E", startSkill: "Q" },
	annie: { style: "ganker", paths: ["fullClearBlue", "threeCampBlue", "threeCampRed"], tip: "Stack stun passively on camps, Tibbers gank", skillOrder: "Q→W→E", startSkill: "Q" },
	gangplank: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed"], tip: "Farm gold with Q, barrels for ganks", skillOrder: "Q→W→E", startSkill: "Q" },
	urgot: { style: "powerFarmer", paths: ["fullClearBlue", "fullClearRed", "fiveCampBlue"], tip: "Tanky shotgun clears, execute with R", skillOrder: "Q→W→E", startSkill: "Q" },
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

// ──────────── SVG key composer ────────────

const CAMP_COLOR: Record<Camp, string> = {
	blue: "#3498DB", gromp: "#2ECC71", wolves: "#95A5A6",
	raptors: "#E67E22", red: "#E74C3C", krugs: "#CD853F",
	scuttle: "#1ABC9C", gank: "#F1C40F",
};

function escapeXmlJgl(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function composeJungleKey(
	campIcon: string | null,
	campName: string,
	stepNum: number,
	camps: Camp[],
	borderColor: string,
	skillLine: string,
	completed: boolean,
	postClear: string,
): string {
	const totalSteps = camps.length;
	const iconEl = campIcon
		? `<image href="${campIcon}" x="32" y="6" width="80" height="80" />`
		: `<rect x="32" y="6" width="80" height="80" fill="#1A2A3A" rx="6"/>`;

	const dotSpacing = Math.min(20, 120 / Math.max(totalSteps, 1));
	const dotsWidth = (totalSteps - 1) * dotSpacing;
	const dotsStartX = (144 - dotsWidth) / 2;
	const dots = camps.map((c, i) => {
		const cx = dotsStartX + i * dotSpacing;
		const isCurrent = !completed && i === stepNum - 1;
		const isPast = completed || i < stepNum - 1;
		const r = isCurrent ? 5 : 4;
		const fill = isCurrent ? "#F1C40F" : isPast ? CAMP_COLOR[c] : "#333355";
		const stroke = isCurrent ? "#FFFFFF" : "none";
		return `<circle cx="${cx}" cy="118" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
	}).join("");

	let mainText: string;
	let subText: string;
	if (completed) {
		mainText = `<text x="72" y="100" fill="#2ECC71" font-size="11" font-weight="bold" text-anchor="middle" font-family="Arial">✓ Done</text>`;
		subText = `<text x="72" y="112" fill="#AAAAAA" font-size="9" text-anchor="middle" font-family="Arial">${escapeXmlJgl(postClear)}</text>`;
	} else {
		const nameLabel = escapeXmlJgl(campName);
		const stepLabel = `${stepNum}/${totalSteps}`;
		mainText = `<text x="72" y="99" fill="#FFFFFF" font-size="10" font-weight="bold" text-anchor="middle" font-family="Arial">${nameLabel}</text>`;
		subText = skillLine
			? `<text x="72" y="110" fill="#F1C40F" font-size="9" text-anchor="middle" font-family="Arial">${escapeXmlJgl(skillLine)}</text>`
			: `<text x="72" y="110" fill="#AAAAAA" font-size="9" text-anchor="middle" font-family="Arial">Step ${stepLabel}</text>`;
	}

	const borderGlow = completed
		? `<rect x="2" y="2" width="140" height="140" rx="8" fill="none" stroke="#2ECC71" stroke-width="3" opacity="0.8"/>`
		: `<rect x="2" y="2" width="140" height="140" rx="8" fill="none" stroke="${borderColor}" stroke-width="3" opacity="0.7"/>`;

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
<rect width="144" height="144" fill="#0A1428" rx="8"/>
${borderGlow}
${iconEl}
${mainText}
${subText}
${dots}
</svg>`;
	return `data:image/svg+xml;base64,${btoa(svg)}`;
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
	private dialStates = new Map<string, { pathIndex: number; stepIndex: number; autoAdvance: boolean; completed: boolean }>();

	// Cached state
	private currentChampAlias = "";
	private currentChampName = "";
	private currentSide: "blue" | "red" = "blue";
	private currentPaths: JunglePathRoute[] = [];
	private currentTip = "";
	private currentSkillOrder = "";
	private currentStartSkill = "";
	private enemyJunglerName = "";
	private enemyJunglerAlias = "";
	private enemyJunglerStyle: PathStyle | "" = "";
	/** Whether we're currently in a live game (not just champ select) */
	private inGame = false;
	/** Last known game time for auto-advance tracking */
	private lastGameTime = 0;

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
			ds.completed = false;
			ds.autoAdvance = true;
		}
		await this.updateAll();
	}

	override async onDialRotate(ev: DialRotateEvent<JunglePathSettings>): Promise<void> {
		const ds = this.getDialState(ev.action.id);
		if (this.currentPaths.length === 0) return;
		const path = this.currentPaths[ds.pathIndex];
		if (!path) return;
		// Manual scroll disables auto-advance for this action
		ds.autoAdvance = false;
		ds.stepIndex = ((ds.stepIndex + ev.payload.ticks) + path.camps.length * 100) % path.camps.length;
		await this.updateAll();
	}

	override async onDialUp(ev: DialUpEvent<JunglePathSettings>): Promise<void> {
		// Press = switch path
		const ds = this.getDialState(ev.action.id);
		if (this.currentPaths.length > 0) {
			ds.pathIndex = (ds.pathIndex + 1) % this.currentPaths.length;
			ds.stepIndex = 0;
			ds.completed = false;
			ds.autoAdvance = true;
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

	private getDialState(actionId: string): { pathIndex: number; stepIndex: number; autoAdvance: boolean; completed: boolean } {
		let ds = this.dialStates.get(actionId);
		if (!ds) {
			ds = { pathIndex: 0, stepIndex: 0, autoAdvance: true, completed: false };
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

		// 3. In-game: auto-advance step based on game time
		if (this.inGame && this.lastGameTime > 0) {
			this.autoAdvanceSteps();
		}

		// 4. Render
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
		ds: { pathIndex: number; stepIndex: number; autoAdvance: boolean; completed: boolean },
		path: JunglePathRoute,
		side: "blue" | "red",
	): Promise<void> {
		if (!a.isDial()) return;

		if (ds.completed) {
			const champIcon = await this.getChampIcon();
			const postClearMsg = path.postClear ?? "→ Gank or Drake";
			await a.setFeedback({
				champ_icon: champIcon ?? "",
				title: `✓ ${path.shortName} Complete`,
				path_name: postClearMsg,
				camp_route: this.currentTip || "Press dial to switch path",
				step_bar: { value: 100, bar_fill_c: "#2ECC71" },
			});
			return;
		}

		const camp = path.camps[ds.stepIndex];
		const stepNum = ds.stepIndex + 1;
		const totalSteps = path.camps.length;
		const progress = Math.round((stepNum / totalSteps) * 100);

		// Icon: camp icon for current step, champion icon as fallback
		const campIcon = camp !== "gank" ? await getCampIcon(camp) : null;
		const champIcon = await this.getChampIcon();
		const displayIcon = campIcon ?? champIcon;

		// Title line: compact but informative
		const sideLabel = side === "blue" ? "🔵" : "🔴";
		const pathIndicator = this.currentPaths.length > 1
			? ` [${ds.pathIndex + 1}/${this.currentPaths.length}]`
			: "";
		const enemyTag = this.enemyJunglerName ? ` vs ${this.enemyJunglerName}` : "";
		const titleLine = `${this.currentChampName}${enemyTag} ${sideLabel}${pathIndicator}`;

		// Path name line: step counter + camp name + skill order
		const campName = campContext(camp, side);
		const skillTag = this.currentSkillOrder ? ` · ${this.currentSkillOrder}` : "";
		const pathNameLine = `▸ ${stepNum}/${totalSteps}  ${campName}`;

		// Camp route line: show upcoming camps (next 3) or tip/skill info
		let routeLine: string;
		if (ds.stepIndex < totalSteps - 1) {
			// Show next camps as preview
			const upcoming = path.camps
				.slice(ds.stepIndex + 1, ds.stepIndex + 4)
				.map((c) => CAMP_EMOJI[c] + CAMP_LABEL[c])
				.join(" → ");
			routeLine = `Next: ${upcoming}`;
		} else {
			// Last step — show tip or skill order
			routeLine = this.currentTip || path.description;
		}

		// If at step 1, show skill order instead of "next"
		if (ds.stepIndex === 0 && this.currentSkillOrder) {
			routeLine = `Skills: ${this.currentSkillOrder}${skillTag ? "" : ""}  •  ${routeLine}`;
			// Truncate if too long for the layout
			if (routeLine.length > 55) routeLine = `Start ${this.currentStartSkill || "Q"} · ${this.currentSkillOrder}`;
		}

		const barColor = this.getBarColor(camp);

		await a.setFeedback({
			champ_icon: displayIcon ?? "",
			title: titleLine,
			path_name: pathNameLine,
			camp_route: routeLine,
			step_bar: { value: progress, bar_fill_c: barColor },
		});
	}

	/** Render the key (button) display */
	private async renderKey(
		a: any,
		ds: { pathIndex: number; stepIndex: number; autoAdvance: boolean; completed: boolean },
		path: JunglePathRoute,
		side: "blue" | "red",
	): Promise<void> {
		const camp = path.camps[ds.stepIndex];
		const campIcon = camp !== "gank" ? await getCampIcon(camp) : null;
		const champIcon = await this.getChampIcon();
		const stepNum = ds.stepIndex + 1;
		const campName = campContext(camp, side);
		const postClearMsg = path.postClear ?? "→ Gank/Drake";
		const skillLine = ds.stepIndex === 0 && this.currentStartSkill
			? `Start ${this.currentStartSkill} · ${this.currentSkillOrder}`
			: "";
		const borderColor = ds.completed ? "#2ECC71" : CAMP_COLOR[camp] ?? "#2ECC71";

		const svgKey = composeJungleKey(
			campIcon ?? champIcon,
			campName,
			stepNum,
			path.camps,
			borderColor,
			skillLine,
			ds.completed,
			postClearMsg,
		);
		await a.setImage(svgKey);
		await a.setTitle("");
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
			this.inGame = true;
			this.lastGameTime = gameData.gameData?.gameTime ?? 0;
			await this.detectFromGame();
			return;
		}

		this.inGame = false;
		this.lastGameTime = 0;

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
		this.currentSkillOrder = "";
		this.currentStartSkill = "";
		this.enemyJunglerName = "";
		this.enemyJunglerAlias = "";
		this.enemyJunglerStyle = "";
		this.inGame = false;
		this.lastGameTime = 0;
	}

	// ─────────── Path resolution ───────────

	private resolvePaths(): void {
		if (!this.currentChampAlias) {
			this.currentPaths = [];
			this.currentTip = "";
			this.currentSkillOrder = "";
			this.currentStartSkill = "";
			return;
		}

		const info = CHAMPION_PATHS[this.currentChampAlias];
		let paths: string[];
		let tip: string;

		if (info) {
			paths = [...info.paths];
			tip = info.tip ?? "";
			this.currentSkillOrder = info.skillOrder ?? "";
			this.currentStartSkill = info.startSkill ?? "";
		} else {
			paths = [...STYLE_DEFAULTS.flexible];
			tip = "Default paths (champion not in DB)";
			this.currentSkillOrder = "";
			this.currentStartSkill = "";
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
				// Add invade routes if not present
				if (!paths.includes("invadeBlue")) paths.push("invadeBlue");
				if (!paths.includes("invadeRed")) paths.push("invadeRed");
			}
		}

		this.currentPaths = paths
			.map((key) => PATHS[key])
			.filter((p): p is JunglePathRoute => !!p);
		this.currentTip = tip;
	}

	// ─────────── In-game auto-advance ───────────

	/**
	 * Automatically advance the step index based on estimated camp clear times
	 * and current game time. Only advances for actions with autoAdvance enabled
	 * (i.e. the user hasn't manually scrolled).
	 * 
	 * Uses cumulative timestamps: if game time exceeds the estimated clear time
	 * for a camp, we advance past it. This gives the user a "follow along" experience.
	 */
	private autoAdvanceSteps(): void {
		if (this.lastGameTime <= 0) return;

		for (const [, ds] of this.dialStates) {
			if (!ds.autoAdvance || ds.completed) continue;
			const path = this.currentPaths[ds.pathIndex];
			if (!path) continue;

			let newStep = ds.stepIndex;
			for (let i = 0; i < path.camps.length; i++) {
				const campTime = CAMP_CLEAR_TIMESTAMPS[path.camps[i]];
				if (this.lastGameTime >= campTime) {
					newStep = i + 1;
				} else {
					break;
				}
			}

			if (newStep >= path.camps.length) {
				// All camps cleared — mark complete
				ds.completed = true;
				ds.stepIndex = path.camps.length - 1;
			} else if (newStep > ds.stepIndex) {
				ds.stepIndex = newStep;
			}
		}
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
