import { spawn } from "node:child_process";
import { findAgyCli } from "./cli";
import type { SpawnAgyOptions, SpawnAgyResult } from "./types";

// ── Execute agy via stdin (no -p flag — avoids argv size limits) ────────────────

const NOISE_PREFIXES = ["Loaded cached credentials", "Skill ", "antigravity-cli"];

function isNoise(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return true;
	return NOISE_PREFIXES.some((prefix) => trimmed.includes(prefix));
}

export function spawnAgy(prompt: string, opts: SpawnAgyOptions): Promise<SpawnAgyResult> {
	return new Promise<SpawnAgyResult>((resolve) => {
		const agyPath = findAgyCli();
		const timeoutStr = `${opts.timeoutSec}s`;

		const args: string[] = ["--dangerously-skip-permissions", "--print-timeout", timeoutStr];
		if (opts.conversationId) {
			args.push("--conversation", opts.conversationId);
		}
		if (opts.addDirs && opts.addDirs.length > 0) {
			for (const dir of opts.addDirs) {
				args.push("--add-dir", dir);
			}
		}

		const startTime = Date.now();
		opts.onProgress?.("waiting for agy...");

		const proc = spawn(agyPath, args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		proc.stdin.write(prompt, "utf-8");
		proc.stdin.end();

		let stdout = "";
		let stderrRaw = "";
		let progressInterval: ReturnType<typeof setInterval> | undefined;

		progressInterval = setInterval(() => {
			const elapsed = Math.round((Date.now() - startTime) / 1000);
			opts.onProgress?.(`agy running (${elapsed}s)`);
		}, 10_000);

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderrRaw += chunk.toString("utf-8");
		});

		let onAbort: (() => void) | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		proc.on("close", (code) => {
			clearInterval(progressInterval);
			if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
			if (killTimer) clearTimeout(killTimer);

			const durationMs = Date.now() - startTime;

			const filteredStderr = stderrRaw
				.split("\n")
				.filter((l) => !isNoise(l))
				.join("\n")
				.trim();

			const exitCode = code ?? 0;
			const hasOutput = stdout.trim().length > 0;
			const substantialError = filteredStderr.length > 0;

			const isError = exitCode !== 0 || (!hasOutput && substantialError);

			resolve({
				text: stdout.trim(),
				stderr: filteredStderr,
				exitCode,
				durationMs,
				isError,
			});
		});

		proc.on("error", (err) => {
			clearInterval(progressInterval);
			const durationMs = Date.now() - startTime;
			resolve({
				text: "",
				stderr: `Failed to spawn agy: ${err.message}`,
				exitCode: 1,
				durationMs,
				isError: true,
			});
		});

		if (opts.signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (opts.signal.aborted) {
				kill();
			} else {
				onAbort = kill;
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});
}
