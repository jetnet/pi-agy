/**
 * Shared rotation-ON execution logic for the `agy` and `agy_image` tools.
 *
 * Both tools share an identical rotation state machine: pin validation,
 * auto-rotation loop, model swap, state transitions, error responses, and
 * the soft-cap advisory warning. The only tool-specific parts are:
 *   - `addDirs` passed to spawnAgy (agy: contextDirs, image: [tmpDir])
 *   - `toolName` for usage logging ("agy" vs "agy_image")
 *   - `buildSuccessContent` callback for post-success response text
 *     (agy detects generated images; image does not)
 *
 * The rotation-OFF path lives exclusively in each tool file and is UNCHANGED.
 */

import { spawnAgy } from "./execute.ts";
import { getCachedModel, resetModelCache, setModelCache } from "./model.ts";
import { readCurrentModel, setModel } from "./model-settings.ts";
import {
	checkPinUsable,
	jitterSleep,
	loadState,
	markExhausted,
	markFlagged,
	markSuccess,
	pickNextAccount,
	saveState,
	withRotationLock,
} from "./rotation.ts";
import { afterAgyCall } from "./session.ts";
import type { AgyToolDetails, RotationConfig, RotationState, SpawnAgyResult } from "./types.ts";
import { logCall } from "./usage.ts";

// Exported so tool files can drop their local alias.
export type ExecResult = { content: Array<{ type: string; text: string }>; details: AgyToolDetails; isError: boolean };

/**
 * Tool-specific content returned by the `buildSuccessContent` callback.
 * The wrapper composes the final response text (appending soft-cap warning
 * and image list) and assembles the ExecResult.
 */
export interface SuccessContent {
	/**
	 * The base response text for a successful or non-quota-error result.
	 * Do NOT include the soft-cap warning or image list here — the wrapper
	 * appends them in the correct order.
	 */
	responseText: string;
	/** Optional generated-image paths to append and include in details. */
	generatedImages?: string[];
}

