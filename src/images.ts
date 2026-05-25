import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Generated image detection ───────────────────────────────────────────────────
//
// agy saves generated images to ~/.gemini/antigravity-cli/brain/<conv-id>/.
// We snapshot the image files before the call and diff after to find new ones.

const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function brainConvDir(conversationId: string): string {
	return path.join(BRAIN_DIR, conversationId);
}

/** List image files in a conversation's brain dir. */
function listImages(conversationId: string): Set<string> {
	const dir = brainConvDir(conversationId);
	try {
		const files = fs.readdirSync(dir);
		return new Set(files.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase())));
	} catch {
		return new Set();
	}
}

/** Snapshot image files before an agy call. */
export function snapshotImages(conversationId: string | undefined): Set<string> {
	if (!conversationId) return new Set();
	return listImages(conversationId);
}

/** Find new images by diffing against a pre-call snapshot. Returns full paths. */
export function findNewImages(conversationId: string | undefined, before: Set<string>): string[] {
	if (!conversationId) return [];
	const after = listImages(conversationId);
	const newFiles: string[] = [];
	for (const f of after) {
		if (!before.has(f)) {
			newFiles.push(path.join(brainConvDir(conversationId), f));
		}
	}
	return newFiles;
}
