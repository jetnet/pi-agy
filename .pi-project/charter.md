# pi-agy — charter

## Vision

pi-agy makes Google's Antigravity CLI (agy) feel like a native Pi tool, so Opus can delegate any task to Gemini as naturally as it delegates work to `bash` or `read`. The invariant is **frictionless integration**: if Opus has to think about CLI flags, model selection, or account state, the abstraction has failed.

## Scope

**In:**

- **`agy`** — send any prompt to Gemini via agy `-p`. Optional `contextFiles` injects file contents as `<file>` blocks. No system prompts added — the caller writes the full prompt.
- **`agy_image`** — send a prompt + image file to Gemini. Uses `--add-dir` with an isolated temp dir so only the target image is exposed.
- **`agy_usage`** — local call counter exposed as a tool, soft-warn at 50/day or 200/week, **never refuses**.
- **`agy_account`** — list / current / backup / switch Google account profiles via `~/.pi/agy-accounts/` swap, 0600 file mode, auto-snapshot to `.last-active/`.
- **`src/model.ts`** — dynamic model detection: probes agy on first call per session, caches result in memory, displays actual model name in tool details instead of hardcoded string.

**Out:**

- **Specialized system prompts** (design, critique, review, imagine modes) — removed. The caller writes their own prompt. pi-agy is a transparent pipe, not a prompt library.
- **Streaming output** — agy `-p` doesn't support it.
- **Parallel multi-account calls** — only one Google account active at a time.
- **Model switching via tool** — agy `-m` flag is silently ignored in v1.0.0; model must be set interactively via agy TUI `/model`.
- **Image generation** — agy `-p` returns text only; image output is not supported.
- **Public npm publishing** — personal-use extension only.

## Constraints

- **Tech stack:** TypeScript ESM, Node 24+, biome 2.x (lint+format), `tsc --noEmit` strict, peerDependencies on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`. No build step.
- **Latency:** ≤30s typical, ≤90s worst-case per call.
- **Failure visibility:** agy crashes never crash Pi — `spawnAgy()` always returns `{ isError: true }`, never throws.
- **Zero-config first-run:** `agy` on PATH + one TUI login = all 4 tools work.

## Milestones

- **M0** — Ship initial 5 tools with security hardening. **DELIVERED 2026-05-20 as v0.1.2.**
- **M1** — Simplify to 4 generic tools; remove specialized prompt modes; add dynamic model detection. **DELIVERED 2026-05-23.**
- **M2** — True usage cross-source: surface Google-side weekly quota, not just local counter.
- **M3** — Account switching reliability: round-trip test between two accounts, verify no credential corruption.
