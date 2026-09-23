# im-lazy

Copy to `.im-lazy.md` at the repo root and fill the two `<...>` values from
your repo's AGENTS.md or package scripts. There is no safe default for
either; the runner refuses to start while they are placeholders.

## config

plan_dir: docs
state_file: .scratch/orchestration/STATE.md
main_branch: main
test: <targeted typecheck + tests, e.g. `vp test run <files>` or `pnpm -F web test`>
setup: <install step for a fresh worktree, e.g. `vp i` or `pnpm i`; delete this line if none>
worktree_dir: .worktrees
