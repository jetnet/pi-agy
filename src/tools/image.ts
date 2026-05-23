import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCurrentAccount } from "../accounts";
import { spawnAgy } from "../execute";
import { getCachedModel, probeActiveModel } from "../model";
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

	// Copy image to an isolated temp dir so --add-dir doesn't expose the
	// entire source directory (which could be large or contain sensitive files).
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

	const result: SpawnAgyResult = await spawnAgy(finalPrompt, {
		cwd: workDir,
		timeoutSec,
		addDirs: [tmpDir],
		signal,
		onProgress: onUpdate
			? (status: string) => onUpdate({ content: [{ type: "text" as const, text: status }] })
			: undefined,
	});

	// Clean up temp dir regardless of outcome
	await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

	const account = getCurrentAccount();
	await logCall({
		ts: new Date().toISOString(),
		tool: "agy_image",
		account,
		latencyMs: result.durationMs,
		promptChars: finalPrompt.length,
		responseChars: result.text.length,
		exitCode: result.exitCode,
	});

	const isError = result.isError;
	const responseText = isError && !result.text ? result.stderr || "(agy exited with no output)" : result.text;

	return {
		content: [{ type: "text", text: responseText }],
		details: { durationMs: result.durationMs, account, exitCode: result.exitCode, model: getCachedModel() },
		isError,
	};
}
