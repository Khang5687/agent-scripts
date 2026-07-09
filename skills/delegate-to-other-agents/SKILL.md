---
name: delegate-to-other-agents
description: "Route implementation work to Codex CLI (or Grok as fallback/alternate); Claude specs, reviews, verifies."
---

# Codex First

Claude Code sessions only. Codex/other harnesses: skip; never self-delegate.

Rationale: Claude (Fable/Opus) tokens metered + expensive; Codex flat-rate. GPT-5.5+ is usually the better and faster model at writing/implementing code; Claude wins at ergonomics — judgment, design, spec-writing, review, orchestration. So Codex types, Claude thinks and verifies.

Grok CLI (`grok`, model `grok-4.5`) is a second flat-rate executor, same role as Codex: it types, Claude thinks and verifies. Use it two ways:

- **Fallback** — Codex run fails/errors with a usage-limit or quota message → resume the same task on Grok instead of stalling. Give Grok the same spec; if Codex had already made partial progress, tell Grok what's done and what's left (git diff/status is enough context, no need to replay history).
- **Free pick** — for a given task, pick per the executor table below, or split independent subtasks across both in parallel (separate repos/worktrees/dirs, like parallel Codex runs).

### Executor pick (firm rules, research-backed July 2026)

Evidence + update procedure (for "update codex-first skill" requests): `references/routing-evidence.md`.

| Task type | Executor |
|---|---|
| Simple bugfix, routine feature, prototyping, scoped refactor, greenfield build-out, high-volume bursts | **Grok 4.5** (fastest iteration + 4× token efficiency; Cursor-data real-workflow fit) |
| Bulk codebase exploration | **Grok 4.5** (token efficiency; 500k context) |
| Long autonomous runs (>30 min) | **Grok 4.5** (RL-trained stamina — old short-run weakness is fixed) or **Codex**, either fine |
| Test writing | **Codex** (Aider Polyglot lead) |
| CI/tooling; terminal/infra/computer-use | Either — near-tie (Terminal-Bench 83.4 vs 83.3); default Codex |
| Hardest delegable tasks where first-pass solve rate matters most | **Codex** (edges Grok on some hard harnesses; DeepSWE 1.1: 67 vs 53) |
| Exploration needing >500k context | **Codex** (Grok context ceiling, was 256k pre-4.5) |

Grok 4.5 (July 2026) is a co-default, not a fallback: it wins on throughput/cost for most routine-to-medium work; Codex wins on peak solve rate and tests. Fallback rule unchanged and now symmetric: quota/failure on one → resume the task on the other.

### Claude does it itself (don't delegate)

Beyond the existing "Keep in Claude" list, Claude (Fable/Opus) implements directly when the executor quality gap makes review-and-retry cycles cost more than just writing it:

- concurrency/race conditions; large cross-file changes needing global consistency
- migrations/large refactors where one-shot success matters (SWE-bench Pro gap: Fable 80% vs GPT-5.5 59%)
- API/architecture design bleeding into implementation; frontend/UX polish and creative engineering
- high-ambiguity tasks — if the spec can't be frozen, delegation fails anyway

Rough threshold: scoped, low-ambiguity, ≲2k LOC / a few files → delegate; big, ambiguous, or taste-sensitive → Claude.

Fable vs Opus (updated post re-release, July 2026): Fable's weights are unchanged but a broad safety classifier now silently reroutes flagged prompts (debugging, security-adjacent, dual-use-ish) to Opus 4.8 — you pay Fable rates for Opus output, and mid-task switches break autonomous runs. So: **Opus 4.8 is the default orchestrator/direct implementer**; reserve Fable for the hardest long-horizon/taste-sensitive work where its ceiling matters and the prompt is unlikely to trigger the classifier (pure feature/creative work, not debugging or security). Opus wins security review/auditing outright.

### Know which model YOU are (self-aware routing)

First step on any routing decision: check the harness-declared model in your environment context ("You are powered by the model named ..."). Trust that declaration only — never guess your identity from self-perception (models are unreliable at self-identifying). Then shift the routing bar:

| You are | Routing shift |
|---|---|
| **Fable 5** | Baseline rules as written. Do the hardest/taste-sensitive work yourself; delegate scoped work. |
| **Opus 4.8** | Same as Fable for orchestration; on the very hardest one-shot multi-file work (SWE Pro 69 vs Fable 80), consider a fable subagent instead of doing it directly. |
| **Sonnet 5** | Delegate MORE aggressively: your direct-impl bar drops to trivial/small edits; route medium+ implementation to Codex/Grok (GPT-5.5 and Grok 4.5 beat Sonnet on hard tasks), and spawn **opus** subagents for adversarial/security verification instead of self-reviewing. |
| **Haiku (any)** | Pure dispatcher: implement nothing non-trivial yourself; spec, delegate, and have an opus/sonnet subagent do the review. |

### Claude subagent tiers (spawn rules)

When Claude spawns subagents (Agent tool, `model:` param), pick the tier by task — subagents keep session tools/MCP, which Codex/Grok never get:

