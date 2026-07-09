# Routing evidence & update procedure

Backing data for the firm routing rules in SKILL.md. NOT for mid-task routing. Read this
when the user asks to update the delegation skill (new models, new harnesses, new evidence).

## Current lineup (as of 2026-07-09)

| Role | Model / harness | Billing |
|---|---|---|
| Orchestrator / direct implementer | Opus 4.8 default; Fable 5 reserved for hardest non-debug/non-security ceiling work (classifier reroute risk) | metered, expensive |
| Subagent worker | Sonnet 5 default; opus for adversarial/security; fable reserved | metered |
| Executor (co-default) | Codex CLI + GPT-5.5 | flat-rate |
| Executor (co-default) | Grok CLI + grok-4.5 (CLI default since 2026-07-08; grok-composer-2.5-fast still available) | flat-rate (sub) |

Orchestrator choice (user-facing, not agent-actionable mid-task): prefer Opus 4.8 sessions; Fable 5 sessions only for long-horizon taste-sensitive feature work unlikely to trip the safety classifier.

2026-07-10: SKILL.md consolidated after adversarial 3-model review (Fable 5 high, GPT-5.5, Grok 4.5) — contradictions removed, benchmarks moved here, single decision flow.

Original 2026-07-08 snapshot removed (superseded by the two snapshots below; see git history). Still-current findings carried forward: SWE Pro gap Fable 80.3% vs GPT-5.5 58.6% (drives "Claude keeps hard multi-file work"); Aider Polyglot GPT-5 lead (drives "Codex for tests"); delegation threshold consensus ≈ scoped/low-ambiguity/≲2k LOC.

## Evidence snapshot — Grok 4.5 (research run 2026-07-09; model released 2026-07-08)

Verdict: promoted Grok from fallback/small-task pick to **co-default executor**.

- **SWE-bench Verified** (independent, vals.ai): Grok 4.5 86.6% — behind Fable ~95% / Opus 88.6%, but ~$0.54 and ~200s per task.
- **SWE-bench Pro**: Grok 4.5 64.7% vs Fable 80.4% → Claude-side boundary unchanged; hardest multi-file/global-consistency stays with Fable. Beats GPT-5.5 (58.6%) here though.
- **Terminal-Bench 2.1**: Grok 4.5 83.3% ≈ GPT-5.5 83.4% → CI/terminal now a tie; Codex kept as default there only by incumbency.
- **DeepSWE 1.1** (mini-swe-agent): Grok 53% vs GPT-5.5 67% / Fable 70% → Codex keeps "hardest delegable, first-pass matters" tasks.
- **Token efficiency**: ~15.9k output tokens/task vs Opus ~67k (4.2×) → drives bulk-exploration + high-volume routing to Grok.
- **Stamina fixed**: RL on long multi-step SE tasks + Cursor data flywheel; old >30-min autonomous weakness no longer applies (vendor claim + early practitioner consensus, low volume).
- **Context**: 500k native (old 256k ceiling gone; 1M planned). Cursor client caps at 256k; CLI/API get full 500k.
- **Sentiment (X, early)**: strongly positive on speed/flow/agentic endurance; recurring caveat — fast but occasionally less nuanced than Fable on diagnosis. Too new for production-longevity data; re-check in a quarter.
- **Caveats**: mostly vendor/launch-window numbers, independent replication thin; test writing stays Codex (no Aider Polyglot number published for 4.5 yet).

## Evidence snapshot — Claude tiers + Fable re-release (research run 2026-07-09)

Verdict: Opus 4.8 becomes default orchestrator; Sonnet 5 default subagent worker; Fable reserved.

