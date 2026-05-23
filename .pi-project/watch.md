# Watch list

Items to re-check when a trigger condition is met.

---

**agy `-m` flag** — Currently silently ignored in agy 1.0.0. Re-check when agy releases a new version. If `-m` starts working, expose a `model` parameter on `agy` and `agy_image`, and retire the probe in `src/model.ts`.

**agy image support via `--add-dir`** — Verified working as of 2026-05-23 (tested with PNG, Gemini correctly identified content). Re-check if agy changes how it handles binary files in the workspace.

**argv length limit** — ~~resolved by M1-f (stdin approach)~~. `contextFiles` still inlines into stdin; no OS limit there. `contextDir` uses `--add-dir` for directory-level context. No further action needed unless agy changes stdin behaviour.

**Model probe accuracy** — `normalise()` in `src/model.ts` handles known response patterns. Re-check if a newly selected model returns a format the normaliser doesn't recognise (symptom: `getCachedModel()` returns `"(unknown — check agy TUI)"`).
