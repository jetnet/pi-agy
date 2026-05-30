import * as fs from "node:fs";
import * as path from "node:path";
import { syncAccount } from "../accounts.ts";
import { spawnAgy } from "../execute.ts";
import { findNewImages, snapshotImages } from "../images.ts";
import { getCachedModel, probeActiveModel, resetModelCache } from "../model.ts";
import { findKnownModel, setModel } from "../model-settings.ts";
import { loadRotationConfig } from "../rotation.ts";
import type { ExecResult } from "../rotation-execute.ts";
import { executeWithRotation } from "../rotation-execute.ts";
import { afterAgyCall, resolveConversationId } from "../session.ts";
import type { SpawnAgyResult } from "../types.ts";
import { logCall } from "../usage.ts";

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

	// ── ROTATION ON: delegated to shared executeWithRotation ─────────────────
	// withRotationLock, pin validation, auto-rotation loop, state transitions,
	// model swap, logging, soft-cap warning, and all error responses are handled
	// by the shared module. The only agy-specific logic is the buildSuccessContent
	// callback, which detects newly generated images for this tool.
	//
	// Cross-account conversation-leak prevention: rotation-ON calls do NOT pass
	// conversationId to spawnAgy. Each rotated attempt starts a fresh agy
	// conversation rather than risking a cross-account UUID leak. Full
	// per-account conversation mapping is deferred to a fast-follow milestone.
	return executeWithRotation({
		rotConfig,
		toolName: "agy",
		pinName: typeof params.account === "string" ? params.account : undefined,
		workDir,
		timeoutSec,
		addDirs,
		requestedModel,
		finalPrompt,
		signal,
		onUpdate,
		piSessionId,
		buildSuccessContent: (result: SpawnAgyResult, convId: string | undefined) => {
			const isError = result.isError;
			const responseText = isError && !result.text ? result.stderr || "(agy exited with no output)" : result.text;
			const newImages = findNewImages(convId, imagesBefore);
			return {
				responseText,
				generatedImages: newImages.length > 0 ? newImages : undefined,
			};
		},
	});
}