| Subagent task | Model |
|---|---|
| Bulk exploration/search; test writing; scoped impl from frozen spec; standard code review | **sonnet** (85–95% of Opus at ~1/5 cost; beats Opus on Terminal-Bench 80.4 vs 74.6) |
| Adversarial verification; security-adjacent review; deep/complex review; architecture drafts | **opus** (Sonnet is safeguard-weakened on exploit/cyber; Opus adds real depth) |
| Hardest long-horizon subagent runs, non-security-flavored | **fable** (highest ceiling, but classifier reroute risk — see above) |

Claude subagent vs external executor: spawn a Claude subagent when the task needs session tools (MCP/browser/secrets), tight multi-turn state, or Claude-family reasoning depth; delegate to Codex/Grok for high-volume, scoped, one-shot work where flat-rate economics dominate. Hybrid (Claude orchestrates, Sonnet workers, external executors for bulk typing) is the consensus quality-per-dollar pattern.

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
grok --no-alt-screen -m grok-4.5 --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P")" >/tmp/grok-last.md 2>/dev/null
```

- `--always-approve` is Grok's `--yolo` equivalent; `--no-alt-screen` keeps it script-friendly.
- Ignore stray `Failed to spawn MCP server 'pencil'` stderr noise — harmless, unrelated to the task (suppressed by `2>/dev/null` above anyway).
- Follow-up fixes: `grok -c --always-approve -p "$(cat "$P2")" --cwd <repo> --output-format plain >/tmp/grok-last.md 2>/dev/null` (`-c` continues the most recent session for that cwd; use `-r <id>` to target a specific one).
- long runs: same as Codex — Bash `run_in_background`, read the redirected file on exit.

## Parallelize

Parallelism buys wall-clock only; quality is protected by rules, not luck.

**Independence test (all three, else serial):**
1. No shared files between lanes.
2. No lane consumes another's output.
3. No lane establishes a convention the others must follow.

**Pilot-then-fan-out** — for N similar tasks (migrations, per-module repeats): run ONE serially, review it to full standard, freeze the reviewed diff as the template in every remaining spec, then fan out N−1 in parallel. Never fan out an unproven pattern.

**Isolation mechanics:** different repos → separate `--cwd`/`-C`. Same repo → one git worktree per lane (`git worktree add`), Claude merges after review. Separate output files per lane. Subagents mutating files in parallel → worktree isolation.

**Caps:** review is the bottleneck, not spawning — max 3–4 implementation lanes at once; each diff still gets full serial-strength review on landing. Exploration/review fan-out (read-only) has no such cap and often *raises* quality — diverse lenses catch what one pass misses.

**Failures:** one lane failing never blocks the others. Failed lane → fallback rule (other executor) or absorb into Claude. Merge conflict between lanes = the independence test was failed, not bad luck: stop fanning, take over integration directly.

## Plan first, delegate second

Never delegate a task you couldn't implement yourself. Before any executor prompt is written, Claude must have a concrete plan: read the relevant code, know which files change and roughly how, know the verification command, know the risks. The spec is the *output* of that plan — not a paraphrase of the user's request. Test: if the executor came back and asked "which approach?", you should already have the answer. If planning reveals you can't freeze the approach, that's the high-ambiguity signal — Claude does it itself (or does the design part itself, then delegates the frozen remainder).

Planning depth scales with risk: trivial/mechanical tasks (known repro, dep bump, tiny scoped edit) need only the repro + verification command; medium+ tasks need the full bar — code read, files known, approach frozen.

The bar is model-relative — if you (per the self-aware table) are a weaker tier and can't honestly meet it for this task, don't lower the bar and don't fire the spec anyway: spawn a stronger subagent (opus/fable) to do the planning or diff review, and dispatch from its plan. Weak orchestrator + strong planner + flat-rate executor is still cheaper than a strong model doing everything. If the stronger tier can't be spawned (quota/limits), walk down the chain (fable → opus → sonnet); if no available tier meets the bar, halt and report to the user — never ship a spec or accept a diff nobody understood. Both external executors dry → Claude (or a capable subagent) implements directly, same halt rule if none can.

Cheap exception: bulk exploration/read-only recon may be delegated *as* the planning step — its output feeds Claude's plan, nothing mutates.

## Prompt contract

Codex/Grok both start with zero session context. Every prompt: goal, exact repo/paths, constraints, non-goals, proof expected (exact test command), output shape ("report files changed + test output"). Spec quality decides success.

## Verify (Claude, always)

- `git status -sb` + read the full diff; judge like a contributor PR
- run focused tests yourself or demand proof output; executor claims (Codex or Grok) are advisory
- iterate via resume; after 2 failed rounds, take over and do it directly
- normal closeout still applies: `$autoreview` before ship

## Economics

Win = generation + exploration tokens moved to Codex; Claude spends only on spec + diff review. Don't ping-pong trivia through delegation; don't re-read what Codex already summarized.
