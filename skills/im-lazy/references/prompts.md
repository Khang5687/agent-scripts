# Literal prompts

Fill the `<...>` slots. Do not add to these prompts per run; consistency is
the point. Both agents report in a fixed shape so the orchestrator can fill
the state row without reading a transcript.

## Worker

```
You are building one ticket in the worktree <wt> on branch im-lazy/<plan>-<NN>.
Read, in this order: <ticket ref>, <plan path>, <workflow_doc if any>.
The plan's Decisions are final. Do not re-open them.

Scope: edit only files named in the plan's Implementation step(s) for this
ticket, plus their tests. If you need another file, stop and report
NEEDS_SCOPE with the path and the reason.

Use /tdd. The seams in the plan's Tests section are already confirmed; do not
ask about them. Never guess a decision the plan leaves open: report
NEEDS_DECISION with the question.

Run `<test>` before reporting. Commit on your branch only, small commits with
plain subjects. Never touch <main_branch>. Never push. Never start dev
servers.

<if last ticket of the plan:>
This is the plan's last ticket. As your final commit, change the plan's
`Status:` line to `Status: implemented (<your shas>)`.

Report exactly, max 15 lines:
STATUS: DONE | NEEDS_SCOPE | NEEDS_DECISION | BLOCKED
COMMITS: <sha> <subject>, ...
TESTS: pass | fail <one line>
DEFERRED: <items or none>
HUMAN_VERIFY: <items or none>
DETAIL: <one line, only if STATUS is not DONE>
```

Bounce-back (test failure, review FAIL, or merge conflict) reuses the same
worker with one extra line at the top:

```
Fix the following and report again in the same shape:
<test output | review findings | "merge <main_branch> conflicts in <files>; resolve keeping both intents, commit">
```

## Reviewer

Runs with cwd `<wt>`.

```
Run /code-review. Fixed point: <main_branch>. Spec: <ticket ref> and
<plan path>. Do not ask the user anything; if the spec is unclear, treat
that as a spec-axis finding.
After the review output, add one final line:
VERDICT: PASS | FAIL <missing or wrong spec items, one line each>
Only a spec-axis finding fails the review. Standards findings go under
DEFERRED: on the line before VERDICT.
```

## Blind completeness check (discuss mode)

Fresh subagent, given only the plan path:

```
Read <plan path>. You will implement it with no other context and no way to
ask. List every point where you would have to guess, one line each, with the
section it belongs in. Output NONE if there are none.
```

## Dry-run ticket guess (run --dry-run)

No subagent. Group the plan's Implementation steps into tickets by shared
files and blocking order, and print them as "would ticket:" lines. Say it is
a guess; the real split comes from /to-tickets.
