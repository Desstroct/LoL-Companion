import {
	action,
	DialRotateEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { GamePlayer } from "../types/lol";
import { gameClient } from "../services/game-client";
import { gameMode } from "../services/game-mode";
import { itemBuilds, ItemBuilds } from "../services/item-builds";
import type { ItemBuild } from "../services/item-builds";
import { dataDragon } from "../services/data-dragon";
import { getItemIcon, prefetchItemIcons } from "../services/lol-icons";
import { fetchPlayerTier } from "../services/lolalytics-tier";

const logger = streamDeck.logger.createScope("BestItem");

/** Tier-2 boots IDs — if any is owned, consider the "boots" slot filled */
const TIER2_BOOTS = new Set([
	3006, // Berserker's Greaves
	3009, // Boots of Swiftness
	3020, // Sorcerer's Shoes
	3047, // Plated Steelcaps
	3111, // Mercury's Treads
	3117, // Mobility Boots
	3158, // Ionian Boots of Lucidity
]);

/** Per-action instance state for BestItem */
interface BestItemState {
	currentBuild: ItemBuild | null;
	currentChampion: string | null;
	currentLane: string | null;
	currentStyle: "ap" | "ad" | null;
	/** -1 = auto (next item), 0 = starting items, 1..N = build item at index N-1 */
	browseIndex: number;
	/** True once the auto-transition from slot 0 → auto has fired (prevents re-triggering) */
	autoTransitioned: boolean;
}

/**
 * Best Item action — recommends the next item to buy based on live game data.
 *
 * Key display: item icon + name + cost
 * Dial display: item icon, name, cost, gold progress bar, BUY/SAVE status
 * Dial rotate: slot 0 = starting items, slots 1–N = full build items
 */
@action({ UUID: "com.desstroct.lol-api.best-item" })
export class BestItem extends SingletonAction {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	/** Per-action instance state for dial browsing and build data */
	private actionStates = new Map<string, BestItemState>();
	private buildPromise: Promise<ItemBuild | null> | null = null;
	/** Cooldown after a failed build fetch (stop infinite retry spam) */
	private buildFailedUntil = 0;
	/** Cached player tier for elo-aware build recommendations */
	private playerTier: string | null = null;

	override onWillAppear(ev: WillAppearEvent): void | Promise<void> {
		this.startPolling();
		if (ev.action.isDial()) {
			ev.action.setFeedbackLayout("layouts/best-item.json");
			return ev.action.setFeedback({
				title: "BEST ITEM",
				item_name: "Waiting...",
				cost_text: "",
				gold_bar: { value: 0 },
				status_text: "",
			});
		}
		return ev.action.setTitle("Best Item\nWaiting...");
	}

	override onWillDisappear(ev: WillDisappearEvent): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) {
			this.stopPolling();
			this.buildFailedUntil = 0;
		}
	}

	override onDialRotate(ev: DialRotateEvent): void | Promise<void> {
		const state = this.getState(ev.action.id);
		if (!state.currentBuild || state.currentBuild.fullBuild.length === 0) return;

		const len = state.currentBuild.fullBuild.length;
		const isSupport = state.currentLane === "support";
		// Support: skip slot 0 (starting items are always the same)
		// Non-support: slot 0 = starting items, slots 1..len = build items
		const minSlot = isSupport ? 1 : 0;
		if (state.browseIndex === -1) {
			// Exiting auto mode
			state.browseIndex = ev.payload.ticks > 0 ? minSlot : len;
		} else {
			state.browseIndex += ev.payload.ticks > 0 ? 1 : -1;
			if (state.browseIndex > len) state.browseIndex = minSlot;
			if (state.browseIndex < minSlot) state.browseIndex = len;
		}

		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
	}

	private getState(actionId: string): BestItemState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { currentBuild: null, currentChampion: null, currentLane: null, currentStyle: null, browseIndex: 0, autoTransitioned: false };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private startPolling(): void {
		this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`));
		if (this.pollInterval) return;
		this.pollInterval = setInterval(() => this.updateAll().catch((e) => logger.error(`updateAll error: ${e}`)), 2000);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async updateAll(): Promise<void> {
		// TFT has a different item system / no Live Client Data API
		if (gameMode.isTFT()) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ item_icon: "", title: "BEST ITEM", item_name: "N/A in TFT", cost_text: "", gold_bar: { value: 0 }, status_text: "" });
				} else {
					await a.setImage(""); await a.setTitle("Best Item\nN/A TFT");
				}
			}
			return;
		}

		const allData = await gameClient.getAllData();

		// ── No game running ──
		if (!allData) {
			// Reset state for next game
			this.buildFailedUntil = 0;
			this.playerTier = null;
			for (const s of this.actionStates.values()) {
				if (s.currentChampion) {
					s.currentChampion = null;
					s.currentLane = null;
					s.currentBuild = null;
					s.browseIndex = 0;
					s.autoTransitioned = false;
				}
			}

			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({
						item_icon: "",
						title: "BEST ITEM",
						item_name: "No game",
						cost_text: "",
						gold_bar: { value: 0 },
						status_text: "",
					});
				} else {
					await a.setImage("");
					await a.setTitle("Best Item\nNo game");
				}
			}
			return;
		}

		// ── Find active player ──
		const me = gameClient.findMe(allData);

		if (!me) {
			for (const a of this.actions) {
				if (a.isDial()) {
					await a.setFeedback({ item_name: "Player?", cost_text: "", status_text: "" });
				} else {
					await a.setTitle("Best Item\n?");
				}
			}
			return;
		}

		// DataDragon needed for alias lookup, patch version, and item names.
		// On plugin restart it may still be initializing — skip until ready.
		if (!dataDragon.isReady()) return;

		// ── Fetch build if not loaded yet (shared across instances — same champion) ──
		const champName = me.championName;
		const lane = gameMode.isARAM() ? "aram" : ItemBuilds.toLolalyticsLane(me.position);

		// Guard: if champion name isn't available yet (loading screen), skip
		if (!champName || champName === "") {
			logger.debug("Champion name not available yet, skipping build fetch");
			return;
		}

		// Detect AP/AD style from items the player already owns, with rune fallback
		// activePlayer may be null briefly during game startup — skip until it's ready
		const fullRunes = allData.activePlayer?.fullRunes;
		if (!fullRunes) return;
		const detectedStyle = detectBuildStyle(
			me.items,
			fullRunes.primaryRuneTree.id,
			fullRunes.secondaryRuneTree.id,
		);

		// Detect enemy team's damage type from their actual in-game items
		const enemies = allData.allPlayers.filter(p => p.team !== me.team);
		const enemyType = detectEnemyDamageType(enemies);

		// Fetch player tier once per game for elo-aware builds
		if (this.playerTier === null) {
			this.playerTier = await fetchPlayerTier();
			logger.info(`Best Item elo filter: ${this.playerTier}`);
		}

		for (const a of this.actions) {
			const state = this.getState(a.id);

			const champChanged = champName !== state.currentChampion || lane !== state.currentLane;
			const styleChanged = detectedStyle !== state.currentStyle;
			const needsFetch = champChanged || styleChanged || (!state.currentBuild && !this.buildPromise);

			if (needsFetch) {
				state.currentChampion = champName;
				state.currentLane = lane;
				state.currentStyle = detectedStyle;
				// Only hard-reset the build on a champion/lane change.
				// On style change or missing build, keep the existing build visible while re-fetching.
				if (champChanged) {
					state.currentBuild = null;
					state.autoTransitioned = false;
					// Support always starts on auto (next item) — starter is always the same
					state.browseIndex = lane === "support" ? -1 : 0;
				}

				// Cooldown: skip refetch if we recently failed (15s) — but always retry on style change
				if (!styleChanged && Date.now() < this.buildFailedUntil) {
					if (!state.currentBuild) continue; // nothing to show — skip render too
					// else: fall through to render the existing build
				} else if (!this.buildPromise) {
					// Only show "Loading..." when there is nothing to display yet
					if (!state.currentBuild) {
						if (a.isDial()) {
							await a.setFeedback({ item_name: "Loading build...", cost_text: "", status_text: "" });
						} else {
							await a.setTitle("Best Item\nLoading...");
						}
					}

					const alias = ItemBuilds.toAlias(champName);
					this.buildPromise = itemBuilds.getBuild(alias, lane, detectedStyle ?? undefined, this.playerTier ?? undefined).catch((e) => {
						logger.error(`Failed to fetch build: ${e}`);
						return null;
					});
				}

				if (this.buildPromise) {
					try {
						const build = await this.buildPromise;

						if (build) {
							// Distribute build — start on starting items (except support)
							for (const s of this.actionStates.values()) {
								if (s.currentChampion === champName && s.currentLane === lane) {
									s.currentBuild = build;
									s.autoTransitioned = false;
									s.browseIndex = lane === "support" ? -1 : 0;
								}
							}
							prefetchItemIcons([...build.startingItems, ...build.fullBuild]);
						} else {
							this.buildFailedUntil = Date.now() + 15_000; // retry in 15s
							// Only show "No data" if there is no fallback build to render
							if (!state.currentBuild) {
								if (a.isDial()) {
									await a.setFeedback({ item_name: "No data", cost_text: "", status_text: "" });
								} else {
									await a.setTitle("Best Item\nNo data");
								}
							}
						}
					} finally {
						this.buildPromise = null;
					}
				}
			}

			if (!state.currentBuild || state.currentBuild.fullBuild.length === 0) continue;

			// ── Determine which item to display ──
			const playerItemIds = new Set(me.items.map((i) => i.itemID));
			const playerGold = allData.activePlayer.currentGold;

			// Adapt boots to enemy damage type when player hasn't bought boots yet
			const rawBuild = state.currentBuild.fullBuild;
			const playerHasBoots = rawBuild.some(id => playerItemIds.has(id) && TIER2_BOOTS.has(id));
			const build = (!playerHasBoots && enemyType)
				? adaptBootsToEnemy(rawBuild, enemyType)
				: rawBuild;

			const styleLabel = state.currentStyle ? ` · ${state.currentStyle.toUpperCase()}` : "";

			// ── Starting items: auto-transition to build once player buys (one-shot) ──
			if (state.browseIndex === 0 && !state.autoTransitioned) {
				const hasAnyItem = me.items.length > 0 && me.items.some(i => i.itemID !== 0);
				if (hasAnyItem) {
					state.browseIndex = -1;
					state.autoTransitioned = true;
				}
			}

			if (state.browseIndex === 0) {
				const startItems = state.currentBuild.startingItems;
				if (startItems.length > 0) {
					const firstName = dataDragon.getItemName(startItems[0]);
					const firstIcon = await getItemIcon(startItems[0]);
					const totalCost = startItems.reduce((sum, id) => sum + dataDragon.getItemCost(id), 0);
					if (a.isDial()) {
						const secondName = startItems.length > 1 ? dataDragon.getItemName(startItems[1]) : "";
						await a.setFeedback({
							item_icon: firstIcon ?? "",
							title: `STARTING${styleLabel}`,
							item_name: truncate(firstName, 18),
							cost_text: startItems.length > 1 ? `+ ${truncate(secondName, 14)}` : "",
							gold_bar: { value: 0, bar_fill_c: "#888888" },
							status_text: `~${formatGold(totalCost)}g`,
						});
					} else {
						const icons = await Promise.all(startItems.slice(0, 3).map((id) => getItemIcon(id)));
						const names = startItems.slice(0, 3).map((id) => dataDragon.getItemName(id));
						await a.setImage(composeStartingItemsKey(icons, names, totalCost));
						await a.setTitle("");
					}
				}
				continue;
			}

			let displayItemId: number;
			let displayItemIdx = 0;
			let displaySlotLabel: string;
			let isNextToBuy: boolean;

			if (state.browseIndex >= 1 && state.browseIndex <= build.length) {
				// ── Browse mode: slot N maps to build[N-1] ──
				displayItemIdx = state.browseIndex - 1;
				displayItemId = build[displayItemIdx];
				displaySlotLabel = `Item ${displayItemIdx + 1}/${build.length}${styleLabel}`;
				isNextToBuy = false;
			} else {
				// ── Auto mode: find next item to buy ──
				const nextIdx = this.findNextItemIndex(build, playerItemIds);

				if (nextIdx === -1) {
					// Full build complete!
					if (a.isDial()) {
						await a.setFeedback({
							item_icon: "",
							title: "BUILD",
							item_name: "Complete!",
							cost_text: `${formatGold(playerGold)}g`,
							gold_bar: { value: 100, bar_fill_c: "#2ECC71" },
							status_text: "Full build ✓",
						});
					} else {
						await a.setImage(composeBuildCompleteKey(build.length));
						await a.setTitle("");
					}
					continue;
				}

				displayItemId = build[nextIdx];
				displayItemIdx = nextIdx;
				displaySlotLabel = `NEXT (${nextIdx + 1}/${build.length})${styleLabel}`;
				isNextToBuy = true;
			}

			// ── Get item info ──
			const itemName = dataDragon.getItemName(displayItemId);
			const itemCost = dataDragon.getItemCost(displayItemId);
			const itemIcon = await getItemIcon(displayItemId);

			const canAfford = playerGold >= itemCost;
			const owned = isItemOwned(displayItemId, playerItemIds);

			// Gold progress towards item (0-100%)
			const goldProgress = itemCost > 0
				? Math.min(100, Math.round((playerGold / itemCost) * 100))
				: 100;

			// Component names — shown in browse mode instead of redundant cost info
			const componentStr = getComponentDisplay(displayItemId);

			// Status text
			let statusText: string;
			let barColor: string;
			if (owned) {
				statusText = "Owned ✓";
				barColor = "#2ECC71";
			} else if (canAfford && isNextToBuy) {
				statusText = "BUY NOW!";
				barColor = "#2ECC71";
			} else if (isNextToBuy) {
				const needed = itemCost - playerGold;
				statusText = `Need ${formatGold(needed)}g`;
				barColor = "#F1C40F";
			} else {
				statusText = componentStr || `${formatGold(itemCost)}g`;
				barColor = "#888888";
			}

			const costText = `${formatGold(itemCost)}g | ${formatGold(playerGold)}g`;

			if (a.isDial()) {
				await a.setFeedback({
					item_icon: itemIcon ?? "",
					title: displaySlotLabel,
					item_name: truncate(itemName, 18),
					cost_text: costText,
					gold_bar: {
						value: owned ? 100 : goldProgress,
						bar_fill_c: barColor,
					},
					status_text: statusText,
				});
			} else {
				await a.setImage(composeItemKey(itemIcon, itemName, playerGold, itemCost, canAfford, isNextToBuy, owned, build, playerItemIds, displayItemIdx, componentStr));
				await a.setTitle("");
			}
		}
	}

	private findNextItemIndex(build: number[], playerItemIds: Set<number>): number {
		for (let i = 0; i < build.length; i++) {
			if (!isItemOwned(build[i], playerItemIds)) return i;
		}
		return -1;
	}
}

// ── Helpers ──

/**
 * Count AP vs AD items across the enemy team to detect their damage type.
 * Requires at least 3 tagged items total before returning a signal.
 */
function detectEnemyDamageType(enemies: GamePlayer[]): "ap" | "ad" | null {
	let ap = 0, ad = 0;
	for (const enemy of enemies) {
		for (const item of enemy.items) {
			const tags = dataDragon.getItem(String(item.itemID))?.tags ?? [];
			if (tags.includes("SpellDamage")) ap++;
			if (tags.includes("Damage")) ad++;
		}
	}
	const total = ap + ad;
	if (total < 3) return null;
	if (ap >= ad * 1.5) return "ap";
	if (ad >= ap * 1.5) return "ad";
	return null;
}

/** Swap the boots slot to counter the enemy's dominant damage type. */
function adaptBootsToEnemy(fullBuild: number[], enemyType: "ap" | "ad"): number[] {
	const adapted = [...fullBuild];
	const bootsIdx = adapted.findIndex(id => TIER2_BOOTS.has(id));
	if (bootsIdx === -1) return adapted;
	adapted[bootsIdx] = enemyType === "ap" ? 3111 : 3047; // Mercury's Treads or Plated Steelcaps
	return adapted;
}

/**
 * Infer AP/AD build style from the player's current items and rune trees.
 *
 * Items take priority: count DDragon "SpellDamage" tags (AP) vs "Damage" tags (AD).
 * Falls back to rune tree IDs when items don't give a clear signal
 * (8200=Sorcery→AP, 8000=Precision/8400=Resolve→AD, Domination uses secondary tree).
 */
function detectBuildStyle(
	playerItems: { itemID: number }[],
	primaryTreeId: number,
	secondaryTreeId: number,
): "ap" | "ad" | null {
	let ap = 0, ad = 0;
	for (const item of playerItems) {
		const tags = dataDragon.getItem(String(item.itemID))?.tags ?? [];
		if (tags.includes("SpellDamage")) ap++;
		if (tags.includes("Damage")) ad++;
	}
	if (ap > ad) return "ap";
	if (ad > ap) return "ad";

	// Item signal inconclusive — use rune trees
	const SORCERY = 8200, PRECISION = 8000, RESOLVE = 8400, DOMINATION = 8100;
	if (primaryTreeId === SORCERY) return "ap";
	if (primaryTreeId === PRECISION || primaryTreeId === RESOLVE) return "ad";
	// Domination primary: use secondary tree as tiebreaker
	if (primaryTreeId === DOMINATION) {
		if (secondaryTreeId === SORCERY) return "ap";
		if (secondaryTreeId === PRECISION) return "ad";
	}
	// Inspiration primary: use secondary tree
	if (secondaryTreeId === SORCERY) return "ap";
	if (secondaryTreeId === PRECISION || secondaryTreeId === RESOLVE) return "ad";

	return null;
}

function isItemOwned(itemId: number, playerItemIds: Set<number>): boolean {
	if (playerItemIds.has(itemId)) return true;
	if (TIER2_BOOTS.has(itemId)) {
		for (const bootId of TIER2_BOOTS) {
			if (playerItemIds.has(bootId)) return true;
		}
	}
	return false;
}

/** Short string listing the component items for a given item (e.g., "Dirk + Long Sword"). */
function getComponentDisplay(itemId: number): string {
	const comps = dataDragon.getItemComponents(itemId);
	if (comps.length === 0) return "";
	return comps.slice(0, 2).map(id => truncate(dataDragon.getItemName(id), 11)).join(" + ");
}

function escapeXml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function composeStartingItemsKey(
	icons: (string | null)[],
	names: string[],
	totalCost: number,
): string {
	const S = 144;
	const cr = 12;
	const GOLD_C = '#C89B3C';
	const BLUE = '#3498DB';

	const count = Math.min(icons.length, 3);
	const iconSize = count === 1 ? 80 : count === 2 ? 58 : 40;
	const gap = 8;
	const totalW = count * iconSize + (count - 1) * gap;
	const startX = Math.round((S - totalW) / 2);
	const iconY = 24;

	let itemsSvg = '';
	for (let i = 0; i < count; i++) {
		const x = startX + i * (iconSize + gap);
		if (icons[i]) {
			itemsSvg += `<clipPath id="si${i}"><rect x="${x}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="6"/></clipPath>
			<image href="${icons[i]}" x="${x}" y="${iconY}" width="${iconSize}" height="${iconSize}" clip-path="url(#si${i})"/>`;
		} else {
			itemsSvg += `<rect x="${x}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="6" fill="#1a2a3a"/>`;
		}
		const cx = x + Math.round(iconSize / 2);
		const nameY = iconY + iconSize + 12;
		itemsSvg += `<text x="${cx}" y="${nameY}" font-size="9" fill="#CCCCCC" text-anchor="middle" font-family="sans-serif">${escapeXml(truncate(names[i] ?? "", 10))}</text>`;
	}

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
		<rect width="${S}" height="${S}" rx="${cr}" fill="#0A1428"/>
		<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 2}" fill="none" stroke="${BLUE}" stroke-width="3"/>
		<text x="${S / 2}" y="16" font-size="10" fill="${BLUE}" text-anchor="middle" font-family="sans-serif" font-weight="600">STARTING</text>
		${itemsSvg}
		<text x="${S / 2}" y="136" font-size="10" fill="${GOLD_C}" text-anchor="middle" font-family="sans-serif">~${formatGold(totalCost)}g</text>
	</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function composeItemKey(
	itemIcon: string | null,
	itemName: string,
	playerGold: number,
	itemCost: number,
	canAfford: boolean,
	isNextToBuy: boolean,
	owned: boolean,
	build: number[],
	playerItemIds: Set<number>,
	currentIdx: number,
	componentStr: string,
): string {
	const S = 144;
	const cr = 12;
	const GREEN = '#2ECC71';
	const GOLD_C = '#C89B3C';

	let borderColor: string;
	let glowColor = '';
	if (owned) {
		borderColor = GREEN;
	} else if (canAfford && isNextToBuy) {
		borderColor = GREEN;
		glowColor = GREEN;
	} else if (isNextToBuy) {
		const progress = itemCost > 0 ? playerGold / itemCost : 0;
		borderColor = progress >= 0.75 ? GOLD_C : '#555555';
	} else {
		borderColor = '#333333';
	}

	let statusText: string;
	let statusColor: string;
	if (owned) {
		statusText = 'Owned ✓';
		statusColor = GREEN;
	} else if (canAfford && isNextToBuy) {
		statusText = 'BUY NOW!';
		statusColor = GREEN;
	} else if (isNextToBuy) {
		statusText = `Need ${formatGold(itemCost - playerGold)}g`;
		statusColor = GOLD_C;
	} else {
		statusText = componentStr || `${formatGold(itemCost)}g`;
		statusColor = '#AAAAAA';
	}

	const glowSvg = glowColor
		? `<defs><radialGradient id="gl" cx="50%" cy="40%" r="60%">
			<stop offset="0%" stop-color="${glowColor}" stop-opacity="0.3"/>
			<stop offset="100%" stop-color="${glowColor}" stop-opacity="0"/>
		   </radialGradient></defs>
		   <rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="8" fill="url(#gl)"/>`
		: '';

	const iconSvg = itemIcon
		? `<clipPath id="ic"><rect x="28" y="6" width="88" height="86" rx="8"/></clipPath>
		   <image href="${itemIcon}" x="28" y="6" width="88" height="86" clip-path="url(#ic)"/>`
		: `<rect x="28" y="6" width="88" height="86" rx="8" fill="#1a2a3a"/>
		   <text x="72" y="57" font-size="32" text-anchor="middle" font-family="sans-serif" fill="#444">?</text>`;

	const dotCount = Math.min(build.length, 6);
	const dotR = 4;
	const spacing = 14;
	const totalW = (dotCount - 1) * spacing + dotR * 2;
	const startX = Math.round((S - totalW) / 2) + dotR;
	const dotY = 122;

	let dots = '';
	for (let i = 0; i < dotCount; i++) {
		const cx = startX + i * spacing;
		const slotOwned = isItemOwned(build[i], playerItemIds);
		const isCurrent = i === currentIdx;
		if (slotOwned) {
			dots += `<circle cx="${cx}" cy="${dotY}" r="${dotR}" fill="${GREEN}"/>`;
		} else if (isCurrent) {
			dots += `<circle cx="${cx}" cy="${dotY}" r="${dotR + 1}" fill="${GOLD_C}"/>`;
		} else {
			dots += `<circle cx="${cx}" cy="${dotY}" r="${dotR}" fill="none" stroke="#555555" stroke-width="1.5"/>`;
		}
	}

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
		<rect width="${S}" height="${S}" rx="${cr}" fill="#0A1428"/>
		${glowSvg}
		${iconSvg}
		<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 2}" fill="none" stroke="${borderColor}" stroke-width="3"/>
		<text x="${S / 2}" y="106" font-size="11" fill="white" text-anchor="middle" font-family="sans-serif">${escapeXml(truncate(itemName, 14))}</text>
		${dots}
		<text x="${S / 2}" y="139" font-size="10" fill="${statusColor}" text-anchor="middle" font-family="sans-serif">${escapeXml(statusText)}</text>
	</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function composeBuildCompleteKey(buildLength: number): string {
	const S = 144;
	const cr = 12;
	const GREEN = '#2ECC71';
	const GOLD_C = '#C89B3C';

	const dotCount = Math.min(buildLength, 6);
	const dotR = 4;
	const spacing = 14;
	const totalW = (dotCount - 1) * spacing + dotR * 2;
	const startX = Math.round((S - totalW) / 2) + dotR;
	const dotY = 122;
	let dots = '';
	for (let i = 0; i < dotCount; i++) {
		dots += `<circle cx="${startX + i * spacing}" cy="${dotY}" r="${dotR}" fill="${GREEN}"/>`;
	}

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
		<rect width="${S}" height="${S}" rx="${cr}" fill="#0A1428"/>
		<defs><radialGradient id="gl" cx="50%" cy="50%" r="55%">
			<stop offset="0%" stop-color="${GREEN}" stop-opacity="0.25"/>
			<stop offset="100%" stop-color="${GREEN}" stop-opacity="0"/>
		</radialGradient></defs>
		<rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="8" fill="url(#gl)"/>
		<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="${cr - 2}" fill="none" stroke="${GREEN}" stroke-width="3"/>
		<text x="${S / 2}" y="64" font-size="48" text-anchor="middle" font-family="sans-serif" fill="${GREEN}">✓</text>
		<text x="${S / 2}" y="92" font-size="14" fill="white" text-anchor="middle" font-family="sans-serif">Build</text>
		<text x="${S / 2}" y="108" font-size="14" fill="${GOLD_C}" text-anchor="middle" font-family="sans-serif">Complete!</text>
		${dots}
	</svg>`;

	return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}


function formatGold(gold: number): string {
	if (gold >= 1000) return `${(gold / 1000).toFixed(1)}k`;
	return String(gold);
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.substring(0, maxLen - 1) + "…";
}
