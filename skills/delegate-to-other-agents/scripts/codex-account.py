#!/usr/bin/env python3
"""codex-account.py — multi-account switching for Codex CLI, compatible with codex-switcher.

Mirrors codex-switcher's own Rust logic exactly (switch_to_account +
update_account_chatgpt_tokens + touch_account), so the app and this script can
be used interchangeably without desyncing each other.

Commands:
  status          active account + latest local rate-limit snapshot (5h/weekly %);
                  also records the observation into the local usage ledger
  list [--json]   all accounts; --json adds plan, ledger observations, and flags
  next            sync back current tokens, rotate to least-recently-used account
  switch <name>   sync back current tokens, switch to the named account
  mark <name> <5h|weekly|no-sol|auth-failed>   record a quota/capability event
  clear <name>    remove all flags for an account

The ledger (~/.codex-switcher/usage-ledger.json) is a sidecar this script owns;
codex-switcher never reads it. It holds last-known usage per account so an
orchestrator can pick accounts despite stale knowledge. Decisions live in the
caller; this script only records facts and performs switches.

Token safety: before any switch, tokens currently in ~/.codex/auth.json are
copied back into accounts.json for the account they belong to (matched by
account_id) — codex CLI rotates refresh tokens, and losing the newest one
would invalidate the stored copy. All writes are atomic (temp + rename), 0600.
"""

import glob
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone

CODEX_HOME = os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
AUTH_PATH = os.path.join(CODEX_HOME, "auth.json")
STORE_PATH = os.path.expanduser("~/.codex-switcher/accounts.json")


def now_rfc3339():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


def atomic_write(path, obj):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-codex-account-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def load(path):
    with open(path) as f:
        return json.load(f)


LOCK_PATH = os.path.expanduser("~/.codex-switcher/.switch.lock")
LEDGER_PATH = os.path.expanduser("~/.codex-switcher/usage-ledger.json")
NOT_INSTALLED = 4  # exit code: no store — caller should treat as single-account mode
VALID_MARKS = ("5h", "weekly", "no-sol", "auth-failed")


def load_ledger():
    try:
        return load(LEDGER_PATH)
    except (OSError, json.JSONDecodeError):
        return {}


def save_ledger(ledger):
    atomic_write(LEDGER_PATH, ledger)


def ledger_entry(ledger, account_id):
    return ledger.setdefault(account_id, {"flags": {}})


def load_store():
    if not os.path.exists(STORE_PATH):
        die(f"no accounts store at {STORE_PATH} — codex-switcher not set up; "
            "single-account mode (nothing to rotate)", NOT_INSTALLED)
    try:
        return load(STORE_PATH)
    except json.JSONDecodeError as e:
        die(f"accounts store is corrupt ({e}); fix or restore from "
            "~/.codex-switcher/backups/ — refusing to touch it")


class SwitchLock:
    """Guards against two parallel lanes rotating at once. Stale after 30s."""

    def __enter__(self):
        deadline = time.time() + 10
        while True:
            try:
                fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(LOCK_PATH) > 30:
                        os.unlink(LOCK_PATH)  # stale
                        continue
                except OSError:
                    continue
                if time.time() > deadline:
                    die("another switch is in progress (lock held >10s)", 2)
                time.sleep(0.2)

    def __exit__(self, *exc):
        try:
            os.unlink(LOCK_PATH)
        except OSError:
            pass


def die(msg, code=1):
    print(f"codex-account: {msg}", file=sys.stderr)
    sys.exit(code)


def active_account(store):
    aid = store.get("active_account_id")
    return next((a for a in store["accounts"] if a["id"] == aid), None)


def sync_back(store):
    """Copy tokens from auth.json into the store for the account they belong to.

    Matched by ChatGPT account_id, not by active_account_id, so a switch done
    elsewhere can never make us clobber the wrong account. Returns True if the
    store was modified.
    """
    if not os.path.exists(AUTH_PATH):
        return False
    try:
        auth = load(AUTH_PATH)
    except (json.JSONDecodeError, OSError):
        return False
    tokens = auth.get("tokens")
    if not tokens:
        return False  # api-key mode or empty; nothing to sync
    live_acct_id = tokens.get("account_id")
    owner = None
    for a in store["accounts"]:
        ad = a["auth_data"]
        if ad.get("type") != "chat_g_p_t":
            continue
        if live_acct_id and ad.get("account_id") == live_acct_id:
            owner = a
            break
    if owner is None:
        owner = active_account(store)
        if owner is None or owner["auth_data"].get("type") != "chat_g_p_t":
            return False
    ad = owner["auth_data"]
    changed = False
    for k in ("id_token", "access_token", "refresh_token"):
        v = tokens.get(k)
        if v and ad.get(k) != v:
            ad[k] = v
            changed = True
    return changed


def write_auth(account):
    ad = account["auth_data"]
    if ad.get("type") == "api_key":
        auth = {"OPENAI_API_KEY": ad["key"]}
    else:
        auth = {
            "tokens": {
                "id_token": ad["id_token"],
                "access_token": ad["access_token"],
                "refresh_token": ad["refresh_token"],
                "account_id": ad.get("account_id"),
            },
            "last_refresh": now_rfc3339(),
        }
    atomic_write(AUTH_PATH, auth)


def do_switch(store, target):
    synced = sync_back(store)
    write_auth(target)
    store["active_account_id"] = target["id"]
    target["last_used_at"] = now_rfc3339()
    atomic_write(STORE_PATH, store)
    prev = " (tokens synced back)" if synced else ""
    print(f"switched to {target['name']}{prev}")


