import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AccountStatus,
	RotationAccountState,
	RotationConfig,
	RotationConfigEntry,
	RotationState,
} from "./types.ts";

// ── Paths ─────────────────────────────────────────────────────────────────────

const PI_DIR = path.join(os.homedir(), ".pi");
const CONFIG_PATH = path.join(PI_DIR, "agy-rotation.config.json");
const STATE_PATH = path.join(PI_DIR, "agy-rotation-state.json");

// ── Module-level async mutex (H3a) ────────────────────────────────────────────
//
// Serializes the entire rotation-enabled critical section across concurrent
// pi tool calls in the same process:
//   loadState → pickNextAccount → setModel(accountHome) → spawnAgy → mark* → saveState
//
// Two concurrent agy / agy_image calls cannot select the same account or
// overwrite each other's rotation state.
//
// The rotation-OFF path must NOT call withRotationLock; it runs unserialized
// exactly as before.

let _lockTail: Promise<void> = Promise.resolve();

/**
 * Run `fn` exclusively: waits for any in-flight rotation operation to finish,
 * then runs `fn`, then releases the lock. Errors from `fn` propagate normally.
 */
export function withRotationLock<T>(fn: () => Promise<T>): Promise<T> {
	const p = _lockTail.then(() => fn());
	// Update the tail to await fn completion; silence rejections so the chain
	// never breaks for the next caller even if fn threw.
	_lockTail = p.then(
		() => {},
		() => {},
	);
	return p;
}

// ── Config validation helpers ─────────────────────────────────────────────────

const ACCOUNT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate a numeric config field; fall back to default for bad values. */
function safePositiveFinite(val: unknown, dflt: number): number {
	return typeof val === "number" && Number.isFinite(val) && val > 0 ? val : dflt;
}

/** Write a human-readable config-invalid warning to stderr. */
function warnConfigInvalid(reason: string): void {
	process.stderr.write(`[pi-agy] rotation config invalid (rotation disabled): ${reason}\n`);
}

/**
 * Load and validate the rotation config from ~/.pi/agy-rotation.config.json.
 *
 * - File absent (ENOENT): returns null SILENTLY — rotation is OFF (expected).
 * - File present but invalid: logs a warning to stderr and returns null.
 * - File valid: returns config.
 *
 * Invalid-but-present is explicitly distinguished from absent so operators
 * can detect misconfiguration rather than silently getting no rotation.
 */
export function loadRotationConfig(): RotationConfig | null {
	return loadRotationConfigFrom(CONFIG_PATH);
}

/**
 * Same as loadRotationConfig but accepts a custom path.
 * Exported for unit testing only.
 */
