# Plan

## Currently working on

### M4 — Auto account rotation on quota (429) — branch `feat/auto-switch-429`
Core IMPLEMENTED; reviewer PASS (0 critical/high), 51 unit tests, `npm run check` clean. NOT merged.
Blocking before merge (operator):
1. Restart pi (picks up `pi.extensions` → `./src/index.ts`; rotation was loading stale `dist/` before).
2. Create `~/.pi/agy-rotation.config.json` with the `dv`/`jn` accounts.
3. Live 2-account round-trip smoke (drain → 429 → switch).
4. Spike S0: capture a real 403 ToS log to verify/correct the provisional ban regex.

## Next up

### M4 fast-follow (after live smoke)
- Shared session store for cross-account continuity: auto-managed `conversations`+`brain` symlinks, re-enable `conversationId` on rotation-ON, HOME-aware `session.ts` discovery (`installation_id` stays per-account). See `feat-auto-switch-429.md` §12.
- `agy_account` observability tool: status / list / clear-flag / pin.
- 2 cosmetic model-label fixes under rotation (see polish.md).

### M2 — True usage cross-source
Surface the real Google-side weekly quota instead of (or alongside) the local counter.
Options: TUI scrape, live API probe, or just linking to the agy TUI `/usage` command clearly in the tool output.

### M3 — Account switching reliability
Reframed by M4 (switching is now HOME-based). Remaining: the live round-trip smoke listed under M4 above.

## Done

- **M0** — 5 tools shipped with security hardening (path traversal, TOCTOU, file mode, abort cleanup). 2026-05-20.
- **M1** — Simplified to 4 tools (`agy`, `agy_image`, `agy_usage`, `agy_account`). Removed all specialized prompt modes. Added dynamic model detection (`src/model.ts`). Fixed `agy_image` temp dir isolation. 2026-05-23. *(Note: `agy_account` was later dropped; 3 tools ship today.)*
