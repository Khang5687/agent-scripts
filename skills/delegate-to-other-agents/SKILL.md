---
name: delegate-to-other-agents
description: "Route implementation work to Codex CLI (or Grok as fallback/alternate); Claude specs, reviews, verifies."
---

# Codex First

Claude Code sessions only. Codex/other harnesses: skip; never self-delegate.

Rationale: Claude (Fable/Opus) tokens metered + expensive; Codex flat-rate. GPT-5.5+ is usually the better and faster model at writing/implementing code; Claude wins at ergonomics — judgment, design, spec-writing, review, orchestration. So Codex types, Claude thinks and verifies.

Grok CLI (`grok`, model `grok-composer-2.5-fast`) is a second flat-rate executor, same role as Codex: it types, Claude thinks and verifies. Use it two ways:

- **Fallback** — Codex run fails/errors with a usage-limit or quota message → resume the same task on Grok instead of stalling. Give Grok the same spec; if Codex had already made partial progress, tell Grok what's done and what's left (git diff/status is enough context, no need to replay history).
- **Free pick** — for a given task, pick per the executor table below, or split independent subtasks across both in parallel (separate repos/worktrees/dirs, like parallel Codex runs).

### Executor pick (firm rules, research-backed July 2026)

Evidence + update procedure (for "update codex-first skill" requests): `references/routing-evidence.md`.

| Task type | Executor |
|---|---|
| Test writing; CI/tooling; terminal/infra/computer-use; anything long-autonomous (>30 min) | **Codex** (Terminal-Bench + Aider lead; determined runs) |
| Simple bugfix, routine feature, rapid prototyping, scoped refactor, high-volume bursts | **Grok** (fastest iteration; quality gap irrelevant at this size) |
| Bulk exploration needing >256k context | **Codex** (Grok context ceiling) |
| Everything else delegable | **Codex** (default) |

Grok is a real first pick for small routine work, not just fallback — but avoid it for long autonomous runs and complex multi-file tasks (short-run stamina, lower peak quality). Fallback rule unchanged: Codex quota/failure → resume on Grok.

### Claude does it itself (don't delegate)

Beyond the existing "Keep in Claude" list, Claude (Fable/Opus) implements directly when the executor quality gap makes review-and-retry cycles cost more than just writing it:

- concurrency/race conditions; large cross-file changes needing global consistency
- migrations/large refactors where one-shot success matters (SWE-bench Pro gap: Fable 80% vs GPT-5.5 59%)
- API/architecture design bleeding into implementation; frontend/UX polish and creative engineering
- high-ambiguity tasks — if the spec can't be frozen, delegation fails anyway

Rough threshold: scoped, low-ambiguity, ≲2k LOC / a few files → delegate; big, ambiguous, or taste-sensitive → Claude.

Fable vs Opus: Fable for the hardest/longest/taste-sensitive work; Opus as the cheaper executor for routine-to-medium Claude-side work, or when Fable safety-refuses (common on security-adjacent tasks — Opus wins security review/auditing outright).

Everything else in this skill (route table, prompt contract, verify obligations, economics) applies identically regardless of which executor runs the work.

## Route

Delegate to Codex (default for hands-on work):

- implementation from a frozen spec; refactors; mechanical migrations
- bug fixes with known repro; test writing; coverage fills
- CI fixes, dependency bumps, scripts/tooling
- bulk codebase exploration where raw reading ≫ the answer

Keep in Claude:

- design, API design, architecture, naming, UX judgment
- tasks where writing the spec IS the work (ambiguity = design)
- tiny edits (~<20 lines, single obvious change) — delegation overhead loses
- anything needing session tools: MCP (browser/computer-use/chronicle), 1Password, secrets
- destructive/irreversible ops, releases, pushes, GitHub mutations — Claude-side per git rules
- review of Codex output — never delegated, never skipped

Mixed task: Claude designs first, freezes spec, delegates build-out.
Heuristic: prompt reads as a work order → delegate; writing it forces decisions → design, Claude.
Portfolio/multi-repo work: `$maintainer-orchestrator` instead.

## Invoke

Prompt via temp file, never inline quoting:

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<goal, repo + key paths, constraints ("don't touch X"), non-goals, proof expected, output shape>
EOF
command codex exec --yolo -C <repo> \
  -c model_reasoning_effort="high" \
  -o /tmp/codex-last.md - <"$P" 2>/dev/null
```

- `--yolo` is the house default; Codex may run commands/tests freely. Keep prompts scoped to the target repo.
- `command codex` bypasses the interactive zsh wrapper; if not on PATH: `fnm exec --using default -- codex`
- stderr suppressed (thinking noise bloats context); drop `2>/dev/null` only to debug a failing run
- read `-o` file for the result; don't parse the JSONL stream
- long runs: Bash run_in_background, read `-o` file on exit; don't kill quiet runs <30 min
- parallel independent tasks OK: separate repos/dirs, separate `-o` files
- outside a git repo add `--skip-git-repo-check`

Follow-up fixes — cheaper than fresh runs, keeps context. `resume` has no `-C`/`--yolo`: run from the repo dir, spell the long flag:

```bash
(cd <repo> && command codex exec resume --last \
  --dangerously-bypass-approvals-and-sandbox \
  -o /tmp/codex-last.md - <"$P2" 2>/dev/null)
```

## Invoke (Grok)

Same prompt-via-temp-file discipline as Codex. Grok has no `-o` file flag; redirect stdout instead.

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<same spec contract as the Codex prompt below>
EOF
grok --no-alt-screen -m grok-composer-2.5-fast --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P")" >/tmp/grok-last.md 2>/dev/null
```

- `--always-approve` is Grok's `--yolo` equivalent; `--no-alt-screen` keeps it script-friendly.
- Ignore stray `Failed to spawn MCP server 'pencil'` stderr noise — harmless, unrelated to the task (suppressed by `2>/dev/null` above anyway).
- Follow-up fixes: `grok -c --always-approve -p "$(cat "$P2")" --cwd <repo> --output-format plain >/tmp/grok-last.md 2>/dev/null` (`-c` continues the most recent session for that cwd; use `-r <id>` to target a specific one).
- long runs: same as Codex — Bash `run_in_background`, read the redirected file on exit.

## Prompt contract

Codex/Grok both start with zero session context. Every prompt: goal, exact repo/paths, constraints, non-goals, proof expected (exact test command), output shape ("report files changed + test output"). Spec quality decides success.

## Verify (Claude, always)

- `git status -sb` + read the full diff; judge like a contributor PR
- run focused tests yourself or demand proof output; executor claims (Codex or Grok) are advisory
- iterate via resume; after 2 failed rounds, take over and do it directly
- normal closeout still applies: `$autoreview` before ship

## Economics

Win = generation + exploration tokens moved to Codex; Claude spends only on spec + diff review. Don't ping-pong trivia through delegation; don't re-read what Codex already summarized.
