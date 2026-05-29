# Decisions

Decisions are append-only. Superseded decisions are marked but not deleted.

## M0-a: Build as a Pi extension (not subagent or pi-interactive-shell config)

**Date:** 2026-05-20
**Context:** agy could be invoked via a shell alias, a Pi skill, or a Pi extension with registered tools. The goal is LLM-callable tools, not user-typed shortcuts.
**Decision:** Pi extension with `pi.registerTool()`. Tools are visible to Opus in the system prompt and callable without user intervention.
**Rationale:** Extension tools are first-class in Pi's LLM routing. Skills and aliases require the user to type `/skill:name`, breaking the frictionless invariant.
**Alternatives considered:**
- *Pi skill* — requires explicit `/skill:agy-design` invocation; user must remember it.
- *Shell alias* — not LLM-callable at all.
**Consequences:** Extension must be loaded at Pi startup. Registered in `settings.json` under `packages`.

---

## M0-b: Hardcode Gemini Flash 3.5 High (no model parameter) ~~SUPERSEDED by M1-b~~

**Date:** 2026-05-20
**Context:** `agy --help` documents a `-m`/`--model` flag, but agy 1.0.0 silently ignores it. Model selection is TUI-only via `/model`.
**Decision:** Assume Flash 3.5 High is the active model. Display `"gemini-3.5-flash-high"` in tool details. No model parameter on any tool.
**Superseded:** M1-b replaces the hardcoded string with a live probe.

---

## M0-c: Profile-based account swap via `~/.pi/agy-accounts/` ~~SUPERSEDED by M4-a~~

**Date:** 2026-05-20
**Superseded:** M4-a replaces the `~/.gemini/*.json` file-swap with HOME+DBUS env-override switching (agy moved creds into `antigravity-cli/antigravity-oauth-token`). The `agy_account` tool described here was already removed in M1.
**Context:** User has personal + work Google accounts. agy reads OAuth credentials from `~/.gemini/oauth_creds.json` and `~/.gemini/google_accounts.json` on each call. No native multi-account support.
**Decision:** `agy_account` with actions `list`/`current`/`backup`/`switch`. Backup copies the two `~/.gemini/*.json` files into `~/.pi/agy-accounts/<profile>/` at mode 0600. Switch writes them back atomically. Auto-snapshot to `.last-active/` before any switch.
**Rationale:** agy reads creds from `~/.gemini/` per call — profile swap requires zero changes to agy itself. Profile names validated with `/^[a-zA-Z0-9_-]+$/` to prevent path traversal.
**Alternatives considered:**
- *`GEMINI_HOME` env var* — agy 1.0.0 doesn't honor it.
- *Symlinks per profile* — fragile under concurrent access.
- *Third-party tools (aisw, AntigravityManager)* — external dependency.
**Consequences:** Running agy sessions retain loaded credentials until restart. Profile names must be alphanumeric + hyphen/underscore.

---

## M0-d: Soft-warn quota, never refuse calls

**Date:** 2026-05-20
**Decision:** `agy_usage` emits warnings at 50 calls/day or 200/week but never blocks tool execution.
**Rationale:** Quota enforcement belongs to Google, not to this extension. A false positive refusal is worse than a quota error from agy itself.

---

## M0-e: Mirror @agnishc/edb-gemini-proxy conventions

**Date:** 2026-05-20
**Decision:** Match file layout, TypeBox schemas, peerDependencies-only policy, no build step, biome strict + tsc strict. Per-tool `tools/<name>.ts` files.
**Rationale:** Consistency with the existing in-house Gemini CLI wrapper pattern.

---

## M0-f: Positional prompt argument to `agy -p`, not stdin pipe ~~SUPERSEDED by M1-f~~

**Date:** 2026-05-20
**Context:** Stdin piping (`echo "prompt" | agy -p`) fails with "flag needs an argument: -p" — agy's Go flag parser requires the prompt inline.
**Decision:** `spawn(agyPath, ["-p", prompt, "--dangerously-skip-permissions", "--print-timeout", timeout], { shell: false })`.
**Rationale:** Empirically reliable. `shell: false` + argv-array prevents shell injection regardless of prompt content.
**Consequences:** Prompts >~128KB (Linux argv limit) would fail with E2BIG. Not a current constraint.

---

## M1-f: Prompt via stdin, not `-p` argv argument

**Date:** 2026-05-23
**Context:** M0-f used `agy -p "<prompt>"` (positional argv). For large prompts (many files inlined, long instructions) this hits the Linux argv limit, producing `E2BIG` on spawn. The original M0-f investigation found stdin pipe failing — but that was `echo | agy -p` with the `-p` flag still present, which requires an inline argument.
**Decision:** Remove `-p` entirely. Write the prompt to `proc.stdin` and call `proc.stdin.end()`. agy reads from stdin when `-p` is absent. Tested: all four stdin approaches work (pipe, redirect, Node.js `stdin.write`). Cross-platform — pure Node.js stdio, no shell, no temp files.
**Rationale:** No argv size limit. No temp files. No shell injection surface. Simpler than the original `-p` approach.
**Alternatives considered:**
- *Temp file + `--add-dir`* — works but adds I/O, cleanup, and a workspace file the model might confuse with context.
- *Temp file + `bash -c "agy -p \"$(cat file)\""`* — still puts content on argv via shell expansion, same E2BIG.
**Consequences:** `spawnAgy()` no longer passes `-p`. `proc.stdin.end()` is called immediately after `proc.stdin.write(prompt)`. Decision M0-f superseded.

