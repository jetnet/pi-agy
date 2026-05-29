# Feature plan — Auto account rotation on quota/ban (429-class) errors

**Branch:** `feat/auto-switch-429`
**Status:** PLAN — direction LOCKED (see §11); awaiting plan review before implementation
**Author:** pi session 2026-05-29

**Locked decisions (2026-05-29):**
- **Rotation philosophy:** REACTIVE-ONLY — switch only when a call 429s. No
  proactive proportional pooling. (`requestsPerRotation` deferred.)
- **Pool source:** EXPLICIT CONFIG list in `~/.pi/agy-rotation.config.json`. No
  directory auto-discovery.
- **Build scope:** stop at this plan for review; implement in a follow-up session.
- **#7 model-settings fix:** CONFIRMED — `setModel(model, home)` resolves the
  settings path from the active account's HOME, not `os.homedir()`. (Writer = pi
  process with pi's HOME; reader = agy child with account HOME — they diverge
  unless setModel is told the account home.)
- **#8 `agy_account` status tool:** FAST-FOLLOW — not in the first cut. Core
  rotation ships and is tested first; observability tool follows in a quick
  second pass.
- **Implementation method:** sub-agent workflow — worker implements → reviewer
  audits for critical/high issues → back to worker → loop until no critical or
  high issues remain.
**Supersedes:** decision **M0-c** (`~/.pi/agy-accounts/` `~/.gemini` file-swap). The
`agy_account` tool it described is already gone (index.ts registers only
`agy`, `agy_image`, `agy_usage`). This feature replaces the switching
*mechanism* entirely.

---

## 1. Goal

When an `agy` call hits a quota/rate-limit (RESOURCE_EXHAUSTED / HTTP 429-class)
error, automatically rotate to another pre-authenticated Google account and
retry, **without** triggering Google's anti-bot WAF (which escalates abused
429s into permanent 403 ToS bans). Stay invisible: respect cooldowns, cap
daily volume, jitter retries, and globally back off if a ban is detected.

Source of best-practice constraints:
`tuxevil/pi-antigravity-rotator/QUOTA_AND_BANS_CHEATSHEET.md` (indexed this
session under source `quota-bans-cheatsheet`).

---

## 2. Switching mechanism (PROVEN by operator transcript)

agy has **no** account/home CLI flag (`agy --help` confirms: only `--print`,
`--conversation`, `--continue`, `--add-dir`, `--log-file`, `--print-timeout`).
The only lever is the **`HOME` environment variable** plus disabling the OS
keyring so agy falls back to file-based credentials:

```sh
export HOME=/home/jet/.ag-acp/accounts/<name>
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/ag-acp-no-keyring-main   # dead socket → keyring unavailable → file creds
agy --print "..."        # authenticates as <name>
```

- Each account = one HOME dir (operator's current dirs: `~/.ag-acp/accounts/dv`,
  `.../jn`). **Paths come from the explicit config list, not a directory scan.**
- Account **name = config entry name** (operator convention: matches dir basename;
  agy reports it, e.g. "Account Name: dv").
- Creds live at `$HOME/.gemini/antigravity-cli/antigravity-oauth-token` (mode
  0600), **not** the old `~/.gemini/oauth_creds.json` + `google_accounts.json`.
- The dead-socket DBUS address forces libsecret to fail → agy uses the on-disk
  token instead of the keyring. Value is a fixed constant in the operator's setup.
- **Pre-auth is a precondition.** This feature does NOT log accounts in; the
  user pre-authenticates each HOME dir once via the agy TUI.

**Injection point:** `spawnAgy()` in `src/execute.ts` already builds
`env: { ...process.env }`. We add `HOME` + `DBUS_SESSION_BUS_ADDRESS` overrides
from the selected account. Zero changes to agy itself.

---

## 3. Cheatsheet rules → hard requirements

