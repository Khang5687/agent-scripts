---
name: delegate-to-other-agents
description: "Route implementation work to flat-rate executors (Codex CLI, Grok CLI) or Claude subagents; Claude specs, reviews, verifies. Use when the user says delegate, hand this to Codex/Grok, spawn a subagent, or asks which model should do a task."
---

# Delegate to Executors

Claude-powered orchestrator sessions only (Claude Code, omp). Running inside Codex or Grok: skip; never self-delegate.

Metered Claude: design, plan, review, verify, judgment/taste/global work. Flat-rate executors: Codex CLI — GPT-6.1 Sol default, GPT-6 Luna cheap lane, GPT-6 Astra escalation (allowance-rationed) — for scoped implementation; Grok CLI (grok-4.7) as overflow.

Firm rules below. Benchmarks + update procedure: `references/routing-evidence.md` (read only when updating this skill; evidence goes stale after ~30 days or any model/pricing/access change — suggest an update run then).

## 1. Know your model

Check the harness-declared model in your environment context (Claude Code: "You are powered by the model named …"; omp: the `Model:` line of the workstation block). Trust only that declaration — never self-perception. No trusted declaration → follow the Sonnet row (over-delegation is cheap; an unidentified weak model doing the hardest work is not).

Tier order (high→low): fable > opus > sonnet > haiku. Current models: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5 — the aliases `fable`/`opus`/`sonnet`/`haiku` resolve to these on the Anthropic API (Claude Code ≥ 2.1.284).

| You are | Shift |
|---|---|
| **Fable 5.1** | Baseline for multi-day, ambiguous, or taste-ceiling work. Routine multi-file implementation that §2 keeps in Claude → spawn opus (equal quality on every independent coding board, 40% of the price). Safeguard fallback is visible and narrow (§4); debugging and refactor do not trip it. |
| **Opus 5.5** | Baseline — the default orchestrator. Fable subagent only for multi-day/research-grade runs or when your own `xhigh` attempt falls short. Thinking tops out at `xhigh`; `max` over-thinks to the output cap. |
| **Sonnet 5.5** | Near-opus implementer: self-implement scoped medium work when executors are down; open-ended judgment and adversarial review → spawn opus. |
| **Haiku 4.5** | Pure dispatcher: implement nothing non-trivial; spawn opus/sonnet for planning and review. |

## 2. Keep or delegate?

**Explicit-invocation override**: if the user invoked this skill by name or said "delegate this", they have decided to delegate — cost arguments ("too expensive", "faster myself", tiny-edit overhead, metered-vs-flat-rate) never refuse it. Cost informs *which* model/executor (§1, §3), never *whether* to obey. Only the safety keeps in step 1 still apply (session tools/secrets, remote mutations) plus the plan-must-be-freezable rule (step 2); if none block it, delegate. Absent an explicit invocation, run the full judgment below.