---

## M1-a: Replace specialized tools with one generic `agy` tool

**Date:** 2026-05-23
**Context:** The original 5 tools (design, critique, image_to_ui, usage, account) grew to 8 after adding ask, review, imagine. Each specialized tool prepended a canned system prompt. The user pointed out this is just a prompt library — the caller can write better prompts themselves.
**Decision:** Remove all specialized tools except `agy_image` (different mechanism) and the two utilities (`agy_usage`, `agy_account`). Replace with one `agy` tool that sends the prompt verbatim, plus optional `contextFiles` for file injection.
**Rationale:** Fewer tools = less LLM confusion. The caller writes the system prompt they actually want. No hidden prompt engineering inside the extension.
**Alternatives considered:**
- *Keep specialized tools as optional* — two APIs to maintain, inconsistent behavior.
- *Make system prompts configurable* — adds complexity, still opinionated defaults.
**Consequences:** Callers must write their own system prompts. `prompts.ts` deleted.

---

## M1-b: Dynamic model detection via one-time probe

**Date:** 2026-05-23
**Context:** M0-b hardcoded `"gemini-3.5-flash-high"` in tool details. This is wrong whenever the user has selected a different model in the agy TUI. No config file or flag exposes the active model.
**Decision:** `src/model.ts` — on first tool call per Pi session, fire a cheap agy probe in parallel with the real call ("what model are you?"). Cache result in module-level variables. All tool `details.model` fields use `getCachedModel()`.
**Rationale:** The probe (~2–4s) completes before any real call (~10–30s) finishes, so there is zero net latency cost. `normalise()` handles Gemini's free-text replies into compact model IDs.
**Alternatives considered:**
- *Parse `~/.gemini/` config files* — model selection is not stored in any JSON file; it lives in protobuf conversation state.
- *Keep hardcoded string* — actively misleads the user.
- *Persist to disk* — stale if the user changes model between Pi sessions.
**Consequences:** First call in a new Pi session fires two agy processes concurrently. `resetModelCache()` is available for future use (e.g. after account switch).

---

## M1-d: `contextDir` parameter uses `--add-dir`; `contextFiles` inlines content

**Date:** 2026-05-23
**Context:** Passing many files via `contextFiles` inlines all content into the prompt argv string. Linux argv limit is ~128KB — a 14-file security audit hit `E2BIG`.
**Decision:** Add `contextDir: string` parameter to `agy`. Passed directly as `--add-dir` to agy; agy makes all files in the directory available to Gemini via workspace. `contextFiles` stays for 1–3 targeted files where inline injection is intentional.
**Rationale:** `--add-dir` bypasses argv entirely — no size limit. Gemini reads files from the workspace on demand.
**Consequences:** Callers should prefer `contextDir` for any multi-file task. `contextFiles` is now explicitly scoped to small targeted use.

---

## M1-e: Dynamic timeout estimation in promptGuidelines

**Date:** 2026-05-23
**Context:** Default 90s timeout caused `timed out waiting for response` on a 14-file security audit. A hardcoded upper bound (e.g. "use 300+") anchors the model to that number instead of reasoning from task size.
**Decision:** Remove hardcoded upper bound. Replace with a formula in `promptGuidelines`: `120s baseline + ~15s per contextFiles file + ~30s per 10 files in contextDir`, doubled for deep analysis. Explicit note that agy FREE/PRO tiers can be 3–5× slower.
**Rationale:** The model has enough context to estimate task size. A formula produces better estimates than a fixed ceiling across varying task sizes.
**Consequences:** Opus should always pass `timeoutSec` explicitly. Default raised to 120s as a safer baseline.

---

## M1-c: `agy_image` uses isolated temp dir for `--add-dir`

**Date:** 2026-05-23
**Context:** `--add-dir` adds an entire directory to agy's workspace. Passing `path.dirname(imagePath)` exposes all files in the image's parent directory to Gemini — could be the project root with thousands of files.
**Decision:** Copy the image to `os.tmpdir()/agy-img-XXXXX/`, pass that as `--add-dir`. Clean up the temp dir after the call.
**Rationale:** Gemini sees exactly one file. No accidental context leakage. Cleanup is safe — the original image is untouched; only the temp copy is deleted.
**Alternatives considered:**
- *Pass parent dir directly* — leaks unrelated files into Gemini's context; slow on large directories.
- *Symlink instead of copy* — same exposure problem.
**Consequences:** Small I/O overhead for the copy. Temp dir created in `os.tmpdir()` so cleanup failure doesn't pollute the project.

