import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncAccount } from "../accounts";
import { spawnAgy } from "../execute";
import { getCachedModel, probeActiveModel, resetModelCache } from "../model";
import { findKnownModel, setModel } from "../model-settings";
import { afterAgyCall, resolveConversationId } from "../session";
import type { AgyToolDetails, SpawnAgyResult } from "../types";
import { logCall } from "../usage";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export async function executeImage(
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: any,
	ctx: any,
): Promise<{ content: Array<{ type: string; text: string }>; details: AgyToolDetails; isError: boolean }> {
	const workDir = params.cwd ?? ctx.cwd;
	probeActiveModel(workDir);
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

	// Model override: swap settings.json if a model was specified
	let restoreModel = () => {};
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
		restoreModel = setModel(resolved);
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

	// Restore original model
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
