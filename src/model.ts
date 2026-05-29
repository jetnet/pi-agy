import { spawnAgy } from "./execute.ts";

// ── Active model detection ─────────────────────────────────────────────────────
//
// agy -p inherits whatever model was last selected in the TUI. There is no
// config file or flag to read the active model; the only way to know is to ask.
//
// We probe once per process (session) and cache the result. The probe is a
// single cheap call: ~2–4s, runs in parallel with the first real tool call
// (see probeActiveModel). Falls back to "(unknown — check agy TUI)" on any
// failure so we never block real work over a metadata question.

const PROBE_PROMPT =
	"What is the exact name of the AI model you are running on right now? " +
	"Reply with ONLY the model identifier. No explanation. No punctuation. Examples: " +
	"gemini-2.5-flash, gemini-2.0-flash-exp, gemini-1.5-pro. One line only.";

const FALLBACK = "(unknown — check agy TUI)";

// Module-level cache: survives across tool calls within the same Pi session.
let cachedModel: string | null = null;
let probePromise: Promise<string> | null = null;

/** Normalise agy's free-text reply into a compact model id. */
function normalise(raw: string): string {
	// Strip quotes, markdown bold/italic, leading "I am / I run on"
	const s = raw
		.trim()
		.replace(/^["'`*_]+|["'`*_]+$/g, "")
		.replace(/^I(?:'m| am| run on| use| am running on| am based on)\s*/i, "")
		.trim();

	// Take only the first clause (before a comma or period followed by space/end)
	// "Gemini 3.5 Flash, a large language model..." → "Gemini 3.5 Flash"
	const firstClause = s.split(/[,.](?:\s|$)/)[0].trim();

	// If the first clause is a reasonable length (< 60 chars), use it
	if (firstClause && firstClause.length < 60) {
		return firstClause;
	}

	// Fallback: extract the first "gemini[-word]" or "gemini N.N name" token
	const match = s.match(/gemini[\s\-\d.\w]*/i);
	if (match) {
		// Trim trailing noise words
		return match[0].replace(/\s+(a|an|the|model|by|from|built).*$/i, "").trim();
	}

	// Last resort: if result looks like prose rather than a model id, return fallback
	const looksLikeModelId = /\d|flash|pro|ultra|nano|exp|preview|gemini|gpt|claude|llama/i.test(s);
	if (!looksLikeModelId || s.length > 80) return FALLBACK;
	return s;
}

/**
 * Fire the probe in the background. Call this before the first real agy call
 * so the probe can run concurrently. Subsequent calls reuse the same promise.
 */
export function probeActiveModel(cwd: string): Promise<string> {
	if (cachedModel !== null) return Promise.resolve(cachedModel);
	if (probePromise !== null) return probePromise;

	probePromise = spawnAgy(PROBE_PROMPT, {
		cwd,
		timeoutSec: 20,
	})
		.then((result) => {
			const model = result.isError || !result.text ? FALLBACK : normalise(result.text);
			cachedModel = model;
			return model;
		})
		.catch(() => {
			cachedModel = FALLBACK;
			return FALLBACK;
		});

	return probePromise;
}

/**
 * Return the cached model name synchronously. Returns null if the probe
 * hasn't completed yet — callers should await probeActiveModel() first.
 */
export function getCachedModel(): string {
	return cachedModel ?? FALLBACK;
}

/** Reset cache — useful in tests or after an account/model switch. */
export function resetModelCache(): void {
	cachedModel = null;
	probePromise = null;
}

/**
 * Directly set the cached model — used by the rotation-ON path to populate
 * the cache from the selected account's settings.json WITHOUT spawning agy.
 * The probe is bypassed entirely when rotation is active.
 */
export function setModelCache(model: string): void {
	cachedModel = model;
	// Leave probePromise as-is: if a probe is in flight (rotation-OFF called it
	// earlier), it will settle into cachedModel. In rotation-ON we never start a
	// probe, so probePromise stays null throughout.
}