| Cheatsheet rule | Our requirement |
|---|---|
| **429 = temporary.** Read cooldown, mark `EXHAUSTED`, rotate. Safe after cooldown. | On quota error: mark account EXHAUSTED with `cooldownUntil`, rotate to next AVAILABLE. |
| **403 ToS = permanent ban.** | Mark account `FLAGGED` (never auto-reused), require manual clear. |
| **Trigger A — Hammering.** Ignoring a 429 and re-hitting the *same* account escalates to a permanent 403 within minutes. | **NEVER retry the same account after a 429.** Retry only on a *different* AVAILABLE account. Respect `cooldownUntil` absolutely. |
| **403 → Protective Pause (default 6h)** across the whole pool to dodge the same WAF rules. | On any 403/ToS detection, set a **global** `pauseUntil = now + 6h`; all accounts blocked until then. |
| **Trigger B — ~200/day rule.** ~200 req/account/day triggers WAF bans even without hammering. | Track `requestsToday` per account; soft daily cap **80–100** (configurable, default 90). In reactive-only mode this is **advisory**: warn in `agy_account` status and surface a soft-warning on the call result when the active account passes the cap. No proactive redistribution. |
| **Capacity planning.** 80–100 req/acct/day. | Surface per-account daily counts in the status tool. |
| **Do not retry blindly.** When all exhausted, return cooldown payload; consumer must NOT loop. | When pool fully exhausted: return a clear `isError` with the soonest `cooldownUntil` ("all accounts exhausted, retry after Xs"). No internal busy-loop. |
| **Proportional pooling.** `requestsPerRotation` (default 5): distribute load, don't drain one account to 0 before switching. | **DEFERRED** (reactive-only chosen). One account is drained until it 429s, then we switch. The state model leaves room to enable this later without a rewrite. |
| Human-like pauses. | Add randomized **jitter** (e.g. 400–1200ms) before each cross-account retry; never machine-gun. |

**Tension with charter M0-d ("never refuse calls"):** that principle was about
the *local usage counter*, which must never block. Ban-protection is different:
hard-refusing only when *all* accounts are genuinely exhausted is what keeps the
pool alive. Soft caps deprioritize but don't refuse while any account is healthy.

---

## 4. The unproven leaf — SPIKE FIRST (blocker-class)

Per AGENTS.md ("prove the leaf node works, then build the tree"), the retry tree
must NOT be built until we confirm agy's log surface.

**Spike S0 — capture real error logs.** Before any retry code:
1. Run agy with `--log-file` on an account near/at quota; capture the log.
2. Confirm the exact string for a quota error. We already match
   `RESOURCE_EXHAUSTED` + `Individual quota reached` (see `parseLogInfo`).
3. Determine whether the log carries a **cooldown / Retry-After duration**. If
   yes → parse it. If no → fall back to a default cooldown (proposed 60s for
   per-minute limits, escalating; see §5).
4. Determine whether a **403 / PERMISSION_DENIED / ToS** error produces a
   *distinct* log string from a 429. If indistinguishable, we cannot safely
   auto-flag bans → degrade to "treat all quota/permission errors as EXHAUSTED
   with a long cooldown" and document the limitation.

**Outcome gates the design:**
- If 403 is distinguishable → full state machine (EXHAUSTED vs FLAGGED + 6h pause).
- If not → reduced machine (EXHAUSTED only), conservative long cooldowns, no
  permanent flag. Still safe, just less precise.

Spike script lives at `/tmp/pi-agy-429-spike.ts` (outside the repo, like the
existing e2e/p0 probes).

---

## 5. State model

New module `src/rotation.ts`. Health state persisted to
`~/.pi/agy-rotation-state.json` (mode 0600), survives across pi calls:

```jsonc
{
  "globalPauseUntil": 0,          // epoch ms; >now blocks the whole pool (403 protective pause)
  "current": "dv",                // last-used account
  "accounts": {
    "dv": {
      "status": "AVAILABLE",      // AVAILABLE | EXHAUSTED | FLAGGED
      "cooldownUntil": 0,         // epoch ms; EXHAUSTED accounts blocked until this
      "requestsToday": 12,
      "dayStamp": "2026-05-29",   // reset requestsToday when this rolls over
      "requestsSinceRotation": 3, // for proportional pooling
      "lastUsedMs": 1730000000000,
      "lastError": null
    }
  }
}
```

