import * as fs from "node:fs";
import * as path from "node:path";
import { syncAccount } from "../accounts.ts";
import { spawnAgy } from "../execute.ts";
import { findNewImages, snapshotImages } from "../images.ts";
import { getCachedModel, probeActiveModel, resetModelCache, setModelCache } from "../model.ts";
import { findKnownModel, readCurrentModel, setModel } from "../model-settings.ts";
import {
	checkPinUsable,
	jitterSleep,
	loadRotationConfig,
	loadState,
	markExhausted,
	markFlagged,
	markSuccess,
	pickNextAccount,
	saveState,
	withRotationLock,
} from "../rotation.ts";
import { afterAgyCall, resolveConversationId } from "../session.ts";
import type { AgyToolDetails, RotationConfig, RotationConfigEntry, RotationState, SpawnAgyResult } from "../types.ts";
import { logCall } from "../usage.ts";

type ExecResult = { content: Array<{ type: string; text: string }>; details: AgyToolDetails; isError: boolean };

export async function executeAgy(
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: any,
	ctx: any,
): Promise<ExecResult> {
	const workDir = params.cwd ?? ctx.cwd;
	// NOTE: probeActiveModel is called inside the rotation-OFF branch only.
	// When rotation is ON, we must NOT spawn agy outside withRotationLock.
	// The rotation-ON path reads the model from the account's settings.json instead.
	const timeoutSec = params.timeoutSec ?? 120;

	const piSessionId: string = ctx.sessionManager?.getSessionId?.() ?? "unknown";

	// ── Build prompt ──────────────────────────────────────────────────────────
	const parts: string[] = [];
	if (params.contextFiles?.length > 0) {
		for (const filePath of params.contextFiles) {
			const absPath = path.isAbsolute(filePath) ? filePath : path.join(workDir, filePath);
			try {
				const content = await fs.promises.readFile(absPath, "utf-8");
				parts.push(`<file path="${absPath}">\n${content}\n</file>`);
			} catch (err) {
				parts.push(`<file path="${absPath}" error="${(err as Error).message}" />`);
			}
		}
	}
	parts.push(params.prompt);
	const finalPrompt = parts.join("\n\n");

	const addDirs: string[] = [];
	if (params.contextDir) {
		const absDir = path.isAbsolute(params.contextDir) ? params.contextDir : path.join(workDir, params.contextDir);
		addDirs.push(absDir);
	}

	// Resolve conversationId for session tracking (used by afterAgyCall regardless of path)
	const conversationId = resolveConversationId(params.conversationId, piSessionId);

	// Validate model name once (fail fast before any spawn)
	let requestedModel: string | undefined;
	if (params.model) {
		const resolved = findKnownModel(params.model);
		if (!resolved) {
			return {
				content: [
					{ type: "text", text: `Unknown model '${params.model}'. Use the exact name from the agy TUI /model list.` },
				],
				details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
				isError: true,
			};
		}
		requestedModel = resolved;
	}

	// Snapshot images before any call attempt (for generated image detection)
	const imagesBefore: Set<string> = snapshotImages(conversationId);

	// ── Load rotation config ──────────────────────────────────────────────────
	const rotConfig = loadRotationConfig();

	// ── ROTATION OFF: exact original behavior, zero changes ───────────────────
	// isError uses pre-rotation logic (quota escalation only, no ban escalation).
	if (!rotConfig) {
		// Probe fires here (rotation-OFF only) — never spawns outside the lock
		// in rotation-ON mode. Safe: no mutex, no rotation state in this path.
		probeActiveModel(workDir);
		let restoreModel = () => {};
		if (requestedModel) {
			restoreModel = setModel(requestedModel); // no home → Pi's HOME
			resetModelCache();
		}

		const result: SpawnAgyResult = await spawnAgy(finalPrompt, {
			cwd: workDir,
			timeoutSec,
			addDirs: addDirs.length > 0 ? addDirs : undefined,
			conversationId,
			signal,
			onProgress: onUpdate
				? (status: string) => onUpdate({ content: [{ type: "text" as const, text: status }] })
				: undefined,
		});

		restoreModel();
		if (requestedModel) resetModelCache();

		const account = syncAccount(result.account);
		await logCall({
			ts: new Date().toISOString(),
			tool: "agy",
			account,
			latencyMs: result.durationMs,
			promptChars: finalPrompt.length,
			responseChars: result.text.length,
			exitCode: result.exitCode,
		});

		const finalConversationId = afterAgyCall(piSessionId, conversationId, workDir);

		if (result.quotaError) {
			const msg = requestedModel
				? `⚠ Quota exhausted for ${requestedModel}: ${result.quotaError}`
				: `⚠ Quota exhausted: ${result.quotaError}`;
			return {
				content: [{ type: "text", text: msg }],
				details: {
					durationMs: result.durationMs,
					account,
					exitCode: result.exitCode,
					model: requestedModel ?? getCachedModel(),
					conversationId: finalConversationId,
				},
				isError: true,
			};
		}

		const isError = result.isError;
		const responseText = isError && !result.text ? result.stderr || "(agy exited with no output)" : result.text;
		const newImages = findNewImages(finalConversationId, imagesBefore);
		const outputParts = [responseText];
		if (newImages.length > 0) {
			outputParts.push("", "Generated images:");
			for (const img of newImages) {
				outputParts.push(img);
			}
		}
		return {
			content: [{ type: "text", text: outputParts.join("\n") }],
			details: {
				durationMs: result.durationMs,
				account,
				exitCode: result.exitCode,
				model: getCachedModel(),
				conversationId: finalConversationId,
				generatedImages: newImages.length > 0 ? newImages : undefined,
			},
			isError,
		};
	}

	// ── ROTATION ON: serialized via module-level mutex ─────────────────────
	// withRotationLock serializes: loadState → pickNextAccount → setModel →
	// spawnAgy → mark* → saveState so two concurrent calls can't pick the
	// same account or clobber each other's state.
	//
	// Cross-account conversation-leak prevention: rotation-ON calls do NOT pass
	// conversationId to spawnAgy. Each rotated attempt starts a fresh agy
	// conversation rather than risking a cross-account UUID leak. Full
	// per-account conversation mapping is deferred to a fast-follow milestone.
	return withRotationLock(async () => {
		// params.account pin: use only the named account, bypass auto-rotation
		const pinName = typeof params.account === "string" ? params.account : undefined;
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
			return runSingleAgyAccount(pinEntry, rotConfig, rotState, finalPrompt, {
				workDir,
				timeoutSec,
				addDirs,
				signal,
				onUpdate,
				requestedModel,
				piSessionId,
				imagesBefore,
			});
		}

		// ── Auto-rotation loop ──────────────────────────────────────────────
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

				// All-exhausted detection: peek ahead. If no account remains, return
				// all-exhausted immediately instead of falling through to post-process
				// the last quota result's fallback text (which would violate the
				// "return cooldown payload, never leak wrong-model text" rule).
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

		// ── Post-process the final result (successful or non-quota-error) ─────
		const result = lastResult;
		const accountName = lastAccountName as string; // always set when lastResult is set
		await logCall({
			ts: new Date().toISOString(),
			tool: "agy",
			account: accountName,
			latencyMs: result.durationMs,
			promptChars: finalPrompt.length,
			responseChars: result.text.length,
			exitCode: result.exitCode,
		});

		// Cross-account leak prevention: pass undefined for usedConversationId since we didn't use one
		const finalConversationId = afterAgyCall(piSessionId, undefined, workDir);

		// Soft-cap advisory warning (reactive mode: informational only, never blocks)
		const acctStateAfter = rotState.accounts[accountName];
		const softCapWarning =
			acctStateAfter && acctStateAfter.requestsToday >= rotConfig.dailySoftCap
				? `\n\n⚠ Account '${accountName}' has made ${acctStateAfter.requestsToday} calls today (soft cap: ${rotConfig.dailySoftCap}). WAF risk increases near this threshold.`
				: "";

		const isError = result.isError;
		const responseText = isError && !result.text ? result.stderr || "(agy exited with no output)" : result.text;
		const newImages = findNewImages(finalConversationId, imagesBefore);
		const outputParts = [responseText + softCapWarning];
		if (newImages.length > 0) {
			outputParts.push("", "Generated images:");
			for (const img of newImages) {
				outputParts.push(img);
			}
		}
		return {
			content: [{ type: "text", text: outputParts.join("\n") }],
			details: {
				durationMs: result.durationMs,
				account: accountName,
				exitCode: result.exitCode,
				model: getCachedModel(),
				conversationId: finalConversationId,
				generatedImages: newImages.length > 0 ? newImages : undefined,
			},
			isError,
		};
	});
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Build the "all accounts quota-exhausted" response with the soonest retry time.
 * Used both from the all-exhausted peek path and the post-loop allExhausted check.
 */
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

