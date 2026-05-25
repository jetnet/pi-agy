import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Agy model selection via settings.json ───────────────────────────────────────
//
// agy has no --model CLI flag. The active model is stored in:
//   ~/.gemini/antigravity-cli/settings.json → "model": "..."
//
// To support per-call model selection, we:
//   1. Read the current model from settings.json
//   2. If different from the requested model, swap it
//   3. Run agy (reads settings.json on startup)
//   4. Restore the original model in a finally block

const SETTINGS_FILE = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");

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

interface SettingsJson {
	model?: string;
	[key: string]: unknown;
}

function readSettings(): SettingsJson {
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
	} catch {
		return {};
	}
}

function writeSettings(settings: SettingsJson): void {
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Temporarily set the agy model in settings.json.
 *
 * Returns a restore function that puts the original model back.
 * If the model is already the active one, returns a no-op.
 *
 * Usage:
 *   const restore = setModel("Gemini 3.1 Pro (High)");
 *   try { await spawnAgy(...); } finally { restore(); }
 */
export function setModel(model: string): () => void {
	const settings = readSettings();
	const originalModel = settings.model;

	if (originalModel === model) {
		// Already the active model — no-op
		return () => {};
	}

	// Swap
	settings.model = model;
	writeSettings(settings);

	// Return restore function
	return () => {
		try {
			// Re-read in case another field changed while agy was running
			const current = readSettings();
			current.model = originalModel;
			writeSettings(current);
		} catch {
			// Non-fatal: worst case the model stays swapped
		}
	};
}

/** Read the current model from settings.json. */
export function getCurrentModel(): string | undefined {
	return readSettings().model;
}
