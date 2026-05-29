// ── Shared type definitions for pi-agy ─────────────────────────────────────────

export interface SpawnAgyOptions {
	cwd: string;
	timeoutSec: number;
	addDirs?: string[];
	conversationId?: string;
	signal?: AbortSignal;
	onProgress?: (status: string) => void;
	/** If set, override HOME env var for the spawned agy process (account rotation). */
	homeDir?: string;
	/** If set, override DBUS_SESSION_BUS_ADDRESS for the spawned agy process (disable keyring). */
	dbusAddress?: string;
}

export interface SpawnAgyResult {
	text: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	isError: boolean;
	/** Authenticated email parsed from agy's log. Undefined if not detected. */
	account?: string;
	/** Quota error message if RESOURCE_EXHAUSTED was detected in agy's log. */
	quotaError?: string;
	/**
	 * Classified error type from log analysis.
	 * - 'ok'     — call succeeded
	 * - 'quota'  — RESOURCE_EXHAUSTED / individual quota reached
	 * - 'banned' — PERMISSION_DENIED / ToS 403 (⚠ provisional regex — unverified against real ban)
	 * - 'error'  — spawn failure or other non-quota error
	 */
	errorClass: "ok" | "quota" | "banned" | "error";
	/** Cooldown duration in seconds parsed from agy's log (best-effort). */
	cooldownSec?: number;
}

export interface UsageRecord {
	ts: string;
	tool: string;
	account: string | null;
	latencyMs: number;
	promptChars: number;
	responseChars: number;
	exitCode: number;
}

export interface UsageSummary {
	totalCalls: number;
	byTool: Record<string, { count: number; pct: number; avgLatencyMs: number }>;
	byDay: Array<{ date: string; count: number; bar: string }>;
	avgLatencyMs: number;
	account: string | null;
	windowLabel: string;
	warnings: string[];
}

export interface AgyToolDetails {
	durationMs: number;
	account: string | null;
	exitCode: number;
	model?: string;
	conversationId?: string;
	generatedImages?: string[];
}

// ── Rotation types ────────────────────────────────────────────────────────────

export type AccountStatus = "AVAILABLE" | "EXHAUSTED" | "FLAGGED";

export interface RotationConfigEntry {
	name: string;
	home: string;
}

export interface RotationConfig {
	accounts: RotationConfigEntry[];
	dbusAddress: string;
	dailySoftCap: number;
	defaultCooldownSec: number;
	protectivePauseHours: number;
	jitterMs: [number, number];
}

export interface RotationAccountState {
	status: AccountStatus;
	/** Epoch ms — EXHAUSTED accounts are blocked until this time. */
	cooldownUntil: number;
	requestsToday: number;
	/** YYYY-MM-DD stamp; requestsToday is reset when this differs from today. */
	dayStamp: string;
	/** Carries forward for future proportional-pooling support. */
	requestsSinceRotation: number;
	lastUsedMs: number;
	lastError: string | null;
}

export interface RotationState {
	/** Epoch ms — global protective pause (403/ToS ban). Whole pool blocked until this. */
	globalPauseUntil: number;
	/** Name of the most-recently-used account (drain-first strategy). */
	current: string;
	accounts: Record<string, RotationAccountState>;
}