---

## M4-a: HOME + DBUS env-override account switching (supersedes M0-c)

**Date:** 2026-05-29
**Context:** agy moved credentials to `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` and exposes no account/home CLI flag (`agy --help`: only `--print`, `--conversation`, `--add-dir`, `--log-file`, `--print-timeout`). M0-c's `~/.gemini/*.json` swap targets a layout agy no longer uses.
**Decision:** Switch accounts by overriding the spawned child's env: `HOME=<account dir>` + `DBUS_SESSION_BUS_ADDRESS=<dead socket>` (kills the OS keyring so agy falls back to the on-disk token). Each account is a pre-authenticated HOME dir (operator convention `~/.ag-acp/accounts/<name>`). Proven by operator transcript.
**Rationale:** Zero changes to agy — the child reads creds from its own HOME. The dead-socket DBUS address forces file-based creds deterministically.
**Alternatives considered:** `~/.gemini` file-swap (M0-c, wrong layout now); symlink-per-profile (fragile); third-party rotators (external dep).
**Consequences:** Accounts must be pre-authenticated. pi's own process HOME is unchanged — only the child env is overridden, which is why M4 also fixes `setModel` to target the account HOME (writer/reader path agreement). Supersedes M0-c.

---

## M4-b: Reactive-only rotation, explicit config pool

**Date:** 2026-05-29
**Context:** The quota/bans cheatsheet describes reactive switching (on 429) and proactive proportional pooling. User chose the simpler shape.
**Decision:** Reactive-only — drain the current account until a 429-class error, then switch to the next entry. Pool defined explicitly in `~/.pi/agy-rotation.config.json` (`accounts[]`); no directory auto-discovery. Missing/invalid config → rotation OFF (byte-identical to prior behavior).
**Rationale:** Matches the ask; simplest correct shape. State model leaves room to enable proportional pooling later without a rewrite.
**Consequences:** One account absorbs volume until it 429s; daily soft cap is advisory in this mode.

---

## M4-c: Anti-ban guardrails from the quota/bans cheatsheet

**Date:** 2026-05-29
**Context:** Source: `tuxevil/pi-antigravity-rotator/QUOTA_AND_BANS_CHEATSHEET.md`. Empirical bans come from hammering 429s and unhuman volume, not from hitting quota itself.
**Decision:** (1) Never re-hit a 429'd account within one call (exclude set + loop bound = pool size) — re-hitting escalates 429→permanent 403. (2) Respect per-account cooldown (Retry-After if parseable, else default 60s). (3) 403/ToS ⇒ permanent FLAGGED + global 6h protective pause across the pool. (4) Advisory daily soft cap (default 90; ~200/day ban heuristic). (5) Jittered retries; all-exhausted returns a clean retry-after payload, no busy-loop. (6) In-process mutex serializes the rotation critical section.
**Consequences:** 403-vs-429 classification relies on agy log parsing; the ban regex is PROVISIONAL until a real 403 log is captured (spike S0). Ambiguous logs classify as quota — safer than a wrong 6h pause.

---

## M4-d: `pi.extensions` → `./src/index.ts` (load TS source, no dist)

**Date:** 2026-05-29
**Context:** `package.json` declared `pi.extensions: ["./dist/index.js"]`, but there is no build step and the local `dist/index.js` was a stale pre-rotation bundle. pi loaded the stale code; `src/` changes never ran — a silent trap that `tsc`/tests do not catch.
**Decision:** Point `pi.extensions` at `./src/index.ts`; delete stale `dist/`. pi's loader (jiti) loads `.ts` directly (verified via the package's own `loadExtensions(['./src/index.ts'])` — registers all three tools). All relative imports use explicit `.ts` extensions for consistency under jiti + `node --experimental-strip-types` tests.
**Rationale:** Reaffirms M0-e noEmit-TS shipping; removes the stale-code trap.
**Consequences:** Restart pi to pick up the change. No build artifact to maintain.

---

## M4-e: Shared session store for cross-account continuity (planned — fast-follow)

**Date:** 2026-05-29
**Context:** Rotation-ON suppresses `conversationId` (cross-account leak prevention) ⇒ a fresh conversation per rotated call. A conversation UUID spans `conversations/<uuid>.pb` + `brain/<uuid>/` + `cache/last_conversations.json`, all under the account HOME.
**Decision (planned, not in first cut):** pi-agy will auto-manage symlinks of each account's `conversations/` + `brain/` to one shared dir (idempotent at config load; migrate existing content first; never clobber), then re-enable `conversationId` on rotation-ON and make `session.ts` discovery HOME-aware. `installation_id` stays per-account — it differs per account (verified), and sharing it links the accounts (a ban-correlation signal).
**Rationale:** Conversations are account-portable (account-agnostic `.pb`, no email/token binding found); sharing the uuid-keyed dirs lets any account resume. Auto-managed symlinks remove operator fragility.
**Consequences:** Cross-account resume must be verified live (spike). See `feat-auto-switch-429.md` §12.
