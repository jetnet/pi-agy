import { Type } from "typebox";

// ── agy ────────────────────────────────────────────────────────────────────────

export const AgyParams = Type.Object({
	prompt: Type.String({
		description: "The full prompt to send to Gemini via agy. Write it however you like — no restrictions.",
	}),
	contextFiles: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Individual file paths (relative to cwd or absolute) whose contents are injected into the prompt as <file> blocks. " +
				"For many files or whole directories use contextDir instead — it avoids the argv size limit.",
		}),
	),
	contextDir: Type.Optional(
		Type.String({
			description:
				"A directory to add to agy's workspace via --add-dir. Gemini can read all files in it. " +
				"Use this instead of contextFiles when passing many files or a whole source tree.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for agy. Defaults to Pi's cwd." })),
	timeoutSec: Type.Optional(
		Type.Number({
			description:
				"Max seconds to wait. Default 120. Always set explicitly based on task size. " +
				"agy FREE/PRO tiers can be slow — be generous.",
		}),
	),
	conversationId: Type.Optional(
		Type.String({
			description:
				"Resume a previous agy conversation by ID (UUID). " +
				"When set, passes --conversation to the agy CLI so Gemini has full prior context. " +
				"Omit to auto-continue the last conversation for the working directory, or set to 'new' to force a fresh conversation.",
		}),
	),
});

// ── agy_image ──────────────────────────────────────────────────────────────────

export const ImageParams = Type.Object({
	imagePath: Type.String({
		description: "Path to the image (PNG/JPG/WebP/GIF). Relative to cwd or absolute.",
	}),
	prompt: Type.String({
		description: "What to do with the image. E.g. 'convert to a React+Tailwind component' or 'describe this UI'.",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for agy. Defaults to Pi's cwd." })),
	timeoutSec: Type.Optional(
		Type.Number({ description: "Max seconds to wait. Default 120. agy FREE/PRO tiers can be slow — be generous." }),
	),
	conversationId: Type.Optional(
		Type.String({
			description:
				"Resume a previous agy conversation by ID (UUID). " +
				"When set, passes --conversation to the agy CLI so Gemini has full prior context. " +
				"Omit to auto-continue the last conversation for the working directory, or set to 'new' to force a fresh conversation.",
		}),
	),
});

// ── agy_usage ──────────────────────────────────────────────────────────────────

export const UsageParams = Type.Object({
	window: Type.Optional(
		Type.Union([Type.Literal("today"), Type.Literal("week"), Type.Literal("month"), Type.Literal("all")], {
			description: "Time window to summarize. Default 'week'.",
		}),
	),
	account: Type.Optional(
		Type.String({
			description: "Filter to a specific account profile name. Default: current active.",
		}),
	),
});

// ── agy_account ────────────────────────────────────────────────────────────────

export const AccountParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("current"), Type.Literal("backup"), Type.Literal("switch")], {
		description:
			"'list' = list profiles. 'current' = show active account. 'backup' = backup current as named profile. 'switch' = switch to profile.",
	}),
	profile: Type.Optional(
		Type.String({
			description: "Profile name for backup/switch. e.g. 'work' or 'personal'.",
		}),
	),
});
