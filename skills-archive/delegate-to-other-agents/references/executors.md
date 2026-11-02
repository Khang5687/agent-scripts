# Executor invocation

Read when SKILL.md §5 reaches the invoke step. Preflight, spec, and the failure policy stay in SKILL.md; this file is the exact commands.

Verified 2026-10-05 against codex-cli 0.160.0 and grok 1.0.46.

## Codex

Prompt via temp file, never inline; per-lane output files; model and effort per the §3 lane:

| Lane | `model` | `model_reasoning_effort` |
|---|---|---|
| default | `gpt-6.1-sol` | `high` |
| cheap / single-step | `gpt-6-luna` | `medium` — `xhigh`/`max` trip a compaction loop on long Luna sessions (codex#41318; not re-tested on 0.160) |
| escalation | `gpt-6-astra` | `high` |

```bash
P=$(mktemp); OUT=$(mktemp); ERR=$(mktemp)
cat >"$P" <<'EOF'
<spec>
EOF
command codex exec --yolo -C <repo> \
  -c model="gpt-6.1-sol" \
  -c model_reasoning_effort="high" \
  -o "$OUT" - <"$P" 2>"$ERR"
```

- `command codex` bypasses the zsh wrapper; not on PATH → `fnm exec --using default -- codex`. Outside a git repo add `--skip-git-repo-check`. `--yolo` is the hidden alias of `--dangerously-bypass-approvals-and-sandbox`.
- Background runs keep stdin redirected from the spec file (`- <"$P"`); a background `codex exec` with an open stdin hangs forever.
- Read the `-o` file, not the stream. The session id is the `session id: <uuid>` line in `$ERR`; record it — required for any resume.
- Quiet runs: leave alone for 30 min (except the §2 stop-override). After 30 min quiet, check process liveness plus the `-o` file / `git status` twice ≥10 min apart; failure only when the process exited or is demonstrably hung, never because `git status` is unchanged.

Follow-ups (`resume` has no `-C`/`--yolo`; run from the repo dir; `--last` only when exactly one recent session exists, else `resume <session-id>`):

```bash
(cd <repo> && command codex exec resume <session-id> \
  -o "$OUT" - <"$P2" 2>"$ERR")
```

Add `--dangerously-bypass-approvals-and-sandbox` when the follow-up must edit files.

## Grok

Single model (`grok-4.7`, default alias `grok-build`). No `-o` flag (redirect stdout); no stdin prompt, so `$(cat)` is the one exception to never-inline. Oversized spec → make `-p` just "Read and execute the spec file at <path>":

```bash
grok --no-alt-screen -m grok-4.7 --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P")" >"$OUT" 2>"$ERR"
```

Follow-ups — same flags, resume by recorded session id (`-r` with no id = most recent for that cwd; safe only when exactly one session exists there):

```bash
grok -r <recorded-session-id> --no-alt-screen -m grok-4.7 --always-approve \
  --cwd <repo> --output-format plain \
  -p "$(cat "$P2")" >"$OUT" 2>"$ERR"
```

## Resume rules (both)

Resume only the same executor in the same repo, by the recorded session id. Unsure which session → fresh run with the frozen spec + `git diff`/status, never a guess. Cross-executor and cross-account are always fresh runs.
