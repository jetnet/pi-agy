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
prompt:        "You are a senior security engineer. Review this code for injection vulnerabilities..."
contextFiles:  ["src/auth.ts", "src/middleware.ts"]   # 1–3 targeted files, injected as <file> blocks
contextDir:    "src"                                   # whole directory via --add-dir, no size limit
timeoutSec:    240                                     # always set explicitly — see Timeout guidance below
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

## Development

```bash
npm run check   # biome lint + tsc --noEmit
```

No build step — Pi loads `.ts` source directly.
