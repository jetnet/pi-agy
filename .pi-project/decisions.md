# Decisions

Append-only. One block per design decision. See
`Dev/Projects/pi-project/template.md` for format.

If a past decision is reversed, **append a new entry** citing the
old one — never edit the old entry.

---

## M0-a: Build as a Pi extension (not subagent or pi-interactive-shell config)

**Date:** 2026-05-20
**Context:** User wants `agy` callable "similarly to subagents" from Pi. Investigation showed `pi-interactive-shell` has a hardcoded allowlist (`pi`/`codex`/`claude`/`cursor`) and `pi-subagents` always spawns `pi`, never external CLIs.
**Decision:** Build pi-agy as a standalone Pi extension under `~/.pi/agent/extensions/pi-agy/`, registering 5 tools via `pi.registerTool()`. Pi auto-discovers via the `package.json` `pi.extensions` field.
**Rationale:** Subagents can't spawn external CLIs without invasive patching. pi-interactive-shell only handles TUI agents (no headless `-p` delegation). A dedicated extension gives clean per-tool delegation, type-safe TypeBox schemas, and integrates with Pi's tool-call lifecycle (renderCall/renderResult) without touching upstream code.
**Alternatives considered:**
- *Add `agy` to pi-interactive-shell's allowlist via config* — TUI-only, no headless delegation, would fight the existing extension's design.
- *Patch pi-subagents to spawn arbitrary CLIs* — invasive, fragile across upstream updates, not generalizable.
- *Reuse @agnishc/edb-gemini-proxy by repointing it at agy* — wrong CLI semantics; agy 1.0.0 has different flags than the old gemini-cli (no `--model`, no `--output-format json`, stdin piping unreliable).
**Consequences:** Each tool gets its own intent/schema and shows up independently in Pi's tool list. Discoverability becomes a `promptSnippet`/`promptGuidelines` problem (see M1). Future tool additions are append-only — no churn to existing surfaces.

---

## M0-b: Hardcode Gemini Flash 3.5 High (no model parameter exposed by pi-agy)

**Date:** 2026-05-20
**Context:** `agy --help` claims a `-m`/`--model` flag, but agy 1.0.0 silently ignores it; model selection is TUI-only via the `/model` slash command. Print mode (`-p`) inherits the last interactively-selected model.
**Decision:** pi-agy assumes Flash 3.5 High is the active model in agy. No model parameter on any tool. Users who need other models (Claude Sonnet 4.6, GPT-OSS-120b, Gemini Pro) invoke `agy` directly, not through pi-agy.
**Rationale:** We can't actually override the model from `-p` mode. Adding a model parameter would lie about capability and create silent failures. The vision invariant is design tasks → Flash 3.5 is the strongest mode for Tailwind/React anyway.
**Alternatives considered:**
- *TUI-scrape the current model from agy's status line* — fragile, agy's ANSI codes can change between releases, breaks zero-config.
- *Add a passthrough `model` flag that fails silently* — confusing UX; user thinks they switched but didn't.
- *Run `agy /model <name>` ourselves before each call* — breaks zero-config invariant, adds latency, requires TUI automation.
**Consequences:** Users must set Flash 3.5 once via `agy` then `/model` in the TUI. Documented in README and in tool descriptions ("Gemini Flash 3.5"). Promptrecipes (M5) can be Flash-tuned without worrying about cross-model portability.

---

## M0-c: Profile-based account swap via `~/.pi/agy-accounts/` (not env vars or auth flow)

**Date:** 2026-05-20
**Context:** User has personal + work Google accounts for Antigravity. agy reads OAuth credentials from `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json` on each call. No native multi-account support; only third-party tools (aisw, AntigravityManager) handle this.
**Decision:** Implement `agy_account` with actions `list`/`current`/`backup`/`switch`. Backup copies the two `~/.gemini/*.json` files into `~/.pi/agy-accounts/<profile>/` at file mode 0600. Switch reads the named profile and writes content back into `~/.gemini/` via `writeFile { mode: 0o600 }` (atomic, no race window). Auto-snapshot the current state to `.last-active/` before any switch for rollback.
**Rationale:** agy reads creds from `~/.gemini/` directly per call, so profile swap requires zero changes to agy itself. Profile names are strictly validated (`/^[a-zA-Z0-9_-]+$/`) to prevent path traversal — added as P0 fix after adversarial review found `name = "../evil"` could escape the sandbox.
**Alternatives considered:**
- *`GEMINI_HOME` env var per call* — agy 1.0.0 doesn't honor it.
- *Shadow `~/.gemini/` symlinks per profile* — too clever, easy to corrupt, fragile under concurrent access.
- *Rely on third-party tools (aisw, AntigravityManager)* — external dependency, version drift, not under our control.
**Consequences:** Already-running agy sessions retain their loaded credentials until restart (documented limitation). Profile names must be alphanumeric + hyphen/underscore. Adversarial review identified two P0 vulnerabilities here (path traversal + TOCTOU), both fixed.

