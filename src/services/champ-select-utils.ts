import { dataDragon } from "./data-dragon";
import { ChampionStats } from "./champion-stats";
import type { lcuApi } from "./lcu-api";

type ChampSelectSession = NonNullable<Awaited<ReturnType<typeof lcuApi.getChampSelectSession>>>;
type TeamMember = ChampSelectSession["theirTeam"][0];

/**
 * Find the enemy laner matching your position in champion select.
 *
 * Uses 3 strategies in order:
 * 1. Direct assignedPosition match (ranked draft — most reliable)
 * 2. Score-based inference from champion tags, skipping already-assigned enemies
 * 3. If only one enemy has picked, use them (early draft)
 */
export function findEnemyLaner(
	session: ChampSelectSession,
	myPosition: string,
): { player: TeamMember; alias: string; name: string } | null {
	if (!myPosition) return null;

	// Strategy 1: Direct assignedPosition match
	const directMatch = session.theirTeam.find(
		(p) => p.assignedPosition === myPosition && p.championId > 0,
	);
	if (directMatch) {
		const champ = dataDragon.getChampionByKey(String(directMatch.championId));
		if (champ) {
			return { player: directMatch, alias: ChampionStats.toLolalytics(champ.id), name: champ.name };
		}
	}

	// Strategy 2: Score-based lane inference
	// Pick the enemy whose champion best fits our lane, skipping enemies already
	// assigned to a different position (they belong to another lane).
	const myLane = ChampionStats.toLolalyticsLane(myPosition);
	let bestScore = 0;
	let bestResult: { player: TeamMember; alias: string; name: string } | null = null;

	for (const enemy of session.theirTeam) {
		if (enemy.championId <= 0) continue;
		if (enemy.assignedPosition && enemy.assignedPosition !== myPosition) continue;

		const champ = dataDragon.getChampionByKey(String(enemy.championId));
		if (!champ) continue;

		const score = championLaneScore(champ.tags, myLane);
		if (score > bestScore) {
			bestScore = score;
			bestResult = { player: enemy, alias: ChampionStats.toLolalytics(champ.id), name: champ.name };
		}
	}

	if (bestResult) return bestResult;

	// Strategy 3: If only one enemy has picked so far, use them (early draft)
	const pickedEnemies = session.theirTeam.filter((p) => p.championId > 0);
	if (pickedEnemies.length === 1) {
		const champ = dataDragon.getChampionByKey(String(pickedEnemies[0].championId));
		if (champ) {
			return { player: pickedEnemies[0], alias: ChampionStats.toLolalytics(champ.id), name: champ.name };
		}
	}

	return null;
}

/**
 * Score how likely a champion plays in a given lane (0 = unlikely, higher = more likely).
 * Uses Data Dragon tags with disambiguation for multi-role champions.
 *
 * Examples:
 *   - Mage+Support (Lux, Morgana, Zyra) → high support, low mid
 *   - Pure Mage (Syndra, Viktor) → high mid
 *   - Fighter+Assassin (Lee Sin, Vi) → medium jungle
 *   - Fighter+Tank (Warwick, Amumu) → medium jungle, medium top
 */
function championLaneScore(tags: string[], lane: string): number {
	switch (lane) {
		case "top":
			// Fighter without Assassin → strong top (Darius, Garen, Fiora)
			if (tags.includes("Fighter") && !tags.includes("Assassin")) return 0.9;
			// Tank without Support → likely top (Ornn, Malphite, Sion)
			if (tags.includes("Tank") && !tags.includes("Support")) return 0.8;
			// Fighter+Assassin → could be top or jungle (Riven, Irelia)
			if (tags.includes("Fighter")) return 0.5;
			return 0;

		case "jungle":
			// Fighter+Tank (Warwick, Amumu, Zac, Sejuani)
			if (tags.includes("Fighter") && tags.includes("Tank")) return 0.6;
			// Assassin+Fighter (Lee Sin, Vi, Kha'Zix, Rek'Sai)
			if (tags.includes("Assassin") && tags.includes("Fighter")) return 0.6;
			// Specialist that can jungle (Ivern, Kindred-ish behavior)
			if (tags.includes("Specialist")) return 0.3;
			return 0;

		case "middle":
			// Pure Mage without Support (Syndra, Viktor, Orianna)
			if (tags.includes("Mage") && !tags.includes("Support")) return 0.9;
			// Pure Assassin without Fighter (Zed, Katarina, Fizz)
			if (tags.includes("Assassin") && !tags.includes("Fighter")) return 0.8;
			// Mage+Support → more likely support (Brand, Lux, Zyra)
			if (tags.includes("Mage") && tags.includes("Support")) return 0.3;
			// Assassin+Fighter → could be mid or jungle (Akali, Qiyana)
			if (tags.includes("Assassin")) return 0.4;
			return 0;

		case "bottom":
			if (tags.includes("Marksman")) return 0.9;
			return 0;

		case "support":
			// Support tag → strong signal (Thresh, Nautilus, Lulu)
			if (tags.includes("Support")) return 0.9;
			// Tank+Support already covered above
			return 0;

		default:
			return 0;
	}
}

/**
 * Heuristic: does this champion likely play in the given lane?
 * Wrapper over championLaneScore for backward compatibility.
 */
export function championMatchesLane(champ: { tags: string[] }, lane: string): boolean {
	return championLaneScore(champ.tags, lane) > 0;
}

/**
 * Get set of champion aliases (Lolalytics format) that are banned or already picked.
 */
export function getUnavailableAliases(session: ChampSelectSession): Set<string> {
	const unavailable = new Set<string>();
	const allActions = session.actions.flat();

	for (const act of allActions) {
		if (act.championId <= 0) continue;
		if ((act.type === "ban" && act.completed) || (act.type === "pick" && act.completed)) {
			const champ = dataDragon.getChampionByKey(String(act.championId));
			if (champ) unavailable.add(ChampionStats.toLolalytics(champ.id));
		}
	}
	return unavailable;
}
