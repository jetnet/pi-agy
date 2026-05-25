# Changelog

All notable changes to pi-agy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-25

### Added
- **Model selection** — new optional `model` parameter on `agy` and `agy_image`. Temporarily overrides the active model in agy's settings.json for a single call, then restores it. Case-insensitive matching against known model names.
- New `src/model-settings.ts` module: reads/writes `~/.gemini/antigravity-cli/settings.json`, validates against known model list, provides atomic swap+restore.
- **Keyring-aware account switching** — `backup` and `switch` now save/restore the OS keyring entry (`secret-tool`) in addition to files. This fixes account switching on Linux where agy authenticates via GNOME Keyring. Falls back to file-only when `secret-tool` is not available.
- **Quota exhaustion detection** — parses `RESOURCE_EXHAUSTED` from agy's log. When agy's print mode silently falls back to another model on quota exhaustion, the extension now returns `isError: true` with a clear message instead of the wrong model's response.
- **Account detection from agy log** — every agy call now captures `--log-file` and parses the real authenticated email from `applyAuthResult: email=...`. If `google_accounts.json` is stale (common after re-auth in the TUI), it's auto-updated. Falls back to the file if log parsing fails.
- **Session-scoped conversation continuation** — each pi session gets its own agy conversation. Gemini retains full prior context across `agy` and `agy_image` calls within the same session. Multiple pi sessions sharing a cwd are fully isolated.
- New `conversationId` parameter on `agy` and `agy_image`: pass a UUID to resume a specific conversation, `'new'` to force a fresh one, or omit to auto-continue (default).
- Conversation ID returned in `details.conversationId` on every response for explicit chaining.
- New `src/session.ts` module: maintains pi-session → agy-conversation mapping in `~/.pi/agy-sessions.json`. Discovers new conversation IDs from agy's cwd-keyed cache immediately after first call. Includes UUID validation and automatic pruning of stale entries on extension load.
- TUI render shows conversation ID prefix (`conv:e973694d`) in result metadata.

## [0.1.0] - 2026-05-20

### Added
- `agy_design` tool — generate UI components via Gemini Flash 3.5
- `agy_critique` tool — design/UX review of existing UI code
- `agy_image_to_ui` tool — mockup-to-component (best-effort via --add-dir)
- `agy_usage` tool — local request counter with soft-warn thresholds
- `agy_account` tool — switch Google accounts by swapping ~/.gemini/ state
- Local quota counter at `~/.pi/agy-usage.jsonl`
- Profile-based account management at `~/.pi/agy-accounts/`