1. **Keep in Claude** if any (stop here): implementation itself needs session tools (MCP/browser/1Password/secrets — main session or Claude subagent, never an executor; tool-based *verification* doesn't count — Claude verifies regardless); unresolved design/API/architecture/naming/UX judgment; risk content — auth/security/privacy, data-loss/migration, invariants spanning unrelated modules (ordinary multi-file changes under a frozen spec remain delegable), concurrency, taste-sensitive polish (even when small; sonnet/opus do it well); tiny edits (<20 lines, single obvious change — do directly at any tier; delegation latency loses); review of executor output. Remote mutations (push/release/GitHub): Claude performs the mutation step itself in the main session — the implementation portion still enters step 2.
2. **Else plan** (mandatory step, not a verdict): files that change, approach, verification (trivial tasks: repro + verify command only). **Frozen** = goal, exact files/areas, non-goals, no unresolved design decisions, and the required verification commands (or one concrete manual check). Read-only recon may be delegated before the freeze (spec: "do not edit files"); judgments and the freeze stay Claude-side. Plan unfreezable → keep designing in Claude until freezable, or Claude implements — an unfrozen plan is never delegated. Can't plan at your tier → spawn stronger (§4) to plan *only* — the frozen plan returns to you; the main session always owns dispatch, verify, and counters. No tier available can plan → halt and report.
3. **Then delegate** if the plan is frozen and the work is scoped, low-ambiguity, and expected *behavior-changing* diff ≲2k LOC (exclude generated/formatting-only output; estimate from the frozen plan; read-only exploration exempt; uncertain and near the boundary → keep in Claude). Mid-run or post-diff clearly ≫2k, or unforeseen global coupling appears → stop the executor (this overrides the quiet-run grace; preserve its diff) and re-enter here. Otherwise Claude implements.

Mixed task: Claude designs first, freezes spec, delegates build-out. Portfolio/multi-repo: `$maintainer-orchestrator` if available; else one frozen plan, serial per-repo runs.

## 3. Executor pick

User names an executor → prefer it; user says "only"/"exclusively" → that executor or halt, never auto-switch. Else: first matching row wins.

| Task | Executor |
|---|---|
| Multi-step or near-size-band test work | **Codex 6.1 Sol** |
| Small single-step test writing | **Codex Luna** (tests need session fixtures/MCP → sonnet subagent) |
| CI/tooling; terminal/infra | **Codex 6.1 Sol** — never Luna (leaves multi-step chains incomplete) |
| Top of the size band (near 2k LOC, multi-file) | **Codex Astra** when its allowance permits (Plus: 5–45 messages/5h), with explicit non-goal fences (`references/spec.md`); else **6.1 Sol** |
| High-volume bursts of small scoped one-shots | **Codex Luna** |
| Bulk read-only exploration | **Codex 6.1 Sol** (1M context); cheapest: Luna (272k; chunk by path globs) |
| Routine implementation: bugfix w/ repro, spec-frozen feature, prototyping, scoped refactor, greenfield | **Codex 6.1 Sol** |
| Codex quota exhausted on every eligible account, or user names it | **Grok 4.7** — overflow lane (slower and costlier per task on long work) |

Effort: 6.1 Sol `high`; Luna `medium`; Astra `high`. `gpt-6-sol` (no `.1`) is a regression — never route to it.

Executor down or failing → §5 failure policy. Both sides dead: Haiku → spawn sonnet/opus to implement (halt if none). Sonnet/Opus → implement directly from the frozen spec. Fable → spawn opus (overrides §4's session-tools-only qualifier); unavailable → implement it yourself.

## 4. Claude subagents

Spawn when the task needs session tools, tight multi-turn state, or Claude reasoning depth; executors for high-volume scoped one-shots.

| Harness | Spawn | Follow-up | Read result |
|---|---|---|---|
| Claude Code | Agent tool, `model: opus\|sonnet\|fable\|haiku` | SendMessage to the agent id/name | result message |
| omp | `task`, per item `model: "anthropic/claude-opus-5-5"` (`…-sonnet-5-5`, `…-fable-5-1`; append `:high`/`:xhigh` for effort) | `write agent://<id>` (revives a parked agent) | `read agent://<id>`; transcript `history://<id>` |

| Subagent task | Model |
|---|---|
| Bulk exploration/search *(only when Codex is unavailable or session tools are needed — else §3)*; standard review; scoped impl when executors are quota-dead or session tools/state are required | **sonnet** |
| Adversarial review; architecture drafts; plan-only at a higher tier | **opus** (`xhigh` ceiling) |
| Multi-day, research-grade, or ambiguous long-horizon runs | **fable** — safeguard fallback fires only on exploit development, dual-use bio, distillation, or frontier-LLM-infra prompts; it is a visible notice that pins the session to Opus. On it: stop, continue on opus with the same frozen plan + git diff. Fable may bill to usage credits behind a consent prompt that times out unattended — a silent early end means re-run on opus. |

Safeguards apply to every Claude 5.x tier (opus/sonnet 5.5 fall back to Opus 4.8 / Sonnet 5 on cyber content); spawning opus does not escape them, and executors refuse the same content. Exploit-adjacent implementation stays in the main session with the user informed.

Follow-ups: continue the existing subagent (table above) — it resumes with full context; a fresh spawn is for a new task, a drifted session (agent contradicts its own earlier output), or a failed continuation — then with the frozen plan + current git diff/status.

**Review policy:** executor output is reviewed by Claude-family only — never by an executor, never skipped. Adversarial-class = the diff touches auth/security/privacy, data-loss/migration, concurrency or cross-module invariants, or was rejected once for correctness/design uncertainty → requires opus+. Session-tool use, ordinary UX/taste, and ordinary design judgment are not adversarial by themselves — standard class → requires sonnet+. Self-review only when your tier ≥ the class floor; below it, spawn the minimum sufficient tier. Haiku never self-accepts any implementation review.

## 5. Invoke

1. **Preflight**: `git status -sb`; record the baseline — `BASE=$(git rev-parse HEAD)` — plus manifests of untracked and ignored files: `git ls-files --others --exclude-standard >"$UNTRACKED"; git ls-files --others --ignored --exclude-standard >"$IGNORED"`. Dirty tree: task-relevant dirty changes → do not delegate; ask or handle in Claude. Unrelated dirt → run the lane in a clean worktree if project rules allow; worktree unavailable or prohibited → keep the work in Claude or ask; an executor never runs in the dirty checkout. Never commit or stash someone else's work without explicit permission. The post-run diff must be attributable to the executor alone. Live credentials or private data anywhere in the repo (including ignored files like `.env`)? Keep that repo in Claude — path exclusion in a spec is not enforceable against a full-approval executor.
2. **Spec**: write it per `references/spec.md` — frozen plan, non-goals (Astra: explicit fences), the verbatim scope sentence ("You may edit only <named files/areas> and run local commands/tests; leave all changes uncommitted. Do not commit, push, release, tag, open/merge PRs, publish, or mutate remote state."), proof, output shape, distilled skills. Credentials and session-tool content stay out.
3. **Run**: commands in `references/executors.md` (Codex per-lane model/effort, Grok, resume forms, the 30-minute quiet rule). Long runs go to the background (Claude Code `run_in_background`; omp `bash` with `timeout: 0`) with stdin redirected from the spec file. Record the emitted session id — required for any resume.
4. **Codex quota or auth failure, or more than one ChatGPT account configured** → `references/codex-accounts.md` (placement, pick, pressure ladder, deterministic quota/auth signatures, fresh-run continuity).

**Failure policy (authoritative):** inspect stderr/output/diff first — a valid in-scope diff is usable even after a non-zero exit; a no-op is success when the requested state already holds. Otherwise: fix the invoke and retry the same executor once (Codex quota → rotate accounts per `references/codex-accounts.md` instead; quota exhaustion is terminal only after all eligible accounts are exhausted — auth/transport/invoke failures follow this policy's normal steps) → still failing (incl. quota/transport, empty output, the quiet rule): user pinned this executor with "only"/"exclusively" → halt and report; else switch once to the other executor with the same spec + git diff/status — never switch back. Infrastructure failures never increment §7's failed-round counter. Both executors dead → §3 both-dead rule. `HEAD` ≠ `BASE` after a run = unexpected executor commit: never reset/stash/amend — stop the lane, report the commit hash + `git status -sb`, ask the user.

## 6. Parallelize

Independence test (all three, else serial): no shared files; no lane consumes another's output; no lane needs a convention established by another lane. Exception — pilot-then-template: for N similar tasks, run ONE lane, review it fully, explicitly freeze its diff as the shared template in the remaining specs, then fan out N−1; an unproven pattern is never fanned out.

Isolation: different repos → separate `--cwd`/`-C`. Same repo → one git worktree per lane, created at `BASE` (serialize instead if project rules forbid worktrees). Claude reviews each lane's uncommitted diff, then applies it to the landing checkout — executors never commit, nothing is merged. Lane-specific `$OUT`/`$ERR` files (`mktemp`), never shared paths across lanes.

Caps: review is the bottleneck — max 3 implementation lanes; every diff gets full review on landing. Read-only fan-out may exceed that but cap it at what you can actually read (default ≤6).

Failures: failed-round counters are per lane/work item — a lane's counter never resets when it switches executors or subagents, and failures in other lanes never affect it; a lane at 2 failed rounds → absorb into Claude (same takeover rule as §7); scope is dropped only when the user marked that item optional. Merge conflict between lanes = the independence test failed: stop fanning, integrate directly.

## 7. Verify (always)

- Compare against the recorded baseline: `HEAD` vs `BASE`; read the tracked diff; compare post-run untracked/ignored manifests to the preflight baseline and inspect every new file; reject any out-of-scope path (counts as a wrong-scope failed round). Judge like a contributor PR.
- Recon lanes must produce zero changes — tracked, untracked, or ignored; any mutation = failed lane, stop and report.
- Run focused verification yourself when feasible; executor claims are advisory.
- Failed round = an attempt that (a) claims done but verify fails, (b) produces an empty/wrong-scope diff when edits were required, or (c) is rejected on review. Infrastructure failures (§5) don't count. The counter is per lane/work item (§6) and never resets across executors or subagents on the same task. After 2 failed rounds: takeover by max(your tier, opus if spawnable); adversarial-class work with opus unavailable → halt and report rather than downgrade the floor; none available → halt and report.
- Partial diff that proves the plan's assumptions wrong → replan in Claude (doesn't consume a failed round), then one resume/fresh run with the updated frozen plan + git diff/status. A *second* plan-invalidating partial diff on the same task counts as a failed round. For subagents, "fresh" only under §4's continuation-failure or drift exceptions. Fix-forward on the same plan → resume; counts as a round only if verify/review fails again.
- Closeout: after the required Claude-family review, run `$autoreview` if available — it never substitutes for the review above.
- **Log it** (powers `/delegation-status`): after verify settles each delegated task, one line — `scripts/delegation-log.py log executor codex-sol --account plus1 --outcome ok -- <task one-liner>` (targets: codex-sol/luna/astra, grok, sonnet/opus/fable for subagents; outcome ok/fail/recovered — `recovered` = succeeded after ≥1 quota rotation on the task). When §2 keeps a delegable-looking task: `log kept claude -- <task>`. Skip logging for trivia (<20-line edits) and recon.