- **Fable 5 reroute risk** (post ~2026-07-01 re-release): a safety classifier silently reroutes debugging/refactor/security-adjacent prompts to Opus 4.8 — Fable-rate billing for Opus output, and mid-run switches break long autonomous runs. Pure feature/creative work mostly unaffected. Reroute frequency is contested (vendor: "small fraction"; dev billing reports: 25–75% of coding sessions). Net: Fable no longer default; use only for pure feature/creative ceiling work.
- **Sonnet 5** (launched ~2026-06-30, $2/$10 intro ≈ 1/5 Opus): SWE-bench Verified ~85.2% (Opus 88.6%), SWE Pro 63.2% (Opus 69.2%), Terminal-Bench 2.1 **80.4% beats Opus 74.6%**. Sufficient for exploration, tests, scoped impl, standard review. Weaknesses: safeguard-weakened on exploit/cyber; tokenizer inflates code tokens 1–1.35×; shallower on hardest ambiguous work.
- **Opus 4.8 as middle tier**: consistent depth, no classifier friction, wins adversarial/security verification and architecture drafts. 2–5× Sonnet cost.
- **Hybrid pattern** (Anthropic-endorsed): flagship orchestrator + Sonnet workers = 92–96% of top-tier perf at 46–63% cost.
- **Subagent vs external executor**: no universal crossover; subagent wins when session tools/state/multi-turn needed, external wins on volume/flat-rate. (Anecdotal/medium confidence.)
- **Caveats**: Fable fallback rate is prompt-dependent (some heavy users see almost none); Sonnet intro pricing may lapse; SWE numbers for Fable often pre-re-release.

## How to update this skill

1. Re-run research. Copy-paste prompt for the research agent (Grok Heavy or similar) is below — swap in the current model/harness names first.
2. From results, update in SKILL.md: §3 Executor pick table; §2 keep/delegate checks + LOC/ambiguity bar; §1 model shift rows; §4 subagent tiers + classifier caveat.
3. Update this file: lineup table, evidence snapshot (keep dated), and prune stale claims.
4. Keep the rules firm — verdicts per task type, not "use judgment". Flag contradictory evidence rather than silently picking a side.

### Research prompt template

```
RESEARCH TASK: Coding-agent model routing rules — evidence gathering

I run a Claude Code setup where an orchestrator (<ORCHESTRATOR MODELS>) routes
implementation work to flat-rate executors. I need evidence to write firm
per-task-type routing rules.

Models to compare (exactly these, current versions):
1. <EXECUTOR 1: harness + model>
2. <EXECUTOR 2: harness + model>
3. <ORCHESTRATOR MODEL(S)>

For each model, find:
- Benchmarks: SWE-bench Verified/Pro, Terminal-Bench, Aider Polyglot,
  LiveCodeBench, agentic/long-horizon evals. Cite scores with dates; note
  vendor-reported vs independent.
- Twitter/X practitioner sentiment (weight heavily): recurring specific claims
  from credible shipping devs about what each model is actually good/bad at.
- Failure modes: instruction drift, over-engineering, breaking unrelated code,
  giving up on long tasks.
- Speed and reliability in agentic harnesses: wall-clock, loop/stall tendency,
  30+ min autonomous run stamina.

Then answer directly, with evidence:
1. Executor vs executor: which task types (bug fix w/ repro, refactor,
   greenfield, test writing, migration, CI/tooling, bulk exploration) does each
   win?
2. When is the metered frontier model worth implementing itself instead of
   delegating (review/retry cycles > direct cost)? Check: concurrency bugs,
   security-sensitive code, design-bleeding-into-impl, large cross-file
   changes, frontend/UX polish.
3. Between the orchestrator-tier models: coding quality differences, which
   tasks justify the top tier?
4. Task-size thresholds (LOC, files, ambiguity) where delegation stops paying?

Output: task type × model verdict table (win/capable/avoid + one-line reason);
per-model 5 strengths / 5 weaknesses with sources; direct answers to 1–4;
confidence per claim (benchmark-backed / practitioner consensus / anecdotal);
sources list. Prioritize last-quarter data. Flag contradictions.
```