**Required config** `~/.pi/agy-rotation.config.json` (the pool is defined here —
no auto-discovery). `accounts` is mandatory; the rest are defaulted:

```jsonc
{
  "accounts": [                                   // REQUIRED, ordered = switch order
    { "name": "dv", "home": "/home/jet/.ag-acp/accounts/dv" },
    { "name": "jn", "home": "/home/jet/.ag-acp/accounts/jn" }
  ],
  "dbusAddress": "unix:path=/tmp/ag-acp-no-keyring-main",
  "dailySoftCap": 90,             // ~200 rule guardrail (advisory in reactive mode)
  "defaultCooldownSec": 60,       // when log carries no Retry-After
  "protectivePauseHours": 6,      // 403 global pause
  "jitterMs": [400, 1200]
}
```

- Each `accounts[]` entry: `name` (validated `/^[a-zA-Z0-9_-]+$/`) + absolute
  `home`. Optional per-entry `dailyCap` override allowed later.
- If the config is missing/empty → rotation is **off**; `agy` behaves exactly as
  today (single account, current `HOME`). Graceful degradation, zero surprise.

**Transitions**
- **success** → `requestsToday++`, `requestsSinceRotation++`, `lastUsedMs=now`,
  status stays AVAILABLE.
- **quota/429** → status=EXHAUSTED, `cooldownUntil = now + (parsed Retry-After ?? defaultCooldownSec)`. Rotate.
- **403/ToS** → status=FLAGGED (permanent), `globalPauseUntil = now + protectivePauseHours`. Abort retries, return ban error.
- **cooldown expiry** → lazily on selection: EXHAUSTED with `cooldownUntil <= now` → AVAILABLE.
- **day rollover** → `requestsToday=0` when `dayStamp != today`.

**Selection (`pickNextAccount`)** — reactive-only:
1. If `now < globalPauseUntil` → none (return pause error).
2. Candidates = config `accounts[]`, status≠FLAGGED, not in cooldown.
3. Order: keep using `current` while it is AVAILABLE (drain it); only move to the
   **next entry in config order** (wrapping) when `current` is EXHAUSTED/FLAGGED.
