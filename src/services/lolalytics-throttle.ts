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
 *
 * Safety: queue is bounded to MAX_QUEUE_SIZE and queued items time out
 * after QUEUE_TIMEOUT_MS to prevent memory leaks if the API is down.
 */

const MAX_TOKENS = 3;
const REFILL_RATE_MS = 500; // 1 token every 500ms → 2 req/s sustained
const MAX_QUEUE_SIZE = 50;
const QUEUE_TIMEOUT_MS = 30_000; // 30s max wait in queue

const FETCH_HEADERS: Record<string, string> = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};

let tokens = MAX_TOKENS;
let lastRefill = Date.now();

interface QueueEntry {
	resolve: () => void;
	reject: (err: Error) => void;
	signal?: AbortSignal;
	enqueuedAt: number;
}

const queue: QueueEntry[] = [];
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

	// Prune timed-out or aborted entries first
	for (let i = queue.length - 1; i >= 0; i--) {
		const entry = queue[i];
		const timedOut = (Date.now() - entry.enqueuedAt) > QUEUE_TIMEOUT_MS;
		const aborted = entry.signal?.aborted;
		if (timedOut || aborted) {
			queue.splice(i, 1);
			entry.reject(new Error(aborted ? "Aborted while queued" : "Throttle queue timeout"));
		}
	}

	while (queue.length > 0 && tokens > 0) {
		tokens--;
		const next = queue.shift();
		next?.resolve();
	}
	if (queue.length === 0 && drainTimer) {
		clearInterval(drainTimer);
		drainTimer = null;
	}
}

function waitForToken(signal?: AbortSignal): Promise<void> {
	refillTokens();
	if (tokens > 0) {
		tokens--;
		return Promise.resolve();
	}

	// Reject immediately if queue is full
	if (queue.length >= MAX_QUEUE_SIZE) {
		return Promise.reject(new Error("Throttle queue full — too many concurrent requests"));
	}

	// Check if already aborted before queuing
	if (signal?.aborted) {
		return Promise.reject(new Error("Aborted before queuing"));
	}

	return new Promise<void>((resolve, reject) => {
		const entry: QueueEntry = { resolve, reject, signal, enqueuedAt: Date.now() };
		queue.push(entry);
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
	await waitForToken(options?.signal);

	const mergedHeaders = { ...FETCH_HEADERS, ...options?.headers };
	logger.debug(`Throttled fetch: ${url} (tokens left: ${tokens}, queued: ${queue.length})`);

	return fetch(url, {
		headers: mergedHeaders,
		signal: options?.signal,
	});
}
