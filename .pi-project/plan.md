# Plan

## Currently working on

### M1 — Discoverability tuning: Opus reaches for `agy_design` ≥2/3 design-shaped requests, no manual nudging

- [ ] Refine each tool's `promptSnippet` and `promptGuidelines` based on observed Opus behavior after a week of real usage
- [ ] Add 2–3 concrete dispatch examples to `~/.pi/agent/AGENTS.md`'s pi-agy delegation rule (e.g., "User: 'build me a hero section' → Opus: `agy_design`")
- [ ] Run a discoverability probe: dispatch 3 design-shaped requests in fresh pi sessions, log which got routed to `agy_design` vs Opus writing Tailwind itself
- [ ] Track "I should have used agy_design here" observations in `watch.md` as discoverability signals
- [ ] Decide on success criterion before measurement (≥2/3 is the current target — confirm or revise)

## Next up

### M2 — True `/usage` cross-source: pi-agy knows the real Google-side weekly quota, not just the local counter

(Sub-tasks defined when M1 closes.)

## Done

- **M0** (2026-05-20, session-log/2026-05-20-001.md) — Shipped 5 tools (`agy_design`/`critique`/`image_to_ui`/`usage`/`account`) + spawnAgy abstraction + profile-based account swap + local usage counter; hardened via adversarial review (P0 path traversal + TOCTOU fixed, all P1s + P2.1 fixed); 3 git commits as v0.1.0, v0.1.1, v0.1.2.
