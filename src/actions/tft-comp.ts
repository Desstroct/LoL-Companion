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
import { getTftComps, clearTftCache, type TftComp } from "../services/tft-comps";

const logger = streamDeck.logger.createScope("TftComp");

// LoL / TFT color palette
const DARK_BLUE = "#0A1428";
const GOLD = "#C89B3C";
const GREEN = "#2ECC71";
const BLUE = "#3498DB";
const RED = "#E74C3C";
const PURPLE = "#9B59B6";

/** Tier colors */
const TIER_COLORS: Record<string, string> = {
	S: "#FF7F50", // coral / orange
	A: GREEN,
	B: BLUE,
	N: "#95A5A6", // gray (new / untiered)
};

/** Tier filter options */
const FILTER_OPTIONS = ["ALL", "S", "A", "B"] as const;
type TierFilter = (typeof FILTER_OPTIONS)[number];

interface TftCompState {
	compIndex: number;
	tierFilter: TierFilter;
}

type TftCompSettings = {
	tierFilter?: TierFilter;
};

/**
 * TFT Comp Advisor — shows the current meta team compositions for TFT.
 *
 * Data sourced from tftactics.gg tier list, cached for 2 hours.
 *
 * Key press: cycle through comps / force refresh
 * Dial rotate: scroll through comps
 * Dial press: cycle tier filter (All → S → A → B → All)
 * Touch: force refresh data
 */
@action({ UUID: "com.desstroct.lol-api.tft-comp" })
export class TftCompAdvisor extends SingletonAction<TftCompSettings> {
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private actionStates = new Map<string, TftCompState>();
	private lastComps: TftComp[] = [];
	private dataLoaded = false;

	override onWillAppear(ev: WillAppearEvent<TftCompSettings>): void | Promise<void> {
		const filter = ev.payload.settings.tierFilter ?? "ALL";
		const state = this.getState(ev.action.id, filter);
		this.startPolling();

		if (ev.action.isDial()) {
			return ev.action.setFeedback({
				title: "TFT Meta Comps",
				comp_name: "Loading...",
				comp_info: "",
				champ_list: "",
				tier_bar: { value: 0 },
			});
		}
		return ev.action.setTitle("TFT\nComps");
	}

	override onWillDisappear(ev: WillDisappearEvent<TftCompSettings>): void | Promise<void> {
		this.actionStates.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPolling();
	}

	/** Key press: next comp */
	override async onKeyDown(ev: KeyDownEvent<TftCompSettings>): Promise<void> {
		const state = this.getState(ev.action.id, ev.payload.settings.tierFilter);
		const filtered = this.getFilteredComps(state.tierFilter);
		if (filtered.length > 0) {
			state.compIndex = (state.compIndex + 1) % filtered.length;
		}
		await this.renderAll();
	}

	/** Dial rotate: scroll through comps */
	override async onDialRotate(ev: DialRotateEvent<TftCompSettings>): Promise<void> {
		const state = this.getState(ev.action.id, ev.payload.settings.tierFilter);
		const filtered = this.getFilteredComps(state.tierFilter);
		if (filtered.length > 0) {
			state.compIndex = ((state.compIndex + ev.payload.ticks) + filtered.length * 100) % filtered.length;
		}
		await this.renderAll();
	}

	/** Dial press: cycle tier filter */
	override async onDialUp(ev: DialUpEvent<TftCompSettings>): Promise<void> {
		const state = this.getState(ev.action.id, ev.payload.settings.tierFilter);
		const idx = FILTER_OPTIONS.indexOf(state.tierFilter);
		state.tierFilter = FILTER_OPTIONS[(idx + 1) % FILTER_OPTIONS.length];
		state.compIndex = 0;
		await this.renderAll();
	}

	/** Touch: force refresh */
	override async onTouchTap(_ev: TouchTapEvent<TftCompSettings>): Promise<void> {
		clearTftCache();
		this.dataLoaded = false;
		await this.fetchComps();
		await this.renderAll();
	}

	private getState(actionId: string, filter?: TierFilter): TftCompState {
		let s = this.actionStates.get(actionId);
		if (!s) {
			s = { compIndex: 0, tierFilter: filter ?? "ALL" };
			this.actionStates.set(actionId, s);
		}
		return s;
	}

	private getFilteredComps(filter: TierFilter): TftComp[] {
		if (filter === "ALL") return this.lastComps;
		return this.lastComps.filter((c) => c.tier === filter);
	}

