import streamDeck from "@elgato/streamdeck";
import { dataDragon } from "./data-dragon";
import { throttledFetch } from "./lolalytics-throttle";
import { ChampionStats } from "./champion-stats";
import type { RunePageData } from "./rune-data";

const logger = streamDeck.logger.createScope("LolaBuild");

// ─────────── Exported types ───────────

export interface BuildPageData {
	/** Recommended rune pages (most common + highest WR) */
	runes: RunePageData[];
	/** Recommended summoner spell combos, sorted by pick rate */
	summonerSpells: SummonerSpellCombo[];
	/** Skill max order (e.g., "QEW") for most common and highest WR */
	skillPriority: SkillPriorityData[];
	/** Full 15-level skill order digit sequence */
	skillOrder: SkillOrderData[];
	/** Early skill levels (levels 1-3), each row = one level, 4 entries for Q/W/E/R */
	skillEarly: SkillEarlyLevel[];
}

export interface SummonerSpellCombo {
	/** Summoner spell IDs, e.g. [4, 14] */
	ids: number[];
	winRate: number;
	pickRate: number;
	games: number;
	source: "most_common" | "highest_wr";
}

export interface SkillPriorityData {
	/** e.g. "QEW" */
	order: string;
	winRate: number;
	pickRate: number;
	games: number;
	source: "most_common" | "highest_wr";
}

export interface SkillOrderData {
	/** 15-digit sequence, each digit = skill (1=Q, 2=W, 3=E, 4=R) */
	sequence: number;
	winRate: number;
	pickRate: number;
	games: number;
	source: "most_common" | "highest_wr";
}

export interface SkillEarlyLevel {
	/** Index in array = level (0=lvl 1, 1=lvl 2, 2=lvl 3) */
	/** Each entry has 4 sub-entries for Q/W/E/R: [wr, pickRate, games] */
	skills: Array<{ winRate: number; pickRate: number; games: number }>;
}

// ─────────── Tree ID constants ───────────

/** Lolalytics page index → Riot tree style ID */
const TREE_STYLE_IDS: Record<number, number> = {
	0: 8000, // Precision
	1: 8100, // Domination
	2: 8200, // Sorcery
	3: 8300, // Inspiration
	4: 8400, // Resolve
};

/** Keystone ID → human-readable name */
const KEYSTONE_NAMES: Record<number, string> = {
	8005: "Press the Attack",
	8008: "Lethal Tempo",
	8010: "Conqueror",
	8021: "Fleet Footwork",
	8112: "Electrocute",
	8124: "Predator",
	8128: "Dark Harvest",
	9923: "Hail of Blades",
	8214: "Summon Aery",
	8229: "Arcane Comet",
	8230: "Phase Rush",
	8351: "Glacial Augment",
	8360: "Unsealed Spellbook",
	8369: "First Strike",
	8437: "Grasp of the Undying",
	8439: "Aftershock",
	8465: "Guardian",
};

// ─────────── Build Page Parser ───────────

/**
 * Fetches and parses the Lolalytics build page SSR (Qwik) data.
 *
 * Since the Lolalytics JSON API (`ep=rune`, `ep=build-itemset`, etc.)
 * no longer works (returns 4042), this parser extracts data directly
 * from the server-rendered HTML, which contains a large `<script type="qwik/json">`
 * block with all champion build data already resolved.
 */
export class LolaBuildParser {
	/** Cache: "champion:lane" → { data, timestamp } */
	private cache = new Map<string, { data: BuildPageData; timestamp: number }>();
	private readonly CACHE_TTL = 30 * 60 * 1000; // 30 min

	/**
	 * Get build page data for a champion + lane.
	 */
	async getBuildData(championAlias: string, lane: string): Promise<BuildPageData | null> {
		const key = `${championAlias}:${lane}`;
		const cached = this.cache.get(key);

		if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
			return cached.data;
		} else if (cached) {
			this.cache.delete(key);
		}

		const lolalyticsLane = lane === "aram" ? "" : lane;
		const pageUrl = lane === "aram"
			? `https://lolalytics.com/lol/${championAlias}/aram/build/`
			: `https://lolalytics.com/lol/${championAlias}/build/?lane=${lolalyticsLane}`;

		try {
			logger.debug(`Fetching build page: ${pageUrl}`);
			const response = await throttledFetch(pageUrl, {
				signal: AbortSignal.timeout(15_000),
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					"Accept": "text/html",
				} as Record<string, string>,
			});

			if (!response.ok) {
				logger.warn(`Lolalytics build page returned ${response.status}`);
				return cached?.data ?? null;
			}

			const html = await response.text();
			const data = this.parseQwikData(html, championAlias, lane);

			if (data) {
				this.cache.set(key, { data, timestamp: Date.now() });
				logger.info(
					`Parsed build page for ${championAlias} ${lane}: ` +
						`${data.runes.length} rune pages, ` +
						`${data.summonerSpells.length} spell combos, ` +
						`${data.skillPriority.length} skill orders`,
				);
			}

