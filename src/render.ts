import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgyToolDetails } from "./types";

// ── TUI rendering ──────────────────────────────────────────────────────────────

/** Shared renderCall for all agy tools. */
export function renderCall(args: any, theme: any): any {
	const toolName: string = args.imagePath
		? "agy_image"
		: args.action
			? "agy_account"
			: args.window
				? "agy_usage"
				: "agy";
	const model = args.action || args.window ? "" : theme.fg("accent", `[${args._model ?? "gemini"}]`);

	let text = theme.fg("toolTitle", theme.bold(`⚡ ${toolName} `)) + model;

	if (args.prompt) {
		const preview = args.prompt.length > 80 ? `${args.prompt.slice(0, 80)}…` : args.prompt;
		text += `\n  ${theme.fg("dim", preview)}`;
	}

	if (args.imagePath) {
		text += `\n  ${theme.fg("muted", "image: ")}${theme.fg("dim", args.imagePath)}`;
	}

	if (args.contextDir) {
		text += `\n  ${theme.fg("muted", "dir: ")}${theme.fg("dim", args.contextDir)}`;
	}

	if (args.contextFiles?.length > 0) {
		text += `\n  ${theme.fg("muted", "files: ")}${theme.fg("dim", args.contextFiles.join(", "))}`;
	}

	if (args.model) {
		text += `\n  ${theme.fg("muted", "model: ")}${theme.fg("accent", args.model)}`;
	}

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
	if (details?.conversationId) metaParts.push(`conv:${details.conversationId.slice(0, 8)}`);
	const meta = metaParts.length ? `  ${metaParts.map((p) => theme.fg("dim", p)).join("  ")}` : "";

	if (result.isError) {
		return new Text(
			theme.fg("error", "✗ ") +
				theme.fg("toolTitle", theme.bold("Agy")) +
				meta +
				`\n${theme.fg("error", text.length > 500 ? `${text.slice(0, 500)}…` : text)}`,
			0,
			0,
		);
	}

	const icon = theme.fg("success", "✓");
	const headerLine = `${icon} ${theme.fg("toolTitle", theme.bold("Agy"))}${meta}`;

	if (expanded) {
		const mdTheme = getMarkdownTheme();
		const container = new Container();
		container.addChild(new Text(headerLine, 0, 0));
		if (text) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Response ───"), 0, 0));
			container.addChild(new Markdown(text.trim(), 0, 0, mdTheme));
		}
		return container;
	}

	const previewLines = text.split("\n").slice(0, 6);
	const previewText = previewLines.join("\n") + (text.split("\n").length > 6 ? "\n…" : "");

	let out = headerLine;
	if (text) out += `\n${theme.fg("toolOutput", previewText)}`;
	out += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

	return new Text(out, 0, 0);
}