4. Soft cap is advisory: an over-cap but healthy account is still used (warn,
   don't refuse — a healthy-but-busy account beats a hard failure).
5. None available → return soonest `cooldownUntil` for the caller's info.

---

## 6. Retry flow (in `executeAgy` / `executeImage`)

```
state = loadState()
if globalPauseUntil > now: return banError(pauseUntil)

tried = new Set()
lastErr = null
for attempt in 0 .. (poolSize - 1):           # hard cap = pool size, never re-hit same account
    acct = pickNextAccount(state, exclude=tried)
    if !acct: return allExhaustedError(soonestCooldown)
    tried.add(acct)
    if attempt > 0: await sleep(jitter())      # human-like pause, only between retries
    result = spawnAgy(prompt, { homeDir: acct.home, dbusAddress, ... })
    cls = classify(result)                     # ok | quota | banned | otherError
    if cls == ok:        markSuccess; persist; return result
    if cls == quota:     markExhausted(acct, cooldown); lastErr=result; continue
    if cls == banned:    markFlagged(acct); setGlobalPause; persist; return banError
    else:                lastErr=result; break # non-quota failure: don't burn the pool
persist()
return lastErr ?? allExhaustedError()
```

- Retry budget = pool size (so 2 accounts → at most 1 reactive switch). Bounded,
  no infinite loop.
- `classify()` consumes the parsed log (`quotaError`, plus new `banError` field).

---

## 7. Files to touch

| File | Change |
|---|---|
| `src/rotation.ts` | **NEW.** Pool discovery, health state, persistence, selection, transitions. Pure-ish, unit-testable. |
| `src/execute.ts` | `spawnAgy` accepts `homeDir` + `dbusAddress`; inject into `env`. Extend `parseLogInfo` to classify ban vs quota + parse cooldown (per spike S0). |
| `src/types.ts` | Extend `SpawnAgyOptions` (homeDir, dbusAddress). Extend `SpawnAgyResult` (errorClass, cooldownSec). Add rotation types. |
| `src/tools/agy.ts`, `src/tools/image.ts` | Wrap `spawnAgy` in the rotation/retry loop. |
| `src/model-settings.ts` | `setModel()` must target the **active account's** `$HOME/.gemini/antigravity-cli/settings.json`, not `~/.gemini`. |
| `src/index.ts` | Update header comment. (New `agy_account` tool deferred to fast-follow.) |
| `src/schemas.ts` | Optional `account` param on `agy`/`agy_image` to pin one call. (`agy_account` params deferred.) |
| `~/.pi/agy-rotation-state.json` | Runtime state (0600). |
| `.pi-project/decisions.md` | New decisions: HOME-based rotation (supersede M0-c), cheatsheet guardrails, spike outcome. |
| `.pi-project/charter.md` | Update Scope: rotation in; note M0-c superseded. |
| `README.md`, `CHANGELOG.md` | Document rotation, config, pre-auth requirement. |

---

## 8. New `agy_account` tool (observability + manual control) — FAST-FOLLOW (not first cut)

Actions:
- `list` — discovered accounts + status + requestsToday + cooldown remaining.
- `status` — current account + global pause state.
- `clear-flag <name>` — manually un-FLAG a recovered account.
- `pin <name>` / `unpin` — force a specific account for subsequent calls.

(Read-only-ish; no secret material ever printed — only dir names + counters.)

---

## 9. Testing

1. **Spike S0** (gates everything) — capture real RESOURCE_EXHAUSTED (+403 if
   reproducible) logs; lock the regexes.
2. **State-machine unit tests** — pure functions: markExhausted/markFlagged,
   cooldown expiry, day rollover, selection skips FLAGGED + cooldowned, LRU
   choice, all-exhausted, global pause. No agy needed.
3. **Round-trip switch** — `dv` ↔ `jn` via the "introduce yourself with account
   name" probe (operator already did this manually; automate as smoke).
4. **No-hammer assertion** — simulate a quota result and assert the same account
   is never retried within the loop.
5. `npm run check` (biome + tsc) green.

---

## 10. Risks / open items

- **R1 (blocker):** agy log may not distinguish 403 from 429 or expose
  Retry-After. → SPIKE S0 first; degrade design if so.
- **R2:** DBUS dead-socket trick may behave differently when spawned from the
  Node process vs an interactive shell. → verify in spike (spawn agy with the
  env from Node, confirm correct account in `--print` output).
- **R3:** `settings.json` model-swap must move to the per-account HOME or model
  override silently no-ops / corrupts the wrong file.
- **R4:** Concurrency — charter forbids parallel multi-account; ensure state
  writes are serialized (single pi process; use atomic write + in-memory lock).
- **R5:** Crash between switch and persist → state file may lag. Atomic write
  (tmp+rename); reconcile from agy log's detected account on next call.

---

## 12. Shared session store for cross-account conversation continuity

**Problem.** The first cut suppresses `conversationId` on the rotation-ON path
(cross-account leak prevention), so every rotated call starts a FRESH agy
conversation — Gemini loses prior context. To restore auto-continue under
rotation, a conversation created under one account must be resumable under any
other account in the pool.

**Storage layout (verified 2026-05-29).** Under `$HOME/.gemini/antigravity-cli/`
a single conversation UUID spans THREE locations:
- `conversations/<uuid>.pb` — transcript (protobuf)
- `brain/<uuid>/` — per-conversation working state (what `pruneSessionMap` checks)
- `cache/last_conversations.json` — `cwd → uuid` pointer (first-call discovery)

**Two empirical findings:**
1. Conversations are **account-portable** — the `.pb` is account-agnostic
   (no email/token/account binding found via `strings`). agy replays the
   transcript locally; the active account's cred authenticates each call.
2. `installation_id` **differs per account** (a client fingerprint). Sharing it
   across accounts presents "one install, many accounts" to Google — an
   account-linking signal that the anti-abuse heuristics (see cheatsheet) may
   flag. **Must stay per-account.**

**Recommended mechanism — selective symlink.** Symlink ONLY `conversations/`
AND `brain/` (paired by UUID — share both) of each account HOME to one common
dir, e.g.:
```
~/.ag-acp/shared/conversations/   ← accounts/<name>/.gemini/antigravity-cli/conversations  (symlink)
~/.ag-acp/shared/brain/           ← accounts/<name>/.gemini/antigravity-cli/brain          (symlink)
```
Keep per-account (DO NOT share): `installation_id`, `antigravity-oauth-token`,
`settings.json`, `cache/`, `log/`, `keybindings.json`.

**Code changes required (these are NOT done in the first cut):**
1. Re-enable passing the pi-session's `conversationId` on the rotation-ON path
   (safe once storage is shared — any account can resolve the UUID).
2. Make `src/session.ts` discovery **HOME-aware**: it currently reads
   `cache/last_conversations.json` from Pi's HOME (`os.homedir()`), but under
   rotation agy writes it to the ACTIVE account's HOME. Discovery must read the
   selected account's cache. `BRAIN_DIR` (used by `pruneSessionMap`) must point
   at the shared brain dir.
3. Keep the in-process mutex; document the cross-process (multi-pi-session)
   same-UUID write race as a pre-existing limitation, unchanged by sharing.

**Who creates the symlinks — DECIDED (2026-05-29): pi-agy auto-manages (b).**
- (b) **pi-agy auto-manages** — at config load, idempotently ensure each
  account's `conversations`/`brain` are symlinks to the shared dir (migrating
  any existing real content into the shared dir first, never clobbering).
  Removes the "operator forgot to symlink" failure mode; self-heals when a new
  account is added. This is the implementation form of the fast-follow.
