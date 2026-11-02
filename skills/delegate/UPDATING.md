# Updating `delegate`

Only the block between `<!-- model-facts:start -->` and `<!-- model-facts:end -->` in `SKILL.md` changes on routine updates. The rules and "How to delegate" sections change only by deliberate human edit.

Cadence: weekly, plus whenever a provider ships or retires a model.

Who runs it:
- **Owner (Khang5687):** a scheduled agent from the private agent-home repo runs `scripts/update-model-facts.md`, commits on a branch, and opens a PR here.
- **Anyone else:** run the same prompt in any harness (Claude Code, OMP, Codex). It writes your findings to `~/.agents/delegation-notes.md` and, if you have `gh`, opens a PR from your fork.

Block format: one Markdown table row per model — `Model | Role | Effort ceiling | Notes | Last verified (YYYY-MM-DD)` — followed by optional one-line caveats. Keep it under ~20 rows; drop retired models.
