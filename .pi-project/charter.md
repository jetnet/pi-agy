# pi-agy — charter

## Vision

pi-agy makes Google's Antigravity CLI (running Gemini 3.5 Flash) feel like a native Pi tool for design work, so that Opus — the architect — can delegate Tailwind/React component generation as naturally as it delegates other implementation work to `worker`. The invariant is **frictionless integration**: if Opus has to think about CLI flags, model selection, or account state to use Flash, the abstraction has failed. Everything downstream — the 5 tools, account swap, soft-warn quota, output rendering — is plumbing in service of that invariant.

## Scope

**In:**

- **agy_design** — UI component generation across frameworks (Tailwind+React, Svelte, Vue, plain HTML), with `outputFormat: code-only` to skip Flash's prose narration
- **agy_critique** — single-file design/UX review with focus filters (`accessibility`, `visual-hierarchy`, `responsive`, `performance`)
- **agy_image_to_ui** — mockup→component conversion via agy's `--add-dir` workaround (best-effort; CLI image reliability unverified)
- **agy_usage** — local call counter exposed as a tool, soft-warn at 50/day or 200/week, **never refuses**
- **agy_account** — list / current / backup / switch Google account profiles via `~/.pi/agy-accounts/` swap, 0600 file mode, auto-snapshot to `.last-active/`

**Out:**

- **Streaming output** (token-by-token rendering) — agy `-p` doesn't support it; pi-agy stays plain-text-on-completion, never fakes streaming.
- **Parallel multi-account calls** — only one Google account active at a time; no quota-pooling across personal + work simultaneously.
- **Other models via agy** (Claude Sonnet 4.6, GPT-OSS-120b, Gemini Pro) — pi-agy is a Flash 3.5 tool, not a general agy wrapper. Users who want other models invoke `agy` directly.
- **Public npm publishing / marketplace listing** — personal-use extension under `~/.pi/agent/extensions/pi-agy/`. No release tooling, no semver discipline, no public docs.
- **Code execution by Flash** (running generated components to verify they compile) — pi-agy returns Flash's output as-is; verification is the user's or another tool's job.
- **Auto-installation of dependencies** from Flash's output (e.g., `npm install lucide-react`) — pi-agy never modifies the host project's `package.json` or runs install commands.

## Constraints

- **Tech stack:** TypeScript ESM, Node 24+ / Bun-compatible, biome 2.4.15 (lint+format), `tsc --noEmit` strict mode, peerDependencies on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `@sinclair/typebox`. No build step — source files are loaded directly by Pi.
- **Primary platform:** Linux (Pi runtime, Node 24). Untested on macOS/Windows.
- **Latency:** a single `agy` call returns in ≤30s typical, ≤90s worst-case for complex prompts. Above 30s flow breaks; above 90s we surface a timeout error.
- **Failure visibility:** agy crashes never crash pi — `spawnAgy()` always returns `{ isError: true, stderr, exitCode }`, never throws. Any new tool must route through `spawnAgy()`, never `child_process.spawn()` directly.
- **Zero-config first-run:** if `agy` is on `PATH` and the user has logged in once via the agy TUI, all 5 tools work with no env vars, no setup script, no `.agy/` initialization. Any future feature that needs setup must be re-scoped or moved to scope-out.

## Milestones

- **M0** — Ship 5 tools (`agy_design`, `agy_critique`, `agy_image_to_ui`, `agy_usage`, `agy_account`) with security hardening (P0 path traversal + TOCTOU, P1 file mode + timezone + TUI render + abort cleanup). **DELIVERED 2026-05-20 as v0.1.2.**
- **M1** — Discoverability tuning: Opus reaches for `agy_design` ≥2 out of 3 design-shaped requests in a real session, no manual nudging.
- **M2** — True `/usage` cross-source: pi-agy knows the real Google-side weekly quota, not just the local counter (either via TUI scrape or live API probe).
- **M3** — Account switching is one command: `agy_account switch=work` just works, no manual `~/.gemini/` editing ever; verified by backing up both accounts and round-tripping between them.
- **M4** — `details` panel polish: TUI shows model + duration + account + a small visual indicator that this output came from Flash 3.5 (builds trust over time).
- **M5** — Prompt-recipe library: framework-specific recipes (`react-tailwind`, `vue`, `svelte`, plain `html`) hand-tuned per Flash 3.5's observed strengths.
- **M6** — `image_to_ui` reliability investigation: empirically test whether agy reads images via `--add-dir` in `-p` mode, then either fix the tool or formally deprecate it with a clear scope-out note.
- **M7** — Critique multi-file: extend `agy_critique` to take 2–5 files while staying under agy's context budget.
