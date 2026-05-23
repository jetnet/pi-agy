# Polish bucket

Low-priority improvements, not blocking any milestone.

---

**`agy_usage` output** — Currently shows a local counter only. Would be better to also print a reminder of how to check Google-side quota (`agy /usage` in TUI). One extra line.

**`agy_image` fallback message** — If Gemini returns text instead of acting on the image (agy CLI limitation), the response gives no guidance. Could add: "If Gemini didn't process the image, try opening agy TUI directly."

**`resetModelCache()` on account switch** — `agy_account action:switch` currently doesn't reset the model probe cache. Different accounts could theoretically have different models selected. Low risk — model selection is global to the agy binary, not per-account. But worth wiring up if it ever causes confusion.

**README examples** — The README shows no usage examples. Add 2–3 concrete `agy` prompt examples (code review, explain, generate).
