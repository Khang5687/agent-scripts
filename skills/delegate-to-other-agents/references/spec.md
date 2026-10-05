# Executor spec

Read when SKILL.md §5 reaches the spec step. Executors start with zero session context: everything they need is in this one document.

## Shape

1. **Goal** — the frozen plan (§2): what changes, in which files/areas, the approach.
2. **Non-goals** — what stays untouched. Astra specifically: name the tests, abstractions, and files it may *not* add; its documented failure mode is unrequested tests and architecture. Out-of-scope diff is a failed round (§7) for any executor.
3. **Constraints** — repo conventions that bear on this diff; distilled skills (below); the scope sentence, verbatim in every spec:

   > You may edit only <named files/areas> and run local commands/tests; leave all changes uncommitted. Do not commit, push, release, tag, open/merge PRs, publish, or mutate remote state.

   Recon lanes replace it with: "Do not edit files."
4. **Proof** — the required verification commands, or one concrete manual check. No-run only for docs/comment/rename changes with listed paths.
5. **Output shape** — what the final message must contain (files touched, commands run with results, open questions).

Credentials, tokens, and content obtained through session tools stay out of the spec.

## Skills propagation

Executors never see Claude's skills; the orchestrator selects and packages them. Package every spec to the Grok floor (no skill mechanism); Codex's `~/.codex/skills` discovery is a bonus, never the contract. Executors read only the exact paths you list — "browse the skills directory" is never an instruction.

- **Behavioral skills** (style/method) → distill into Constraints: ≤8 bullets / ≤120 words, only diff-changing rules (decision ladder, hard bans, safety floors, intensity). Strip triggers, frontmatter, examples, session language. Name the source ("Constraints (from <skill>): …") so review can check compliance. Inline text is the channel; a path alone is not.
- **Reference skills** (in-repo API docs, e.g. `.agents/skills/<name>/`) → ≤3 exact paths, conditional and observable: "Before touching widget config, read `.agents/skills/appintents/SKILL.md`." Add the fence: "Read only the listed paths." Need >3 → the task is too broad: split lanes or synthesize an integration brief first. Inline only a task-critical excerpt/checklist ≤15 lines; indexes stay out.
- **Precedence**: spec > repo AGENTS.md/conventions > skill philosophy. Resolve every conflict (including skill-vs-skill) at freeze time; the executor receives decisions, not debates. Claude-only frontmatter (`context: fork`, `agent:`) stays out of specs.
- Paths must be readable from the executor cwd (repo-relative preferred); plugin-only skills → distill the needed fact or keep the work in Claude. Parallel lanes: each lane gets only its own skills. Recon lanes usually get none. Zero skills is valid — under-include over speculate.
- Verify fails because guidance was ignored → resume with "you violated constraint X; re-read <path> and fix" — the retry carries the pointer, not the full skill body.