export function loadRotationConfigFrom(configPath: string): RotationConfig | null {
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf-8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null; // absent — silent, expected
		process.stderr.write(`[pi-agy] rotation config unreadable: ${(err as Error).message}\n`);
		return null;
	}

	// File is present — any parse/validation failure is now a diagnostic (not silent)
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		warnConfigInvalid(`JSON parse error: ${(err as Error).message}`);
		return null;
	}

	const rawAccounts = parsed.accounts;
	if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) {
		warnConfigInvalid("missing or empty 'accounts' array");
		return null;
	}

	const accounts: RotationConfigEntry[] = [];
	const seenNames = new Set<string>();
	const seenHomes = new Set<string>();

	for (const entry of rawAccounts as unknown[]) {
		if (typeof entry !== "object" || entry === null) {
			warnConfigInvalid("account entry must be an object");
			return null;
		}
		const e = entry as Record<string, unknown>;

		// Name validation
		if (typeof e.name !== "string" || !ACCOUNT_NAME_RE.test(e.name)) {
			warnConfigInvalid(`invalid account name (must match /^[a-zA-Z0-9_-]+$/): ${JSON.stringify(e.name)}`);
			return null;
		}
		// Home validation
		if (typeof e.home !== "string" || !path.isAbsolute(e.home)) {
			warnConfigInvalid(`account '${e.name}' home must be an absolute path, got: ${JSON.stringify(e.home)}`);
			return null;
		}

		// Duplicate name check — reject same name appearing twice
		if (seenNames.has(e.name)) {
			warnConfigInvalid(`duplicate account name: '${e.name}'`);
			return null;
		}
		seenNames.add(e.name);

		// Duplicate home check — canonicalize for comparison to prevent no-hammer bypass via aliased homes
		// Use realpathSync if the path exists, else path.resolve (handles not-yet-created dirs)
		let canonHome: string;
		try {
			canonHome = fs.realpathSync(e.home);
		} catch {
			canonHome = path.resolve(e.home);
		}
		if (seenHomes.has(canonHome)) {
			warnConfigInvalid(`duplicate account home path: '${e.home}' resolves to the same directory as another entry`);
			return null;
		}
		seenHomes.add(canonHome);

		accounts.push({ name: e.name, home: e.home });
	}

	const dbusAddress =
		typeof parsed.dbusAddress === "string" ? parsed.dbusAddress : "unix:path=/tmp/ag-acp-no-keyring-main";

	// Numeric fields: invalid values fall back to defaults (don't kill config
	// over one bad optional number — config numeric validation)
	const dailySoftCap = safePositiveFinite(parsed.dailySoftCap, 90);
	const defaultCooldownSec = safePositiveFinite(parsed.defaultCooldownSec, 60);
	const protectivePauseHours = safePositiveFinite(parsed.protectivePauseHours, 6);

	let jitterMs: [number, number] = [400, 1200];
	if (Array.isArray(parsed.jitterMs) && parsed.jitterMs.length === 2) {
		const mn = parsed.jitterMs[0] as unknown;
		const mx = parsed.jitterMs[1] as unknown;
		if (
			typeof mn === "number" &&
			typeof mx === "number" &&
			Number.isFinite(mn) &&
			Number.isFinite(mx) &&
			mn >= 0 &&
			mx > 0 &&
			mn <= mx
		) {
			jitterMs = [mn, mx];
		}
		// else: use default [400, 1200] silently
	}

	return { accounts, dbusAddress, dailySoftCap, defaultCooldownSec, protectivePauseHours, jitterMs };
}

// ── State helpers ─────────────────────────────────────────────────────────────

/** Format epoch ms as YYYY-MM-DD. */
export function todayStamp(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function defaultAccountState(now: number): RotationAccountState {
	return {
		status: "AVAILABLE",
		cooldownUntil: 0,
		requestsToday: 0,
		dayStamp: todayStamp(now),
		requestsSinceRotation: 0,
		lastUsedMs: 0,
		lastError: null,
	};
}

/**
 * Load persisted rotation state. Creates a fresh state if the file is missing.
 * Ensures all accounts from config have entries; ignores entries not in config.
 */
export function loadState(config: RotationConfig, now = Date.now()): RotationState {
	let stored: Partial<RotationState> = {};
	try {
		stored = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as RotationState;
	} catch {
		// No state file yet — start fresh
	}

	const accounts: Record<string, RotationAccountState> = {};
	for (const entry of config.accounts) {
		const existing = stored.accounts?.[entry.name];
		accounts[entry.name] = existing ?? defaultAccountState(now);
	}

	const current =
		stored.current && config.accounts.some((a) => a.name === stored.current)
			? (stored.current as string)
			: config.accounts[0].name;

	return {
		globalPauseUntil: stored.globalPauseUntil ?? 0,
		current,
		accounts,
	};
}

/**
 * Atomically persist rotation state to ~/.pi/agy-rotation-state.json (mode 0600).
 * Uses a tmp-file + rename pattern. Failure is best-effort (never throws).
 */
export function saveState(state: RotationState): void {
	const tmpPath = `${STATE_PATH}.tmp.${process.pid}`;
	try {
		fs.mkdirSync(PI_DIR, { recursive: true });
		fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmpPath, STATE_PATH);
		try {
			fs.chmodSync(STATE_PATH, 0o600);
		} catch {
			// best-effort chmod after rename
		}
	} catch {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// ignore cleanup error
		}
	}
}

