---
name: delegate-to-other-agents
description: "Route implementation work to flat-rate executors (Codex CLI, Grok CLI) or Claude subagents; Claude specs, reviews, verifies."
---

# Delegate to Executors

Claude Code sessions only. Codex/other harnesses: skip; never self-delegate.

Metered Claude: design, plan, review, verify, hard/taste/global work. Flat-rate executors: Codex CLI (GPT-5.6 — terra default, luna cheap lane, sol escalation) and Grok CLI (grok-4.5): scoped implementation.

Firm rules below. Benchmarks + update procedure: `references/routing-evidence.md` (read only when updating this skill; evidence is stale after ~30 days or any model/pricing/access change — suggest an update run then).

## 1. Know your model

Check the harness-declared model in your environment context ("You are powered by the model named ..."). Trust only that declaration — never self-perception. No trusted declaration → follow the Sonnet row (over-delegation is cheap; an unidentified weak model doing the hardest work is not).

Tier order (high→low): fable > opus > sonnet > haiku.

| You are | Shift |
|---|---|
| **Fable 5** | Baseline for pure feature/taste work. Debugging-, refactor-heavy-, security/auth-, or exploit-adjacent work: never self-implement — spawn opus (classifier — §4 fable row). |
| **Opus 4.8** | Baseline; optional fable subagent for pure-feature multi-file ceiling work (§4 fable constraints). |
| **Sonnet 5** | Delegate more: medium+ implementation → executors (not a sonnet subagent unless session tools/state needed); adversarial review → spawn opus. |
| **Haiku** | Pure dispatcher: implement nothing non-trivial; spawn opus/sonnet for planning and review. |

## 2. Keep or delegate?

