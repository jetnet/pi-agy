# Changelog

All notable changes to pi-agy will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-25

### Added
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
