# pi-agy

Pi extension that wraps Google's Antigravity CLI (`agy`) as native LLM-callable tools. Opus delegates tasks to Gemini Flash without thinking about CLI flags, model selection, or account state.

## Requirements

- **Linux or macOS** (Windows is not supported — see [Limitations](#limitations))
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
model:           "Gemini 3.1 Pro (High)"                   # optional: override model for this call
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
model:      "Gemini 3.1 Pro (High)"  # optional
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

### Account detection

agy authenticates via the OS keyring and doesn't always update `google_accounts.json` (e.g. after re-authenticating in the TUI). The extension detects the real authenticated email by parsing agy's `--log-file` output after every call (`applyAuthResult: email=...`). If the detected email differs from `google_accounts.json`, the file is updated automatically. To switch accounts, re-authenticate in the agy TUI (`agy` → `/login`).

## Model selection

Pass `model` to override the active model for a single call:

```
model: "Gemini 3.1 Pro (High)"
```

Available models (exact names from the agy TUI):

| Model | Notes |
|---|---|
| Gemini 3.5 Flash (High) | Default if not changed |
| Gemini 3.5 Flash (Medium) | |
| Gemini 3.5 Flash (Low) | |
| Gemini 3.1 Pro (High) | |
| Gemini 3.1 Pro (Low) | |
| Claude Sonnet 4.6 (Thinking) | |
| Claude Opus 4.6 (Thinking) | |
| GPT-OSS 120B (Medium) | |

The override is temporary — the original model is restored after the call. Running interactive agy sessions are unaffected (they read settings once on startup).

### How model switching works

agy has no `--model` CLI flag and no environment variable override. The active model is stored in `~/.gemini/antigravity-cli/settings.json`:

```json
{ "model": "Gemini 3.5 Flash (High)" }
```

```mermaid
sequenceDiagram
    participant Pi as Pi (Opus)
    participant Ext as pi-agy
    participant Cfg as settings.json
    participant Agy as agy CLI

    Pi->>Ext: agy(prompt, model="Gemini 3.1 Pro (High)")
    Ext->>Cfg: read current model
    Cfg-->>Ext: "Gemini 3.5 Flash (High)"
    Ext->>Cfg: write "Gemini 3.1 Pro (High)"
    Ext->>Agy: spawn agy (reads settings.json on startup)
    Agy-->>Ext: response
    Ext->>Cfg: restore "Gemini 3.5 Flash (High)"
    Ext-->>Pi: response
```

If the requested model's quota is exhausted, agy's print mode silently falls back to another model instead of erroring. The extension detects this by parsing `RESOURCE_EXHAUSTED` from agy's `--log-file` and returns `isError: true`:

```
⚠ Quota exhausted for Claude Sonnet 4.6 (Thinking): Individual quota reached
```

**Known limitation:** if Pi crashes between the settings swap and the restore, `settings.json` retains the overridden model. The next agy call (or TUI session) will use that model until manually changed via `/model`.

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
    Note right of Agy: Gemini has full prior context
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

- **Windows** — not supported. The extension uses `which` for CLI discovery and Unix-style paths (`~/.local/bin/agy`). Contributions welcome.
- **Model selection** — agy has no `--model` CLI flag. The extension swaps `~/.gemini/antigravity-cli/settings.json` before each call and restores it after. If pi crashes mid-call, the settings file may retain the overridden model.
- **No streaming** — `agy -p` returns output only on completion.
- **Image generation** — not supported; `agy -p` is text-only.
- **Conversation auto-continue** — session mapping relies on `~/.pi/agy-sessions.json` (pi→agy) and `~/.gemini/antigravity-cli/cache/last_conversations.json` (first-call discovery). If either is unavailable, each call starts a fresh conversation (graceful degradation).

## Development

```bash
npm run check   # biome lint + tsc --noEmit
```

No build step — Pi loads `.ts` source directly.
