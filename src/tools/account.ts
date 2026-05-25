import { backupProfile, getCurrentAccount, listProfiles, switchProfile } from "../accounts";
import type { AgyToolDetails, ProfileInfo } from "../types";

export async function executeAccount(
	params: any,
	_signal: AbortSignal | undefined,
	_onUpdate: any,
	_ctx: any,
): Promise<{ content: Array<{ type: string; text: string }>; details: AgyToolDetails; isError: boolean }> {
	const startTime = Date.now();
	const action = params.action as string;
	const profile = params.profile as string | undefined;
	const currentAccount = getCurrentAccount();

	const ok = (text: string) => ({
		content: [{ type: "text" as const, text }],
		details: {
			durationMs: Date.now() - startTime,
			account: currentAccount,
			exitCode: 0,
			model: "gemini-3.5-flash-high",
		} as AgyToolDetails,
		isError: false as const,
	});

	const err = (text: string) => ({
		content: [{ type: "text" as const, text }],
		details: {
			durationMs: Date.now() - startTime,
			account: currentAccount,
			exitCode: 1,
			model: "gemini-3.5-flash-high",
		} as AgyToolDetails,
		isError: true as const,
	});

	switch (action) {
		case "current": {
			if (currentAccount) {
				return ok(`Active account: ${currentAccount}`);
			}
			return ok("No active Google account found in ~/.gemini/google_accounts.json.");
		}

		case "list": {
			const profiles: ProfileInfo[] = await listProfiles();
			if (profiles.length === 0) {
				return ok(
					"No backed-up profiles found. Use action:backup with a profile name to create one.\n" +
						"Example: agy_account action:backup profile:work",
				);
			}
			const lines = ["Configured accounts:", ""];
			for (const p of profiles) {
				const date = p.backedUpAt !== "(unknown)" ? new Date(p.backedUpAt).toLocaleDateString() : "(unknown)";
				lines.push(`  ${p.name.padEnd(12)} ${p.email}  (backed up ${date})`);
			}
			return ok(lines.join("\n"));
		}

		case "backup": {
			if (!profile) {
				return err("The 'backup' action requires a profile name.\nExample: agy_account action:backup profile:work");
			}
			const result = await backupProfile(profile);
			if (result.ok) {
				const keyringNote = result.keyring
					? "Keyring credentials saved."
					: "Keyring not available — file-based credentials only.";
				return ok(
					`Backed up current account '${result.email}' as profile '${profile}'.\n` +
						`${keyringNote}\n` +
						"Files stored at ~/.pi/agy-accounts/\n" +
						"Note: if an interactive agy session is running, it keeps its loaded credentials.\n" +
						"New agy -p calls pick up the swapped credentials automatically.",
				);
			}
			return err(result.error);
		}

		case "switch": {
			if (!profile) {
				return err("The 'switch' action requires a profile name.\nExample: agy_account action:switch profile:work");
			}
			const result = await switchProfile(profile);
			if (result.ok) {
				const keyringNote = result.keyring
					? "Keyring credentials swapped."
					: "Keyring not swapped (no saved keyring for this profile — re-auth in agy TUI if needed).";
				return ok(
					`Switched to account '${result.email}' (profile: ${profile}).\n` +
						`${keyringNote}\n` +
						"Previous state auto-snapshot to ~/.pi/agy-accounts/.last-active/\n" +
						"Note: if an interactive agy session is running, it keeps its loaded credentials.\n" +
						"New agy -p calls pick up the swapped credentials automatically.",
				);
			}
			return err(result.error);
		}

		default:
			return err(`Unknown action: '${action}'. Valid actions: list, current, backup, switch.`);
	}
}
