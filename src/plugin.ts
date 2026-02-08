import streamDeck from "@elgato/streamdeck";

import { GameStatus } from "./actions/game-status";
import { LobbyScannerAction } from "./actions/lobby-scanner";
import { SummonerTracker } from "./actions/summoner-tracker";
import { JungleTimer } from "./actions/jungle-timer";
import { KdaTracker } from "./actions/kda-tracker";
import { AutoAccept } from "./actions/auto-accept";
import { Counterpick } from "./actions/counterpick";
import { BestPick } from "./actions/best-pick";
import { LobbyLevelTracker } from "./actions/lobby-level";
import { AutoRune } from "./actions/auto-rune";
import { BestItem } from "./actions/best-item";
import { DeathTimer } from "./actions/death-timer";
import { AutoPick } from "./actions/auto-pick";
import { lcuConnector } from "./services/lcu-connector";
import { dataDragon } from "./services/data-dragon";

// Enable trace logging for development
streamDeck.logger.setLevel("trace");

const logger = streamDeck.logger.createScope("Plugin");

// ── Global error handlers (prevent plugin crashes) ──
process.on("uncaughtException", (err) => {
	logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
	logger.error(`Unhandled rejection: ${reason}`);
});

// Initialize services
async function init() {
	logger.info("LoL Companion plugin starting...");

	// Initialize Data Dragon with retry (network may be slow on startup)
	for (let attempt = 1; attempt <= 3; attempt++) {
		await dataDragon.init();
		if (dataDragon.getVersion() !== "14.24.1" || attempt === 3) break;
		logger.warn(`DataDragon init attempt ${attempt} may have failed, retrying in ${attempt * 2}s...`);
		await new Promise((r) => setTimeout(r, attempt * 2000));
	}

	// Start polling for the League Client
	lcuConnector.startPolling(3000);

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
streamDeck.actions.registerAction(new Counterpick());
streamDeck.actions.registerAction(new BestPick());
streamDeck.actions.registerAction(new LobbyLevelTracker());
streamDeck.actions.registerAction(new AutoRune());
streamDeck.actions.registerAction(new BestItem());
streamDeck.actions.registerAction(new DeathTimer());
streamDeck.actions.registerAction(new AutoPick());

// Connect to Stream Deck and initialize
streamDeck.connect().then(() => {
	init().catch((e) => logger.error(`Init failed: ${e}`));
});
