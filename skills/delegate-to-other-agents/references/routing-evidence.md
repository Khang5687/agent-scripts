# Routing evidence & update procedure

Backing data for the firm routing rules in SKILL.md. Read this when the user says
"update codex-first skill" (new models, new harnesses, new evidence).

## Current lineup (as of 2026-07-08)

| Role | Model / harness | Billing |
|---|---|---|
| Orchestrator / direct implementer | Claude Fable 5 (sometimes Opus 4.8) via Claude Code | metered, expensive |
| Executor (default) | Codex CLI + GPT-5.5 | flat-rate |
| Executor (alternate/fallback) | Grok CLI + grok-composer-2.5-fast | flat-rate |

## Evidence snapshot (research run 2026-07-08, Grok Heavy: benchmarks + X practitioner sentiment)

- **SWE-bench Verified**: Fable 5 ~95%; Opus 4.8 ~88.6%; GPT-5.5 ~82–88.7%; grok-code-fast-1 ~70.8%.
- **SWE-bench Pro** (harder, low leakage): Fable 5 80.3%; Opus 4.8 69.2%; GPT-5.5 58.6% → drives the "Claude does big multi-file work itself" rule.
- **Terminal-Bench 2.1**: GPT-5.5 ~83.4% (lead/near-top); Fable 5 ~83.1%; Opus lower; Grok ~70.8% → drives "Codex for CI/tooling/terminal".
- **Aider Polyglot**: GPT-5 series lead (~88%) → drives "Codex for test writing".
- **Practitioner sentiment (X)**: Grok praised for terminal UX/speed on routine work despite lower peak quality; short autonomous stamina (beta) → avoid for >30 min runs. Fable praised for one-shot long-horizon/taste ("generational"); safety-refuses security-adjacent tasks → Opus fallback there. Heavy users noted GPT-5.5 instruction drift; GPT-5.6 reportedly fixes it.
- **Grok context ceiling**: 256k → Codex for bulk exploration beyond that.
- **Thresholds**: no published hard numbers; consensus ≈ scoped/low-ambiguity/≲2k LOC/few files → delegate.

## How to update this skill

1. Re-run research. Copy-paste prompt for the research agent (Grok Heavy or similar) is below — swap in the current model/harness names first.
2. From results, update in SKILL.md: the **Executor pick** table, the **Claude does it itself** list + threshold, and the Fable-vs-Opus (or successor) note.
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
