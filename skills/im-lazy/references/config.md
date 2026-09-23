# `.im-lazy.md` config

Lives at the repo root. Markdown with one `key: value` per line under a
`## config` heading so humans can add notes above it.

| key | required | meaning |
|---|---|---|
| `plan_dir` | yes | where `plan_<slug>.md` files live, e.g. `docs` |
| `state_file` | yes | orchestration ledger, e.g. `.scratch/orchestration/STATE.md` |
| `main_branch` | yes | branch tickets land on. Never guessed. |
| `test` | yes | run in a worktree before review and after merging main. Derive it from the repo's AGENTS.md or package scripts; targeted checks if the repo forbids repo-wide ones. Never defaulted. |
| `setup` | no | run once after `git worktree add`, e.g. an install step. Needed when a bare worktree has broken module resolution. |
| `worktree_dir` | no | where worktrees are created; default `.worktrees` |
| `workflow_doc` | no | extra repo rules workers read first, e.g. `docs/WORKFLOW.md` |

Landing is not configurable: it is `git merge <main_branch>` inside the
worktree, then `git merge --ff-only` on the primary checkout. Branches are
`im-lazy/<plan>-<NN>`.

The state file is created on first run if missing. Its shape:

```
# Orchestration state

| plan | ticket | title | blocked-by | branch | status | attempts | sha | notes |
|---|---|---|---|---|---|---|---|---|
```

`status` is one of `open`, `in-progress`, `landed`, `parked`. A parked row
always has a reason in `notes`. `attempts` is `test:N review:N merge:N` so
the one-bounce rule survives a `/clear`.