1. **Keep in Claude** if any (stop here): implementation itself needs session tools (MCP/browser/1Password/secrets — main session or Claude subagent, never an executor; tool-based *verification* doesn't count — Claude verifies regardless); unresolved design/API/architecture/naming/UX judgment; risk content — auth/security/privacy, data-loss/migration, invariants spanning unrelated modules (ordinary multi-file changes under a frozen spec remain delegable), concurrency, taste-sensitive polish (even when small); tiny edits (<20 lines, single obvious change — do directly at any tier; delegation overhead loses); review of executor output. Remote mutations (push/release/GitHub): Claude performs the mutation step itself in the main session — the implementation portion still enters step 2.
2. **Else plan** (mandatory step, not a verdict): files that change, approach, verification (trivial tasks: repro + verify command only). Frozen = goal, exact files/areas, non-goals, no unresolved design decisions, and the required verification commands (or one concrete manual check). Read-only recon may be delegated to Grok before the freeze (spec: "do not edit files"); judgments and the freeze stay Claude-side. Plan unfreezable → keep designing in Claude until freezable, or Claude implements — never delegate an unfrozen plan. Can't plan at your tier → spawn stronger (§4) to plan *only* — the frozen plan returns to you; the main session always owns dispatch, verify, and counters. No tier available can plan → halt and report.
3. **Then delegate** if the plan is frozen and the work is scoped, low-ambiguity, and expected *behavior-changing* diff ≲2k LOC (exclude generated/formatting-only output; estimate from the frozen plan; read-only exploration exempt; uncertain and near the boundary → keep in Claude). Mid-run or post-diff clearly ≫2k, or unforeseen global coupling appears → stop the executor (this overrides the §5 quiet-run grace; preserve its diff) and re-enter here. Otherwise Claude implements.

Mixed task: Claude designs first, freezes spec, delegates build-out. Portfolio/multi-repo: `$maintainer-orchestrator` if available; else one frozen plan, serial per-repo runs.

## 3. Executor pick

User names an executor → prefer it; user says "only"/"exclusively" → that executor or halt, never auto-switch. Else: first matching row wins.

| Task | Executor |
|---|---|
| Multi-step or near-size-band test work | **Codex terra** |
| Small single-step test writing | **Codex luna** (unless tests need session fixtures/MCP → sonnet subagent) |
| CI/tooling; terminal/infra | **Codex terra** — never luna (chain-shortcutting) |
| Top of the size band (near 2k LOC, multi-file) | **Codex sol** when available, else **terra** |
| High-volume bursts of small scoped one-shots | **Codex luna** |
| Bulk codebase exploration | **Grok** (500k context; beyond that, chunk by path globs) |
| Routine implementation: bugfix w/ repro, spec-frozen feature, prototyping, scoped refactor, greenfield | **Grok** (throughput/cost) |

Executor down or failing → §5 failure policy. Both sides dead: Haiku → spawn sonnet/opus to implement (halt if none). Sonnet/Opus → implement directly from the frozen spec. Fable → spawn sonnet (overrides §4's session-tools-only qualifier); unavailable → implement only pure feature/taste work yourself, else halt and report.

## 4. Claude subagents

Spawn (Agent tool, `model:`) when the task needs session tools, tight multi-turn state, or Claude reasoning depth; executors for high-volume scoped one-shots.

| Subagent task | Model |
|---|---|
| Bulk exploration/search *(only when Grok unavailable or session tools needed — else §3)*; standard review; scoped impl *only when session tools/state required* | **sonnet** |
| Adversarial review; architecture drafts | **opus** |
| Hardest long-horizon runs — pure feature/creative only | **fable** — avoid debugging, refactor-heavy, security/auth, exploit-ish prompts (silent classifier reroute breaks runs). Mid-run symptoms (stall, style shift on a debug turn) → stop it; continue on opus with the same frozen plan + git diff. |

Follow-ups: continue an existing subagent via SendMessage (agent ID/name) — it resumes with full context; never re-spawn fresh to iterate on the same task. Continuation fails or session unavailable → fresh spawn with the frozen plan + current git diff/status. Fresh spawn also for a new task or a drifted session (agent contradicts its own earlier output).

**Review policy:** executor output is reviewed by Claude-family only — never by an executor, never skipped. Adversarial-class = the diff touches auth/security/privacy, data-loss/migration, concurrency or cross-module invariants, or was rejected once for correctness/design uncertainty → requires opus+. Session-tool use, ordinary UX/taste, and ordinary design judgment are not adversarial by themselves — standard class → requires sonnet+. Self-review only when your tier ≥ the class floor; below it, spawn the minimum sufficient tier. Haiku never self-accepts any implementation review.

## 5. Invoke

Preflight: `git status -sb`; record the baseline — `BASE=$(git rev-parse HEAD)` — plus manifests of untracked and ignored files: `git ls-files --others --exclude-standard >"$UNTRACKED"; git ls-files --others --ignored --exclude-standard >"$IGNORED"`. Dirty tree: task-relevant dirty changes → do not delegate; ask or handle in Claude. Unrelated dirt → run the lane in a clean worktree if project rules allow; worktree unavailable or prohibited → keep the work in Claude or ask, never run an executor in the dirty checkout. Never commit or stash someone else's work without explicit permission. The post-run diff must be attributable to the executor alone. Live credentials or private data anywhere in the repo (including ignored files like `.env`)? Do not delegate to an external executor there — use Claude; path exclusion in the spec is not enforceable against a full-approval executor.

Executors start with zero session context. Spec = the frozen plan (§2) + constraints, non-goals, proof expected, output shape. Proof = the required verification commands, or one concrete manual check (no-run only for docs/comment/rename changes with listed paths). Every prompt states scope and includes: "You may edit only <named files/areas> and run local commands/tests; leave all changes uncommitted. Do not commit, push, release, tag, open/merge PRs, publish, or mutate remote state." (Recon: "do not edit files.") Never include credentials, tokens, or content from session tools in an executor spec.

### Skills propagation

Executors never see Claude's skills — the orchestrator selects and packages them into the spec; never tell an executor to browse a skills directory. Package every spec to the Grok floor (no skill mechanism); Codex's `~/.codex/skills` discovery is a bonus, never the contract.

- **Behavioral skills** (style/method, e.g. ponytail) → inline-distill into Constraints: ≤8 bullets / ≤120 words, only diff-changing rules (decision ladder, hard bans, safety floors, intensity). Strip triggers, frontmatter, examples, session language. Name the source ("Constraints (ponytail full): ...") so review can check compliance. Path-only is never the sole channel.
- **Reference skills** (in-repo API docs, e.g. `.agents/skills/<name>/`) → ≤3 exact paths, conditional and observable: "Before touching widget config, consult `.agents/skills/appintents/SKILL.md`." Always add the fence: "Do not browse the skills directory; read only the listed paths." Need >3 → task too broad: split lanes or Claude synthesizes an integration brief first. Inline only a task-critical excerpt/checklist ≤15 lines; never paste indexes.
- **Precedence**: spec > repo AGENTS.md/conventions > skill philosophy. All conflicts (including skill-vs-skill) are resolved by the orchestrator at freeze time — never left to the executor. Claude-only frontmatter (`context: fork`, `agent:`) never reaches a spec.
- Paths must be readable from the executor cwd (repo-relative preferred); plugin-only skills → distill the needed fact or keep the work in Claude. Parallel lanes: each lane gets only its own skills. Recon lanes usually get none. Zero skills is valid — under-include over speculate.
- Verify fails because guidance was ignored → resume with "you violated constraint X; re-read <path> and fix" — never dump full skill bodies on retry.

Record the emitted session id after every executor run — required for any resume.

**Codex multi-account** (needs the codex-switcher store `~/.codex-switcher/accounts.json`; exit 4 = no store → single-account mode, skip this block. `next` exit 2 = no eligible alternate *right now* → stay in the pressure ladder, never skip the block. `status` exit 5 = no usable snapshot → usage unknown, not healthy). Mechanics: `scripts/codex-account.py` — `status` (probe + record; exit 3 when hot: 5h ≥85% or weekly ≥95%), `list --json` (plans + last-known usage + flags + computed `eligible`), `switch <name>`/`next`, `mark <name> 5h|weekly|no-sol|auth-failed`, `clear <name>`. Decisions are yours:

- **Placement**: luna lanes → Plus accounts; terra/sol lanes → Pro accounts (a Plus 5h pool buys ~3× more luna than sol messages — never burn Plus quota on sol when a Pro account exists). Keep the strongest fresh account as reserve for urgent work (reserve one, not half the pool). Quota-model reality: one pool per account; heavier model drains it faster.
- **Pick** (from `list --json`): trust `eligible` + `effective` — the cache is reset-aware (an account observed hot before its window reset reports effectively fresh; expired flags drop off the `flags` map). `no-sol` blocks sol lanes only — the account stays eligible for terra/luna. Prefer effective headroom → an account with no observations gets one low-risk dispatch to learn its state. Keep the ledger warm: run `status` after each codex run, and before picking when the ledger is cold. Never probe accounts speculatively; **quota errors are authoritative** — on one, `mark` the account (`5h` or `weekly` per the error; weekly-capped stays excluded until the weekly reset) and `mark <name> no-sol` when sol isn't rolled out there.
- **Pressure ladder** (in order): same model on another eligible account → switch account. None fresh → downgrade one model tier only if the lane's floor allows, then re-pick (a Plus account may now be optimal). Floor blocks it → background work waits for the soonest reset; urgent work → Grok (deliberate overflow, not a failure). API-key account only with explicit user spend authorization. Then the §3 both-dead rule.
- **Quota-death detection (deterministic, case-insensitive)**: after any Codex failure, grep `$ERR` + `$OUT` for quota signatures — `usage limit`, `rate limit`, `quota`, `429`, `too many requests`, `upgrade to continue` → it's quota: `mark` the account (`weekly` if the message says weekly/plan, else `5h` — the mark self-expires at the window reset) and rotate. Auth signatures — `401`, `unauthorized`, `authentication failed`, `refresh.*failed` (never bare "token"/"login" — ordinary output contains them) → `mark <name> auth-failed`, rotate, CONTINUE the ladder (other accounts → Grok); never halt for re-auth — report "account X needs re-login in codex-switcher" in the task summary and keep working. User confirms re-login (or sol rollout) → `clear <name>` restores the account. No signature match → not quota; normal failure policy.
- **Recovery continuity**: an account switch = always a **fresh run, never resume** (sessions don't follow accounts). The fresh prompt = same frozen spec + current `git diff`/status + untracked list + "preserve the existing diff; implement only the remaining work — do not redo completed parts." The partial diff stays in the worktree; verify still compares against the original `BASE`.
- **Safety**: `switch`/`next` refuse (exit 6) while any `codex exec` run is live — a lane hitting quota while another lane is live: queue the rotation until lanes drain, or send the urgent retry to Grok now; `--force` only for guard false-positives, never past a real live lane. A long run crossing a reset is left alone — reroute the next attempt.

Codex — prompt via temp file, never inline; per-lane output files; model per the §3 lane (default terra):

```bash
P=$(mktemp); OUT=$(mktemp); ERR=$(mktemp)
cat >"$P" <<'EOF'
<spec>
EOF
command codex exec --yolo -C <repo> \
  -c model="gpt-5.6-terra" \
  -c model_reasoning_effort="high" \
  -o "$OUT" - <"$P" 2>"$ERR"
```

- `command codex` bypasses the zsh wrapper; not on PATH → `fnm exec --using default -- codex`. Outside a git repo add `--skip-git-repo-check`.
- Read the `-o` file, not the stream. Long runs: run_in_background; don't kill quiet runs <30 min (except the §2 stop-override); after 30 min quiet, check process liveness + the `-o` file / git status twice ≥10 min apart — failure only if the process exited or is demonstrably hung, not merely because git status is unchanged.

Codex follow-ups (`resume` has no `-C`/`--yolo`; run from the repo dir; `--last` only when exactly one recent session exists, else `resume <session-id>`):

```bash
(cd <repo> && command codex exec resume --last \
  -o "$OUT" - <"$P2" 2>"$ERR")
```

Add `--dangerously-bypass-approvals-and-sandbox` only when the follow-up must edit files.

Grok — no `-o` flag (redirect stdout); no stdin prompt, so `$(cat)` is the exception to never-inline. Oversized spec → make `-p` just "Read and execute the spec file at <path>":

```bash
grok --no-alt-screen -m grok-4.5 --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P")" >"$OUT" 2>"$ERR"
```

Grok follow-ups — same flags, resume by recorded session id (`-c` = most recent for that cwd; safe only when exactly one session exists there):

```bash
grok -r <recorded-session-id> --no-alt-screen -m grok-4.5 --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P2")" >"$OUT" 2>"$ERR"
```

Resume rules: resume only the same executor in the same repo, by the recorded session id; unsure which session → fresh run with git diff/status + full spec, never guess. Cross-executor is always a fresh run.

**Failure policy (authoritative):** inspect stderr/output/diff first — a valid in-scope diff is usable even after a non-zero exit; a no-op is success when the requested state already holds. Otherwise: fix the invoke and retry the same executor once (Codex quota → rotate accounts per the multi-account block instead; Codex "fails" only when all accounts are capped) → still failing (incl. quota/transport, empty output, the quiet rule): user pinned this executor with "only"/"exclusively" → halt and report; else switch once to the other executor with the same spec + git diff/status — never switch back. Infrastructure failures never increment §7's failed-round counter. Both executors dead → §3 both-dead rule. `HEAD` ≠ `BASE` after a run = unexpected executor commit: never reset/stash/amend — stop the lane, report the commit hash + `git status -sb`, ask the user.

## 6. Parallelize

Independence test (all three, else serial): no shared files; no lane consumes another's output; no lane needs a convention established by another lane. Exception — pilot-then-template: for N similar tasks, run ONE lane, review it fully, explicitly freeze its diff as the shared template in the remaining specs, then fan out N−1; never fan out an unproven pattern.

Isolation: different repos → separate `--cwd`/`-C`. Same repo → one git worktree per lane, created at `BASE` (serialize instead if project rules forbid worktrees). Claude reviews each lane's uncommitted diff, then applies it to the landing checkout — executors never commit, nothing is merged. Lane-specific `$OUT`/`$ERR` files (`mktemp`), never shared paths across lanes.

Caps: review is the bottleneck — max 3 implementation lanes; every diff gets full review on landing. Read-only fan-out may exceed that but cap it at what you can actually read (default ≤6).

Failures: failed-round counters are per lane/work item — a lane's counter never resets when it switches executors or subagents, and failures in other lanes never affect it; a lane at 2 failed rounds → absorb into Claude (same takeover rule as §7); never drop scope unless the user marked that item optional. Merge conflict between lanes = the independence test failed: stop fanning, integrate directly.

## 7. Verify (always)

- Compare against the recorded baseline: `HEAD` vs `BASE`; read the tracked diff; compare post-run untracked/ignored manifests to the preflight baseline and inspect every new file; reject any out-of-scope path (counts as a wrong-scope failed round). Judge like a contributor PR.
- Recon lanes must produce zero changes — tracked, untracked, or ignored; any mutation = failed lane, stop and report.
- Run focused verification yourself when feasible; executor claims are advisory.
- Failed round = an attempt that (a) claims done but verify fails, (b) produces an empty/wrong-scope diff when edits were required, or (c) is rejected on review. Infrastructure failures (§5) don't count. The counter is per lane/work item (§6) and never resets across executors or subagents on the same task. After 2 failed rounds: takeover by max(your tier, opus if spawnable) — if the remaining work is in fable's avoid list (§4), the takeover tier is opus; adversarial-class work with opus unavailable → halt and report rather than downgrade the floor; none available → halt and report.
- Partial diff that proves the plan's assumptions wrong → replan in Claude (doesn't consume a failed round), then one resume/fresh run with the updated frozen plan + git diff/status. A *second* plan-invalidating partial diff on the same task counts as a failed round. For subagents, "fresh" only under §4's continuation-failure or drift exceptions. Fix-forward on the same plan → resume; counts as a round only if verify/review fails again.
- Closeout: after the required Claude-family review, run `$autoreview` if available — it never substitutes for the review above.
- **Log it** (powers `/delegation-status`): after verify settles each delegated task, one line — `scripts/delegation-log.py log executor codex-terra --account plus2 --outcome ok -- <task one-liner>` (targets: codex-terra/luna/sol, grok, sonnet/opus/fable for subagents; outcome ok/fail/recovered — `recovered` = succeeded after ≥1 quota rotation on the task). When §2 keeps a delegable-looking task: `log kept claude -- <task>`. Quota rotations/marks auto-log. Skip logging for trivia (<20-line edits) and recon.
