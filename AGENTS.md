# pi-agy — agent notes

pi-agy is a Pi extension that wraps Google's Antigravity CLI to delegate Tailwind/React design work to Gemini 3.5 Flash. The invariant is **frictionless integration**: agy must feel like a native Pi tool to Opus, never requiring manual ceremony. Hard constraints: latency ≤30s typical / ≤90s worst-case per call, agy crashes never crash pi (always return `isError:true` with diagnostic, never throw), and zero-config first-run (agy on `PATH` + one TUI login = all 5 tools work).

Canonical project state lives in `.pi-project/`. **This file's job is to keep
that state from going stale.** It is not a re-statement of charter, plan, or
decisions; read those directly when you need them.

## Pre-commit hygiene (required at every milestone close)

Before writing the milestone's commit, run these five scans. Record findings
under a `## Documentation hygiene` section in the session log, even if all
scans are clean.

1. **Stale milestone refs in code.** Search code for `\bM\d+\b`. Each hit
   must either be current and correct, or rewritten to name the invariant
   (e.g. `# scoring: 1*cells + 9*cleared*regions^2`, not `# M6 scoring`).
2. **API-shape drift in docstrings.** For every function you modified this
   milestone, eyeball the docstring. Does the return type / parameter list /
   contract still match the implementation?
3. **Decision triggers.** Open `.pi-project/watch.md` and scan for "re-check
   when" conditions. Any now plausibly met?
4. **Polish bucket overflow.** Open `.pi-project/polish.md`. Any item now
   actionable, blocked by current work, or directly relevant to the
   milestone just closed?
5. **Charter drift.** Skim `.pi-project/charter.md` (it's short). Does the
   stated intent still match the code state? Note any drift, even if you
   don't act on it.

If any scan finds drift, fix in the same session before commit. Capture
deferred items in `.pi-project/watch.md` with an explicit re-check trigger.

## Outstanding triggers

(None yet.)

## Session orientation (start of work)

1. Read `.pi-project/plan.md` — what's "currently working on".
2. Read the most recent `.pi-project/session-log/` file — its "open
   questions for next session" section.
3. If a milestone was closed in the prior session, trust that pre-commit
   hygiene ran — but do a 30-second sanity skim of recently-modified files
   for obvious stale comments.

## Project specifics

- **Template version:** `v0.2` (see `.pi-project/VERSION`). Methodology
  recipe lives in Obsidian at `Dev/Projects/pi-project/`. For *this*
  project, `.pi-project/` is authoritative; Obsidian is only consulted for
  "how the methodology works in general."

- **Top gotchas:** populate as discovered. Full catalogue in Obsidian
  `Dev/Projects/pi-project/gotchas.md`.

- **Reference extension:** `@agnishc/edb-gemini-proxy` at
  `~/code/pi-extention-monorepo/packages/edb-gemini-proxy/`. Mirror its
  conventions for file layout, schemas, `peerDependencies` policy, and
  noEmit-TS shipping (decision M0-e).

- **Build & verify:** `cd ~/.pi/agent/extensions/pi-agy && npm run check`
  (biome + `tsc --noEmit`). Pi loads `.ts` source directly via its
  extension loader — no compile step, no `dist/`.

- **End-to-end smoke:** `bun run /tmp/pi-agy-e2e.ts` produces real
  React+Tailwind code via `executeDesign()`. Recreate the script if `/tmp`
  has been cleared; it lives outside the project intentionally (not
  a test, just a manual probe).

- **Negative test:** `bun run /tmp/pi-agy-p0-test.ts` confirms profile-name
  validation blocks all 10 known attack vectors. Run after any change to
  `src/accounts.ts`.

<!-- Add a "Test runner" section here when the first test infrastructure
     ships. Format: exact command(s) to run all suites, plus any
     bootstrap step (e.g. type cache, fixture setup). Don't add this
     section before tests exist; an empty test-runner section rots. -->
