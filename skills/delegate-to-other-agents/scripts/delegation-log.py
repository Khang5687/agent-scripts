#!/usr/bin/env python3
"""delegation-log.py — record and display who did what in the delegation skill.

Log (append-only JSONL, global): ~/.claude/delegation-log.jsonl

Commands:
  log <kind> <target> [--account A] [--outcome ok|fail|recovered|n/a]
      [--project P] -- <task text...>
        kind   = executor | subagent | kept | quota
        target = codex-terra, codex-luna, codex-sol, grok, sonnet, opus,
                 fable, claude (for kept), or a quota event like
                 rotate/mark-5h/mark-weekly/mark-auth-failed
  status [--all] [--days N] [--recent N]
        summary + recent view; current project by default, --all for global

Project is auto-detected (git toplevel name, else cwd basename) unless
--project is given. Timestamps are local time.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime

LOG_PATH = os.path.expanduser("~/.claude/delegation-log.jsonl")
KINDS = ("executor", "subagent", "kept", "quota")
OUTCOMES = ("ok", "fail", "recovered", "n/a")


def detect_project():
    try:
        out = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return os.path.basename(out.stdout.strip())
    except Exception:
        pass
    return os.path.basename(os.getcwd())


def cmd_log(argv):
    if len(argv) < 2:
        die("usage: log <kind> <target> [--account A] [--outcome O] "
            "[--project P] -- <task...>")
    kind, target = argv[0], argv[1]
    if kind not in KINDS:
        die(f"kind must be one of {'/'.join(KINDS)}")
    account = project = None
    outcome = "n/a" if kind in ("kept", "quota") else "ok"
    rest = argv[2:]
    task_words = []
    i = 0
    while i < len(rest):
        a = rest[i]
        if a == "--account":
            account = rest[i + 1]; i += 2
        elif a == "--outcome":
            outcome = rest[i + 1]; i += 2
        elif a == "--project":
            project = rest[i + 1]; i += 2
        elif a == "--":
            task_words = rest[i + 1:]; break
        else:
            task_words = rest[i:]; break
    if outcome not in OUTCOMES:
        die(f"outcome must be one of {'/'.join(OUTCOMES)}")
    task = " ".join(task_words).strip()
    if not task and kind != "quota":
        die("task text required (after --)")
    entry = {
        "ts": int(time.time()),
        "project": project or detect_project(),
        "kind": kind,
        "target": target,
        "account": account,
        "outcome": outcome,
        "task": task,
    }
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"logged: {kind} {target} [{outcome}] {task[:60]}")


def read_entries():
    if not os.path.exists(LOG_PATH):
        return []
    out = []
    for line in open(LOG_PATH):
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def bar(n, peak, width=10):
    return "█" * max(1, round(width * n / peak)) if peak else ""


def cmd_status(argv):
    all_projects = "--all" in argv
    days = 7
    recent_n = 12
    if "--days" in argv:
        days = int(argv[argv.index("--days") + 1])
    if "--recent" in argv:
        recent_n = int(argv[argv.index("--recent") + 1])
    project = detect_project()
    cutoff = time.time() - days * 86400
    entries = [e for e in read_entries() if e["ts"] >= cutoff
               and (all_projects or e["project"] == project)]
    scope = "all projects" if all_projects else f"project: {project}"
    print(f"DELEGATION STATUS ({scope}, last {days}d)\n")
    if not entries:
        print("  no entries for this filter — try --all or --days 30")
        return

    work = [e for e in entries if e["kind"] in ("executor", "subagent", "kept")]
    quota = [e for e in entries if e["kind"] == "quota"]

    # by target
    counts = {}
    for e in work:
        counts[e["target"]] = counts.get(e["target"], 0) + 1
    peak = max(counts.values(), default=0)
    label_w = max((len(t) for t in counts), default=0)
    print("  by target:")
    for t, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"    {t:<{label_w}}  {bar(n, peak)} {n}")

    # accounts
    accts = {}
    for e in work:
        if e.get("account"):
            accts[e["account"]] = accts.get(e["account"], 0) + 1
    if accts:
        print("  accounts:   " + " · ".join(
            f"{a} {n}" for a, n in sorted(accts.items(), key=lambda kv: -kv[1])))

    # outcomes
    ok = sum(1 for e in work if e["outcome"] == "ok")
    fail = sum(1 for e in work if e["outcome"] == "fail")
    rec = sum(1 for e in work if e["outcome"] == "recovered")
    kept = sum(1 for e in work if e["kind"] == "kept")
    line = f"  outcomes:   ✓ {ok + rec}"
    if fail:
        line += f"   ✗ {fail}"
    if rec:
        line += f"   ({rec} quota-recovered)"
    print(line)
    extras = []
    if kept:
        extras.append(f"kept in Claude: {kept}")
    if quota:
        extras.append(f"quota events: {len(quota)}")
    if extras:
        print("  " + " · ".join(extras))

    # recent
    print("\n  RECENT")
    sym = {"ok": "✓", "fail": "✗", "recovered": "✗→✓", "n/a": "·"}
    for e in sorted(entries, key=lambda x: -x["ts"])[:recent_n]:
        t = datetime.fromtimestamp(e["ts"]).strftime("%m-%d %H:%M")
        acct = e.get("account") or "—"
        proj = f"  [{e['project']}]" if all_projects else ""
        task = (e["task"][:56] + "…") if len(e["task"]) > 57 else e["task"]
        print(f"  {t}  {e['target']:<12} {acct:<6} {sym.get(e['outcome'], '?'):<3} "
              f"{task}{proj}")


def die(msg, code=2):
    print(f"delegation-log: {msg}", file=sys.stderr)
    sys.exit(code)


def main():
    args = sys.argv[1:]
    if not args:
        die(__doc__.strip())
    if args[0] == "log":
        cmd_log(args[1:])
    elif args[0] == "status":
        cmd_status(args[1:])
    else:
        die(f"unknown command '{args[0]}'")


if __name__ == "__main__":
    main()
