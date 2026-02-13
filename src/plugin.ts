// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  RIOT / VANGUARD COMPLIANCE — READ BEFORE ADDING ANY FEATURE              ║
// ║                                                                            ║
// ║  This plugin ONLY uses two official, Riot-sanctioned data sources:         ║
// ║                                                                            ║
// ║  ✅ ALLOWED — LCU API (League Client, localhost, HTTPS)                    ║
// ║     • Reading: game phase, lobby, champ select, match history, runes,      ║
// ║       ranked stats, summoner info, item sets                               ║
// ║     • Writing: accept match, pick/ban champion, set rune page,             ║
// ║       set item sets — all things a human does via the client UI            ║
// ║     • Same API used by Blitz, Porofessor, Mobalytics, U.GG, OP.GG         ║
// ║                                                                            ║
// ║  ✅ ALLOWED — Live Client Data API (in-game, 127.0.0.1:2999)              ║
// ║     • Read-only: player stats, scores, items, abilities, game time         ║
// ║     • Built and documented by Riot specifically for overlays               ║
// ║     • Only exposes data already visible on the player's screen             ║
// ║                                                                            ║
// ║  ✅ ALLOWED — Public websites / APIs (Lolalytics, OP.GG, DDragon, CDN)    ║
// ║     • Static data: champion stats, counter picks, item builds, icons       ║
// ║                                                                            ║
// ║  ──────────────────────────────────────────────────────────────────────     ║
// ║                                                                            ║
// ║  🚫 NEVER DO ANY OF THE FOLLOWING — instant ban by Vanguard:               ║
// ║                                                                            ║
// ║  ❌ Read/write game process memory (LeagueOfLegends.exe)                   ║
// ║  ❌ Inject input into the game window (auto-dodge, auto-combo, scripting)  ║
// ║  ❌ Intercept or modify network packets to/from the game server            ║
// ║  ❌ Modify game files (textures, particles, hitboxes, camera zoom)         ║
// ║  ❌ Access fog-of-war data or enemy positions not visible on screen        ║
// ║  ❌ Automate in-game actions (mouse clicks, key presses in game window)    ║
// ║  ❌ Interact with Vanguard (vgk.sys / vgtray.exe) in any way              ║
// ║                                                                            ║
// ║  Rule of thumb: LCU (client/launcher) = fair game.                         ║
// ║                 LeagueOfLegends.exe (game process) = never touch.          ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

// ── Silence EPIPE immediately (before any import touches stdout) ──
// When Stream Deck restarts the plugin, the stdio pipes close. Any further
// writes (including from the SDK logger) would throw EPIPE and crash the
// process in a cascade.  Swallowing the error keeps the process alive long
// enough for a clean shutdown.
for (const stream of [process.stdout, process.stderr]) {
	stream?.on?.("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
		// Re-throw anything that isn't a pipe error
		throw err;
	});
}

import streamDeck from "@elgato/streamdeck";

import { GameStatus } from "./actions/game-status";
import { LobbyScannerAction } from "./actions/lobby-scanner";
import { SummonerTracker } from "./actions/summoner-tracker";
import { JungleTimer } from "./actions/jungle-timer";
import { KdaTracker } from "./actions/kda-tracker";
import { AutoAccept } from "./actions/auto-accept";
import { SmartPick } from "./actions/smart-pick";
import { LobbyLevelTracker } from "./actions/lobby-level";
import { AutoRune } from "./actions/auto-rune";
import { BestItem } from "./actions/best-item";
import { EnemyBuilds } from "./actions/enemy-builds";
import { DeathTimer } from "./actions/death-timer";
import { AutoPick } from "./actions/auto-pick";
import { LpTracker } from "./actions/lp-tracker";
import { JunglePath } from "./actions/jungle-path";
import { lcuConnector } from "./services/lcu-connector";
import { gameMode } from "./services/game-mode";
import { dataDragon } from "./services/data-dragon";

streamDeck.logger.setLevel("info");

const logger = streamDeck.logger.createScope("Plugin");

// ── Global error handlers (prevent plugin crashes) ──
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
	// EPIPE is already handled on the streams — don't log (it'd EPIPE again)
	if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
	try { logger.error(`Uncaught exception: ${err.message}\n${err.stack}`); } catch { /* swallow */ }
});
process.on("unhandledRejection", (reason) => {
	try { logger.error(`Unhandled rejection: ${reason}`); } catch { /* swallow */ }
});

async function init() {
	logger.info("LoL Companion plugin starting...");

	// Initialize Data Dragon with retry (network may be slow on startup)
	for (let attempt = 1; attempt <= 3; attempt++) {
		await dataDragon.init();
		if (dataDragon.isReady() || attempt === 3) break;
		logger.warn(`DataDragon init attempt ${attempt} may have failed, retrying in ${attempt * 2}s...`);
		await new Promise((r) => setTimeout(r, attempt * 2000));
	}

	// Start polling for the League Client
	lcuConnector.startPolling(3000);

	// Start centralised game-mode detection (LoL vs TFT vs ARAM etc.)
	gameMode.start();

	lcuConnector.onConnectionChange((creds) => {
		if (creds) {
			logger.info(`League Client connected (port ${creds.port})`);
		} else {
			logger.info("League Client disconnected");
		}
	});

	logger.info("LoL Companion plugin initialized");
}

// Register actions
streamDeck.actions.registerAction(new GameStatus());
streamDeck.actions.registerAction(new LobbyScannerAction());
streamDeck.actions.registerAction(new SummonerTracker());
streamDeck.actions.registerAction(new JungleTimer());
streamDeck.actions.registerAction(new KdaTracker());
streamDeck.actions.registerAction(new AutoAccept());
streamDeck.actions.registerAction(new SmartPick());
streamDeck.actions.registerAction(new LobbyLevelTracker());
streamDeck.actions.registerAction(new AutoRune());
streamDeck.actions.registerAction(new BestItem());
streamDeck.actions.registerAction(new EnemyBuilds());
streamDeck.actions.registerAction(new DeathTimer());
streamDeck.actions.registerAction(new AutoPick());
streamDeck.actions.registerAction(new LpTracker());
streamDeck.actions.registerAction(new JunglePath());

// Connect to Stream Deck and initialize
streamDeck.connect().then(() => {
	init().catch((e) => logger.error(`Init failed: ${e}`));
});