interface AgyCallOpts {
	workDir: string;
	timeoutSec: number;
	addDirs: string[];
	signal: AbortSignal | undefined;
	onUpdate: any;
	requestedModel: string | undefined;
	piSessionId: string;
	imagesBefore: Set<string>;
}

/**
 * Execute a single agy call against a specific account (pin mode).
 * Transitions rotation state and returns the tool response.
 * Never throws out of the tool.
 */
async function runSingleAgyAccount(
	acct: RotationConfigEntry,
	rotConfig: RotationConfig,
	rotState: RotationState,
	finalPrompt: string,
	opts: AgyCallOpts,
): Promise<ExecResult> {
	const { workDir, timeoutSec, addDirs, signal, onUpdate, requestedModel, piSessionId, imagesBefore } = opts;

	// Set model cache from the account's settings.json (no spawn — probe is rotation-OFF only).
	setModelCache(readCurrentModel(acct.home));

	// setModel can throw if account home is unwritable (never throws out of the tool)
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
			// Cross-account leak prevention: do NOT pass conversationId in rotation-ON path
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

	// Transition state for the pinned account
	if (result.errorClass === "ok") markSuccess(rotState, acct.name);
	else if (result.errorClass === "quota")
		markExhausted(rotState, acct.name, result.cooldownSec ?? rotConfig.defaultCooldownSec);
	else if (result.errorClass === "banned") markFlagged(rotState, acct.name, rotConfig.protectivePauseHours);
	saveState(rotState);

	await logCall({
		ts: new Date().toISOString(),
		tool: "agy",
		account: acct.name,
		latencyMs: result.durationMs,
		promptChars: finalPrompt.length,
		responseChars: result.text.length,
		exitCode: result.exitCode,
	});

	// Cross-account leak prevention: pass undefined for usedConversationId
	const finalConversationId = afterAgyCall(piSessionId, undefined, workDir);

	if (result.quotaError) {
		const msg = requestedModel
			? `⚠ Quota exhausted for ${requestedModel} on account '${acct.name}': ${result.quotaError}`
			: `⚠ Quota exhausted on account '${acct.name}': ${result.quotaError}`;
		return {
			content: [{ type: "text", text: msg }],
			details: {
				durationMs: result.durationMs,
				account: acct.name,
				exitCode: result.exitCode,
				model: requestedModel ?? getCachedModel(),
				conversationId: finalConversationId,
			},
			isError: true,
		};
	}

	if (result.errorClass === "banned") {
		const until = new Date(rotState.globalPauseUntil).toLocaleString();
		return {
			content: [
				{
					type: "text",
					text: `⛔ Account '${acct.name}' received a ToS/403 signal. Flagged permanently. Global pool paused until ${until}.`,
				},
			],
			details: {
				durationMs: result.durationMs,
				account: acct.name,
				exitCode: result.exitCode,
				model: getCachedModel(),
				conversationId: finalConversationId,
			},
			isError: true,
		};
	}

	const isError = result.isError;
	const responseText = isError && !result.text ? result.stderr || "(agy exited with no output)" : result.text;
	const newImages = findNewImages(finalConversationId, imagesBefore);
	const outputParts = [responseText];
	if (newImages.length > 0) {
		outputParts.push("", "Generated images:");
		for (const img of newImages) {
			outputParts.push(img);
		}
	}
	return {
		content: [{ type: "text", text: outputParts.join("\n") }],
		details: {
			durationMs: result.durationMs,
			account: acct.name,
			exitCode: result.exitCode,
			model: getCachedModel(),
			conversationId: finalConversationId,
			generatedImages: newImages.length > 0 ? newImages : undefined,
		},
		isError,
	};
}
