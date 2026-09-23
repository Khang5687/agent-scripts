# run mode, in detail

## 0. Preflight

- Primary checkout: `git branch --show-current` equals `main_branch` and
  `git status --porcelain` is empty. Detached HEAD or dirty tree: stop, say
  what to do (`git switch <main_branch>`, stash or commit), do nothing else.
- Config has `test`, `main_branch`, `state_file`, `plan_dir`. `setup` is
  optional but ask once if the repo has an install step and it is absent.
- Companion skills present (see SKILL.md).

## 1. Resume (every run chat, before anything else)

For each `in-progress` row in the state file:

- Worktree missing: delete the branch if it exists, set the row to `open`,
  note "worktree gone, restarted".
- Worktree present with commits past the merge-base: keep it. Discard
  uncommitted work (`git -C <wt> reset --hard && git -C <wt> clean -fd`).
  Set the row to `open`, note "resume from branch". The next worker for that
  ticket continues from the existing commits.
- Worktree present with no commits: remove it, set the row to `open`.

Resumed rows are never auto-started. Print the table and wait for `go` again.

## 2. Plan selection

- Parse `Status:` and `Depends on:` from the first five lines of every
  `plan_*.md`. Anything else is `draft`.
- Eligible: `ready-for-agent` and no row in the state file. A plan whose
  dependency is `draft` or has a parked row is not eligible; say why.
- Topologically sort. On a cycle, print the cycle and stop.

## 3. Ticketing

You cannot invoke `/to-tickets` and must not emulate it. For each eligible
plan, in dependency order:

1. Print exactly: `Run /to-tickets <plan path> now, then tell me when it has
   published.` Wait.
2. Read back what it published: local files under `.scratch/<slug>/issues/`
   or tracker issues carrying the `ready-for-agent` label. Read the layout,
   do not assume it.
3. Write one state row per ticket: plan, ticket ref (path or issue number),
   title, blocked-by, `status: open`, branch `im-lazy/<plan>-<NN>`.

Work only from the state rows plus each ticket's body fetched by ref. Then
print the table and stop. Wait for the literal `go`. Anything else is a
question; answer it and wait again.

## 4. Building a ticket

1. `git worktree add <worktree_dir>/<plan>-<NN> -b im-lazy/<plan>-<NN> <main_branch>`.
   If `setup` is configured, run it in the worktree.
2. Set the row to `in-progress`, write the state file.
3. Spawn one worker with the worker prompt (`prompts.md`). Read only its
   report, never its transcript.
   - `NEEDS_SCOPE`: if the path is in the plan's implementation list for a
     sibling ticket, park with "needs sibling <NN>". Otherwise allow it once
     and re-run the worker with the path added.
   - `NEEDS_DECISION` or `BLOCKED`: park with the reason.
4. Run `test` in the worktree. Fail: send the output to the same worker once.
   Fail again: park.
5. Spawn the reviewer with the reviewer prompt. `FAIL`: send the review to the
   worker once. Second `FAIL`: park.
6. Land (below).

Attempts are counted per ticket in the state row, not remembered.

## 5. Landing (orchestrator only, one ticket at a time)

1. In the worktree: `git merge <main_branch>`. Conflict: send it back to the
   same worker once ("resolve, keep both intents, commit"). Still conflicted:
   `git merge --abort`, park "conflict with <sha>".
2. If step 1 brought in commits, run `test` again. Fail: worker gets one fix
   attempt, then park.
3. If this is the plan's last open ticket, the worker adds the plan's
   `Status: implemented (<shas>)` line as a commit on the ticket branch.
4. In the primary checkout: `git merge --ff-only im-lazy/<plan>-<NN>`. If
   fast-forward fails, main moved: go back to step 1.
5. `git worktree remove`, `git branch -d`, set the row to `landed` with the
   sha. Never push.

## 6. Parking and cascade

A parked row always has a reason in `notes`. When a ticket parks:

- Every ticket that transitively lists it in blocked-by parks with
  "blocked by <NN>".
- Every plan whose `Depends on` names this plan is skipped with that reason.
- Unrelated tickets and plans continue.

## 7. Parallelism

Plans with no path between them in the dependency graph run at the same time
in separate worktrees. Tickets inside one plan run in order. Cap: 2 workers.
Each worktree runs its own `setup` and typecheck on one machine; past 2 the
merges and the machine both slow down.

## 8. Context

The state file is your only memory. Rows carry: plan, ticket ref, title,
blocked-by, branch, status, attempts, sha, notes. Write it before every next
action. You only ever read the 15-line worker and reviewer reports. After
every 5 landings, tell the human: "You may `/clear` and run `/im-lazy run`
again; the state file continues this batch."

## 9. Receipt

```
## <plan>
- landed: <sha> <NN> <title>, ...
- parked: <NN> <title> — <reason>
- deferred: <items workers reported>
- human verify: <items workers reported, plus a real-client pass if the
  repo's rules ask for one, plus closing tracker issues if they were
  published as issues>
```