// ── Lazy refresh (applied in-place) ──────────────────────────────────────────

/**
 * Apply lazy transitions to a single account state:
 * - day rollover: reset requestsToday when dayStamp != today
 * - cooldown expiry: EXHAUSTED → AVAILABLE when cooldownUntil <= now
 */
export function refreshAccountState(acct: RotationAccountState, now: number): void {
	const today = todayStamp(now);
	if (acct.dayStamp !== today) {
		acct.requestsToday = 0;
		acct.dayStamp = today;
	}
	if (acct.status === "EXHAUSTED" && acct.cooldownUntil <= now) {
		acct.status = "AVAILABLE";
	}
}

// ── Pure transition functions ─────────────────────────────────────────────────
// These take state objects and mutate them. They are exported for unit testing.
// Call saveState() after any transition to persist changes.

/**
 * Record a successful call on the named account.
 * Increments per-day and per-rotation counters; updates lastUsedMs; sets current.
 */
export function markSuccess(state: RotationState, name: string, now = Date.now()): void {
	const acct = state.accounts[name];
	if (!acct) return;
	acct.status = "AVAILABLE" as AccountStatus;
	acct.requestsToday += 1;
	acct.requestsSinceRotation += 1;
	acct.lastUsedMs = now;
	acct.lastError = null;
	state.current = name;
}

/**
 * Mark an account as quota-exhausted with a cooldown period.
 * Status → EXHAUSTED; cooldownUntil = now + cooldownSec * 1000.
 */
export function markExhausted(state: RotationState, name: string, cooldownSec: number, now = Date.now()): void {
	const acct = state.accounts[name];
	if (!acct) return;
	acct.status = "EXHAUSTED" as AccountStatus;
	acct.cooldownUntil = now + cooldownSec * 1000;
	acct.lastUsedMs = now;
	acct.lastError = `quota exhausted; cooldown until ${new Date(acct.cooldownUntil).toISOString()}`;
}

/**
 * Mark an account as permanently flagged (ToS/403 ban).
 * Also sets the global protective pause for the whole pool.
 *
 * WARNING: This is triggered by the 'banned' errorClass which relies on
 * provisional regex patterns for 403/ToS detection (unverified against a real ban).
 * See execute.ts parseLogContent for the caveat.
 */
export function markFlagged(state: RotationState, name: string, protectivePauseHours: number, now = Date.now()): void {
	const acct = state.accounts[name];
	if (!acct) return;
	acct.status = "FLAGGED" as AccountStatus;
	acct.lastUsedMs = now;
	acct.lastError = "ToS ban (403/PERMISSION_DENIED) — manual clear required via agy_account clear-flag";
	state.globalPauseUntil = now + protectivePauseHours * 3_600_000;
}

// ── Pin validation ────────────────────────────────────────────────────────────

/**
 * Check if a pinned account is usable. Returns an error message string or null.
 *
 * Checks the GLOBAL PAUSE FIRST: a 403/ToS protective pause must
 * block ALL accounts including explicitly pinned ones. Without this check,
 * a user could bypass the 6h WAF pause by pinning any non-flagged account.
 *
 * @param rotState Current rotation state
 * @param name     Account name to check
 * @param now      Injectable clock (ms since epoch) for deterministic testing
 */
export function checkPinUsable(rotState: RotationState, name: string, now = Date.now()): string | null {
	// Global pause check FIRST — must block all accounts including pinned
	if (rotState.globalPauseUntil > now) {
		const until = new Date(rotState.globalPauseUntil).toLocaleString();
		return `⛔ All accounts paused until ${until} (protective pause after ToS/403 detection). Do not retry until then.`;
	}
	const acctState = rotState.accounts[name];
	if (acctState?.status === "FLAGGED") {
		return `Account '${name}' is permanently flagged (ToS/403 ban). Use agy_account clear-flag to restore.`;
	}
	if (acctState?.status === "EXHAUSTED" && acctState.cooldownUntil > now) {
		const remaining = Math.ceil((acctState.cooldownUntil - now) / 1000);
		return `Account '${name}' is in cooldown for ${remaining}s. Use a different account or wait.`;
	}
	return null;
}