			return data;
		} catch (e) {
			logger.error(`Failed to fetch build page for ${championAlias} ${lane}: ${e}`);
			return cached?.data ?? null;
		}
	}

	/**
	 * Parse the Qwik SSR JSON data from the build page HTML.
	 */
	private parseQwikData(html: string, _champion: string, _lane: string): BuildPageData | null {
		try {
			// Extract the <script type="qwik/json"> block
			const match = html.match(/<script type=["']qwik\/json["']>([\s\S]*?)<\/script>/);
			if (!match) {
				logger.warn("No qwik/json script found in build page");
				return null;
			}

			const qwikData = JSON.parse(match[1]) as { objs: unknown[] };
			const objs = qwikData.objs;
			if (!Array.isArray(objs) || objs.length === 0) {
				logger.warn("Empty or invalid qwik objs array");
				return null;
			}

			// Helper: resolve a base-36 reference to the actual value
			const resolve = (ref: string): unknown => {
				const idx = parseInt(ref, 36);
				if (isNaN(idx) || idx >= objs.length) return undefined;
				return objs[idx];
			};

			// Helper: deep-resolve references up to a max depth
			const deepResolve = (ref: unknown, depth = 0): unknown => {
				if (depth > 6 || ref === undefined || ref === null) return ref;
				if (typeof ref === "number" || typeof ref === "boolean") return ref;
				if (typeof ref !== "string") {
					if (Array.isArray(ref)) return ref.map((x) => deepResolve(x, depth + 1));
					if (typeof ref === "object") {
						const out: Record<string, unknown> = {};
						for (const [k, v] of Object.entries(ref as Record<string, unknown>)) {
							out[k] = deepResolve(v, depth + 1);
						}
						return out;
					}
					return ref;
				}
				// String — check if it's a base-36 reference
				const val = resolve(ref);
				if (val === undefined) return ref; // plain string
				return deepResolve(val, depth + 1);
			};

			// Find the main data object: has keys like "summary", "runes", "spells", "skillOrder"
			const mainDataIdx = objs.findIndex(
				(o) =>
					typeof o === "object" &&
					o !== null &&
					!Array.isArray(o) &&
					"summary" in o &&
					"spells" in o &&
					"skillOrder" in o,
			);

			if (mainDataIdx === -1) {
				logger.warn("Could not find main data object in Qwik data");
				return null;
			}

			const mainObj = objs[mainDataIdx] as Record<string, string>;

			// Resolve the summary object (contains pick / win data)
			const summary = deepResolve(resolve(mainObj.summary)) as {
				pick?: SummarySection;
				win?: SummarySection;
			} | null;

			if (!summary) {
				logger.warn("Could not resolve summary data");
				return null;
			}

			const runes = this.extractRunes(summary);
			const summonerSpells = this.extractSummonerSpells(summary);
			const skillPriority = this.extractSkillPriority(summary);
			const skillOrder = this.extractSkillOrder(summary);

			// Extract early skill levels from main data
			const skillEarly = this.extractSkillEarly(mainObj, objs, deepResolve);

			return { runes, summonerSpells, skillPriority, skillOrder, skillEarly };
		} catch (e) {
			logger.error(`Failed to parse Qwik data: ${e}`);
			return null;
		}
	}

	// ─────────── Data extraction helpers ───────────

	private extractRunes(summary: { pick?: SummarySection; win?: SummarySection }): RunePageData[] {
		const results: RunePageData[] = [];

		if (summary.pick?.runes) {
			const page = this.convertRuneData(summary.pick.runes, "most_common");
			if (page) results.push(page);
		}

		if (summary.win?.runes) {
			const page = this.convertRuneData(summary.win.runes, "highest_wr");
			if (page) results.push(page);
		}

		return results;
	}

	private convertRuneData(
		runes: SummaryRunes,
		source: "most_common" | "highest_wr",
	): RunePageData | null {
		const { set, page, wr, n } = runes;
		if (!set?.pri || !set?.sec || !set?.mod || !page) return null;
		if (!Array.isArray(set.pri) || set.pri.length !== 4) return null;
		if (!Array.isArray(set.sec) || set.sec.length !== 2) return null;
		if (!Array.isArray(set.mod) || set.mod.length !== 3) return null;

		const primaryStyleId = TREE_STYLE_IDS[page.pri] ?? this.treeFromKeystoneId(set.pri[0]);
		const subStyleId = TREE_STYLE_IDS[page.sec] ?? this.treeFromRuneId(set.sec[0]);
		if (!primaryStyleId || !subStyleId) return null;

		const selectedPerkIds = [...set.pri, ...set.sec, ...set.mod];
		const keystoneName = KEYSTONE_NAMES[set.pri[0]] ?? `Keystone ${set.pri[0]}`;

		return {
			primaryStyleId,
			subStyleId,
			selectedPerkIds,
			winRate: wr ?? 0,
			games: n ?? 0,
			source,
			keystoneName,
		};
	}

	private extractSummonerSpells(summary: { pick?: SummarySection; win?: SummarySection }): SummonerSpellCombo[] {
		const results: SummonerSpellCombo[] = [];

		if (summary.pick?.sums) {
			const { ids, n, wr } = summary.pick.sums;
			if (Array.isArray(ids) && ids.length === 2) {
				results.push({
					ids,
					winRate: wr ?? 0,
					pickRate: 100, // Most common by definition
					games: n ?? 0,
					source: "most_common",
				});
			}
		}

		if (summary.win?.sums) {
			const { ids, n, wr } = summary.win.sums;
			if (Array.isArray(ids) && ids.length === 2) {
				// Avoid duplicate if same combo
				const isDupe = results.some(
					(r) => r.ids[0] === ids[0] && r.ids[1] === ids[1],
				);
				if (!isDupe) {
					results.push({
						ids,
						winRate: wr ?? 0,
						pickRate: 0,
						games: n ?? 0,
						source: "highest_wr",
					});
				}
			}
		}

		return results;
	}

	private extractSkillPriority(summary: { pick?: SummarySection; win?: SummarySection }): SkillPriorityData[] {
		const results: SkillPriorityData[] = [];

		if (summary.pick?.skillpriority) {
			const { id, n, wr } = summary.pick.skillpriority;
			if (typeof id === "string" && id.length >= 2) {
				results.push({
					order: id,
					winRate: wr ?? 0,
					pickRate: 100,
					games: n ?? 0,
					source: "most_common",
				});
			}
		}

		if (summary.win?.skillpriority) {
			const { id, n, wr } = summary.win.skillpriority;
			if (typeof id === "string" && id.length >= 2) {
				const isDupe = results.some((r) => r.order === id);
				if (!isDupe) {
					results.push({
						order: id,
						winRate: wr ?? 0,
						pickRate: 0,
						games: n ?? 0,
						source: "highest_wr",
					});
				}
			}
		}

		return results;
	}

	private extractSkillOrder(summary: { pick?: SummarySection; win?: SummarySection }): SkillOrderData[] {
		const results: SkillOrderData[] = [];

		if (summary.pick?.skillorder) {
			const { id, n, wr } = summary.pick.skillorder;
			if (typeof id === "number") {
				results.push({
					sequence: id,
					winRate: wr ?? 0,
					pickRate: 100,
					games: n ?? 0,
					source: "most_common",
				});
			}
		}

		if (summary.win?.skillorder) {
			const { id, n, wr } = summary.win.skillorder;
			if (typeof id === "number") {
				const isDupe = results.some((r) => r.sequence === id);
				if (!isDupe) {
					results.push({
						sequence: id,
						winRate: wr ?? 0,
						pickRate: 0,
						games: n ?? 0,
						source: "highest_wr",
					});
				}
			}
		}

		return results;
	}

	private extractSkillEarly(
		mainObj: Record<string, string>,
		objs: unknown[],
		deepResolve: (ref: unknown, depth?: number) => unknown,
	): SkillEarlyLevel[] {
		try {
			if (!mainObj.skillEarly) return [];

			const resolve = (ref: string): unknown => {
				const idx = parseInt(ref, 36);
				return isNaN(idx) || idx >= objs.length ? undefined : objs[idx];
			};

			const raw = deepResolve(resolve(mainObj.skillEarly)) as number[][][];
			if (!Array.isArray(raw)) return [];

			return raw.map((level) => ({
				skills: (level as number[][]).map((skill) => ({
					winRate: skill[0] ?? 0,
					pickRate: skill[1] ?? 0,
					games: skill[2] ?? 0,
				})),
			}));
		} catch {
			return [];
		}
	}

	// ─────────── Tree ID helpers ───────────

	private treeFromKeystoneId(id: number): number {
		if (id >= 8000 && id < 8500) return Math.floor(id / 100) * 100;
		if (id === 9923) return 8100; // Hail of Blades
		return 8000;
	}

	private treeFromRuneId(id: number): number {
		if (id >= 8400 && id < 8500) return 8400;
		if (id >= 8300 && id < 8400) return 8300;
		if (id >= 8200 && id < 8300) return 8200;
		if (id >= 8100 && id < 8200) return 8100;
		if (id >= 8000 && id < 8100) return 8000;
		if (id >= 9100 && id < 9200) return 8000;
		return 8000;
	}
}

// ─────────── Internal types ───────────

interface SummaryRunes {
	wr: number;
	n: number;
	page: { pri: number; sec: number };
	set: { pri: number[]; sec: number[]; mod: number[] };
}

interface SummarySums {
	ids: number[];
	n: number;
	wr: number;
}

interface SummarySkillPriority {
	id: string;
	n: number;
	wr: number;
}

interface SummarySkillOrder {
	id: number;
	n: number;
	wr: number;
}

interface SummarySection {
	runes?: SummaryRunes;
	sums?: SummarySums;
	skillpriority?: SummarySkillPriority;
	skillorder?: SummarySkillOrder;
}

/** Singleton */
export const lolaBuild = new LolaBuildParser();
