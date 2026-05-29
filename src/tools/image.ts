import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncAccount } from "../accounts.ts";
import { spawnAgy } from "../execute.ts";
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
import type { AgyToolDetails, RotationConfig, RotationState, SpawnAgyResult } from "../types.ts";
import { logCall } from "../usage.ts";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

type ExecResult = { content: Array<{ type: string; text: string }>; details: AgyToolDetails; isError: boolean };

export async function executeImage(
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: any,
	ctx: any,
): Promise<ExecResult> {
	const workDir = params.cwd ?? ctx.cwd;
	// NOTE: probeActiveModel is called inside the rotation-OFF branch only.
	// When rotation is ON, model is read from the account's settings.json (no spawn).
	const timeoutSec = params.timeoutSec ?? 120;

	const piSessionId: string = ctx.sessionManager?.getSessionId?.() ?? "unknown";

	const absPath = path.isAbsolute(params.imagePath) ? params.imagePath : path.join(workDir, params.imagePath);

	try {
		await fs.promises.access(absPath, fs.constants.R_OK);
	} catch {
		return {
			content: [{ type: "text", text: `Image not found or not readable: ${absPath}` }],
			details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
			isError: true,
		};
	}

	const ext = path.extname(absPath).toLowerCase();
	if (!SUPPORTED_EXTENSIONS.has(ext)) {
		return {
			content: [
				{ type: "text", text: `Unsupported format '${ext}'. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}` },
			],
			details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
			isError: true,
		};
	}

	// Stage image into an isolated tmp dir (--add-dir only exposes this dir to agy)
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agy-img-"));
	const tmpImage = path.join(tmpDir, path.basename(absPath));
	try {
		await fs.promises.copyFile(absPath, tmpImage);
	} catch (err) {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
		return {
			content: [{ type: "text", text: `Failed to stage image: ${(err as Error).message}` }],
			details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
			isError: true,
		};
	}

	const finalPrompt = `Image file: ${tmpImage}\n\n${params.prompt}`;
	const conversationId = resolveConversationId(params.conversationId, piSessionId);

	// Validate model name once (fail fast before any spawn)
	let requestedModel: string | undefined;
	if (params.model) {
		const resolved = findKnownModel(params.model);
		if (!resolved) {
			await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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

	// ── Load rotation config ──────────────────────────────────────────────────
	const rotConfig = loadRotationConfig();

	// ── ROTATION OFF: exact original behavior, zero changes ───────────────────
	// isError uses pre-rotation logic (quota escalation only, no ban escalation).
	if (!rotConfig) {
		// Probe fires here (rotation-OFF only) — safe to spawn agy outside the lock.
		probeActiveModel(workDir);
		let restoreModel = () => {};
		if (requestedModel) {
			restoreModel = setModel(requestedModel);
			resetModelCache();
		}

		const result: SpawnAgyResult = await spawnAgy(finalPrompt, {
			cwd: workDir,
			timeoutSec,
			addDirs: [tmpDir],
			conversationId,
			signal,
			onProgress: onUpdate
				? (status: string) => onUpdate({ content: [{ type: "text" as const, text: status }] })
				: undefined,
		});

		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		restoreModel();
		if (requestedModel) resetModelCache();

		const account = syncAccount(result.account);
		await logCall({
			ts: new Date().toISOString(),
			tool: "agy_image",
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
		return {
			content: [{ type: "text", text: responseText }],
			details: {
				durationMs: result.durationMs,
				account,
				exitCode: result.exitCode,
				model: getCachedModel(),
				conversationId: finalConversationId,
			},
			isError,
		};
	}

	// ── ROTATION ON ──────────────────────────────────────────────────────────
	// Outer try/finally ensures tmpDir is ALWAYS cleaned regardless of where
	// the rotation-ON section returns or throws (always clean up tmpDir regardless of exit path).
	//
	// withRotationLock serializes: loadState → pickNextAccount → setModel →
	// spawnAgy → mark* → saveState so concurrent calls can't pick the same
	// account or clobber each other's state.
	//
	// Cross-account conversation-leak prevention: rotation-ON calls do NOT pass
	// conversationId to spawnAgy to prevent cross-account UUID leakage. Full
	// per-account conversation mapping is deferred to a fast-follow milestone.
	try {
		return await withRotationLock(async () => {
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

				// Set model cache from pin account's settings.json (no spawn — probe is rotation-OFF only).
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
						addDirs: [tmpDir],
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
				else if (pinResult.errorClass === "banned")
					markFlagged(rotState, pinEntry.name, rotConfig.protectivePauseHours);
				saveState(rotState);

				await logCall({
					ts: new Date().toISOString(),
					tool: "agy_image",
					account: pinEntry.name,
					latencyMs: pinResult.durationMs,
					promptChars: finalPrompt.length,
					responseChars: pinResult.text.length,
					exitCode: pinResult.exitCode,
				});
				// Cross-account leak prevention: pass undefined for usedConversationId
				const pinConvId = afterAgyCall(piSessionId, undefined, workDir);

				if (pinResult.quotaError) {
					return {
						content: [
							{
								type: "text",
								text: `⚠ Quota exhausted on account '${pinEntry.name}': ${pinResult.quotaError}`,
							},
						],
						details: {
							durationMs: pinResult.durationMs,
							account: pinEntry.name,
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
								text: `⛔ Account '${pinEntry.name}' received a ToS/403 signal. Flagged permanently. Pool paused until ${until}.`,
							},
						],
						details: {
							durationMs: pinResult.durationMs,
							account: pinEntry.name,
							exitCode: pinResult.exitCode,
							model: getCachedModel(),
							conversationId: pinConvId,
						},
						isError: true,
					};
				}
				const isPinErr = pinResult.isError;
				return {
					content: [
						{
							type: "text",
							text: isPinErr && !pinResult.text ? pinResult.stderr || "(agy exited with no output)" : pinResult.text,
						},
					],
					details: {
						durationMs: pinResult.durationMs,
						account: pinEntry.name,
						exitCode: pinResult.exitCode,
						model: getCachedModel(),
						conversationId: pinConvId,
					},
					isError: isPinErr,
				};
			}

			// ── Auto-rotation loop ────────────────────────────────────────────
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
								text: `⛔ All accounts paused until ${until} (protective pause after ToS/403 detection).`,
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
				excluded.add(acct.name);

				// Set model cache from account settings.json (no spawn — probe is rotation-OFF only).
				setModelCache(readCurrentModel(acct.home));

				if (attempt > 0) await jitterSleep(rotConfig);

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
						addDirs: [tmpDir],
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

					// All-exhausted detection: peek ahead — return all-exhausted immediately if nothing left
					const peekNext = pickNextAccount(rotState, rotConfig, excluded);
					if (peekNext.kind === "paused") {
						const until = new Date(peekNext.until).toLocaleString();
						return {
							content: [
								{
									type: "text",
									text: `⛔ All accounts paused until ${until} (protective pause after ToS/403 detection).`,
								},
							],
							details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
							isError: true,
						};
					}
					if (peekNext.kind === "exhausted") {
						return buildAllExhaustedResponse(rotState, rotConfig);
					}
					continue;
				}

				if (result.errorClass === "banned") {
					markFlagged(rotState, acct.name, rotConfig.protectivePauseHours);
					saveState(rotState);
					const until = new Date(rotState.globalPauseUntil).toLocaleString();
					return {
						content: [
							{
								type: "text",
								text: `⛔ Account '${acct.name}' received a ToS/403 signal. Flagged permanently. Pool paused until ${until}.`,
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

				saveState(rotState);
				break; // 'error' — non-quota failure: don't burn the pool
			}

			if (allExhausted || lastResult === null) {
				saveState(rotState);
				return buildAllExhaustedResponse(rotState, rotConfig);
			}

			const result = lastResult;
			const accountName = lastAccountName as string;
			await logCall({
				ts: new Date().toISOString(),
				tool: "agy_image",
				account: accountName,
				latencyMs: result.durationMs,
				promptChars: finalPrompt.length,
				responseChars: result.text.length,
				exitCode: result.exitCode,
			});
			// Cross-account leak prevention: pass undefined for usedConversationId
			const finalConversationId = afterAgyCall(piSessionId, undefined, workDir);
			const isError = result.isError;
			const responseText = isError && !result.text ? result.stderr || "(agy exited with no output)" : result.text;
			return {
				content: [{ type: "text", text: responseText }],
				details: {
					durationMs: result.durationMs,
					account: accountName,
					exitCode: result.exitCode,
					model: getCachedModel(),
					conversationId: finalConversationId,
				},
				isError,
			};
		}); // end withRotationLock
	} finally {
		// Always clean up tmpDir regardless of how the rotation-ON section exits
		// (return, throw, or any early return from inside the lock).
		// force:true makes this idempotent — safe even if never written to.
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
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
		content: [{ type: "text", text: `⚠ All rotation accounts are quota-exhausted. Retry in ~${retrySec}s.` }],
		details: { durationMs: 0, account: null, exitCode: 1, model: getCachedModel() },
		isError: true,
	};
}
