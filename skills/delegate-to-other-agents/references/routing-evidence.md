# Routing evidence & update procedure

Backing data for the firm routing rules in SKILL.md. NOT for mid-task routing. Read this when the user asks to update the delegation skill (new models, new harnesses, new evidence).

Tags: **[V]** vendor-reported · **[I]** independent · **[L]** local machine ground truth · **[A]** anecdotal.

## Current lineup (as of 2026-10-05)

| Role | Model / harness | $/MTok in/out | Billing |
|---|---|---|---|
| Orchestrator default | Claude Opus 5.5 (`claude-opus-5-5`, 2026-09-22; alias `opus`) | $4/$20 | metered |
| Orchestrator ceiling | Claude Fable 5.1 (`claude-fable-5-1`, 2026-09-01; alias `fable`) — multi-day / research-grade / ambiguous only | $10/$50 | metered |
| Subagent worker | Claude Sonnet 5.5 (`claude-sonnet-5-5`, 2026-09-28; alias `sonnet`) | $2/$10 | metered |
| Dispatcher floor | Claude Haiku 4.5 (Haiku 5.5 announced, not shipped) | $1/$5 | metered |
| Executor default | Codex CLI 0.160 + GPT-6.1 Sol (`gpt-6.1-sol`, 2026-09-29) — GA on Plus, 15–160 msgs/5h | $2/$10 ($0.10 cached) | flat-rate (Plus) |
| Executor cheap lane | GPT-6 Luna (`gpt-6-luna`, 2026-09-22) — 272k ctx in Codex, 350–3,000 msgs/5h on Plus | $0.10/$0.50 | flat-rate |
| Executor escalation | GPT-6 Astra (`gpt-6-astra`, 2026-09-03) — on Plus but rationed 5–45 msgs/5h [V help center]; the Plus pricing card omits it (contradiction, unresolved); local `models_cache.json` lists it at priority 2 [L] | $10/$50 | flat-rate, rationed |
| Executor overflow | Grok CLI 1.0.46 + Grok 4.7 (`grok-4.7`, 2026-09-21; the CLI serves only this model) | $2/$6 (<200k), $4/$12 above | flat-rate (sub) |

Retired since July: GPT-5.6 Sol/Terra/Luna ("Older" in Codex; no GPT-6 Terra exists), GPT-5.5 (retires 2026-10-14), Grok 4.5/4.6, Opus 4.8, Opus 5, Sonnet 5 ($2/$10 made permanent; the $3/$15 rise was cancelled). Claude Code ≥ 2.1.284 resolves `opus`/`sonnet`/`fable` to the 5.5 / 5.5 / 5.1 models on the Anthropic API; Bedrock/Vertex/Foundry aliases lag — pin with `ANTHROPIC_DEFAULT_*_MODEL` there.

## Evidence snapshot — 2026-10-05 research run

Verdicts: Opus 5.5 default orchestrator; Sonnet 5.5 a full-strength implementer; GPT-6.1 Sol replaces Terra as Codex default; Luna stays single-step only; Astra is the escalation with a scope-creep caveat; Grok demoted from co-default to overflow.

### Independent benchmarks

- **Terminal-Bench 4.0** (vals.ai, mini-swe-agent, avg@3, 8h limit, 2026-10-01) [I]: Opus 5.5 65.2% ($13.20/task) · Sonnet 5.5 64.1% ($16.51) · Astra 59.6% ($9.58) · Fable 5.1 58.1% ($17.18) · **GPT-6.1 Sol 55.1% ($1.72)** · Opus 5 53.5 · GPT-6 Sol 44.4 · **Grok 4.7 28.8% ($18.09)** · Opus 4.8 23.2 · GPT-5.6 Terra 22.7 · **GPT-6 Luna 13.6%** (≈ 5.6 Luna 11.6) · Sonnet 5 9.6. Category: Astra is the only model >60% on *software* (61.1%); Opus 5.5 drops to 29.6% on *operations* where Sonnet 5.5 leads (51.9%). TB 2.x numbers are not comparable and are retired. Artificial Analysis' own TB4 run orders Sonnet 5.5 (63.6) above Opus 5.5 (59.6).
- **vals Code Migration** (2026-10-01) [I]: Sonnet 5.5 69.8% · Astra 67.7 · Opus 5.5 66.7 · **GPT-6.1 Sol 65.1% ($6.51/test vs $113 for Opus 5.5)** · Fable 5.1 54.6 · Grok 4.7 44.8 ($36.55) · GPT-6 Luna 42.6 ($0.60).
- **Vals Index** (2026-10-02) [I]: Sonnet 5.5 67.0 ($21) · Opus 5.5 67.0 ($32) · Fable 5.1 65.8 · Astra 63.1 · GPT-6.1 Sol 61.2 ($3.24) · Grok 4.7 55.0 · GPT-6 Luna 51.2.
- **AI Coding Daily** (single maintainer, 4 real projects, max 70, 2026-10-03) [I-small]: GPT-6.1 Sol high 68.1 ($0.22/prompt) · Opus 5.5 67.4 ($0.79) · Astra 66.4 · Sonnet 5.5 64.3 · Fable 5.1 61.0 · Grok 4.7 60.1 ($1.85, **23 min/prompt**) · GPT-6 Luna max 59.1 / high 53.0 / medium 43.7. Edge-case-test sub-score (max 20): 6.1 Sol 20, Opus 5.5 20, Luna 16.7 (max) → 9.7 (medium), Grok 16.3.
- **cubic Bug Bench** (observational, bugs per AI-attributed line in reviewed PRs, Jun–Oct) [I-obs]: Sonnet 5.5 0.96 · Fable 5.1 1.12 · Astra 1.28 · GPT-6.1 Sol 1.41 · Opus 5.5 1.63 (task mix confounds; review Opus output, do not exempt it).
- **Safety-classifier fallbacks** [I vals TB4]: Fable 5.1 11% of attempts served by Opus 5 (58.1% → 50.0% if counted as failures); Opus 5.5 11% served by Opus 5 / 4.8; Sonnet 5.5 2%. Vals Index fallback rates ~1–4%. OpenAI claims ~40% on AutomationBench [V-adversarial]; unreconciled.
- **METR** (Opus 5.5 pre-deployment, 2026-09-22): "incremental improvement above Fable 5.1, rather than a discontinuous jump". No METR horizons for GPT-6.x / Grok 4.7 found.