def cmd_switch(name):
    with SwitchLock():
        store = load_store()
        target = next((a for a in store["accounts"] if a["name"] == name), None)
        if target is None:
            die(f"account '{name}' not found; have: "
                + ", ".join(a["name"] for a in store["accounts"]))
        do_switch(store, target)


def cmd_next():
    with SwitchLock():
        store = load_store()
        masked = set(store.get("masked_account_ids", []))
        aid = store.get("active_account_id")
        candidates = [a for a in store["accounts"]
                      if a["id"] not in masked and a["id"] != aid]
        if not candidates:
            die("no other unmasked account to rotate to (single-account mode)", 2)
        # least-recently-used first
        candidates.sort(key=lambda a: a.get("last_used_at") or "")
        do_switch(store, candidates[0])


def cmd_list(as_json=False):
    store = load_store()
    aid = store.get("active_account_id")
    masked = set(store.get("masked_account_ids", []))
    if not as_json:
        for a in store["accounts"]:
            flags = ("*" if a["id"] == aid else " ") + ("m" if a["id"] in masked else " ")
            print(f"{flags} {a['name']}\t{a.get('plan_type') or '?'}\t"
                  f"last_used={a.get('last_used_at') or 'never'}")
        return
    ledger = load_ledger()
    out = []
    for a in store["accounts"]:
        led = ledger.get(a["id"], {})
        obs_ts = led.get("ts")
        out.append({
            "name": a["name"],
            "plan": a.get("plan_type"),
            "active": a["id"] == aid,
            "masked": a["id"] in masked,
            "subscription_expires_at": a.get("subscription_expires_at"),
            "last_used_at": a.get("last_used_at"),
            "last_observed": {
                "5h_pct": led.get("h5"), "weekly_pct": led.get("weekly"),
                "ts": obs_ts,
                "age_s": int(time.time() - obs_ts) if obs_ts else None,
            },
            "flags": led.get("flags", {}),
        })
    print(json.dumps(out, indent=1))


def latest_rate_limits():
    """Newest rate_limits snapshot from ~/.codex/sessions/**/rollout-*.jsonl."""
    files = glob.glob(os.path.join(CODEX_HOME, "sessions", "**", "rollout-*.jsonl"),
                      recursive=True)
    if not files:
        return None
    for path in sorted(files, key=os.path.getmtime, reverse=True)[:5]:
        try:
            with open(path, "rb") as f:
                lines = f.read().decode(errors="replace").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            rl = find_key(ev, "rate_limits")
            if rl:
                return {"rl": rl, "age_s": int(time.time() - os.path.getmtime(path))}
    return None


def find_key(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            r = find_key(v, key)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_key(v, key)
            if r is not None:
                return r
    return None


def cmd_status():
    store = load_store()
    act = active_account(store)
    name = act["name"] if act else "?"
    snap = latest_rate_limits()
    if snap is None:
        print(f"account={name} 5h=? weekly=? (no rate_limits snapshot found)")
        return
    rl = snap["rl"]
    p = rl.get("primary") or {}
    s = rl.get("secondary") or {}
    # field name varies across codex versions
    p_pct = p.get("used_percent", p.get("used_percentage", "?"))
    s_pct = s.get("used_percent", s.get("used_percentage", "?"))
    print(f"account={name} 5h={p_pct}% weekly={s_pct}% snapshot_age={snap['age_s']}s")
    # record the observation for the active account
    if act is not None and isinstance(p_pct, (int, float)):
        ledger = load_ledger()
        e = ledger_entry(ledger, act["id"])
        e["h5"] = p_pct
        if isinstance(s_pct, (int, float)):
            e["weekly"] = s_pct
        e["ts"] = int(time.time()) - snap["age_s"]
        save_ledger(ledger)
    # exit 3 when hot, so callers can `|| switch`
    try:
        if float(p_pct) >= 85 or float(s_pct) >= 95:
            sys.exit(3)
    except (TypeError, ValueError):
        pass


def account_by_name(store, name):
    a = next((a for a in store["accounts"] if a["name"] == name), None)
    if a is None:
        die(f"account '{name}' not found; have: "
            + ", ".join(x["name"] for x in store["accounts"]))
    return a


def cmd_mark(name, event):
    if event not in VALID_MARKS:
        die(f"mark must be one of {'/'.join(VALID_MARKS)}", 2)
    store = load_store()
    a = account_by_name(store, name)
    ledger = load_ledger()
    e = ledger_entry(ledger, a["id"])
    e["flags"][event] = int(time.time())
    if event == "5h":
        e["h5"] = 100.0
    if event == "weekly":
        e["weekly"] = 100.0
    save_ledger(ledger)
    print(f"marked {name}: {event}")


def cmd_clear(name):
    store = load_store()
    a = account_by_name(store, name)
    ledger = load_ledger()
    ledger.pop(a["id"], None)  # forget flags AND observations (marks seed h5/weekly)
    save_ledger(ledger)
    print(f"cleared ledger entry for {name}")


def main():
    args = sys.argv[1:]
    if not args:
        die(__doc__.strip(), 2)
    cmd = args[0]
    if cmd == "status":
        cmd_status()
    elif cmd == "list":
        cmd_list(as_json="--json" in args)
    elif cmd == "next":
        cmd_next()
    elif cmd == "switch":
        if len(args) < 2:
            die("switch requires an account name", 2)
        cmd_switch(args[1])
    elif cmd == "mark":
        if len(args) < 3:
            die("usage: mark <name> <5h|weekly|no-sol|auth-failed>", 2)
        cmd_mark(args[1], args[2])
    elif cmd == "clear":
        if len(args) < 2:
            die("clear requires an account name", 2)
        cmd_clear(args[1])
    else:
        die(f"unknown command '{cmd}'", 2)


if __name__ == "__main__":
    main()