// ── Selection ─────────────────────────────────────────────────────────────────

export type PickResult =
	| { kind: "ok"; account: RotationConfigEntry }
	| { kind: "paused"; until: number }
	| { kind: "exhausted"; soonestCooldownUntil: number };

/**
 * Pick the next available account using the reactive-only (drain-first) strategy.
 *
 * Strategy:
 *   1. Global pause → block all.
 *   2. Lazy-refresh all accounts (cooldown expiry, day rollover).
 *   3. Try `state.current` first (drain it until it 429s).
 *   4. Then iterate config offsets 1..n-1 from currentIndex, wrapping around.
 *   5. If none → return soonest cooldown.
 *
 * @param state   Rotation state (mutated for lazy refreshes)
 * @param config  Pool config (defines account order)
 * @param exclude Names to skip (already tried this call — no-hammer guarantee)
 * @param now     Injectable clock (ms since epoch) for deterministic testing
 */
export function pickNextAccount(
	state: RotationState,
	config: RotationConfig,
	exclude: Set<string>,
	now = Date.now(),
): PickResult {
	// Check global protective pause
	if (state.globalPauseUntil > now) {
		return { kind: "paused", until: state.globalPauseUntil };
	}

	// Lazy-refresh all accounts
	for (const acct of Object.values(state.accounts)) {
		refreshAccountState(acct, now);
	}

	// Build try order: current first, then wrap-around from currentIndex
	const tryOrder = buildTryOrder(config.accounts, state.current, exclude);

	let soonestCooldown = Number.MAX_SAFE_INTEGER;

	for (const entry of tryOrder) {
		const acct = state.accounts[entry.name];
		if (!acct) continue;
		if (acct.status === "FLAGGED") continue;
		if (acct.status === "EXHAUSTED") {
			soonestCooldown = Math.min(soonestCooldown, acct.cooldownUntil);
			continue;
		}
		// AVAILABLE
		return { kind: "ok", account: entry };
	}

	const fallbackCooldown = soonestCooldown === Number.MAX_SAFE_INTEGER ? now + 60_000 : soonestCooldown;
	return { kind: "exhausted", soonestCooldownUntil: fallbackCooldown };
}

/**
 * Build the ordered list of accounts to try: current first, then iterate
 * offsets 1..n-1 modulo accounts.length starting from currentIndex.
 *
 * BEFORE (buggy): after current, restarted from config index 0.
 *   [dv, jn, extra], current=jn → tried jn, dv, extra  ← wrong
 * AFTER (fixed): wrap-around from currentIndex.
 *   [dv, jn, extra], current=jn (idx=1) → tried jn, extra, dv  ← correct
 */
function buildTryOrder(accounts: RotationConfigEntry[], current: string, exclude: Set<string>): RotationConfigEntry[] {
	const result: RotationConfigEntry[] = [];
	const n = accounts.length;
	const currentIndex = accounts.findIndex((a) => a.name === current);

	if (currentIndex === -1) {
		// current not in pool (stale state) — just iterate config order
		for (const entry of accounts) {
			if (!exclude.has(entry.name)) result.push(entry);
		}
		return result;
	}

	// Current first (drain strategy)
	if (!exclude.has(current)) {
		result.push(accounts[currentIndex]);
	}

	// Then offsets 1..n-1 modulo n from currentIndex (wrap-around)
	for (let offset = 1; offset < n; offset++) {
		const entry = accounts[(currentIndex + offset) % n];
		if (!exclude.has(entry.name)) {
			result.push(entry);
		}
	}

	return result;
}

// ── Jitter ────────────────────────────────────────────────────────────────────

/**
 * Sleep for a random duration within config.jitterMs.
 * Called between retry attempts to appear human-like to Google's WAF.
 */
export function jitterSleep(config: RotationConfig): Promise<void> {
	const [min, max] = config.jitterMs;
	const delay = Math.floor(Math.random() * (max - min + 1)) + min;
	return new Promise((resolve) => setTimeout(resolve, delay));
}