---

## M0-d: Soft-warn quota, never refuse calls

**Date:** 2026-05-20
**Context:** Antigravity's free tier was slashed ~92% in March 2026; weekly quota cycle. Real quota lives behind Google API — invisible to pi-agy. User had to choose between hard cap (interrupt mid-task) and soft warn (informational).
**Decision:** Append every call to `~/.pi/agy-usage.jsonl` (one JSON object per line: timestamp, tool, account, latency, prompt size, response size, exit code). The `agy_usage` tool summarizes by window (today/week/month/all). Soft-warn fires inline at >50 calls/day or >200/week but `never refuses` the call.
**Rationale:** Refusing mid-task is worse than overage. Local counter is approximate (doesn't see cross-source agy usage) but informs the user enough to switch accounts or pace work. Aligns with the vision invariant: frictionless UX > strict quota policing.
**Alternatives considered:**
- *Hard cap at 50/day* — interrupts real work, violates frictionless invariant.
- *No counter at all, trust Google's quota* — invisible failures when quota exhausts mid-task.
- *Scrape `/usage` live before each call* — added latency per call (~1-3s), explicitly scoped out under the zero-config + latency constraints.
**Consequences:** Counter accuracy is local-only — doesn't see calls made via the agy TUI directly or from other tools. Users must manually trigger `/usage` in the agy TUI for the real Google-side number. This is M2's whole purpose: get the real quota in-tool. Not locked as a constraint yet (could be promoted later).

---

## M0-e: Mirror @agnishc/edb-gemini-proxy conventions (file layout, schemas, no build)

**Date:** 2026-05-20
**Context:** User maintains `@agnishc/edb-gemini-proxy` — a Pi extension wrapping the old gemini-cli. It's the in-house pattern for Gemini CLI wrappers in this environment.
**Decision:** Match its conventions exactly: `src/{index,execute,cli,render,format,types,schemas}.ts` layout, TypeBox schemas as both runtime validators and LLM-facing docs, `peerDependencies` only for `@earendil-works/*` and `@sinclair/typebox`, no build step (Pi loads `.ts` source directly via its own loader), biome strict + tsc strict via `npm run check`. Per-tool `tools/<name>.ts` extracts execute functions to keep `index.ts` thin.
**Rationale:** User's existing maintained code is the convention. Reduces cognitive load for future maintenance — same shape across Gemini-family extensions. The `pi-extension-author` skill explicitly endorses this pattern.
**Alternatives considered:**
- *Invent a new structure tailored to agy's specifics* — needless divergence; benefits don't outweigh inconsistency cost.
- *Use a published Pi extension template* — none exists yet; would have to author one anyway.
- *Monorepo (workspaces) from day 1* — overkill for one extension; trivial to migrate later because layout matches edb-gemini-proxy.
**Consequences:** Future v0.2+ monorepo migration is trivial (file layout already matches). Edits should match edb-gemini-proxy's tab indentation, double quotes (enforced by biome), and section banner comments. Cross-extension refactors become possible when 2+ Gemini wrappers exist.

---

## M0-f: Positional prompt argument to `agy -p`, not stdin pipe

**Date:** 2026-05-20
**Context:** Initial probe showed `agy -p "prompt"` and `echo "prompt" | agy -p` both documented. Empirically, stdin piping failed with `flag needs an argument: -p` — agy's Go flag parser treats `-p` as requiring its argument inline.
**Decision:** `spawnAgy()` uses `spawn(agyPath, ["-p", prompt, "--dangerously-skip-permissions", "--print-timeout", timeout], { shell: false })` — positional prompt as argv, no shell, no stdin write.
**Rationale:** Empirically reliable across test runs. `shell: false` + argv-array means no shell injection possible regardless of prompt content. `--dangerously-skip-permissions` is required for headless `-p` mode (interactive permission prompt would block).
**Alternatives considered:**
- *Stdin pipe* (`proc.stdin.write(prompt); proc.stdin.end()`) — empirically fails with "flag needs an argument: -p". Not a workable fallback.
- *Temp-file + `--continue`* — adds I/O, state complexity, and a cleanup path; also `--continue` is for conversation resumption, not initial prompt delivery.
**Consequences:** Very long prompts (>argv limit ~128KB on Linux) would fail with E2BIG. Not a constraint at current usage (design prompts are typically <10KB including reference files). If we ever hit it (M5 prompt-recipe library could push toward larger contexts), the fix is temp-file + `--continue` workaround.

---
