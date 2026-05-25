import * as fs from "node:fs";
import * as path from "node:path";
import { syncAccount } from "../accounts";
import { spawnAgy } from "../execute";
import { getCachedModel, probeActiveModel, resetModelCache } from "../model";
import { findKnownModel, setModel } from "../model-settings";
import { afterAgyCall, resolveConversationId } from "../session";
import type { AgyToolDetails, SpawnAgyResult } from "../types";
import { logCall } from "../usage";

export async function executeAgy(
	params: any,
	signal: AbortSignal | undefined,
	onUpdate: any,
	ctx: any,
): Promise<{ content: Array<{ type: string; text: string }>; details: AgyToolDetails; isError: boolean }> {
	const workDir = params.cwd ?? ctx.cwd;
	probeActiveModel(workDir);
	const timeoutSec = params.timeoutSec ?? 120;

	const piSessionId: string = ctx.sessionManager?.getSessionId?.() ?? "unknown";

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

	const conversationId = resolveConversationId(params.conversationId, piSessionId);

	// Model override: swap settings.json if a model was specified
	let restoreModel = () => {};
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
		restoreModel = setModel(resolved);
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

	// Restore original model before anything else
	restoreModel();
	if (requestedModel) resetModelCache();

	// Use the real account from agy's log, fall back to google_accounts.json
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

	// Quota error: agy print mode silently falls back to another model.
	// Surface the error instead of returning the wrong model's response.
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
