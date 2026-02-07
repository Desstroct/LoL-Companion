import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import streamDeck from "@elgato/streamdeck";
import type { LcuCredentials } from "../types/lol";

const logger = streamDeck.logger.createScope("LcuConnector");

/**
 * Discovers and maintains the connection to the League Client (LCU).
 * The LCU runs a local HTTPS server with a random port and auth token.
 * We discover it via the process command line or lockfile.
 */
export class LcuConnector {
	private credentials: LcuCredentials | null = null;
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private listeners: Array<(creds: LcuCredentials | null) => void> = [];

	/**
	 * Returns the current LCU credentials, or null if not connected.
	 */
	getCredentials(): LcuCredentials | null {
		return this.credentials;
	}

	/**
	 * Whether the LCU client is currently detected.
	 */
	isConnected(): boolean {
		return this.credentials !== null;
	}

	/**
	 * Register a listener for connection state changes.
	 */
	onConnectionChange(listener: (creds: LcuCredentials | null) => void): void {
		this.listeners.push(listener);
	}

	/**
	 * Start polling for the League Client process.
	 */
	startPolling(intervalMs = 3000): void {
		if (this.pollInterval) return;

		// Check immediately
		this.discover();

		this.pollInterval = setInterval(() => {
			this.discover();
		}, intervalMs);

		logger.info("Started LCU polling");
	}

	/**
	 * Stop polling.
	 */
	stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	/**
	 * Try to discover the LCU credentials.
	 * First tries process command line, then falls back to lockfile.
	 */
	private async discover(): Promise<void> {
		try {
			const creds = await this.discoverFromProcess();
			if (creds) {
				if (!this.credentials || this.credentials.port !== creds.port) {
					this.credentials = creds;
					logger.info(`LCU discovered on port ${creds.port}`);
					this.notifyListeners();
				}
				return;
			}
		} catch {
			// Process discovery failed, try lockfile
		}

		try {
			const creds = await this.discoverFromLockfile();
			if (creds) {
				if (!this.credentials || this.credentials.port !== creds.port) {
					this.credentials = creds;
					logger.info(`LCU discovered from lockfile on port ${creds.port}`);
					this.notifyListeners();
				}
				return;
			}
		} catch {
			// Lockfile discovery failed too
		}

		// If we had credentials before but now can't find the client
		if (this.credentials) {
			this.credentials = null;
			logger.info("LCU client lost");
			this.notifyListeners();
		}
	}

	/**
	 * Discover LCU credentials by reading the LeagueClientUx process command line.
	 */
	private discoverFromProcess(): Promise<LcuCredentials | null> {
		return new Promise((resolve, reject) => {
			const cmd = process.platform === "win32"
				? `wmic PROCESS WHERE name='LeagueClientUx.exe' GET commandline`
				: `ps -A -o args | grep LeagueClientUx`;

			exec(cmd, { timeout: 5000 }, (error, stdout) => {
				if (error) {
					reject(error);
					return;
				}

				const portMatch = stdout.match(/--app-port=(\d+)/);
				const tokenMatch = stdout.match(/--remoting-auth-token=([\w_-]+)/);
				const pidMatch = stdout.match(/--app-pid=(\d+)/);

				if (portMatch && tokenMatch) {
					resolve({
						port: parseInt(portMatch[1], 10),
						password: tokenMatch[1],
						pid: pidMatch ? parseInt(pidMatch[1], 10) : 0,
						protocol: "https",
					});
				} else {
					resolve(null);
				}
			});
		});
	}

	/**
	 * Discover LCU credentials from the lockfile.
	 * Lockfile format: processName:pid:port:password:protocol
	 */
	private async discoverFromLockfile(): Promise<LcuCredentials | null> {
		// Common League installation paths
		const possiblePaths = process.platform === "win32"
			? [
				"C:\\Riot Games\\League of Legends\\lockfile",
				"D:\\Riot Games\\League of Legends\\lockfile",
				join(process.env.LOCALAPPDATA || "", "Riot Games", "League of Legends", "lockfile"),
			]
			: [
				"/Applications/League of Legends.app/Contents/LoL/lockfile",
			];

		for (const lockfilePath of possiblePaths) {
			try {
				const content = await readFile(lockfilePath, "utf-8");
				const parts = content.split(":");

				if (parts.length >= 5) {
					return {
						pid: parseInt(parts[1], 10),
						port: parseInt(parts[2], 10),
						password: parts[3],
						protocol: parts[4],
					};
				}
			} catch {
				// File not found at this path, try next
				continue;
			}
		}

		return null;
	}

	private notifyListeners(): void {
		for (const listener of this.listeners) {
			try {
				listener(this.credentials);
			} catch (e) {
				logger.error(`Listener error: ${e}`);
			}
		}
	}
}

// Singleton instance
export const lcuConnector = new LcuConnector();
