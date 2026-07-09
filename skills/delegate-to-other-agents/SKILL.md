---
name: delegate-to-other-agents
description: "Route implementation work to flat-rate executors (Codex CLI, Grok CLI) or Claude subagents; Claude specs, reviews, verifies."
---

# Delegate to Executors

Claude Code sessions only. Codex/other harnesses: skip; never self-delegate.

Metered Claude: design, plan, review, verify, hard/taste/global work. Flat-rate Codex CLI (GPT-5.5) and Grok CLI (grok-4.5): scoped implementation.

Firm rules below. Benchmarks + update procedure: `references/routing-evidence.md` (read only when updating this skill; evidence dated 2026-07 — suggest an update run if clearly stale).

## 1. Know your model

Check the harness-declared model in your environment context ("You are powered by the model named ..."). Trust only that declaration — never self-perception. No trusted declaration → follow the Sonnet row (over-delegation is cheap; an unidentified weak model doing the hardest work is not).

Tier order (high→low): fable > opus > sonnet > haiku.

| You are | Shift |
|---|---|
| **Fable 5** | Baseline. Hardest taste/feature work yourself; debug/security-heavy work → prefer opus (classifier — §4 fable row). |
| **Opus 4.8** | Baseline; optional fable subagent for pure-feature multi-file ceiling work (§4 fable constraints). |
| **Sonnet 5** | Delegate more: medium+ implementation → executors (not a sonnet subagent unless session tools/state needed); adversarial review → spawn opus. |
| **Haiku** | Pure dispatcher: implement nothing non-trivial; spawn opus/sonnet for planning and review. |

## 2. Keep or delegate?

