import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("LolalyticsThrottle");

/**
 * Global rate limiter for Lolalytics requests.
 *
 * All services (champion-stats, item-builds, rune-data) go through this
 * throttle to avoid hammering Lolalytics when multiple actions trigger
 * fetches concurrently (e.g. entering champ select fires Smart Pick +
 * Auto Rune + Best Item all at once).
 *
 * Strategy: token-bucket with max 2 requests/second, burst of 3.
 * Each `throttledFetch()` waits its turn, then calls native `fetch()`.
 */

const MAX_TOKENS = 3;
const REFILL_RATE_MS = 500; // 1 token every 500ms → 2 req/s sustained

const FETCH_HEADERS: Record<string, string> = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

let tokens = MAX_TOKENS;
let lastRefill = Date.now();
const queue: Array<() => void> = [];
let drainTimer: ReturnType<typeof setInterval> | null = null;

function refillTokens(): void {
	const now = Date.now();
	const elapsed = now - lastRefill;
	const newTokens = Math.floor(elapsed / REFILL_RATE_MS);
	if (newTokens > 0) {
		tokens = Math.min(MAX_TOKENS, tokens + newTokens);
		lastRefill += newTokens * REFILL_RATE_MS;
	}
}

function drainQueue(): void {
	refillTokens();
	while (queue.length > 0 && tokens > 0) {
		tokens--;
		const next = queue.shift();
		next?.();
	}
	if (queue.length === 0 && drainTimer) {
		clearInterval(drainTimer);
		drainTimer = null;
	}
}

function waitForToken(): Promise<void> {
	refillTokens();
	if (tokens > 0) {
		tokens--;
		return Promise.resolve();
	}
	// Enqueue and start drain loop
	return new Promise<void>((resolve) => {
		queue.push(resolve);
		if (!drainTimer) {
			drainTimer = setInterval(drainQueue, REFILL_RATE_MS);
		}
	});
}

/**
 * Rate-limited fetch for Lolalytics URLs.
 * Drop-in replacement for `fetch(url, { headers, signal })`.
 * Shared User-Agent header is applied automatically.
 */
export async function throttledFetch(
	url: string,
	options?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<Response> {
	await waitForToken();

	const mergedHeaders = { ...FETCH_HEADERS, ...options?.headers };
	logger.debug(`Throttled fetch: ${url} (tokens left: ${tokens}, queued: ${queue.length})`);

	return fetch(url, {
		headers: mergedHeaders,
		signal: options?.signal,
	});
}