### Vendor-only (unreplicated)

DeepSWE 1.1: GPT-6.1 Sol 75.2 (high) / 71.9 (max) · Astra 74.1 · Grok 4.7 71.0 · Fable 5.1 67.4 · GPT-6 Luna 66.6; Opus/Sonnet 5.5 unreported. FrontierCode 1.1: Opus 5.5 54.4 · Astra 53.3 · Sonnet 5.5 52.1 (xhigh) / 46.2 (max — ran a review skill and over-scoped). Vendor TB4 (Claude Code harness): Sonnet 5.5 70.6 · Opus 5.5 66.4 · Astra 57.9 · Fable 5.1 55.8 · Grok 4.7 37.6. Grok's DeepSWE 71.0 is the lone signal keeping it near the pack.

### Practitioner findings that drive rules

- **Astra scope creep** [A, OpenAI forum thread 21 posts/43 likes + r/codex]: invents architecture, "tests for tests for tests", treats explicit prohibitions as suggestions, burns a week's allowance in a 4h off-scope run → Astra specs carry explicit non-goal fences; out-of-scope diff is a failed round.
- **Luna multi-step** [I+V]: TB4 13.6%, edge-case tests collapse below max effort; OpenAI scopes Luna to "focused, repeatable tasks" → single-step lanes only. Codex CLI compaction loop on Luna at xhigh/max (codex#41318, 0.150) not re-tested on 0.160 → Luna at `medium`.
- **GPT-6 Sol regression** [A, HN]: "worse than 5.6 Sol"; superseded by 6.1 Sol after 7 days. Never route to `gpt-6-sol`.
- **Grok 4.7** [I]: slowest and costliest per task on long agentic work (vals: $36–46/test on migration/program benches); 500k ctx no longer unique (6.1 Sol has 1M at $0.10 cached) → overflow lane only.
- **Fable 5.1 reroute** [V+A]: categories narrowed to offensive cyber (exploit development, malware, attack tooling), dual-use bio, distillation, frontier-LLM infra (distributed training, accelerator kernels); vulnerability *discovery* allowed; cyber false positives −60%. Reroute is now a visible notice; the Claude Code session pins to Opus for the rest of the conversation (toggle: Config > MODEL & OUTPUT). Rerouted requests bill at Opus rates. PCMag: zero coding blocks on 5.1. Opus 5.5 and Sonnet 5.5 carry the same safeguards (fallback → Opus 4.8 / Sonnet 5), so spawning opus does not escape the classifier. Fable is not the default on any plan and may bill to usage credits behind a consent prompt that times out after 5 min in unattended sessions.
- **Opus 5.5 at `max`** [A, Willison]: over-thinks to the 128k output cap on trivial prompts → cap subagents at `xhigh`.
- **Sonnet 5.5** [V+I]: design/taste reputation is the strongest new signal; 3.6 iterations/build vs 7.7 for Opus 5 (Base44); ties Opus 5.5 on Vals Index at 2/3 cost; Anthropic: Opus "clearly stronger at complex, open-ended work requiring sustained judgment".
- **Executors and security** [I]: GPT-6.1 Sol CyberBench rank 42/44 (safeguards) → security review and exploit-adjacent work cannot be delegated even as a second opinion.

### Thresholds

The ≲2k behavior-changing LOC bar is July consensus, not re-validated; executor stamina is no longer the limiter (6.1 Sol completes 8h TB4 tasks at 55%, 1.5h migrations at 65%) — the binding constraints are scope discipline and ambiguity. The <20-line do-it-yourself rule stands on latency, not cost (6.1 Sol $0.14–0.22/prompt).

### Unknowns

SWE-bench Verified and Aider Polyglot have no current-model scores (retired/stale). SWE-bench Pro: ~30% of tasks broken per OpenAI's audit; no GPT-6.x / Grok 4.7 numbers. AA Coding Agent Index v1.5 paywalled. Astra accessibility on Plus: help center says yes (rationed), pricing card omits it, not probed locally. Luna compaction loop on 0.160 untested.

### Key sources

Anthropic: anthropic.com/claude-fable-and-mythos-5-1 · anthropic.com/claude-opus-5-5 · anthropic.com/claude-sonnet-5-5 · support.claude.com/en/articles/15363606 (reroute) · code.claude.com/docs/en/model-config (aliases). OpenAI: openai.com/index/gpt-6-astra · openai.com/index/introducing-gpt-6-1-sol · openai.com/index/introducing-gpt-6-sol-and-luna · developers.openai.com/codex/pricing · learn.chatgpt.com/docs/models · community.openai.com/t/…/1399757 (Astra scope) · github.com/openai/codex/issues/41318 (Luna loop). xAI: x.ai/news/grok-4-7 · docs.x.ai/developers/models. Independent: vals.ai/benchmarks/terminal-bench-4 · vals.ai/benchmarks/code-migration · vals.ai/benchmarks/vals_index · aicodingdaily.com/leaderboard · cubic.dev/bugbench · metr.org/blog/2026-09-22-claude-opus-5-5 · simonwillison.net/2026/Sep/22/opus-and-sol-and-luna · me.pcmag.com/en/ai/37981. Local: `~/.codex/models_cache.json`, `~/.codex/config.toml`, `grok models`, omp model cache (2026-10-05).

History: 2026-07-08 → 07-10 snapshots (GPT-5.6 family, Grok 4.5, Fable 5 / Opus 4.8 / Sonnet 5) superseded in full; see git history. 2026-07-10 adversarial 3-model review converged SKILL.md; 2026-10-05 restructured per `writing-for-agents` (invoke/accounts/spec disclosed to `references/`).

## How to update this skill

Review cadence: event-driven, not scheduled — a new model/harness, an observed routing failure, or a major skill change. Scheduled re-reviews of a converged file produce churn.

1. Collect local ground truth first: `~/.codex/models_cache.json` (available Codex models, retirements), `~/.codex/config.toml`, `codex login status`, `grok models`, the orchestrator harness's model list. Local facts outrank web claims about availability.
2. Re-run research with the prompt below — swap in the current model/harness names first.
3. From results, update in SKILL.md: §3 executor table and effort line; §2 keep/delegate checks + LOC/ambiguity bar; §1 model rows; §4 subagent tiers + safeguard caveat. Rename script flags if a tier name changed (`codex-account.py` `VALID_MARKS`, `delegation-log.py` target list).
4. Update this file: lineup table, evidence snapshot (dated), prune superseded claims.
5. Keep the rules firm — verdicts per task type, not "use judgment". Flag contradictory evidence rather than silently picking a side.

### Research prompt template

```
RESEARCH TASK: Coding-agent model routing rules — evidence gathering

I run a Claude-orchestrated setup (<ORCHESTRATOR MODELS>) that routes
implementation work to flat-rate executors. I need evidence to write firm
per-task-type routing rules.

Models to compare (exactly these, current versions):
1. <EXECUTOR 1: harness + model(s)>
2. <EXECUTOR 2: harness + model(s)>
3. <ORCHESTRATOR MODEL(S)>

For each model, find:
- Benchmarks: Terminal-Bench 4.x, vals Code Migration / Vals Index, DeepSWE,
  FrontierCode, AA Coding Agent Index, METR horizons. Cite scores with dates;
  note vendor-reported vs independent; note fallback/refusal rates.
- Practitioner sentiment (X, Reddit, HN, blogs; weight heavily): recurring
  specific claims from credible shipping devs about what each model is
  actually good/bad at.
- Failure modes: instruction drift, scope creep / unrequested tests,
  shortcutting multi-step chains, breaking unrelated code, giving up on long
  tasks, safety-classifier reroutes, harness bugs (compaction loops).
- Speed, cost per task, and reliability in agentic harnesses.
- Access: which plans/tiers can run it, message allowances, retirements.

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
per-model strengths / weaknesses with sources; direct answers to 1–4;
confidence per claim (benchmark-backed / practitioner consensus / anecdotal);
a delta list against the current SKILL.md rules; sources list. Prioritize
last-quarter data. Flag contradictions. State unknowns as unknown.
```
