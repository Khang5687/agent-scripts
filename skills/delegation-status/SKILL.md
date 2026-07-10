---
name: delegation-status
description: "Show who's been doing the delegated work: executor/subagent/kept-in-Claude breakdown, accounts, outcomes, recent tasks. Use when the user asks /delegation-status, 'what has been delegated', 'which model is being used most', or 'delegation history'."
---

# Delegation Status

Run and display, verbatim (default = current project, last 7 days):

```bash
python3 ~/.claude/skills/delegate-to-other-agents/scripts/delegation-log.py status
```

Arguments the user may ask for: `--all` (every project), `--days N`, `--recent N`.

After the raw output, add at most 2 sentences of insight if something stands out (one target dominating, unusual failure rate, quota churn). No insight-worthy pattern → no commentary.

Empty log = the delegation skill hasn't dispatched anything yet (logging obligations live in `delegate-to-other-agents` §5/§7); say so plainly.
