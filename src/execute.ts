import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findAgyCli } from "./cli";
import type { SpawnAgyOptions, SpawnAgyResult } from "./types";

// ── Execute agy via stdin (no -p flag — avoids argv size limits) ────────────────

const NOISE_PREFIXES = ["Loaded cached credentials", "Skill ", "antigravity-cli"];

function isNoise(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return true;
	return NOISE_PREFIXES.some((prefix) => trimmed.includes(prefix));
}

export function spawnAgy(prompt: string, opts: SpawnAgyOptions): Promise<SpawnAgyResult> {
	return new Promise<SpawnAgyResult>((resolve) => {
		const agyPath = findAgyCli();
		const timeoutStr = `${opts.timeoutSec}s`;

		// Capture agy's log to extract the authenticated email (agy uses the OS
		// keyring and doesn't always update google_accounts.json).
		const logFile = path.join(os.tmpdir(), `agy-log-${process.pid}-${Date.now()}.log`);

		const args: string[] = ["--dangerously-skip-permissions", "--print-timeout", timeoutStr, "--log-file", logFile];
		if (opts.conversationId) {
			args.push("--conversation", opts.conversationId);
		}
		if (opts.addDirs && opts.addDirs.length > 0) {
			for (const dir of opts.addDirs) {
				args.push("--add-dir", dir);
			}
		}

		const startTime = Date.now();
		opts.onProgress?.("waiting for agy...");

		const proc = spawn(agyPath, args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		proc.stdin.write(prompt, "utf-8");
		proc.stdin.end();

		let stdout = "";
		let stderrRaw = "";
		let progressInterval: ReturnType<typeof setInterval> | undefined;

		progressInterval = setInterval(() => {
			const elapsed = Math.round((Date.now() - startTime) / 1000);
			opts.onProgress?.(`agy running (${elapsed}s)`);
		}, 10_000);

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderrRaw += chunk.toString("utf-8");
		});

		let onAbort: (() => void) | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		proc.on("close", (code) => {
			clearInterval(progressInterval);
			if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
			if (killTimer) clearTimeout(killTimer);

			const durationMs = Date.now() - startTime;

			const filteredStderr = stderrRaw
				.split("\n")
				.filter((l) => !isNoise(l))
				.join("\n")
				.trim();

			const exitCode = code ?? 0;
			const hasOutput = stdout.trim().length > 0;
			const substantialError = filteredStderr.length > 0;

			const isError = exitCode !== 0 || (!hasOutput && substantialError);

			// Parse account + quota info from agy's log
			const logInfo = parseLogInfo(logFile);
			cleanupLogFile(logFile);

			resolve({
				text: stdout.trim(),
				stderr: filteredStderr,
				exitCode,
				durationMs,
				isError: isError || !!logInfo.quotaError,
				account: logInfo.account,
				quotaError: logInfo.quotaError,
			});
		});

		proc.on("error", (err) => {
			clearInterval(progressInterval);
			const durationMs = Date.now() - startTime;
			resolve({
				text: "",
				stderr: `Failed to spawn agy: ${err.message}`,
				exitCode: 1,
				durationMs,
				isError: true,
			});
		});

		if (opts.signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (opts.signal.aborted) {
				kill();
			} else {
				onAbort = kill;
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});
}

// ── Log parsing helpers ─────────────────────────────────────────────────────────

interface LogInfo {
	account?: string;
	quotaError?: string;
}

/**
 * Parse useful info from agy's log file:
 * - Authenticated email from `applyAuthResult: email=<addr>`
 * - Quota errors from `RESOURCE_EXHAUSTED` (agy print mode silently falls back
 *   to another model instead of erroring, so we must detect this from the log)
 */
function parseLogInfo(logFile: string): LogInfo {
	try {
		const log = fs.readFileSync(logFile, "utf-8");
		const info: LogInfo = {};

		// Account
		const m1 = log.match(/applyAuthResult: email=([^\s,]+)/);
		if (m1?.[1]) info.account = m1[1];
		else {
			const m2 = log.match(/authenticated successfully as ([^\s,]+)/);
			if (m2?.[1]) info.account = m2[1];
		}

		// Quota exhaustion (agy silently falls back in print mode)
		const qm =
			log.match(/RESOURCE_EXHAUSTED[^:]*: ([^:]+?)(?::|\.)/) ?? log.match(/Individual quota reached\. ([^.]+)/);
		if (qm) {
			info.quotaError = qm[1].trim();
		}

		return info;
	} catch {
		return {};
	}
}

function cleanupLogFile(logFile: string): void {
	try {
		fs.unlinkSync(logFile);
	} catch {
		// Best-effort cleanup
	}
}