1. **Keep in Claude** if any (stop here): implementation itself needs session tools (MCP/browser/1Password/secrets — main session or Claude subagent, never an executor; tool-based *verification* doesn't count — Claude verifies regardless); remote mutations (push/release/GitHub — Claude does these itself in the main session); design/API/architecture/naming/UX judgment; risk content — auth/security/privacy, data-loss/migration, global/cross-file consistency, concurrency, taste-sensitive polish (even when small); tiny edits (<20 lines, single obvious change — do directly at any tier; delegation overhead loses); review of executor output.
2. **Else plan** (mandatory step, not a verdict): files that change, approach, verify command (trivial tasks: repro + verify command only). Can't plan at your tier → spawn stronger (§4) to plan *only* — the frozen plan returns to you; the main session always owns dispatch, verify, and counters. No available tier meets the bar → halt and report. Plan unfreezable → Claude implements (or designs until freezable, then re-enters here).
3. **Then delegate** if the plan is frozen and the work is scoped, low-ambiguity, and expected *edited diff* ≲2k LOC (estimate from the frozen plan; read-only exploration exempt). Otherwise Claude implements.

Mixed task: Claude designs first, freezes spec, delegates build-out. Portfolio/multi-repo: `$maintainer-orchestrator` if available; else one frozen plan, serial per-repo runs.

## 3. Executor pick

First matching row wins — specific rows precede routine work.

| Task | Executor |
|---|---|
| Test writing | **Codex** (unless tests need session fixtures/MCP → sonnet subagent) |
| CI/tooling; terminal/infra | **Codex** |
| Top of the size band (near 2k LOC, multi-file) | **Codex** (peak solve rate) |
| Bulk codebase exploration | **Grok** (500k context; beyond that, chunk by path globs) |
| Routine implementation: bugfix w/ repro, spec-frozen feature, prototyping, scoped refactor, greenfield, high-volume bursts | **Grok** (throughput/cost) |

Quota/transport failure → **restart** on the other executor: same spec + git diff/status as done/remaining context. At most one such switch per side per task; both sides dead → sonnet subagent implements from the frozen spec; Claude absorbs only if the task fails the §4 spawn criteria; none can → halt and report.

## 4. Claude subagents

Spawn (Agent tool, `model:`) when the task needs session tools, tight multi-turn state, or Claude reasoning depth; executors for high-volume scoped one-shots.

| Subagent task | Model |
|---|---|
| Bulk exploration/search; standard review; scoped impl *only when session tools/state required* | **sonnet** |
| Adversarial review; architecture drafts | **opus** |
| Hardest long-horizon runs — pure feature/creative only | **fable** — avoid debugging, refactor-heavy, security/auth, exploit-ish prompts (silent classifier reroute breaks runs). Mid-run symptoms (stall, style shift on a debug turn) → stop it; continue on opus with the same frozen plan + git diff. |

Follow-ups: continue an existing subagent via SendMessage (agent ID/name) — it resumes with full context; never re-spawn fresh to iterate on the same task. Fresh spawn only for a new task or a drifted session (agent contradicts its own earlier output).

**Review policy (sole statement):** executor output is reviewed by Claude-family only — never by an executor, never skipped. Adversarial-class = the diff hits the §2 risk list (auth/security/privacy, data-loss/migration, global/cross-file consistency, concurrency) or was rejected once for correctness/design uncertainty → requires opus+. Everything else = standard → requires sonnet+. Self-review only when your tier ≥ the class floor; below it, spawn the minimum sufficient tier. Haiku never self-accepts any implementation review.

## 5. Invoke

Preflight: `git status -sb`. Dirty tree: task-relevant dirty changes → do not delegate; ask or handle in Claude. Unrelated dirt → run the lane in a clean worktree if project rules allow; never commit or stash someone else's work without explicit permission. The post-run diff must be attributable to the executor alone.

Executors start with zero session context. Spec = goal, exact repo/paths, constraints, non-goals, proof expected, output shape. Proof = exact verification command (no-run only for docs/comment/rename changes with listed paths). Every prompt states local scope ("edit only <named files/areas>", or "do not edit files" for recon) and includes: "do not commit, push, release, tag, open/merge PRs, publish, or otherwise mutate git or remote state." Never include credentials, tokens, or content from session tools (1Password, MCP, private browser state) in an executor spec. Repo contains live credentials (.env, keys)? Exclude those paths from scope or don't delegate in that repo.

Codex — prompt via temp file, never inline:

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<spec>
EOF
command codex exec --yolo -C <repo> \
  -c model_reasoning_effort="high" \
  -o /tmp/codex-last.md - <"$P" 2>/tmp/codex-err.log
```

- `command codex` bypasses the zsh wrapper; not on PATH → `fnm exec --using default -- codex`. Outside a git repo add `--skip-git-repo-check`.
- Read the `-o` file, not the stream. Long runs: run_in_background; don't kill quiet runs <30 min; after 30 min quiet, check the `-o` file / git status — no progress across two checks ≥10 min apart → executor error.

Codex follow-ups (`resume` has no `-C`/`--yolo`; run from the repo dir):

```bash
(cd <repo> && command codex exec resume --last \
  -o /tmp/codex-last.md - <"$P2" 2>/tmp/codex-err.log)
```

Add `--dangerously-bypass-approvals-and-sandbox` only when the follow-up must edit files.

Grok — no `-o` flag (redirect stdout); no stdin prompt, so `$(cat)` is the exception to never-inline. Oversized spec → make `-p` just "Read and execute the spec file at <path>":

```bash
grok --no-alt-screen -m grok-4.5 --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P")" >/tmp/grok-last.md 2>/tmp/grok-err.log
```

Grok follow-ups: `grok -c ...` (continues the most recent session for that cwd; `-r <id>` targets one).

Resume rules: resume only the same executor in the same repo. `--last`/`-c` only when exactly one recent session exists there; after parallel/interleaved runs, resume by explicit session id; unsure which session → fresh run with git diff/status + full spec, never guess. Cross-executor is always a fresh run.

Executor error (≠ failed round): non-zero exit, missing/empty output file, no diff when edits were expected, an unexpected local commit, or the 30-min-quiet rule → read the err log; fix the invoke once, then one switch to the other executor; still dead → §3 both-dead rule.

## 6. Parallelize

Independence test (all three, else serial): no shared files; no lane consumes another's output; no lane sets a convention others must follow. N similar tasks: pilot ONE → full review → freeze that diff as the template in the remaining specs → fan out N−1; never fan out an unproven pattern.

Isolation: different repos → separate `--cwd`/`-C`. Same repo → one git worktree per lane (serialize instead if project rules forbid worktrees); Claude merges after review. Lane-specific output/err files (`mktemp`), never the literal `/tmp/*-last.md` across lanes.

Caps: review is the bottleneck — max 3–4 implementation lanes; every diff gets full review on landing. Read-only fan-out may exceed that but cap it at what you can actually read (default ≤6).

Failures: counters are per-lane — one lane never blocks the others; a lane at 2 failed rounds → absorb into Claude (same takeover rule as §7); never drop scope unless the user marked that item optional. Merge conflict between lanes = the independence test failed: stop fanning, integrate directly.

## 7. Verify (always)

- `git status -sb` + read the full diff; judge like a contributor PR.
- Run focused verification yourself when feasible; executor claims are advisory.
- Failed round = an attempt that (a) claims done but verify fails, (b) produces an empty/wrong-scope diff when edits were required, or (c) is rejected on review. Executor errors and quota switches don't count. The counter never resets across executors or subagents on the same task. After 2 failed rounds: takeover by max(your tier, opus if spawnable) — but if the remaining work is in fable's avoid list (§4), the takeover tier is opus; none available → halt and report.
- Closeout: after the required Claude-family review, run `$autoreview` if available — it never substitutes for the review above.