	private startPolling(): void {
		if (this.pollInterval) return;

		// Initial fetch
		this.fetchComps()
			.then(() => this.renderAll())
			.catch((e) => logger.error(`TFT fetch error: ${e}`));

		// Refresh every 30 minutes (data is cached for 2h, but we check periodically)
		this.pollInterval = setInterval(
			() => {
				this.fetchComps()
					.then(() => this.renderAll())
					.catch((e) => logger.error(`TFT poll error: ${e}`));
			},
			30 * 60 * 1000,
		);
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	private async fetchComps(): Promise<void> {
		const comps = await getTftComps();
		if (comps.length > 0) {
			this.lastComps = comps;
			this.dataLoaded = true;
		}
	}

	private async renderAll(): Promise<void> {
		for (const a of this.actions) {
			await this.renderAction(a);
		}
	}

	private async renderAction(
		a: DialAction<TftCompSettings> | KeyAction<TftCompSettings>,
	): Promise<void> {
		const state = this.getState(a.id);
		const filtered = this.getFilteredComps(state.tierFilter);

		if (!this.dataLoaded || filtered.length === 0) {
			if (a.isDial()) {
				await a.setFeedback({
					title: `TFT Comps · ${state.tierFilter}`,
					comp_name: this.dataLoaded ? "No comps found" : "Loading...",
					comp_info: "",
					champ_list: "",
					tier_bar: { value: 0 },
				});
			} else {
				await a.setImage("");
				await a.setTitle(this.dataLoaded ? "TFT\nNo comps" : "TFT\nLoading...");
			}
			return;
		}

		const comp = filtered[state.compIndex % filtered.length];
		const tierColor = TIER_COLORS[comp.tier] ?? "#AAA";
		const trendIcon = comp.trend === "up" ? "▲" : comp.trend === "down" ? "▼" : comp.trend === "new" ? "★" : "";

		// Abbreviate champion list
		const champShort = comp.champions
			.slice(0, 5)
			.map((c) => {
				const prefix = c.threeStarred ? "★" : "";
				return `${prefix}${abbreviateName(c.name)}`;
			})
			.join(" ");

		const champFull = comp.champions
			.map((c) => {
				const prefix = c.threeStarred ? "★" : "";
				const items = c.items.length > 0 ? ` (${c.items.map(abbreviateItem).join(",")})` : "";
				return `${prefix}${c.name}${items}`;
			})
			.join(" · ");

		// Items for carries (champions with items)
		const carries = comp.champions.filter((c) => c.items.length > 0);
		const carryStr = carries
			.slice(0, 2)
			.map((c) => `${abbreviateName(c.name)}: ${c.items.map(abbreviateItem).join("+")}`)
			.join(" | ");

		if (a.isDial()) {
			const tierBar = comp.tier === "S" ? 95 : comp.tier === "A" ? 65 : comp.tier === "B" ? 35 : 15;
			await a.setFeedback({
				title: { value: `${trendIcon} [${comp.tier}] ${comp.name}`, color: tierColor },
				comp_name: { value: `${comp.playstyle} · ${state.compIndex + 1}/${filtered.length}`, color: "#FFF" },
				comp_info: { value: carryStr || champShort, color: "#AAA" },
				champ_list: { value: champShort, color: GOLD },
				tier_bar: { value: tierBar, bar_fill_c: tierColor },
			});
		} else {
			// Key: render SVG
			const img = this.composeKeyImage(comp, state.compIndex + 1, filtered.length, state.tierFilter);
			if (img) await a.setImage(img);
			await a.setTitle("");
		}
	}

	/**
	 * Compose SVG key image for TFT comp display.
	 */
	private composeKeyImage(
		comp: TftComp,
		index: number,
		total: number,
		filter: TierFilter,
	): string | null {
		const S = 144;
		const cx = S / 2;
		const tierColor = TIER_COLORS[comp.tier] ?? "#AAA";
		const trendIcon = comp.trend === "up" ? "▲" : comp.trend === "down" ? "▼" : "";

		// Top 4 champions abbreviated
		const champLine1 = comp.champions
			.slice(0, 4)
			.map((c) => (c.threeStarred ? "★" : "") + abbreviateName(c.name))
			.join(" ");
		const champLine2 = comp.champions.length > 4
			? comp.champions
				.slice(4, 8)
				.map((c) => (c.threeStarred ? "★" : "") + abbreviateName(c.name))
				.join(" ")
			: "";

		// Carry items (first carry with items)
		const carry = comp.champions.find((c) => c.items.length > 0);
		const carryLine = carry
			? `${abbreviateName(carry.name)}: ${carry.items.map(abbreviateItem).join("+")}`
			: "";

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
			<rect width="${S}" height="${S}" rx="14" fill="${DARK_BLUE}"/>
			<rect x="3" y="3" width="${S - 6}" height="${S - 6}" rx="12" fill="none" stroke="${tierColor}" stroke-width="2" opacity="0.5"/>

			<!-- Tier badge -->
			<rect x="10" y="7" width="30" height="22" rx="5" fill="${tierColor}" opacity="0.9"/>
			<text x="25" y="24" font-size="16" fill="#FFF" text-anchor="middle" font-weight="bold" font-family="sans-serif">${esc(comp.tier)}</text>

			<!-- Trend + index -->
			<text x="${S - 12}" y="23" font-size="11" fill="#888" text-anchor="end" font-family="sans-serif">${esc(trendIcon)} ${index}/${total}</text>

			<!-- Comp name -->
			<text x="${cx}" y="48" font-size="14" fill="${tierColor}" text-anchor="middle" font-weight="bold" font-family="sans-serif">${esc(truncate(comp.name, 16))}</text>

			<!-- Playstyle -->
			<text x="${cx}" y="65" font-size="11" fill="#AAA" text-anchor="middle" font-family="sans-serif">${esc(comp.playstyle || "Standard")}</text>

			<!-- Champions line 1 -->
			<text x="${cx}" y="86" font-size="11" fill="${GOLD}" text-anchor="middle" font-weight="600" font-family="sans-serif">${esc(truncate(champLine1, 22))}</text>

			<!-- Champions line 2 -->
			<text x="${cx}" y="102" font-size="11" fill="${GOLD}" text-anchor="middle" font-weight="600" font-family="sans-serif">${esc(truncate(champLine2, 22))}</text>

			<!-- Carry items -->
			<text x="${cx}" y="122" font-size="10" fill="#AAA" text-anchor="middle" font-family="sans-serif">${esc(truncate(carryLine, 24))}</text>

			<!-- Filter indicator -->
			<text x="${cx}" y="138" font-size="9" fill="#666" text-anchor="middle" font-family="sans-serif">Filter: ${filter}</text>
		</svg>`;

		return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	}
}

// ── Helpers ──

function abbreviateName(name: string): string {
	// Handle multi-word names: "Lucian & Senna" → "Luc&Sen"
	if (name.includes("&")) {
		const parts = name.split("&").map((p) => p.trim());
		return parts.map((p) => p.slice(0, 3)).join("&");
	}
	// Handle compound names: "Miss Fortune" → "MF", "Dr Mundo" → "DrM"
	const words = name.split(" ");
	if (words.length >= 2) {
		// Common abbreviations
		const first = words[0].charAt(0).toUpperCase();
		const second = words[1].charAt(0).toUpperCase();
		return first + second;
	}
	// Single word: first 4 chars
	return name.length > 5 ? name.slice(0, 4) : name;
}

function abbreviateItem(item: string): string {
	const abbrevs: Record<string, string> = {
		"Bloodthirster": "BT",
		"Deathblade": "DB",
		"Giant Slayer": "GS",
		"Guinsoo's Rageblade": "GRB",
		"Hand of Justice": "HoJ",
		"Hextech Gunblade": "HGB",
		"Infinity Edge": "IE",
		"Last Whisper": "LW",
		"Nashor's Tooth": "NT",
		"Quicksilver": "QSS",
		"Rabadon's Deathcap": "Rab",
		"Spear of Shojin": "SoS",
		"Statikk Shiv": "SS",
		"Titan's Resolve": "TR",
		"Archangel's Staff": "AA",
		"Blue Buff": "BB",
		"Bramble Vest": "BV",
		"Dragon's Claw": "DC",
		"Edge of Night": "EoN",
		"Evenshroud": "ES",
		"Gargoyle Stoneplate": "GS",
		"Ionic Spark": "IS",
		"Morellonomicon": "Mor",
		"Sunfire Cape": "SFC",
		"Warmog's Armor": "WA",
		"Jeweled Gauntlet": "JG",
		"Crownguard": "CG",
		"Adaptive Helm": "AH",
		"Red Buff": "RB",
		"Spirit Visage": "SV",
		"Sterak's Gage": "SG",
		"Striker's Flail": "SF",
		"Void Staff": "VS",
		"Kraken's Fury": "KF",
	};
	return abbrevs[item] ?? item.split(" ").map((w) => w[0]).join("");
}

function truncate(str: string, max: number): string {
	return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function esc(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
