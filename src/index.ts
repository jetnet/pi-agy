/**
 * pi-agy
 *
 * Registers 4 tools that delegate tasks to Google's Antigravity CLI (agy)
 * running in non-interactive print mode (-p).
 *
 * - agy:         send any prompt to Gemini, optionally inject file context
 * - agy_image:   send a prompt + image file (uses --add-dir workaround)
 * - agy_usage:   local request counter with soft-warn thresholds
 * - agy_account: switch Google accounts by swapping ~/.gemini/ state
 *
 * Requires: agy on PATH, OAuth login via agy TUI, model selected via agy /model
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderCall, renderResult } from "./render";
import { AgyParams, ImageParams, UsageParams } from "./schemas";
import { pruneSessionMap } from "./session";
import { executeAgy } from "./tools/agy";
import { executeImage } from "./tools/image";
import { executeUsage } from "./tools/usage";

export default function piAgyExtension(pi: ExtensionAPI): void {
	// Housekeeping: prune stale pi→agy session mappings on load
	try {
		pruneSessionMap();
	} catch {
		// Non-fatal
	}
	// ── Tool: agy ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "agy",
		label: "Agy",
		description:
			"Send any prompt to Gemini via the agy CLI. " +
			"Use contextFiles to inject file contents into the prompt. " +
			"Write the prompt however you like — no restrictions on format or content. " +
			"Conversations auto-continue by default; pass conversationId to target a specific session or 'new' for a fresh one.",
		promptSnippet: "Ask Gemini — delegates any question, task, or generation request to Gemini via agy",
		promptGuidelines: [
			"Use agy when the user wants to delegate a task to Gemini Flash.",
			"Pass contextDir to add a whole directory to the workspace (uses --add-dir, no argv size limit).",
			"Pass contextFiles for 1–3 targeted files; use contextDir for anything broader.",
			"Write the full prompt yourself — agy sends it verbatim, nothing is added.",
			"Always set timeoutSec explicitly — do not rely on the default. " +
				"Estimate: 120s baseline + ~15s per file for contextFiles + ~30s per 10 files estimated in contextDir. " +
				"Double the estimate for deep analysis tasks (security audit, architecture review). " +
				"agy FREE/PRO tiers can be 3–5x slower than expected — when in doubt, be generous.",
			"Conversations auto-continue: each pi session gets its own agy conversation. " +
				"Gemini retains full context from prior calls within the same session. " +
				"Pass conversationId='new' to force a fresh conversation. " +
				"The response includes the conversationId in details for chaining.",
			"Pass model to override the active model for one call (e.g. 'Gemini 3.1 Pro (High)'). " +
				"Omit to use whatever is configured in the agy TUI. The override is temporary — the original model is restored after the call.",
			"When agy generates images, the file paths appear in the response under 'Generated images:'. " +
				"Use those paths with telegram_attach or read to show the image to the user.",
		],
		parameters: AgyParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeAgy(params, signal, onUpdate as any, ctx) as any;
		},
		renderCall,
		renderResult,
	});

	// ── Tool: agy_image ─────────────────────────────────────────────────
	pi.registerTool({
		name: "agy_image",
		label: "Agy Image",
		description:
			"Send a prompt + image file to Gemini via agy. " +
			"Uses --add-dir to make the image accessible to agy. " +
			"Supported formats: PNG, JPG, WebP, GIF.",
		promptSnippet: "Send image to Gemini — use when the task involves an image file",
		promptGuidelines: [
			"Use agy_image when the prompt needs to reference an image file.",
			"Write the full prompt — imagePath is injected automatically.",
			"Supported formats: PNG, JPG, WebP, GIF.",
		],
		parameters: ImageParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeImage(params, signal, onUpdate as any, ctx) as any;
		},
		renderCall,
		renderResult,
	});

	// ── Tool: agy_usage ─────────────────────────────────────────────────
	pi.registerTool({
		name: "agy_usage",
		label: "Agy Usage",
		description:
			"Show pi-agy's local request counter. " + "Soft-warns at 50 calls/day or 200/week but never refuses calls.",
		promptSnippet: "Show agy usage — triggers on 'agy usage', 'how many agy calls', 'check agy quota'",
		promptGuidelines: [
			"Use agy_usage to check how many calls have been made.",
			"The counter is local only — does not reflect Google's server-side quota.",
		],
		parameters: UsageParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeUsage(params, signal, onUpdate as any, ctx) as any;
		},
		renderCall,
		renderResult,
	});
}
