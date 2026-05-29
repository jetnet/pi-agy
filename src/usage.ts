import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCurrentAccount } from "./accounts.ts";
import type { UsageRecord, UsageSummary } from "./types.ts";

// ── Storage paths ──────────────────────────────────────────────────────────────

const USAGE_DIR = path.join(os.homedir(), ".pi", "agy-usage.jsonl");

// ── Log a call ─────────────────────────────────────────────────────────────────

export async function logCall(record: UsageRecord): Promise<void> {
	const line = `${JSON.stringify(record)}\n`;
	await fs.promises.appendFile(USAGE_DIR, line, "utf-8");
}

// ── Read all records ───────────────────────────────────────────────────────────

function readRecords(): UsageRecord[] {
	try {
		const raw = fs.readFileSync(USAGE_DIR, "utf-8");
		return raw
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				try {
					return JSON.parse(l) as UsageRecord;
				} catch {
					return null;
				}
			})
			.filter((r): r is UsageRecord => r !== null);
	} catch {
		return [];
	}
}

// ── Window helpers ─────────────────────────────────────────────────────────────

function getWindowStart(window: string): Date {
	const now = new Date();
	const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	switch (window) {
		case "today":
			return utcMidnight;
		case "week": {
			const d = new Date(utcMidnight);
			d.setUTCDate(d.getUTCDate() - d.getUTCDay());
			return d;
		}
		case "month":
			return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		default:
			return new Date(0);
	}
}

// ── ASCII bar ──────────────────────────────────────────────────────────────────

function asciiBar(count: number, max: number): string {
	const width = 20;
	const filled = max > 0 ? Math.round((count / max) * width) : 0;
	const empty = Math.max(width - filled, 0);
	return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function formatPct(value: number, total: number): number {
	if (total === 0) return 0;
	return Math.round((value / total) * 100);
}

// ── Summarize ──────────────────────────────────────────────────────────────────

export function summarize(window: "today" | "week" | "month" | "all", account?: string): UsageSummary {
	const records = readRecords();
	const windowStart = getWindowStart(window);

	const filtered = records.filter((r) => {
		const ts = new Date(r.ts);
		if (ts < windowStart) return false;
		if (account && r.account !== account) return false;
		return true;
	});

	const totalCalls = filtered.length;
	const toolMap = new Map<string, { count: number; totalLatency: number }>();

	for (const r of filtered) {
		const entry = toolMap.get(r.tool) ?? { count: 0, totalLatency: 0 };
		entry.count++;
		entry.totalLatency += r.latencyMs;
		toolMap.set(r.tool, entry);
	}

	const byTool: Record<string, { count: number; pct: number; avgLatencyMs: number }> = {};
	for (const [tool, data] of toolMap) {
		byTool[tool] = {
			count: data.count,
			pct: formatPct(data.count, totalCalls),
			avgLatencyMs: Math.round(data.totalLatency / data.count),
		};
	}

	// byDay
	const dayMap = new Map<string, number>();
	for (const r of filtered) {
		const day = r.ts.slice(0, 10);
		dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
	}

	const dayMax = Math.max(...dayMap.values(), 1);
	const byDay = Array.from(dayMap.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, count]) => ({
			date,
			count,
			bar: asciiBar(count, dayMax),
		}));

	const totalLatency = filtered.reduce((sum, r) => sum + r.latencyMs, 0);
	const avgLatencyMs = totalCalls > 0 ? Math.round(totalLatency / totalCalls) : 0;

	const warnings: string[] = [];
	const todayCount = records.filter((r) => {
		const ts = new Date(r.ts);
		return ts >= getWindowStart("today");
	}).length;
	const weekCount = records.filter((r) => {
		const ts = new Date(r.ts);
		return ts >= getWindowStart("week");
	}).length;

	if (todayCount > 50) {
		warnings.push(
			`\u26a0 pi-agy has made ${todayCount} calls today \u2014 consider checking agy /usage in TUI to verify Google quota remaining.`,
		);
	}
	if (weekCount > 200) {
		warnings.push(
			`\u26a0 pi-agy has made ${weekCount} calls this week \u2014 consider checking agy /usage in TUI to verify Google quota remaining.`,
		);
	}

	const currentAccount = getCurrentAccount();

	return {
		totalCalls,
		byTool,
		byDay,
		avgLatencyMs,
		account: currentAccount,
		windowLabel: window,
		warnings,
	};
}

// ── Soft warn check ────────────────────────────────────────────────────────────

export function checkSoftWarn(): { warn: boolean; message?: string } {
	const allRecords = readRecords();
	const todayStart = getWindowStart("today");
	const weekStart = getWindowStart("week");

	const todayCount = allRecords.filter((r) => new Date(r.ts) >= todayStart).length;
	const weekCount = allRecords.filter((r) => new Date(r.ts) >= weekStart).length;

	if (todayCount > 50) {
		return {
			warn: true,
			message: `pi-agy has made ${todayCount} calls today \u2014 check agy TUI /usage for remaining quota.`,
		};
	}
	if (weekCount > 200) {
		return {
			warn: true,
			message: `pi-agy has made ${weekCount} calls this week \u2014 check agy TUI /usage for remaining quota.`,
		};
	}
	return { warn: false };
}
