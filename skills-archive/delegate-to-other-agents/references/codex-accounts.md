# Codex multi-account rotation

Read when a Codex run fails with a quota or auth signature, or before placing a lane when more than one ChatGPT account is configured. Mechanics live in `scripts/codex-account.py`; decisions are yours.

## Is this block live?

- `scripts/codex-account.py list --json` exit 4 = no codex-switcher store (`~/.codex-switcher/accounts.json`) → single-account mode; skip this file.
- The store exists but no entry is `eligible` **and** `codex login status` reports a working login → the live login is not in the store. Treat as single-account mode: run lanes on it, and report "codex-switcher store has no eligible account; live login is unmanaged" once in the task summary. (This is the state of this machine as of 2026-10-05: one expired free-plan entry in the store, a Plus login outside it.)
- `next` exit 2 = no eligible alternate *right now* → stay in the pressure ladder below. `status` exit 5 = no usable snapshot → usage unknown, not healthy.

Commands: `status` (probe + record; exit 3 when hot: 5h ≥85% or weekly ≥95%), `list --json` (plans + last-known usage + flags + computed `eligible`), `switch <name>` / `next`, `mark <name> 5h|weekly|no-astra|auth-failed`, `clear <name>`.

## Placement

- Sol and Luna lanes → Plus accounts. Astra lanes → Pro accounts when one exists; a Plus account's Astra allowance is 5–45 messages per 5h against 15–160 for 6.1 Sol, so never spend a Plus pool on Astra while a Pro account is fresh.
- One quota pool per account; a heavier model drains it faster. Keep the strongest fresh account as reserve for urgent work — reserve one, not half the pool.

## Pick

From `list --json`: trust `eligible` + `effective` — the cache is reset-aware (an account observed hot before its window reset reports effectively fresh; expired flags drop off the `flags` map). Astra lanes require `eligible` **and** no `no-astra` flag — pick via `list --json` + `switch <name>`, never blind `next` (LRU-only, lane- and headroom-blind emergency rotation). `no-astra` accounts stay eligible for Sol/Luna. Prefer effective headroom; an account with no observations gets one low-risk dispatch to learn its state. Keep the ledger warm: run `status` after each Codex run and before picking when the ledger is cold. Probe only through real dispatches; **quota errors are authoritative** — on one, `mark` the account (`5h` or `weekly` per the error; weekly-capped stays excluded until the weekly reset) and `mark <name> no-astra` when Astra is not available there.

## Pressure ladder (in order)

1. Same model on another eligible account → `switch`.
2. None fresh → downgrade one model tier only if the lane's floor allows (Astra → 6.1 Sol; 6.1 Sol → Luna only for single-step lanes), then re-pick — a Plus account may now be optimal.
3. Floor blocks it → background work waits for the soonest reset; urgent work → Grok (deliberate overflow, not a failure).
4. API-key account only with explicit user spend authorization.
5. Then the §3 both-dead rule.

## Quota-death detection (deterministic, case-insensitive)

After any Codex failure, grep `$ERR` + `$OUT`:

- Quota signatures — `usage limit`, `rate limit`, `quota`, `429`, `too many requests`, `upgrade to continue` → `mark` the account (`weekly` if the message says weekly/plan, else `5h`; the mark self-expires at the window reset) and rotate.
- Auth signatures — `401`, `unauthorized`, `authentication failed`, `refresh.*failed` (never bare "token"/"login"; ordinary output contains them) → `mark <name> auth-failed`, rotate, and CONTINUE the ladder (other accounts → Grok). Report "account X needs re-login in codex-switcher" in the task summary and keep working. User confirms re-login (or Astra rollout) → `clear <name>` restores the account.
- No signature match → not quota; SKILL.md §5 failure policy.

## Recovery continuity

An account switch is always a **fresh run, never a resume** (sessions do not follow accounts). The fresh prompt = same frozen spec + current `git diff`/status + untracked list + "preserve the existing diff; implement only the remaining work — do not redo completed parts." The partial diff stays in the worktree; verify still compares against the original `BASE`.

## Safety

`switch`/`next` refuse (exit 6) while any `codex exec` run is live. A lane hitting quota while another lane is live: queue the rotation until lanes drain, or send the urgent retry to Grok now. `--force` only for guard false-positives, never past a real live lane. A long run crossing a reset is left alone — reroute the next attempt.
