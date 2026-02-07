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
import { lcuConnector } from "./services/lcu-connector";
import { dataDragon } from "./services/data-dragon";

// Enable trace logging for development
streamDeck.logger.setLevel("trace");

const logger = streamDeck.logger.createScope("Plugin");

// Initialize services
async function init() {
	logger.info("LoL Companion plugin starting...");

	// Initialize Data Dragon (champion & spell static data)
	await dataDragon.init();

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

// Connect to Stream Deck and initialize
streamDeck.connect().then(() => {
	init().catch((e) => logger.error(`Init failed: ${e}`));
});
