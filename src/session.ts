import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Pi-session → Agy-conversation mapping ──────────────────────────────────────
//
// Each pi session gets its own agy conversation. The mapping is stored in
// ~/.pi/agy-sessions.json as { piSessionId: agyConversationId }.
//
// Discovery (first call in a pi session):
//   After agy exits it writes the conversation UUID into
//   ~/.gemini/antigravity-cli/cache/last_conversations.json (keyed by cwd).
//   We read that file immediately and store the UUID in our own mapping.
//   Subsequent calls resolve from the mapping, never touching agy's file again.

const AGY_CONVERSATIONS_FILE = path.join(
	os.homedir(),
	".gemini",
	"antigravity-cli",
	"cache",
	"last_conversations.json",
);

const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");

const SESSION_MAP_FILE = path.join(os.homedir(), ".pi", "agy-sessions.json");

// ── Our session map: piSessionId → agyConversationId ────────────────────────

let sessionMap: Record<string, string> = {};
let sessionMapLoaded = false;

function loadSessionMap(): Record<string, string> {
	if (sessionMapLoaded) return sessionMap;
	try {
		const raw = fs.readFileSync(SESSION_MAP_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			sessionMap = parsed;
		}
	} catch {
		sessionMap = {};
	}
	sessionMapLoaded = true;
	return sessionMap;
}

function saveSessionMap(): void {
	try {
		const dir = path.dirname(SESSION_MAP_FILE);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(sessionMap, null, "\t"), "utf-8");
	} catch {
		// Non-fatal: worst case we start a fresh conversation next time
	}
}

/**
 * Get the agy conversation ID linked to a pi session.
 */
export function getConversationForSession(piSessionId: string): string | undefined {
	const map = loadSessionMap();
	const convId = map[piSessionId];
	return convId && isValidConversationId(convId) ? convId : undefined;
}

/**
 * Link a pi session to an agy conversation ID.
 */
export function setConversationForSession(piSessionId: string, agyConversationId: string): void {
	loadSessionMap();
	sessionMap[piSessionId] = agyConversationId;
	saveSessionMap();
}

// ── Read agy's conversation map (for first-call discovery only) ─────────────

/**
 * Read the conversation UUID that agy just wrote for a given cwd.
 * Called once immediately after the first agy call in a pi session.
 */
function readAgyConversationForCwd(cwd: string): string | undefined {
	try {
		const raw = fs.readFileSync(AGY_CONVERSATIONS_FILE, "utf-8");
		const map = JSON.parse(raw);
		if (typeof map !== "object" || map === null || Array.isArray(map)) return undefined;

		if (map[cwd]) return map[cwd];

		// Try resolved path
		const resolved = fs.realpathSync(cwd);
		if (map[resolved]) return map[resolved];
	} catch {
		// File missing or corrupt — first call ever, no big deal
	}
	return undefined;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate that a conversation ID looks like a UUID.
 * Prevents injection of arbitrary CLI flags.
 */
export function isValidConversationId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ── Convenience: resolve + update for tool calls ────────────────────────────

/**
 * Resolve the agy conversation ID to use for a tool call.
 *
 * Priority:
 *   1. explicitId = "new"        → undefined (fresh conversation)
 *   2. explicitId = valid UUID   → that UUID
 *   3. No explicitId             → look up piSessionId in our mapping
 *   4. No mapping found          → undefined (first call → fresh conv)
 */
export function resolveConversationId(explicitId: string | undefined, piSessionId: string): string | undefined {
	if (explicitId === "new") return undefined;

	if (explicitId && isValidConversationId(explicitId)) {
		return explicitId;
	}

	return getConversationForSession(piSessionId);
}

/**
 * After an agy call, update the session mapping.
 *
 * - If we passed --conversation: ensure mapping is stored.
 * - If this was a fresh call: read agy's cwd-keyed file to get the new UUID.
 *
 * Returns the final conversation ID.
 */
export function afterAgyCall(
	piSessionId: string,
	usedConversationId: string | undefined,
	cwd: string,
): string | undefined {
	if (usedConversationId) {
		const existing = getConversationForSession(piSessionId);
		if (existing !== usedConversationId) {
			setConversationForSession(piSessionId, usedConversationId);
		}
		return usedConversationId;
	}

	// First call: read the UUID agy just wrote
	const discovered = readAgyConversationForCwd(cwd);
	if (discovered && isValidConversationId(discovered)) {
		setConversationForSession(piSessionId, discovered);
		return discovered;
	}

	return undefined;
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/**
 * Prune stale entries from the session map.
 * Removes entries whose agy conversation no longer exists on disk.
 */
export function pruneSessionMap(): number {
	loadSessionMap();
	let pruned = 0;

	for (const [piId, agyId] of Object.entries(sessionMap)) {
		const convDir = path.join(BRAIN_DIR, agyId);
		try {
			fs.statSync(convDir);
		} catch {
			delete sessionMap[piId];
			pruned++;
		}
	}

	if (pruned > 0) saveSessionMap();
	return pruned;
}
