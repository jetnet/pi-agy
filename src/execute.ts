import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findAgyCli } from "./cli.ts";
import type { SpawnAgyOptions, SpawnAgyResult } from "./types.ts";

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

		// Log file: collision-proof UUID name (H3b fix).
		// pid+Date.now() could collide under concurrent calls; randomUUID cannot.
		const logFile = path.join(os.tmpdir(), `agy-log-${randomUUID()}.log`);

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

		// Build child env: start from process.env, then override HOME + DBUS if
		// account rotation is active. This isolates agy's credentials without
		// affecting Pi's own process environment.
		const childEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) childEnv[k] = v;
		}
		if (opts.homeDir) {
			childEnv.HOME = opts.homeDir;
		}
		if (opts.dbusAddress) {
			// A dead / non-existent socket forces libsecret to fail gracefully,
			// making agy fall back to file-based OAuth token instead of the keyring.
			childEnv.DBUS_SESSION_BUS_ADDRESS = opts.dbusAddress;
		}

		const proc = spawn(agyPath, args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: childEnv,
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

			const processError = exitCode !== 0 || (!hasOutput && substantialError);

			// Parse account + quota/ban info from agy's log
			const logInfo = parseLogInfo(logFile);
			cleanupLogFile(logFile);

			// Classify error type for rotation logic. Priority: banned > quota > error > ok.
			const errorClass = classifyError(processError, logInfo);

			// isError computation — rotation-OFF parity invariant:
			// Ban markers do NOT escalate isError here. The rotation-ON path
			// explicitly checks errorClass === "banned" and returns isError:true
			// from the tool layer. This keeps rotation-OFF isError identical to
			// pre-rotation behavior (quota escalation only, never ban escalation).
			resolve({
				text: stdout.trim(),
				stderr: filteredStderr,
				exitCode,
				durationMs,
				isError: processError || !!logInfo.quotaError,
				account: logInfo.account,
				quotaError: logInfo.quotaError,
				errorClass,
				cooldownSec: logInfo.cooldownSec,
				appealUrl: logInfo.appealUrl,
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
				errorClass: "error",
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
	/**
	 * Ban/ToS error detected from the log.
	 *
	 * VERIFIED (2026-05-30): regex confirmed against a real 403 ToS ban log
	 * from a banned account. The log contains a JSON error body with:
	 *   "status": "PERMISSION_DENIED"
	 *   "message": "...violation of Terms of Service..."
	 * Both patterns match. The ambiguity policy (quota wins over banned when
	 * both appear) remains — see classifyError below.
	 */
	banError?: string;
	/** Appeal URL extracted from a ToS/403 ban response (e.g. Google Forms link). */
	appealUrl?: string;
	/** Retry-After / cooldown seconds parsed from the log (best-effort). */
	cooldownSec?: number;
}

/**
 * Parse a log content string (already read from disk) into LogInfo.
 * Extracted so that unit tests can pass synthetic log strings without file I/O.
 */
function parseLogContent(log: string): LogInfo {
	const info: LogInfo = {};

	// Account email
	const m1 = log.match(/applyAuthResult: email=([^\s,]+)/);
	if (m1?.[1]) info.account = m1[1];
	else {
		const m2 = log.match(/authenticated successfully as ([^\s,]+)/);
		if (m2?.[1]) info.account = m2[1];
	}

	// Quota exhaustion (agy silently falls back in print mode)
	const qm = log.match(/RESOURCE_EXHAUSTED[^:]*: ([^:]+?)(?::|\.)/) ?? log.match(/Individual quota reached\. ([^.]+)/);
	if (qm) {
		info.quotaError = qm[1].trim();
	}

	// Best-effort: parse a retry/cooldown duration from the log.
	// Patterns seen in Google API responses: "retry after Ns", "retryDelay: Ns",
	// "Retry-After: N". Captures the number of seconds (integer or decimal).
	const retryMatch = log.match(/(?:retry[- ]?after|retryDelay)[:\s]+(\d+(?:\.\d+)?)\s*s/i);
	if (retryMatch?.[1]) {
		info.cooldownSec = Math.ceil(Number.parseFloat(retryMatch[1]));
	}

	// ── Ban / ToS detection ─────────────────────────────────────────────────
	// VERIFIED (2026-05-30) against a real 403 ToS ban log. Patterns confirmed:
	//   - PERMISSION_DENIED: gRPC status string ("status": "PERMISSION_DENIED")
	//   - "Terms of Service": in the human-readable error message
	// Additional patterns kept for coverage:
	//   - "tos_violation": URL-form sometimes in API JSON bodies
	//   - "policy violation": alternative phrasing in some Google error payloads
	//
	// Deliberately NOT matching generic "403" or "permission" strings to
	// minimise false positives.
	const banMatch = log.match(/PERMISSION_DENIED|Terms of Service|tos_violation|policy.?violation/i);
	if (banMatch) {
		info.banError = banMatch[0];
	}

	// Appeal URL — extract from the JSON error body so users can self-serve.
	// Real format: "appeal_url": "https://forms.gle/..."
	const appealMatch = log.match(/"appeal_url":\s*"([^"]+)"/i);
	if (appealMatch?.[1]) {
		info.appealUrl = appealMatch[1];
	}

	return info;
}

/**
 * Parse useful info from agy's log file.
 * Reads the file and delegates to parseLogContent.
 */
function parseLogInfo(logFile: string): LogInfo {
	try {
		const log = fs.readFileSync(logFile, "utf-8");
		return parseLogContent(log);
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

/**
 * Classify an error based on process exit status and log analysis.
 *
 * Ambiguity policy: when BOTH quota and ban markers appear, classify as
 * 'quota'. Being wrong toward quota (rotate + cooldown) is safe; being wrong
 * toward 'banned' (6h global pause) is costly to the pool.
 *
 * NOTE: 'banned' is only emitted when banError is present AND quotaError is
 * absent. This is the deliberate safe-degradation policy.
 */
export function classifyError(processError: boolean, logInfo: LogInfo): SpawnAgyResult["errorClass"] {
	if (logInfo.banError && !logInfo.quotaError) return "banned";
	if (logInfo.quotaError) return "quota";
	if (processError) return "error";
	return "ok";
}

/**
 * Parse a synthetic log string and classify its error type.
 * Exported for unit testing only (log classification fixture tests). Do not call from
 * production code — use spawnAgy() which reads from the real log file.
 */
export function classifyLogContent(logContent: string, processError: boolean): SpawnAgyResult["errorClass"] {
	return classifyError(processError, parseLogContent(logContent));
}

/**
 * Extract appeal URL from a synthetic log string.
 * Exported for unit testing only.
 */
export function extractAppealUrl(logContent: string): string | undefined {
	return parseLogContent(logContent).appealUrl;
}
