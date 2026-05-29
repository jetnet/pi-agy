# Polish bucket

Low-priority improvements, not blocking any milestone.

---

**`agy_usage` output** — Currently shows a local counter only. Would be better to also print a reminder of how to check Google-side quota (`agy /usage` in TUI). One extra line.

**`agy_image` fallback message** — If Gemini returns text instead of acting on the image (agy CLI limitation), the response gives no guidance. Could add: "If Gemini didn't process the image, try opening agy TUI directly."

**`resetModelCache()` on account switch** — now relevant under M4 rotation: each account has its own `settings.json` model. Rotation reads the active account's model via `readCurrentModel(home)`; revisit if the displayed model ever lags the active account.

**M4: model label wrong on rotation-ON `model=` override** — when a `model` override is requested under rotation, `setModelCache(readCurrentModel(...))` is discarded by the following `resetModelCache()`, so `details.model` shows the fallback label rather than the override name. Cosmetic only (the model IS set correctly in the account's settings.json). Fix: report `requestedModel` directly in details on the rotation-ON path.

**M4: cross-mode model-cache bleed** — if rotation config is added mid-session, a later rotation-OFF call's `probeActiveModel` short-circuits on the non-null cache and reports the prior account's model. Cosmetic; requires a mid-session config toggle.

**README examples** — The README shows no usage examples. Add 2–3 concrete `agy` prompt examples (code review, explain, generate).
