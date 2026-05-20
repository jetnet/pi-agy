import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgyToolDetails } from "./types";

// ── TUI rendering ──────────────────────────────────────────────────────────────

function getToolLabel(args: any): string {
	if (args.focus) return "agy_critique";
	if (args.imagePath) return "agy_image_to_ui";
	if (args.action) return "agy_account";
	if (args.window) return "agy_usage";
	if (args.prompt) return "agy_design";
	return "agy_tool";
}

/** Shared renderCall for all agy tools. */
export function renderCall(args: any, theme: any): any {
	const toolName = getToolLabel(args);
	const modelLabel = "flash-3.5-high";

	let text = theme.fg("toolTitle", theme.bold(`\u26a1 ${toolName} `)) + theme.fg("accent", `[${modelLabel}]`);

	// For prompt tools, show the prompt preview
	if (args.prompt) {
		const prompt = String(args.prompt ?? "");
		const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}\u2026` : prompt;
		text += `\n  ${theme.fg("dim", preview)}`;
	}

	// For critique, show the target file
	if (args.targetFile) {
		text += `\n  ${theme.fg("muted", "file: ")}${theme.fg("dim", args.targetFile)}`;
	}

	// For image_to_ui, show the image path
	if (args.imagePath) {
		text += `\n  ${theme.fg("muted", "image: ")}${theme.fg("dim", args.imagePath)}`;
	}

	// For account, show the action
	if (args.action) {
		text += `\n  ${theme.fg("muted", "action: ")}${theme.fg("accent", args.action)}`;
		if (args.profile) text += `  ${theme.fg("dim", args.profile)}`;
	}

	return new Text(text, 0, 0);
}

/** Shared renderResult for all agy tools. */
export function renderResult(result: any, { expanded }: any, theme: any): any {
	const details = result.details as AgyToolDetails | undefined;
	const text = result.content[0]?.type === "text" ? result.content[0].text : "(no output)";

	const metaParts: string[] = [];
	if (details?.model) metaParts.push(details.model);
	if (details?.durationMs) metaParts.push(`${(details.durationMs / 1000).toFixed(1)}s`);
	if (details?.account) metaParts.push(details.account);
	const meta = metaParts.length ? `  ${metaParts.map((p) => theme.fg("dim", p)).join("  ")}` : "";

	if (result.isError) {
		return new Text(
			theme.fg("error", "\u2717 ") +
				theme.fg("toolTitle", theme.bold("Agy")) +
				meta +
				`\n${theme.fg("error", text.length > 500 ? `${text.slice(0, 500)}\u2026` : text)}`,
			0,
			0,
		);
	}

	const icon = theme.fg("success", "\u2713");
	const headerLine = `${icon} ${theme.fg("toolTitle", theme.bold("Agy"))}${meta}`;

	if (expanded) {
		const mdTheme = getMarkdownTheme();
		const container = new Container();
		container.addChild(new Text(headerLine, 0, 0));
		if (text) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Response \u2500\u2500\u2500"), 0, 0));
			container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
		}
		return container;
	}

	// Collapsed view
	const previewLines = text.split("\n").slice(0, 6);
	const previewText = previewLines.join("\n") + (text.split("\n").length > 6 ? "\n\u2026" : "");

	let out = headerLine;
	if (text) out += `\n${theme.fg("toolOutput", previewText)}`;
	out += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

	return new Text(out, 0, 0);
}
