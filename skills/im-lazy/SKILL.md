---
name: im-lazy
description: "Hands-off feature loop: discuss one feature per chat into a self-contained docs/plan_<slug>.md, then in one fresh chat ticket, build, review, and land every ready plan with subagents while the human runs /to-tickets per plan and says 'go' once. Use whenever the user says im-lazy, wants to 'discuss' a feature into a plan, wants to 'run' or 'ship all the ready plans', asks how to hand a batch of plan files to agents, or mentions plan_*.md, ready-for-agent, or an agent loop."
---

# im-lazy

Two modes. **discuss** turns one feature into a plan file the runner can build
without you. **run** builds every ready plan in one chat. The human's job is to
answer product questions in discuss, and in run to invoke `/to-tickets` per
plan and then say `go`.

Argument is the mode: `/im-lazy discuss <what I want>` or `/im-lazy run`.
No argument: ask which.

## Before either mode

1. Read `.im-lazy.md` at the repo root (format: `references/config.md`). If
   it is missing, start from `assets/im-lazy.example.md`, derive `test` and
   `setup` from the repo's AGENTS.md or package scripts, show every value you
   would write, and wait for a yes. Never guess `main_branch`; never write a
   default `test`.
2. Check the companion skills are installed: `to-tickets`, `code-review`,
   `tdd`. Find them with `find ~/.claude -name SKILL.md -path '*<name>*'`;
   never pin a version path. Run mode stops without the first two. If any is
   missing, print:

   ```
   im-lazy needs Matt Pocock's engineering skills.
   Install: npx skills add mattpocock/skills
   Then run /setup-matt-pocock-skills once in this repo.
   ```

   Do not reimplement them inline. Their behaviour is the contract, not a
   snapshot of it, and they may change under you. `to-tickets` is
   human-invoked only (`disable-model-invocation`); respect that. You ask the
   human to run it, you never run or emulate it.

## Plan file contract

A plan is `<plan_dir>/plan_<slug>.md` and starts with:

```
# <Title>
Status: draft | ready-for-agent | implemented (<commits>)
Depends on: none | plan_<slug>, plan_<slug>
```

`ready-for-agent` means the runner, which never sees the discussion chat, can
build it from the file alone: paths and line refs, numbered decisions with
reasons, the tests to write, a "not in scope" list, and a dependency-ordered
implementation list that names files per step. That list is also the worker's
scope fence, because `to-tickets` deliberately leaves file paths out of
tickets. Skeleton: `references/plan-template.md`.

## discuss mode

One feature per chat. The output is a plan file, not code.

1. Restate the ask in one line. If the user attached screenshots, say what
   you see in them.
2. Scout before proposing: spawn a read-only subagent to find the relevant
   files, current behaviour, and existing tests. Quote paths and line numbers
   back. Proposals without this are guesses the runner will inherit.
3. Write `plan_<slug>.md` early with `Status: draft`, and update it as the
   discussion moves. The file is the memory; the chat is not.
4. Split trigger: more than 8 implementation steps, more than 2 top-level
   areas (e.g. server/web/mobile/contracts), or more than ~15 files. Propose
   a split into plans linked by `Depends on` before writing decisions.
5. When the user asks to stress-test, spawn a red-team subagent with the plan
   and scout findings; fold real findings back as decisions or risks.
6. The discussion is finished when the only open items are product calls.
   List them plainly and ask. A technical gap (no UI yet, storage shape
   missing) is your call: decide it and record it.
7. Blind check before `ready-for-agent`: spawn a fresh subagent with only the
   plan path and this prompt: "You will implement this with no other context.
   List every point where you would have to guess, one line each, with the
   section it belongs in. Output NONE if there are none." Fix technical
   guesses in the plan; send product guesses to the human. Repeat until NONE.
8. Set `Status: ready-for-agent`, fill `Depends on` by checking which other
   plans touch the same files, and tell the user to `/clear` and start the
   next feature.

Do not write feature code in discuss mode. Do not fold two features into one
plan; a second plan with a `Depends on` line is cheaper than one big plan.

## run mode

One chat, all ready plans. You are the orchestrator: you never write feature
code, workers do. Full loop: `references/run-mode.md`. Literal worker and
reviewer prompts: `references/prompts.md`. Outline:

1. Preflight: primary checkout is on `main_branch` and clean; otherwise stop
   and say what to fix. Read the state file; trust it over your memory. Apply
   the resume rules to any `in-progress` row.
2. List plans with `Status: ready-for-agent` and no ticket rows. Order by
   `Depends on`; refuse cycles and name them.
3. Ticketing: for each plan in order, print `/to-tickets <plan path>` and ask
   the human to run it in this chat. Its approval quiz is theirs. Read back
   what it published; write one state row per ticket. Then print the table
   and **stop for `go`**. This is the one gate; it exists so the human can
   pull a plan before any worktree is created.
4. On `go`: per ticket, one worker in its own worktree (`references/prompts.md`),
   then the config's `test`, then a reviewer wrapping `/code-review` with a
   forced `VERDICT` line, then land. Tickets of one plan run in order; plans
   with no path between them run in parallel, at most 2 workers.
5. Write the state file before every next action. After a plan's last ticket
   lands, its `Status: implemented (<shas>)` line rides that ticket's branch,
   never a direct commit on main.
6. Stop when no row is `open`. Print the receipt per plan. Every 5 landings,
   tell the human they may `/clear` and re-run `/im-lazy run`; resume rules
   carry the batch.

Rules that keep this safe to leave alone:

- Never work on `main_branch` directly. One worktree per ticket, removed
  after landing. Never rewrite main history. Never push.
- Landing is serial and done only by you; that is the lock. Merge conflicts
  go back to the worker once, then park.
- A failing review goes back to the worker once. A second failure parks the
  ticket with the reason. Parking cascades: every ticket that transitively
  lists it in blocked-by parks too, every plan that depends on this plan is
  skipped, unrelated tickets continue.
- Never guess a decision the plan leaves open. Park and note it for the next
  discuss chat.
- `--dry-run` does steps 1–2, prints plan order and a guessed ticket split
  from each plan's implementation list, and touches nothing.
