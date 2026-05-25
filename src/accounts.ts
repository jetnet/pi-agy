import { execSync } from "node:child_process";
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

function keyringSecretPath(name: string): string {
	return path.join(profileDir(name), "keyring.secret");
}

// ── Profile name validation ───────────────────────────────────────────────────

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function isValidProfileName(name: string): boolean {
	return typeof name === "string" && PROFILE_NAME_RE.test(name);
}

// ── Ensure profile dir exists with secure perms ────────────────────────────────

async function ensureDir(dir: string, mode: number = 0o700): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode });
}

// ── OS keyring helpers (best-effort, via secret-tool) ───────────────────────────
//
// agy authenticates via the OS keyring (GNOME Keyring / libsecret) on Linux.
// The keyring entry takes priority over google_accounts.json / oauth_creds.json.
// To truly switch accounts, we must swap the keyring entry too.
//
// If secret-tool is not available (headless server, macOS, etc.), we skip
// keyring operations — agy will fall back to file-based auth.

const KEYRING_SERVICE = "gemini";
const KEYRING_USERNAME = "antigravity";
const KEYRING_LABEL = "Password for 'antigravity' on 'gemini'";

let hasSecretTool: boolean | null = null;

function secretToolAvailable(): boolean {
	if (hasSecretTool !== null) return hasSecretTool;
	try {
		execSync("which secret-tool", { stdio: "ignore" });
		hasSecretTool = true;
	} catch {
		hasSecretTool = false;
	}
	return hasSecretTool;
}

/** Read the current keyring secret. Returns undefined if unavailable. */
function readKeyringSecret(): string | undefined {
	if (!secretToolAvailable()) return undefined;
	try {
		const secret = execSync(`secret-tool lookup service ${KEYRING_SERVICE} username ${KEYRING_USERNAME}`, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		return secret || undefined;
	} catch {
		return undefined;
	}
}

/** Write a secret to the keyring. */
function writeKeyringSecret(secret: string): boolean {
	if (!secretToolAvailable()) return false;
	try {
		execSync(`secret-tool store --label='${KEYRING_LABEL}' service ${KEYRING_SERVICE} username ${KEYRING_USERNAME}`, {
			input: secret,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}

/** Clear the keyring entry. */
function clearKeyringSecret(): boolean {
	if (!secretToolAvailable()) return false;
	try {
		execSync(`secret-tool clear service ${KEYRING_SERVICE} username ${KEYRING_USERNAME}`, {
			stdio: "ignore",
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
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

export async function backupProfile(
	name: string,
): Promise<{ ok: true; email: string; keyring: boolean } | { ok: false; error: string }> {
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

		// Files
		const googleContent = await fs.promises.readFile(googleAccountsPath());
		await fs.promises.writeFile(path.join(destDir, "google_accounts.json"), googleContent, { mode: 0o600 });

		try {
			const oauthContent = await fs.promises.readFile(oauthCredsPath());
			await fs.promises.writeFile(path.join(destDir, "oauth_creds.json"), oauthContent, { mode: 0o600 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}

		// Keyring (best-effort)
		let keyringSaved = false;
		const secret = readKeyringSecret();
		if (secret) {
			await fs.promises.writeFile(keyringSecretPath(name), secret, { mode: 0o600 });
			keyringSaved = true;
		}

		// Metadata
		const meta: ProfileInfo = {
			name,
			email: current,
			backedUpAt: new Date().toISOString(),
		};
		await fs.promises.writeFile(metadataPath(name), JSON.stringify(meta, null, 2), "utf-8");

		return { ok: true, email: current, keyring: keyringSaved };
	} catch (err) {
		return { ok: false, error: `Backup failed: ${(err as Error).message}` };
	}
}

// ── Switch to a named profile ──────────────────────────────────────────────────

export async function switchProfile(
	name: string,
): Promise<{ ok: true; email: string; keyring: boolean } | { ok: false; error: string }> {
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
			// Snapshot best-effort
		}
		// Snapshot current keyring too
		const currentSecret = readKeyringSecret();
		if (currentSecret) {
			try {
				await fs.promises.writeFile(path.join(lastActiveDir(), "keyring.secret"), currentSecret, { mode: 0o600 });
			} catch {
				/* best-effort */
			}
		}

		// Validate profile
		const profileAccountsPath = path.join(srcDir, "google_accounts.json");
		const raw = await fs.promises.readFile(profileAccountsPath, "utf-8");
		const parsed = JSON.parse(raw) as { active?: string };
		if (!parsed.active) {
			return { ok: false, error: "Profile's google_accounts.json is missing or invalid." };
		}

		// Swap files
		await fs.promises.writeFile(googleAccountsPath(), raw, { mode: 0o600, encoding: "utf-8" });

		const profileOauthPath = path.join(srcDir, "oauth_creds.json");
		try {
			const oauthContent = await fs.promises.readFile(profileOauthPath);
			await fs.promises.writeFile(oauthCredsPath(), oauthContent, { mode: 0o600 });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}

		// Swap keyring (best-effort)
		let keyringSwapped = false;
		const profileKeyringPath = keyringSecretPath(name);
		try {
			const profileSecret = await fs.promises.readFile(profileKeyringPath, "utf-8");
			if (profileSecret) {
				// Clear old entry first, then write new one
				clearKeyringSecret();
				keyringSwapped = writeKeyringSecret(profileSecret);
			}
		} catch {
			// No keyring backup for this profile — skip
		}

		return { ok: true, email: parsed.active, keyring: keyringSwapped };
	} catch (err) {
		return { ok: false, error: `Switch failed: ${(err as Error).message}` };
	}
}
