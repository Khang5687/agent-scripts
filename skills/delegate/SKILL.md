---
name: delegate
description: "Hand work to other agents: Paseo agents, in-harness subagents, or CLI executors; pick tiers and effort. Use when the user says delegate, spawn/parallelize agents, hand this to Codex/Claude, or asks which model should do a task."
---

# Delegate

## Rules (durable)

1. **Parallel only with no shared files.** Lanes run in parallel only when no two touch the same file, none consumes another's output, and none needs a convention another establishes. Otherwise serialize.
2. **Pilot one, then fan out.** For N similar tasks, run one lane, review it fully, freeze it as the template, then fan out the rest.
3. **Helpers never commit or push.** Workers leave changes uncommitted; the orchestrator reviews, verifies, and lands.
4. **Reviewer tier ≥ worker tier.** Never let a weaker model sign off on a stronger model's diff.

## How to delegate today

Prefer the first that fits:

- **Paseo agents** — when Paseo is available (`paseo` skill): `create_agent` for a new agent in a workspace, `send_agent_prompt` to continue it, `ask_agent` for a quick question. Best for long runs, other machines, or other providers. Read the `paseo` skill for exact usage.
- **In-harness subagents** — same session, shared tools/MCP: Claude Code `Agent` tool (`model: opus|sonnet|fable|haiku`; follow up with SendMessage); OMP `task` (per item `model: "anthropic/claude-opus-5-5:xhigh"`; follow up via `write agent://<id>`).
- **CLI executors** (`codex exec`, `grok -p`) — only when the above are unavailable or a flat-rate lane is explicitly wanted. Prompt from a file, redirect stdin, record the session id for resume. Old command reference: `skills-archive/delegate-to-other-agents/references/executors.md`.

Every handoff: goal, exact files/areas, non-goals, verification commands, and "leave changes uncommitted". Verify the diff yourself; worker claims are advisory.

## Model facts

Auto-maintained; edit only between the markers (see `UPDATING.md`).

<!-- model-facts:start -->
| Model | Role | Effort ceiling | Notes | Last verified |
|---|---|---|---|---|
| Claude Fable 5.1 (`fable`) | Top tier: multi-day, research-grade, ambiguous work | `xhigh` | Safeguard fallback (visible notice, pins session to Opus) on exploit dev, dual-use bio, distillation, frontier-LLM infra. On it: stop, keep that work in main session. | 2026-11-02 |
| Claude Opus 5.5 (`opus`) | Default orchestrator; adversarial review, architecture | `xhigh` | `max` over-thinks to the output cap on trivial prompts. | 2026-11-02 |
| Claude Sonnet 5.5 (`sonnet`) | Near-Opus implementer; standard review | `high` | Ties Opus 5.5 on Vals Index at ~2/3 cost; strong design/taste. | 2026-11-02 |
| Claude Haiku 5.5 (`haiku`) | Narrow subagent: lookups, summaries, extraction, explore | `high` | Terminal-Bench 4.0 39% vs Sonnet 5.5 71%: never give it multi-step implement. `haiku` is still 4.5 on Bedrock/Vertex/Foundry. | 2026-11-02 |
| GPT-6.1 Sol (`gpt-6.1-sol`) | Default Codex executor; 1M ctx API, 500K default in Codex | `high` | Not for security review (safeguards). local: 6/18 `high` Paseo runs failed Oct 31-Nov 1; 71/71 other runs ok. | 2026-11-02 |
| GPT-6 Sol (`gpt-6-sol`) | — | — | Regression vs `gpt-6.1-sol`; never route to it. | 2026-10-05 |
| GPT-6 Luna (`gpt-6-luna`) | Cheap single-step lane; 272k ctx | `medium` | Leaves multi-step chains incomplete; `xhigh`/`max` can trip a Codex compaction loop. | 2026-10-05 |
| GPT-6 Astra (`gpt-6-astra`) | Escalation for large multi-file work | `high` | Scope creep: needs explicit non-goal fences; rationed on Plus. | 2026-10-05 |
| GPT-6.1 Terra (`gpt-6.1-terra`) | Screens/images, computer use, plain writing; 1M ctx | `high` | Not a coding lane: route code to `gpt-6.1-sol`. Needs Codex CLI ≥ 0.159.0. | 2026-11-02 |
| Grok 4.7 (`grok-4.7`) | Overflow only | — | Slowest and costliest per task on long agentic work. | 2026-10-05 |

Safeguards apply to all Claude 5.x tiers; spawning a higher tier does not escape them.
<!-- model-facts:end -->

## Personal picks

Read `~/.agents/delegation-notes.md` if present; it overrides the defaults above for this user.

## Keeping this current

- After each delegated task settles, if `~/git/agent-home` exists, its stats hooks record an `agent_run` line (model, effort, job, outcome, duration — never task text) in `stats/<host>.jsonl`. Don't log manually unless asked.
- A weekly updater agent refreshes the model-facts block from those records plus provider release notes: follow `scripts/update-model-facts.md`. Details: `UPDATING.md`.
