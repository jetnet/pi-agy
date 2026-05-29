import type { AgyToolDetails } from "../types.ts";
import { summarize } from "../usage.ts";

export async function executeUsage(
	params: any,
	_signal: AbortSignal | undefined,
	_onUpdate: any,
	_ctx: any,
): Promise<{ content: Array<{ type: string; text: string }>; details: AgyToolDetails; isError: boolean }> {
	const startTime = Date.now();
	const window = params.window ?? "week";
	const account = params.account ?? undefined;

	const summary = summarize(window as "today" | "week" | "month" | "all", account);

	const lines: string[] = [];

	const accountLabel = summary.account ?? "(unknown)";
	lines.push(`pi-agy usage \u2014 ${summary.windowLabel} (account: ${accountLabel})`);
	lines.push("");

	const toolNames = Object.keys(summary.byTool).sort();
	const maxNameLen = Math.max(...["Total", ...toolNames].map((n) => n.length));
	for (const tool of toolNames) {
		const data = summary.byTool[tool];
		const label = tool.padEnd(maxNameLen);
		lines.push(
			`  ${label}  ${data.count} call${data.count === 1 ? "" : "s"} (${data.pct}%)  ~${Math.round(data.avgLatencyMs / 1000)}s avg`,
		);
	}

	const totalLabel = "Total".padEnd(maxNameLen);
	const avgSec = Math.round(summary.avgLatencyMs / 1000);
	lines.push(
		`  ${totalLabel}  ${summary.totalCalls} call${summary.totalCalls === 1 ? "" : "s"}  ~${avgSec}s avg latency`,
	);
	lines.push("");

	if (summary.byDay.length > 0) {
		for (const day of summary.byDay) {
			const date = new Date(day.date);
			const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
			lines.push(`  ${dow}  ${day.bar}  ${day.count}`);
		}
		lines.push("");
	}

	lines.push("Note: this is pi-agy's local counter only. For Google-side quota, run /usage in the agy TUI.");

	if (summary.warnings.length > 0) {
		lines.push("");
		for (const warn of summary.warnings) {
			lines.push(warn);
		}
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { durationMs: Date.now() - startTime, account: summary.account ?? null, exitCode: 0 },
		isError: false,
	};
}
