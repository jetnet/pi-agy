import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Account detection ──────────────────────────────────────────────────────────
//
// agy authenticates via the OS keyring and doesn't always update
// google_accounts.json. The real account email is detected from agy's
// --log-file after every call (see execute.ts). This module provides
// the file-based fallback and keeps google_accounts.json in sync.

const GEMINI_DIR = path.join(os.homedir(), ".gemini");

function googleAccountsPath(): string {
	return path.join(GEMINI_DIR, "google_accounts.json");
}

/** Read the active email from google_accounts.json (may be stale). */
export function getCurrentAccount(): string | null {
	try {
		const raw = fs.readFileSync(googleAccountsPath(), "utf-8");
		const parsed = JSON.parse(raw) as { active?: string };
		return parsed.active ?? null;
	} catch {
		return null;
	}
}

/**
 * Accept the real account email detected from agy's log.
 * If it differs from google_accounts.json, update the file.
 * Returns the best-known account email.
 */
export function syncAccount(logDetected: string | undefined): string | null {
	const fileAccount = getCurrentAccount();

	if (!logDetected) return fileAccount;

	if (logDetected !== fileAccount) {
		try {
			const raw = fs.readFileSync(googleAccountsPath(), "utf-8");
			const parsed = JSON.parse(raw);
			parsed.active = logDetected;
			fs.writeFileSync(googleAccountsPath(), JSON.stringify(parsed, null, 2), "utf-8");
		} catch {
			// Best-effort
		}
	}

	return logDetected;
}
