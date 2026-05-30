import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncAccount } from "../accounts.ts";
import { spawnAgy } from "../execute.ts";
import { getCachedModel, probeActiveModel, resetModelCache } from "../model.ts";
import { findKnownModel, setModel } from "../model-settings.ts";
import { loadRotationConfig } from "../rotation.ts";
import type { ExecResult } from "../rotation-execute.ts";
import { executeWithRotation } from "../rotation-execute.ts";
import { afterAgyCall, resolveConversationId } from "../session.ts";
import type { SpawnAgyResult } from "../types.ts";
import { logCall } from "../usage.ts";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

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

	// ── ROTATION ON: delegated to shared executeWithRotation ─────────────────
	// withRotationLock, pin validation, auto-rotation loop, state transitions,
	// model swap, logging, soft-cap warning (now applied here too — fixing the
	// previous gap), and all error responses are handled by the shared module.
	//
	// The outer try/finally ensures tmpDir is ALWAYS cleaned regardless of
	// which code path exits — including throws from within the lock.
	//
	// Cross-account conversation-leak prevention: rotation-ON calls do NOT pass
	// conversationId to spawnAgy to prevent cross-account UUID leakage. Full
	// per-account conversation mapping is deferred to a fast-follow milestone.
	try {
		return await executeWithRotation({
			rotConfig,
			toolName: "agy_image",
			pinName: typeof params.account === "string" ? params.account : undefined,
			workDir,
			timeoutSec,
			addDirs: [tmpDir], // always pass tmpDir so agy can read the staged image
			requestedModel,
			finalPrompt,
			signal,
			onUpdate,
			piSessionId,
			buildSuccessContent: (result: SpawnAgyResult, _convId: string | undefined) => {
				const isError = result.isError;
				return {
					responseText: isError && !result.text ? result.stderr || "(agy exited with no output)" : result.text,
				};
			},
		});
	} finally {
		// Always clean up tmpDir regardless of how the rotation-ON section exits
		// (return, throw, or any early return from inside the lock).
		// force:true makes this idempotent — safe even if never written to.
		await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