- (a) ~~Operator manual `ln -s` per account~~ — rejected: breaks silently when a
  new account is added without the symlink.

**Alternatives considered & rejected:**
- *Symlink the whole `antigravity-cli` dir* — shares `installation_id` (account
  fingerprint linkage). Rejected.
- *Pin each conversation to its origin account* — defeats rotation for active
  conversations (stuck on origin until it cools down). Rejected.
- *pi-agy replays the transcript in the prompt* — token cost balloons, hits
  prompt-size limits, reimplements `--conversation`. Rejected.

**SPIKE (pending, blocker for trusting this path):** cross-account resume is
*evidenced* (account-agnostic `.pb`) but not *proven live*. Verify: with
`conversations`+`brain` symlinked, create a conversation under `dv`, then resume
the same UUID under `jn` and confirm Gemini has the prior context. Burns ~2 agy
requests — bundle with the 2-account round-trip smoke (operator-run).

**Status:** documented; implementation deferred to the conversation-continuity
fast-follow (alongside `agy_account`). First cut keeps the safe behavior
(fresh conversation per rotated call).

---

## 11. Decisions — LOCKED (2026-05-29)

- **Q1 — Rotation philosophy:** ✅ **Reactive-only.** Switch only on a 429-class
  error. Proactive proportional pooling deferred (state model keeps the door open).
- **Q2 — Account pool source:** ✅ **Explicit config list** in
  `~/.pi/agy-rotation.config.json` (`accounts[]`). No directory auto-discovery.
- **Q3 — Build scope now:** ✅ **Stop for plan review.** Implementation (starting
  with spike S0) happens in a follow-up session once this doc is approved.

### Still to confirm during/after review
- Outcome of **spike S0** (§4) gates whether the 403/FLAGGED branch is full or
  reduced. Not a fork the operator needs to pre-answer — it's an empirical check.
- ~~Whether the new `agy_account` tool (§8) is in-scope for the first cut~~ →
  RESOLVED: fast-follow.
