import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProfileInfo } from "./types";

// ── Storage paths ──────────────────────────────────────────────────────────────

const ACCOUNTS_DIR = path.join(os.homedir(), ".pi", "agy-accounts");
const GEMINI_DIR = path.join(os.homedir(), ".gemini");

function googleAccountsPath(): string {
	return path.join(GEMINI_DIR, "google_accounts.json");
}

function oauthCredsPath(): string {
	return path.join(GEMINI_DIR, "oauth_creds.json");
}

function profileDir(name: string): string {
	return path.join(ACCOUNTS_DIR, name);
}

function lastActiveDir(): string {
	return path.join(ACCOUNTS_DIR, ".last-active");
}

function metadataPath(name: string): string {
	return path.join(profileDir(name), "metadata.json");
}

// ── Profile name validation ───────────────────────────────────────────────────
//
// Profile names become directory names under ACCOUNTS_DIR. Without a strict
// guard, `path.join(ACCOUNTS_DIR, name)` can be coerced past the sandbox via
// `..` or absolute paths, leaking OAuth refresh tokens.
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function isValidProfileName(name: string): boolean {
	return typeof name === "string" && PROFILE_NAME_RE.test(name);
}

// ── Ensure profile dir exists with secure perms ────────────────────────────────

async function ensureDir(dir: string, mode: number = 0o700): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode });
}

// ── Read email from google_accounts.json ───────────────────────────────────────

export function getCurrentAccount(): string | null {
	try {
		const raw = fs.readFileSync(googleAccountsPath(), "utf-8");
		const parsed = JSON.parse(raw) as { active?: string };
		return parsed.active ?? null;
	} catch {
		return null;
	}
}

// ── Sync account from agy log ──────────────────────────────────────────────────

/**
 * Accept the real account email detected from agy's log.
 * If it differs from google_accounts.json, update the file.
 * Returns the best-known account email.
 */
export function syncAccount(logDetected: string | undefined): string | null {
	const fileAccount = getCurrentAccount();

	if (!logDetected) return fileAccount;

	// Update google_accounts.json if stale
	if (logDetected !== fileAccount) {
		try {
			const raw = fs.readFileSync(googleAccountsPath(), "utf-8");
			const parsed = JSON.parse(raw);
			parsed.active = logDetected;
			fs.writeFileSync(googleAccountsPath(), JSON.stringify(parsed, null, 2), "utf-8");
		} catch {
			// Best-effort — don't fail the call over this
		}
	}

	return logDetected;
}

// ── List profiles ──────────────────────────────────────────────────────────────

export async function listProfiles(): Promise<ProfileInfo[]> {
	try {
		const entries = await fs.promises.readdir(ACCOUNTS_DIR, { withFileTypes: true });
		const results: ProfileInfo[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const metaPath = metadataPath(entry.name);
			try {
				const raw = await fs.promises.readFile(metaPath, "utf-8");
				const meta = JSON.parse(raw) as ProfileInfo;
				results.push(meta);
			} catch {
				results.push({ name: entry.name, email: "(unknown)", backedUpAt: "(unknown)" });
			}
		}
		return results;
	} catch {
		return [];
	}
}

// ── Backup current account as a named profile ──────────────────────────────────

export async function backupProfile(name: string): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
	if (!isValidProfileName(name)) {
		return { ok: false, error: "Invalid profile name. Use only letters, numbers, hyphens, and underscores." };
	}

	try {
		const current = getCurrentAccount();
		if (!current) {
			return { ok: false, error: "No active account found in ~/.gemini/google_accounts.json." };
		}

		const destDir = profileDir(name);
		await ensureDir(destDir);

		// Read+write atomically with 0o600 — no race window, no separate chmod needed
		const googleContent = await fs.promises.readFile(googleAccountsPath());
		const destGoogle = path.join(destDir, "google_accounts.json");
		await fs.promises.writeFile(destGoogle, googleContent, { mode: 0o600 });

		// Read+write oauth_creds atomically if it exists, with ENOENT-only suppression
		const destOauth = path.join(destDir, "oauth_creds.json");
		try {
			const oauthContent = await fs.promises.readFile(oauthCredsPath());
			await fs.promises.writeFile(destOauth, oauthContent, { mode: 0o600 });
		} catch (err) {
			// oauth_creds.json doesn't exist for API-key-auth — best-effort skip
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}

		// Write metadata
		const meta: ProfileInfo = {
			name,
			email: current,
			backedUpAt: new Date().toISOString(),
		};
		await fs.promises.writeFile(metadataPath(name), JSON.stringify(meta, null, 2), "utf-8");

		return { ok: true, email: current };
	} catch (err) {
		return { ok: false, error: `Backup failed: ${(err as Error).message}` };
	}
}

// ── Switch to a named profile ──────────────────────────────────────────────────

export async function switchProfile(name: string): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
	if (!isValidProfileName(name)) {
		return { ok: false, error: "Invalid profile name. Use only letters, numbers, hyphens, and underscores." };
	}

	const srcDir = profileDir(name);
	try {
		await fs.promises.access(srcDir);
	} catch {
		return { ok: false, error: `Profile '${name}' not found. Use agy_account action:backup first.` };
	}

	try {
		// Auto-snapshot current state to .last-active/
		await ensureDir(lastActiveDir());
		try {
			await fs.promises.copyFile(googleAccountsPath(), path.join(lastActiveDir(), "google_accounts.json"));
			await fs.promises.copyFile(oauthCredsPath(), path.join(lastActiveDir(), "oauth_creds.json"));
		} catch {
			// Snapshot best-effort — may not exist
		}

		// Validate profile's google_accounts.json
		const profileAccountsPath = path.join(srcDir, "google_accounts.json");
		const raw = await fs.promises.readFile(profileAccountsPath, "utf-8");
		const parsed = JSON.parse(raw) as { active?: string };
		if (!parsed.active) {
			return { ok: false, error: "Profile's google_accounts.json is missing or invalid." };
		}

		// Write validated content to ~/.gemini/ — single atomic write closes the
		// TOCTOU window between validation and the copy that would re-read disk.
		await fs.promises.writeFile(googleAccountsPath(), raw, { mode: 0o600, encoding: "utf-8" });

		const profileOauthPath = path.join(srcDir, "oauth_creds.json");
		try {
			const oauthContent = await fs.promises.readFile(profileOauthPath);
			await fs.promises.writeFile(oauthCredsPath(), oauthContent, { mode: 0o600 });
		} catch (err) {
			// No oauth_creds in profile — that's fine
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}

		return { ok: true, email: parsed.active };
	} catch (err) {
		return { ok: false, error: `Switch failed: ${(err as Error).message}` };
	}
}