export interface RotationExecOpts {
	/** The loaded rotation config (non-null — only called when rotation is ON). */
	rotConfig: RotationConfig;
	/** Usage-log tool name: "agy" or "agy_image". */
	toolName: string;
	/** Pinned account name from params.account, or undefined → auto-rotation. */
	pinName: string | undefined;
	workDir: string;
	timeoutSec: number;
	/**
	 * Tool-specific dirs for spawnAgy --add-dir.
	 * agy passes its contextDirs (may be empty); image passes [tmpDir] (always set).
	 * Empty array → no --add-dir flags (same as `undefined` in spawnAgy).
	 */
	addDirs: string[];
	requestedModel: string | undefined;
	finalPrompt: string;
	signal: AbortSignal | undefined;
	onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void;
	piSessionId: string;
	/**
	 * Build the base success-response content for a completed (ok or error) result.
	 * Called for both auto-rotation and pin-mode success.
	 *
	 * @param result  The SpawnAgyResult from the call.
	 * @param convId  The resolved conversation ID (undefined in rotation-ON).
	 * @returns SuccessContent with the base text and optional generated images.
	 */
	buildSuccessContent: (result: SpawnAgyResult, convId: string | undefined) => SuccessContent;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildAllExhaustedResponse(rotState: RotationState, rotConfig: RotationConfig): ExecResult {
	const now = Date.now();
	let soonest = Number.MAX_SAFE_INTEGER;
	for (const acctState of Object.values(rotState.accounts)) {
		if (acctState.status === "EXHAUSTED") soonest = Math.min(soonest, acctState.cooldownUntil);
	}
	const retrySec = soonest < Number.MAX_SAFE_INTEGER ? Math.ceil((soonest - now) / 1000) : rotConfig.defaultCooldownSec;
	return {
		content: [
			{
				type: "text",
				text: `⚠ All rotation accounts are quota-exhausted. Retry in ~${retrySec}s. No calls were made.`,
			},
		],
		details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
		isError: true,
	};
}

/** Build the final content text from base text + soft-cap warning + optional image list. */
function assembleSuccessText(
	responseText: string,
	softCapWarning: string,
	generatedImages: string[] | undefined,
): string {
	const parts = [responseText + softCapWarning];
	if (generatedImages && generatedImages.length > 0) {
		parts.push("", "Generated images:");
		for (const img of generatedImages) {
			parts.push(img);
		}
	}
	return parts.join("\n");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Execute the rotation-ON path for a tool call.
 *
 * Handles `withRotationLock`, pin validation, auto-rotation loop, model swap,
 * rotation state transitions, usage logging, afterAgyCall, soft-cap warning,
 * and all error response objects.
 *
 * The rotation-OFF path is NOT handled here — it remains in each tool file
 * unchanged.
 *
 * NOTE: For `agy_image`, wrap this call in `try/finally` to clean up the
 * staged image tmp dir regardless of which code path exits.
 */
export async function executeWithRotation(opts: RotationExecOpts): Promise<ExecResult> {
	const {
		rotConfig,
		toolName,
		pinName,
		workDir,
		timeoutSec,
		addDirs,
		requestedModel,
		finalPrompt,
		signal,
		onUpdate,
		piSessionId,
		buildSuccessContent,
	} = opts;

	return withRotationLock(async () => {
		// ── PIN MODE ─────────────────────────────────────────────────────────
		// Use only the named account; bypass auto-rotation entirely.
		if (pinName !== undefined) {
			const pinEntry = rotConfig.accounts.find((a) => a.name === pinName);
			if (!pinEntry) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown rotation account '${pinName}'. Check ~/.pi/agy-rotation.config.json.`,
						},
					],
					details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
					isError: true,
				};
			}

			const rotState = loadState(rotConfig);
			// checkPinUsable checks global pause FIRST (a 403/ToS protective pause must block pinned calls too)
			const pinErr = checkPinUsable(rotState, pinName);
			if (pinErr) {
				return {
					content: [{ type: "text", text: pinErr }],
					details: { durationMs: 0, account: pinName, exitCode: 1, model: getCachedModel() },
					isError: true,
				};
			}

			// Populate model cache from the account's settings.json (no spawn — probe is rotation-OFF only).
			setModelCache(readCurrentModel(pinEntry.home));

			// setModel can throw if account home is unwritable (never throws out of the tool)
			let restoreModel = () => {};
			if (requestedModel) {
				try {
					restoreModel = setModel(requestedModel, pinEntry.home);
					resetModelCache();
				} catch (err) {
					saveState(rotState);
					return {
						content: [
							{
								type: "text",
								text: `⚠ Failed to set model on account '${pinEntry.name}': ${(err as Error).message}`,
							},
						],
						details: { durationMs: 0, account: pinEntry.name, exitCode: 1, model: getCachedModel() },
						isError: true,
					};
				}
			}

			let pinResult: SpawnAgyResult;
			try {
				pinResult = await spawnAgy(finalPrompt, {
					cwd: workDir,
					timeoutSec,
					addDirs: addDirs.length > 0 ? addDirs : undefined,
					// Cross-account leak prevention: do NOT pass conversationId in rotation-ON path
					conversationId: undefined,
					signal,
					homeDir: pinEntry.home,
					dbusAddress: rotConfig.dbusAddress,
					onProgress: onUpdate
						? (status: string) =>
								onUpdate({ content: [{ type: "text" as const, text: `[${pinEntry.name}] ${status}` }] })
						: undefined,
				});
			} finally {
				restoreModel();
				if (requestedModel) resetModelCache();
			}

			if (pinResult.errorClass === "ok") markSuccess(rotState, pinEntry.name);
			else if (pinResult.errorClass === "quota")
				markExhausted(rotState, pinEntry.name, pinResult.cooldownSec ?? rotConfig.defaultCooldownSec);
			else if (pinResult.errorClass === "banned") markFlagged(rotState, pinEntry.name, rotConfig.protectivePauseHours);
			saveState(rotState);

			// P1-2: prefer authenticated email from log; fall back to config name
			const pinAccountId = pinResult.account ?? pinEntry.name;
			await logCall({
				ts: new Date().toISOString(),
				tool: toolName,
				account: pinAccountId,
				latencyMs: pinResult.durationMs,
				promptChars: finalPrompt.length,
				responseChars: pinResult.text.length,
				exitCode: pinResult.exitCode,
			});

			// Cross-account leak prevention: pass undefined for usedConversationId
			const pinConvId = afterAgyCall(piSessionId, undefined, workDir);

			if (pinResult.quotaError) {
				const msg = requestedModel
					? `⚠ Quota exhausted for ${requestedModel} on account '${pinEntry.name}': ${pinResult.quotaError}`
					: `⚠ Quota exhausted on account '${pinEntry.name}': ${pinResult.quotaError}`;
				return {
					content: [{ type: "text", text: msg }],
					details: {
						durationMs: pinResult.durationMs,
						account: pinAccountId,
						exitCode: pinResult.exitCode,
						model: requestedModel ?? getCachedModel(),
						conversationId: pinConvId,
					},
					isError: true,
				};
			}

			if (pinResult.errorClass === "banned") {
				const until = new Date(rotState.globalPauseUntil).toLocaleString();
				return {
					content: [
						{
							type: "text",
							text: `⛔ Account '${pinEntry.name}' received a ToS/403 signal. Flagged permanently. Global pool paused until ${until}. Contact Google if this is unexpected.`,
						},
					],
					details: {
						durationMs: pinResult.durationMs,
						account: pinAccountId,
						exitCode: pinResult.exitCode,
						model: getCachedModel(),
						conversationId: pinConvId,
					},
					isError: true,
				};
			}

			// Pin success (or non-quota error): build tool-specific content
			// Soft-cap advisory (same logic as auto-rotation path — must apply to pin mode too).
			const pinAcctStateAfter = rotState.accounts[pinEntry.name];
			const pinSoftCapWarning =
				pinAcctStateAfter && pinAcctStateAfter.requestsToday >= rotConfig.dailySoftCap
					? `\n\n⚠ Account '${pinEntry.name}' has made ${pinAcctStateAfter.requestsToday} calls today (soft cap: ${rotConfig.dailySoftCap}). WAF risk increases near this threshold.`
					: "";
			const { responseText: pinResponseText, generatedImages: pinImages } = buildSuccessContent(pinResult, pinConvId);
			return {
				content: [{ type: "text", text: assembleSuccessText(pinResponseText, pinSoftCapWarning, pinImages) }],
				details: {
					durationMs: pinResult.durationMs,
					account: pinAccountId,
					exitCode: pinResult.exitCode,
					model: getCachedModel(),
					conversationId: pinConvId,
					generatedImages: pinImages,
				},
				isError: pinResult.isError,
			};
		}

		// ── AUTO-ROTATION LOOP ────────────────────────────────────────────────
		// Retry budget = pool size. Same account is never re-tried (no-hammer guarantee).
		const rotState = loadState(rotConfig);
		const excluded = new Set<string>();
		let lastResult: SpawnAgyResult | null = null;
		let lastAccountName: string | null = null;
		let allExhausted = false;

		for (let attempt = 0; attempt < rotConfig.accounts.length; attempt++) {
			const pick = pickNextAccount(rotState, rotConfig, excluded);

			if (pick.kind === "paused") {
				saveState(rotState);
				const until = new Date(pick.until).toLocaleString();
				return {
					content: [
						{
							type: "text",
							text: `⛔ All accounts paused until ${until} (protective pause after ToS/403 detection). Do not retry until then.`,
						},
					],
					details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
					isError: true,
				};
			}

			if (pick.kind === "exhausted") {
				allExhausted = true;
				break;
			}

			const acct = pick.account;
			excluded.add(acct.name); // no-hammer: never re-try this account this call

			// Populate model cache from the account's settings.json
			// (static file read, no agy spawn — probe is rotation-OFF only).
			setModelCache(readCurrentModel(acct.home));

			if (attempt > 0) {
				await jitterSleep(rotConfig); // human-like pause between account switches
			}

			// Model override: target the account's settings.json (fix #7).
			// Wrapped in try/catch: setModel writes to disk and can fail if the
			// account home is unwritable (never throws out of the tool).
			let restoreModel = () => {};
			if (requestedModel) {
				try {
					restoreModel = setModel(requestedModel, acct.home);
					resetModelCache();
				} catch (err) {
					saveState(rotState);
					return {
						content: [
							{
								type: "text",
								text: `⚠ Failed to set model on account '${acct.name}': ${(err as Error).message}`,
							},
						],
						details: { durationMs: 0, account: acct.name, exitCode: 1, model: getCachedModel() },
						isError: true,
					};
				}
			}

			let result: SpawnAgyResult;
			try {
				result = await spawnAgy(finalPrompt, {
					cwd: workDir,
					timeoutSec,
					addDirs: addDirs.length > 0 ? addDirs : undefined,
					// Cross-account leak prevention: do NOT pass conversationId in rotation-ON
					// path. Each rotated attempt starts fresh to avoid cross-account UUID leakage.
					// Full per-account conversation mapping is a fast-follow item.
					conversationId: undefined,
					signal,
					homeDir: acct.home,
					dbusAddress: rotConfig.dbusAddress,
					onProgress: onUpdate
						? (status: string) => onUpdate({ content: [{ type: "text" as const, text: `[${acct.name}] ${status}` }] })
						: undefined,
				});
			} finally {
				restoreModel();
				if (requestedModel) resetModelCache();
			}

			lastResult = result;
			lastAccountName = acct.name;

			if (result.errorClass === "ok") {
				markSuccess(rotState, acct.name);
				saveState(rotState);
				break;
			}

			if (result.errorClass === "quota") {
				const cooldownSec = result.cooldownSec ?? rotConfig.defaultCooldownSec;
				markExhausted(rotState, acct.name, cooldownSec);
				saveState(rotState);

				// Peek ahead: if no account remains, return all-exhausted immediately
				// instead of falling through to post-process the last quota result's
				// fallback text (would violate "return cooldown payload" rule).
				const peekNext = pickNextAccount(rotState, rotConfig, excluded);
				if (peekNext.kind === "paused") {
					const until = new Date(peekNext.until).toLocaleString();
					return {
						content: [
							{
								type: "text",
								text: `⛔ All accounts paused until ${until} (protective pause after ToS/403 detection). Do not retry until then.`,
							},
						],
						details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
						isError: true,
					};
				}
				if (peekNext.kind === "exhausted") {
					return buildAllExhaustedResponse(rotState, rotConfig);
				}
				continue; // peekNext.kind === "ok" — a next account is available
			}

			if (result.errorClass === "banned") {
				markFlagged(rotState, acct.name, rotConfig.protectivePauseHours);
				saveState(rotState);
				const until = new Date(rotState.globalPauseUntil).toLocaleString();
				return {
					content: [
						{
							type: "text",
							text: `⛔ Account '${acct.name}' received a ToS/403 signal. Flagged permanently. Global pool paused until ${until}. Contact Google if this is unexpected.`,
						},
					],
					details: {
						durationMs: result.durationMs,
						account: acct.name,
						exitCode: result.exitCode,
						model: getCachedModel(),
					},
					isError: true,
				};
			}

			// 'error' — non-quota spawn/process failure: don't burn the pool
			saveState(rotState);
			break;
		}

		if (allExhausted || lastResult === null) {
			saveState(rotState);
			return buildAllExhaustedResponse(rotState, rotConfig);
		}

		// ── Post-process: successful or non-quota-error ───────────────────────
		const result = lastResult;
		const accountName = lastAccountName as string; // always set when lastResult is set

		// P1-2: prefer authenticated email from log; fall back to config name.
		// Rotation-OFF logs the email (via syncAccount). Rotation-ON was logging
		// only the config name — now both paths prefer the actual email so
		// agy_usage account filtering is consistent regardless of rotation mode.
		const accountId = result.account ?? accountName;

		await logCall({
			ts: new Date().toISOString(),
			tool: toolName,
			account: accountId,
			latencyMs: result.durationMs,
			promptChars: finalPrompt.length,
			responseChars: result.text.length,
			exitCode: result.exitCode,
		});

		// Cross-account leak prevention: pass undefined for usedConversationId since we didn't use one
		const finalConversationId = afterAgyCall(piSessionId, undefined, workDir);

		// Soft-cap advisory warning (reactive mode: informational only, never blocks).
		// Applied to both agy and agy_image (fixes the gap that existed in image.ts).
		const acctStateAfter = rotState.accounts[accountName];
		const softCapWarning =
			acctStateAfter && acctStateAfter.requestsToday >= rotConfig.dailySoftCap
				? `\n\n⚠ Account '${accountName}' has made ${acctStateAfter.requestsToday} calls today (soft cap: ${rotConfig.dailySoftCap}). WAF risk increases near this threshold.`
				: "";

		const { responseText, generatedImages } = buildSuccessContent(result, finalConversationId);

		return {
			content: [{ type: "text", text: assembleSuccessText(responseText, softCapWarning, generatedImages) }],
			details: {
				durationMs: result.durationMs,
				account: accountId,
				exitCode: result.exitCode,
				model: getCachedModel(),
				conversationId: finalConversationId,
				generatedImages,
			},
			isError: result.isError,
		};
	});
}
