# Update model facts (agent prompt)

You are refreshing the model-facts block of the `delegate` skill. Follow these steps exactly. Never include prompt or task text from logs in anything you write.

## 1. Gather local evidence

- If `~/git/agent-home/stats/` exists, read every `*.jsonl` file there. Use only lines where `"kind":"agent_run"`. For the last 30 days, per `model` (and `effort`): count runs, share of `outcome` = `ok` / `fail` / `cancelled`, median `duration_s`, and the `job` mix. Flag any model with ≥5 runs and fail+cancelled > 30%.
- Note local model availability if cheap to check (e.g. `~/.codex/models_cache.json`, the harness's model list). Local facts outrank web claims about availability.

## 2. Check providers

Via web search/fetch, read the current official sources:
- Anthropic: model overview / release notes / deprecations (docs.anthropic.com, anthropic.com/news), Claude Code model-config docs (aliases).
- OpenAI: models list, Codex changelog, deprecations (platform.openai.com/docs, openai.com/index).
Record new models, retirements, alias changes, effort/thinking limits, and documented regressions. Cite URLs in your summary, not in the block.

## 3. Rewrite the block

Edit `skills/delegate/SKILL.md` (installed copy: `~/.agents/skills/delegate/SKILL.md` or the repo checkout):
- Change ONLY the lines between `<!-- model-facts:start -->` and `<!-- model-facts:end -->`. Keep the table columns.
- Rows you confirmed unchanged: keep the text, set "Last verified" to today.
- Rows you could not confirm: keep the text and the old date.
- Add rows for new relevant models; remove retired ones. Keep notes to one line, firm verdicts, no "use judgment".
- Local stats that contradict a note → add the finding to Notes (e.g. "local: 40% fail on implement, 12 runs") rather than silently deleting the note.

## 4. Publish

**Owner instance** (repo checkout with remote `Khang5687/agent-scripts` you can push to):
```bash
git switch -c model-facts/$(date +%Y-%m-%d)
git add skills/delegate/SKILL.md
git commit -m "delegate: refresh model facts $(date +%Y-%m-%d)"
git push -u <remote-for-Khang5687/agent-scripts> HEAD
gh pr create --repo Khang5687/agent-scripts --base main --fill
```
Do not merge.

**Everyone else:**
1. Append a dated section to `~/.agents/delegation-notes.md` (create if missing) with your findings and any personal picks your stats support. Optionally update your installed copy's block.
2. If `gh` is installed and authenticated: `gh repo fork Khang5687/agent-scripts --clone`, apply the block change in the clone on a new branch, commit, push to your fork, and `gh pr create --repo Khang5687/agent-scripts --base main` with the findings and sources in the body. Do not include personal notes or stats files.

## 5. Report

Print: rows changed/added/removed, sources consulted, stats summary, and the PR URL (if any).
