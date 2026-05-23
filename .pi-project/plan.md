# Plan

## Currently working on

Nothing — M1 just closed.

## Next up

### M2 — True usage cross-source
Surface the real Google-side weekly quota instead of (or alongside) the local counter.
Options: TUI scrape, live API probe, or just linking to the agy TUI `/usage` command clearly in the tool output.

### M3 — Account switching reliability
Round-trip test: backup two accounts, switch between them, verify no credential corruption.
Prerequisite: user has two Google accounts configured in agy.

## Done

- **M0** — 5 tools shipped with security hardening (path traversal, TOCTOU, file mode, abort cleanup). 2026-05-20.
- **M1** — Simplified to 4 tools (`agy`, `agy_image`, `agy_usage`, `agy_account`). Removed all specialized prompt modes. Added dynamic model detection (`src/model.ts`). Fixed `agy_image` temp dir isolation. 2026-05-23.
