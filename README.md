# pi-agy

Pi extension that wraps Google's Antigravity CLI (`agy`) as native LLM-callable tools. Opus delegates tasks to Gemini Flash without thinking about CLI flags, model selection, or account state.

## Requirements

- `agy` on PATH (Google Antigravity CLI)
- Logged in once via `agy` TUI (OAuth)
- Model selected via `agy` TUI `/model` (inherited by all `-p` calls)

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["../../src/pi-agy"]
}
```

Or symlink into the global extensions directory:

```bash
ln -s ~/src/pi-agy ~/.pi/agent/extensions/pi-agy
```

Then `/reload` in Pi or start a new session.

## Tools

### `agy`

Send any prompt to Gemini. Write it however you like — nothing is added by the extension.

```
prompt:          "You are a senior security engineer. Review this code for injection vulnerabilities..."
contextFiles:    ["src/auth.ts", "src/middleware.ts"]   # 1–3 targeted files, injected as <file> blocks
contextDir:      "src"                                  # whole directory via --add-dir, no size limit
timeoutSec:      240                                    # always set explicitly — see Timeout guidance below
conversationId:  "e973694d-85e4-..."                     # optional: resume a specific conversation
```

**`contextFiles` vs `contextDir`**

| | `contextFiles` | `contextDir` |
|---|---|---|
| Mechanism | file contents inlined in prompt via stdin | `--add-dir` → agy workspace |
| Size limit | none (stdin, not argv) | none |
| Use for | 1–3 targeted files | whole dirs, many files |

### `agy_image`

Send a prompt + image file to Gemini (PNG, JPG, WebP, GIF).

```
imagePath:  "screenshots/mockup.png"
prompt:     "Convert this to a React + Tailwind component"
timeoutSec: 120   # optional, default 120
```

The image is copied to an isolated temp directory before passing to agy, so only the target file is exposed to Gemini.

Also supports `conversationId` for continuing a prior conversation.

### `agy_usage`

Show the local call counter.

```
window:  "today" | "week" | "month" | "all"   # optional, default "week"
account: "work"                                # optional, filter by profile
```

Soft-warns at 50 calls/day or 200/week. Never blocks calls. Counter is local only — does not reflect Google's server-side quota.

### `agy_account`

Manage Google accounts by swapping `~/.gemini/` credentials.

```
action:  "list" | "current" | "backup" | "switch"
profile: "work"   # required for backup/switch
```

Always back up before the first switch:
```
action: backup  profile: work
action: backup  profile: personal
action: switch  profile: work
```

## Conversation continuation

Each pi session gets its own agy conversation. Gemini retains full context from prior `agy` and `agy_image` calls within the same session — no need to re-explain what you're working on.

Multiple pi sessions sharing the same working directory are fully isolated: each talks to its own Gemini conversation.

| `conversationId` | Behavior |
|---|---|
| _(omitted)_ | Auto-continue this pi session's conversation |
| `"<uuid>"` | Resume a specific conversation by ID |
| `"new"` | Force a fresh conversation (no prior context) |

The conversation UUID is returned in `details.conversationId` on every response, so you can store it and pass it back later.

### New session (no mapping yet)

```mermaid
sequenceDiagram
    participant Pi as Pi (Opus)
    participant Ext as pi-agy
    participant Map as agy-sessions.json
    participant Agy as agy CLI
    participant Cache as last_conversations.json

    Pi->>Ext: agy(prompt)
    Ext->>Map: lookup piSessionId
    Map-->>Ext: (not found)
    Ext->>Agy: spawn agy (no --conversation)
    Agy-->>Ext: response text
    Ext->>Cache: read cwd → agyConvId
    Cache-->>Ext: "a1b2c3d4-..."
    Ext->>Map: store piSessionId → "a1b2c3d4-..."
    Ext-->>Pi: response + details.conversationId
```

### Continue (mapping exists)

```mermaid
sequenceDiagram
    participant Pi as Pi (Opus)
    participant Ext as pi-agy
    participant Map as agy-sessions.json
    participant Agy as agy CLI

    Pi->>Ext: agy(prompt)
    Ext->>Map: lookup piSessionId
    Map-->>Ext: "a1b2c3d4-..."
    Ext->>Agy: spawn agy --conversation a1b2c3d4-...
    Note right of Agy: Gemini has full<br/>prior context
    Agy-->>Ext: response text
    Ext-->>Pi: response + details.conversationId
```

The mapping in `~/.pi/agy-sessions.json` survives pi restarts, so resumed sessions pick up where they left off. Stale entries are pruned on extension load.

## Timeout guidance

Always set `timeoutSec` explicitly — the default (120s) is only safe for simple one-shot questions.

**Estimate:** `120 + (files × 15)` seconds, then double for deep analysis tasks.

| Task | Files | Estimate |
|------|-------|----------|
| Quick question | 0 | 120s |
| Small code review | 3 | ~165s |
| Security audit, 10 files | 10 | ~420s |
| Full directory audit | 20+ | 600s+ |

> **agy FREE / PRO tiers can be 3–5× slower.** When in doubt, be generous — agy returns as soon as it's done regardless of the timeout value.

## Limitations

- **Model selection** — `agy -m` is silently ignored in agy 1.0.0. Set the model once via `agy` TUI `/model`. The extension detects the active model via a one-time probe on first call per session.
- **No streaming** — `agy -p` returns output only on completion.
- **Image generation** — not supported; `agy -p` is text-only.
- **Running agy sessions** — retain their loaded credentials until restarted after an account switch.
- **Conversation auto-continue** — session mapping relies on `~/.pi/agy-sessions.json` (pi→agy) and `~/.gemini/antigravity-cli/cache/last_conversations.json` (first-call discovery). If either is unavailable, each call starts a fresh conversation (graceful degradation).

## Development

```bash
npm run check   # biome lint + tsc --noEmit
```

No build step — Pi loads `.ts` source directly.
