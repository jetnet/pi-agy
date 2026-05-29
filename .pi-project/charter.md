# pi-agy — charter

## Vision

pi-agy makes Google's Antigravity CLI (agy) feel like a native Pi tool, so Opus can delegate any task to Gemini as naturally as it delegates work to `bash` or `read`. The invariant is **frictionless integration**: if Opus has to think about CLI flags, model selection, or account state, the abstraction has failed.

## Scope

**In:**

- **`agy`** — send any prompt to Gemini via agy `-p`. Optional `contextFiles` injects file contents as `<file>` blocks. No system prompts added — the caller writes the full prompt.
- **`agy_image`** — send a prompt + image file to Gemini. Uses `--add-dir` with an isolated temp dir so only the target image is exposed.
- **`agy_usage`** — local call counter exposed as a tool, soft-warn at 50/day or 200/week, **never refuses**.
- **`src/model.ts`** — dynamic model detection: probes agy on first call per session, caches result in memory, displays actual model name in tool details instead of hardcoded string.
- **`src/rotation.ts` (M4)** — auto account rotation on quota/429: reactive switch across a pre-authenticated account pool via `HOME`+`DBUS` env override, defined in `~/.pi/agy-rotation.config.json`. Anti-ban guardrails (no-hammer, cooldown, 403→6h global pause, advisory daily cap). Opt-in: no config ⇒ off, behaves as before. Supersedes the M0-c file-swap.
- **Fast-follow (planned):** `agy_account` observability tool (status/list/clear-flag/pin); shared session store (auto-managed `conversations`+`brain` symlinks) for cross-account conversation continuity — see `feat-auto-switch-429.md` §12.

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
- **Zero-config first-run:** `agy` on PATH + one TUI login = all 3 tools work. Account rotation is opt-in (requires `~/.pi/agy-rotation.config.json`); absent config = unchanged single-account behavior.

## Milestones

- **M0** — Ship initial 5 tools with security hardening. **DELIVERED 2026-05-20 as v0.1.2.**
- **M1** — Simplify to 4 generic tools; remove specialized prompt modes; add dynamic model detection. **DELIVERED 2026-05-23.**
- **M2** — True usage cross-source: surface Google-side weekly quota, not just local counter.
- **M3** — Account switching reliability: round-trip test between two accounts, verify no credential corruption. *(Reframed by M4: switching is now HOME-based; reliability covered by the rotation state machine + 51 unit tests, pending the live round-trip smoke.)*
- **M4** — Auto account rotation on quota (429-class) errors. Core **IMPLEMENTED on `feat/auto-switch-429`** (reviewer PASS, 51 tests); pending live 2-account smoke + merge. Fast-follow: `agy_account` tool + shared session store.
