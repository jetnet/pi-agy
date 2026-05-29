# Watch list

Items to re-check when a trigger condition is met.

---

**agy `-m` flag** — Currently silently ignored in agy 1.0.0. Re-check when agy releases a new version. If `-m` starts working, expose a `model` parameter on `agy` and `agy_image`, and retire the probe in `src/model.ts`.

**agy image support via `--add-dir`** — Verified working as of 2026-05-23 (tested with PNG, Gemini correctly identified content). Re-check if agy changes how it handles binary files in the workspace.

**argv length limit** — ~~resolved by M1-f (stdin approach)~~. `contextFiles` still inlines into stdin; no OS limit there. `contextDir` uses `--add-dir` for directory-level context. No further action needed unless agy changes stdin behaviour.

**Model probe accuracy** — `normalise()` in `src/model.ts` handles known response patterns. Re-check if a newly selected model returns a format the normaliser doesn't recognise (symptom: `getCachedModel()` returns `"(unknown — check agy TUI)"`).

**M4 spike S0 — ban regex is PROVISIONAL** — the 403/ToS classifier in `src/execute.ts` was never validated against a real ban log. Re-check (verify/correct the regex + lock a fixture test) the first time a real 403 ToS log is captured. Until then the FLAGGED/6h-pause path is untrusted; ambiguous logs degrade to quota.

**M4 cross-account resume — unproven live** — conversation portability across accounts is evidenced (account-agnostic `.pb`) but not proven end-to-end. Verify during the fast-follow: symlink `conversations`+`brain`, create a conv under one account, resume under another. Trigger: starting the shared-session fast-follow.

**M4 agy storage-layout dependency** — rotation assumes creds at `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`, model at `.../settings.json`, conversations at `conversations/<uuid>.pb` + `brain/<uuid>/`, and the dead-socket DBUS keyring-disable trick. Re-check ALL of these if agy changes its on-disk layout or keyring behavior (symptom: rotation switches but agy authenticates as the wrong/old account, or model override no-ops).
