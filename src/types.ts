// ── Shared type definitions for pi-agy ─────────────────────────────────────────

export interface SpawnAgyOptions {
	cwd: string;
	timeoutSec: number;
	addDirs?: string[];
	conversationId?: string;
	signal?: AbortSignal;
	onProgress?: (status: string) => void;
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

export interface ProfileInfo {
	name: string;
	email: string;
	backedUpAt: string;
}

export interface AgyToolDetails {
	durationMs: number;
	account: string | null;
	exitCode: number;
	model?: string;
	conversationId?: string;
}
