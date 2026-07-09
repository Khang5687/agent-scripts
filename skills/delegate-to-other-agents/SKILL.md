---
name: delegate-to-other-agents
description: "Route implementation work to flat-rate executors (Codex CLI, Grok CLI) or Claude subagents; Claude specs, reviews, verifies."
---

# Delegate to Executors

Claude Code sessions only. Codex/other harnesses: skip; never self-delegate.

Claude tokens are metered; Codex CLI (GPT-5.5) and Grok CLI (grok-4.5) are flat-rate and good enough for scoped work. Claude's edge — judgment, design, spec-writing, review, hard multi-file work — is reserved for where it pays. Executors type; Claude thinks and verifies.

Evidence + update procedure (for "update this skill" requests): `references/routing-evidence.md`. Rules here are firm verdicts; benchmark numbers live there.

## 1. Know your model

Check the harness-declared model in your environment context ("You are powered by the model named ..."). Trust only that declaration — never self-perception. No trusted declaration → follow the Opus row, and when in doubt on review, spawn rather than self-accept.

| You are | Shift |
|---|---|
| **Fable 5** | Baseline rules. Do the hardest/taste-sensitive work yourself. |
| **Opus 4.8** | Same; optional fable subagent for pure-feature multi-file ceiling work (never debug/security-flavored). |
| **Sonnet 5** | Delegate more: direct-impl bar drops to trivial edits; medium+ implementation → executors; spawn opus for adversarial/security review. |
| **Haiku** | Pure dispatcher: implement nothing non-trivial; spawn opus/sonnet for planning and review. |

## 2. Keep or delegate?

Ordered checks — stop at the first hit:

1. **Keep in Claude**: needs session tools (MCP/browser/1Password/secrets — main session or Claude subagent, never an executor); remote mutations (push/release/GitHub) per git rules; design/API/architecture/naming/UX judgment; tiny edits (<20 lines); review of executor output.
2. **Plan first.** Never ship a spec or accept a diff nobody understood. Before any executor prompt, you (or a stronger spawned tier) must hold a concrete plan: files that change, approach, verification command. Depth scales with risk — trivial/mechanical needs only repro + verify command; medium+ needs the full bar. Can't meet the bar at your tier → spawn a stronger tier (opus, or fable if classifier-safe) to plan/review and dispatch from its plan; unavailable → walk down the chain; no tier meets it → halt and report. Plan can't be frozen at all → Claude does it (or designs, freezes, delegates the remainder).
3. **Delegate** when scoped, low-ambiguity, ≲2k LOC, and free of global invariants / concurrency / taste-sensitive polish — those stay with Claude even under 2k LOC.

Mixed task: Claude designs first, freezes spec, delegates build-out. Heuristic: prompt reads as a work order → delegate; writing it forces decisions → design, Claude. Portfolio/multi-repo work: `$maintainer-orchestrator` (if available).

## 3. Executor pick

| Task | Executor |
|---|---|
| Routine implementation: bugfix w/ repro, feature, prototyping, scoped refactor, greenfield, high-volume bursts | **Grok** (throughput/cost) |
| Bulk codebase exploration | **Grok** (500k context; beyond that, chunk by path globs) |
| Test writing | **Codex** (unless tests need session fixtures/MCP → sonnet subagent) |
| CI/tooling; terminal/infra | **Codex** |
| Hardest delegable work where first-pass solve rate matters | **Codex** (peak solve rate) |

Quota/failure on either → **restart** on the other: same spec, plus git diff/status as done/remaining context. Long autonomous runs (>30 min): either, in background.

## 4. Claude subagents

Spawn (Agent tool, `model:`) when the task needs session tools, tight multi-turn state, or Claude reasoning depth; use executors for high-volume scoped one-shots.

| Subagent task | Model |
|---|---|
| Bulk exploration/search; scoped impl from frozen spec; standard review | **sonnet** |
| Adversarial verification; security-adjacent/deep review; architecture drafts | **opus** |
| Hardest long-horizon runs — pure feature/creative only | **fable** (avoid debugging, security/auth, dual-use-adjacent prompts: classifier reroutes to Opus and breaks runs) |

**Review policy (sole statement):** executor output is reviewed by Claude-family only — never by an external executor, never skipped. Self-review only when your tier ≥ the required tier for that review class; Sonnet/Haiku never self-accept adversarial/security review — spawn opus.

## 5. Invoke

Executors start with zero session context. Spec = goal, exact repo/paths, constraints, non-goals, proof expected, output shape. Proof = exact verification command; no-run is acceptable only for docs/comment/rename changes with listed paths. Every prompt must include: "do not push, release, tag, or mutate remote state unless this prompt explicitly authorizes it."

Codex — prompt via temp file, never inline quoting:

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<spec>
EOF
command codex exec --yolo -C <repo> \
  -c model_reasoning_effort="high" \
  -o /tmp/codex-last.md - <"$P" 2>/dev/null
```

- `command codex` bypasses the zsh wrapper; not on PATH → `fnm exec --using default -- codex`. Outside a git repo add `--skip-git-repo-check`.
- House model is GPT-5.5 — if the CLI default drifts, pin explicitly (`-c model=...`).
- stderr suppressed (thinking noise); read the `-o` file, not the stream. Long runs: run_in_background; don't kill quiet runs <30 min.

Codex follow-ups (`resume` has no `-C`/`--yolo`):

```bash
(cd <repo> && command codex exec resume --last \
  --dangerously-bypass-approvals-and-sandbox \
  -o /tmp/codex-last.md - <"$P2" 2>/dev/null)
```

Grok — no `-o` flag (redirect stdout); no stdin prompt, so `$(cat)` is the unavoidable exception to the never-inline rule (keep specs well under ARG_MAX):

```bash
grok --no-alt-screen -m grok-4.5 --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P")" >/tmp/grok-last.md 2>/dev/null
```

Grok follow-ups: `grok -c ...` (continues the most recent session for that cwd; `-r <id>` targets one).

Resume rules: resume only the same executor in the same repo. `--last`/`-c` only when exactly one recent session exists there; after parallel/interleaved runs, resume by explicit session id or start fresh with git diff/status. Cross-executor is always a fresh run.

## 6. Parallelize

Independence test (all three, else serial): no shared files; no lane consumes another's output; no lane sets a convention others must follow.

Pilot-then-fan-out for N similar tasks: run ONE serially, review to full standard, freeze the reviewed diff as the template in every remaining spec, then fan out N−1. Never fan out an unproven pattern.

Isolation: different repos → separate `--cwd`/`-C`. Same repo → one git worktree per lane (serialize instead if project rules forbid worktrees); Claude merges after review. Separate output files per lane.

Caps: review is the bottleneck — max 3–4 implementation lanes; every diff still gets full review on landing. Read-only fan-out (exploration, multi-lens review) is uncapped and often raises quality.

Failures: one lane never blocks the others; failed lane → other executor or absorb into Claude. Merge conflict between lanes = the independence test failed: stop fanning, integrate directly.

## 7. Verify (always)

- `git status -sb` + read the full diff; judge like a contributor PR.
- Run focused verification yourself when feasible; executor claims are advisory.
- Failed round = an attempt whose diff fails verify (tests fail or review rejects). Quota/error switches don't count; the counter never resets across executors. After 2 failed rounds: takeover by max(your tier, opus if spawnable) per the model table; none available → halt and report.
- Don't ping-pong trivia through delegation; don't re-explore what the executor already summarized — still read the full diff.
- Closeout: `$autoreview` before ship (if available).
