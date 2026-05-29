import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Agy model selection via settings.json ───────────────────────────────────────
//
// agy has no --model CLI flag. The active model is stored in:
//   <home>/.gemini/antigravity-cli/settings.json → "model": "..."
//
// To support per-call model selection, we:
//   1. Read the current model from settings.json under the target home
//   2. If different from the requested model, swap it
//   3. Run agy (reads settings.json on startup from its HOME)
//   4. Restore the original model in a finally block
//
// Fix #7: setModel(model, home?) accepts the account HOME so that when rotation
// is active, Pi writes the settings file into the same directory that the spawned
// agy process will read. Without this, Pi would write to Pi's own ~/.gemini/...
// while agy reads from the account's ~/.gemini/... — silently diverging.

/** Known model names from the agy TUI. Used for validation. */
const KNOWN_MODELS = new Set([
	"Gemini 3.5 Flash (Medium)",
	"Gemini 3.5 Flash (High)",
	"Gemini 3.5 Flash (Low)",
	"Gemini 3.1 Pro (Low)",
	"Gemini 3.1 Pro (High)",
	"Claude Sonnet 4.6 (Thinking)",
	"Claude Opus 4.6 (Thinking)",
	"GPT-OSS 120B (Medium)",
]);

/** All known models, exported for schema generation / prompt guidelines. */
export const KNOWN_MODEL_LIST = [...KNOWN_MODELS];

/**
 * Check if a model name is in the known list.
 * Case-insensitive match to be forgiving of minor typos in casing.
 */
export function findKnownModel(name: string): string | undefined {
	// Exact match first
	if (KNOWN_MODELS.has(name)) return name;

	// Case-insensitive fallback
	const lower = name.toLowerCase();
	for (const m of KNOWN_MODELS) {
		if (m.toLowerCase() === lower) return m;
	}

	return undefined;
}

/** Resolve the settings.json path for a given home directory (or Pi's own home). */
function settingsFilePath(home?: string): string {
	return path.join(home ?? os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

interface SettingsJson {
	model?: string;
	[key: string]: unknown;
}

function readSettings(home?: string): SettingsJson {
	try {
		return JSON.parse(fs.readFileSync(settingsFilePath(home), "utf-8"));
	} catch {
		return {};
	}
}

function writeSettings(settings: SettingsJson, home?: string): void {
	fs.writeFileSync(settingsFilePath(home), JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Temporarily set the agy model in the target account's settings.json.
 *
 * @param model  The model name to activate (must be in KNOWN_MODELS).
 * @param home   The account HOME directory. Defaults to Pi's own home (os.homedir()).
 *               When rotation is active, pass the account's home dir so Pi writes
 *               to the same settings.json that the spawned agy process will read.
 *
 * Returns a restore function that puts the original model back.
 * If the model is already active, returns a no-op.
 *
 * Usage:
 *   const restore = setModel("Gemini 3.1 Pro (High)", acct.home);
 *   try { await spawnAgy(..., { homeDir: acct.home }); } finally { restore(); }
 */
export function setModel(model: string, home?: string): () => void {
	const settings = readSettings(home);
	const originalModel = settings.model;

	if (originalModel === model) {
		// Already the active model — no-op
		return () => {};
	}

	// Swap
	settings.model = model;
	writeSettings(settings, home);

	// Return restore function
	return () => {
		try {
			// Re-read in case another field changed while agy was running
			const current = readSettings(home);
			current.model = originalModel;
			writeSettings(current, home);
		} catch {
			// Non-fatal: worst case the model stays swapped
		}
	};
}

/** Read the current model from Pi's own settings.json (no rotation). */
export function getCurrentModel(): string | undefined {
	return readSettings().model;
}

/**
 * Read the active model name from settings.json for the given home directory.
 * Used by the rotation-ON path to populate tool details WITHOUT spawning agy.
 *
 * @param home  The account HOME directory (default: Pi's home).
 * @returns The model string from settings.json, or a neutral fallback label.
 */
export function readCurrentModel(home?: string): string {
	return readSettings(home).model ?? "(rotation: check account settings)";
}
