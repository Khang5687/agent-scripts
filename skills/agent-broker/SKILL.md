---
name: agent-broker
description: "Use for Netlify, Vercel, Supabase or Apify work (deploys, logs, SQL, migrations, actors), API tokens or .env secrets, Docker Compose secrets on a Linux homelab, or adding a project/account."
---

# Agent broker

The owner has several logins per service. Tokens live only in the **broker** (user `_deployer`, unreadable to
agents). Two layers:

- **Account stack**: one login per service (e.g. stack `acme` = Acme's Netlify + Supabase; stack `global` = default fallback for general projects). Tokens stored once.
- **Project**: a folder, its stack, and the one site / database it may touch (pinned). Nothing else: build folders and
  other settings stay in the project's own files (`netlify.toml`, `vercel.json`, `.actor/`, `supabase/config.toml`),
  read by the real CLI on every call.

**The folder picks the project.** Run `agent-broker` from inside the project folder. Never name an account, site id or
project ref. `gh` is separate (one GitHub account, logged in normally, never touched or logged out by the broker).
## Use it

```sh
agent-broker whoami      # this folder's project, stack, site, database
agent-broker help        # every action
agent-broker <service> <action> [options]
```

- **Deploy**: build as yourself first, then `agent-broker netlify deploy --message "..."` (a draft). It runs
  `netlify deploy --no-build` on the pinned site: netlify.toml `publish` picks the folder, or pass `--dir out`;
  `--prod`, `--alias`, `--functions`, `--json` ... pass through (`agent-broker help`). Add `--prod` only when the owner
  asks (credits). Vercel: `mkdir -p .vercel && agent-broker vercel settings > .vercel/project.json`, `vercel build`,
  `agent-broker vercel deploy`.
- **Supabase**: `query "select ..."` is read-only; `migrate [--dry-run]` applies `supabase/migrations`; any other
  write is `admin-query "..."`, which waits: ask the owner to run `agent-broker-admin approve <id>`, then
  `agent-broker result <id>`.
- **Apify**: `push [--dir <actor folder>]`, `info|builds|runs <actor>`, `logs <run-id>`, `call <actor> --input-file F`,
  `pull <actor> | tar -x`.
- **Plain CLIs** (`netlify`, `supabase`, `apify`, `vercel`) do local work only (`netlify dev`, `supabase start`,
  `vercel build`); account commands stop with a pointer here. For owner manual CLI work with personal global logins,
  pass `--global` (e.g. `netlify deploy --global`) or set `export AGENT_BROKER_BYPASS=1`.
- **Scripts that need a token while running** (nightly jobs, backups) run on GitHub Actions: `gh workflow run ...`.
- **Tokens stay unread**: `.env` secrets, token files, CLI configs, `~/Secrets/*.kdbx`. Never put one in a file,
  argument, log or reply.
- **Errors** "no ... token" or a missing action: stop and ask the owner to run the wizard. `--project NAME` exists
  only for a folder that holds two projects (the error names them).
- **`agent-broker-admin`** is the owner's: it makes a Touch ID prompt on their screen (Linux: a password prompt). Run it
  only when asked.

## New project

"Not inside a registered project" means a new project. Ask the user which stack (`agent-broker stacks`); if a stack
named `global` exists, omitting `--stack` defaults to `global`. In the project folder:

```sh
agent-broker init [--stack <name>] --list    # the stack's sites / databases, and which are free
agent-broker init [--stack <name>] [--netlify-site ID | --netlify-new NAME] [--supabase-ref REF] [--apify]
agent-broker attach --supabase-ref REF       # later: add a service the project does not have yet
```

- `init` registers the git repo root (`--here`: this exact folder) and writes the block into the project's
  `AGENTS.md` / `CLAUDE.md` (refresh: `agent-broker agents-md --write`). No owner approval: it only claims a folder
  nobody owns, on an existing stack, with a site / database of that stack's account that no other project uses.
- `--netlify-new` creates a free Netlify site. A new Supabase project costs money: ask the user to create it on
  supabase.com, then `attach --supabase-ref`. A Supabase ref also gets a read-only database user (`--no-reader` skips).
- A stack that does not exist yet, or lacks a token: the owner adds it with the wizard (menu 1 or 2).

## Owner: the wizard

In your own Terminal app:

```sh
~/git/agent-scripts/skills/agent-broker/scripts/wizard.sh
```

Menu: 1 Add an account stack · 2 Replace a token (one place, every project on the stack) · 3 Add a project
(optional; agents use `init`) · 4 Move a project to another stack · 5 Add a folder (second clone) · 6 AGENTS.md text ·
7 Set up / update. Each save asks for Touch ID once. Git worktrees of a registered repo work without adding them.

Setup / update installs `broker/` to `/opt/agent-broker` (own Node and CLIs), `/usr/local/bin/agent-broker{,-admin}`,
the sudo rule `/etc/sudoers.d/agent-broker` (password every time), and the CLI guard (`/opt/agent-broker/guard`, first
in `PATH` via one line in `~/.zshenv` and `~/.zshrc`). Owner bypass for a real CLI: its full path (`which -a netlify`).
Changing the broker: edit `broker/`, `cd broker && npm test`, then wizard → 7.

## Linux (homelab)

The cloud actions above (`netlify`, `vercel`, `supabase`, `apify`), `init`, `whoami` and `compose` all run on Linux. The
cloud CLIs run in a bwrap sandbox that cannot read the broker's folders; without the owner's AppArmor file (Owner
section) a cloud action stops with one line that names the fix.

```sh
agent-broker health      # one line, exit 0 = the broker can serve every key its groups promise; waiting token copies are notes
agent-broker stacks      # marks: follows_mac (changed on the Mac only), shared (copied to another machine)
agent-broker compose ps | up -d | logs --tail 100 app | pull | down     # instead of docker compose, in the stack folder
agent-broker compose --profile mcp up -d                                 # -f F, --profile, --dry-run before the command
agent-broker compose exec -T db psql -U app < dump.sql                   # stdin passes through; use -T
```

- A compose stack folder is a project; its secrets live in the broker, its `.env` keeps only the non-secret settings.
- Runs in the registered folder only (never a git worktree of it: same Compose project name = live containers).
  `--env-file`, `-p`, `--project-directory` are not offered; drop `--env-file .env` from old runbook commands. `-f`
  takes a file inside the project (not `-`, not a remote reference). Only `exec` gets your stdin.
- Plain `docker compose` there fails on `${VAR:?set VAR}`: that is the cue to use the broker. `docker logs <container>`
  and `docker ps` need no secrets.
- Output is scrubbed of stored values; `compose config` shows `[secret]`.
- Offered commands, one table in `bin/compose-guard.mjs` (a test keeps this line equal to it):
  `up, down, ps, logs, exec, run, pull, restart, stop, start, rm, config, build, images, top, port, version`. Each takes
  only the flags the table names; the rest are refused by name. `down -v` and `rm -v` (volumes) are the owner's to run.

### Keys for services and programs

A service or program gets its keys from its **group**, through the owner's grant, by one of three paths. Each path
belongs to its own caller (the unit, OMP, root); an agent has no use for them and the secret guard refuses them:

- a systemd user unit: its own pre-start step, `ExecStartPre=+/usr/local/bin/agent-broker run <group>`, writes the unit's
  keys into its `RuntimeDirectory=` (tmpfs, 0700). The folder must be exactly `<run root>/<unit>-keys` (one folder, no
  sub-folder): the secret guard hides only those, and `run` refuses any other name;
- OMP: a `models.yml` key line, `apiKey: "!/usr/local/bin/agent-broker key <group> <KEY>"`;
- the owner's root-run setup scripts: `agent-broker-admin get <group> <KEY>`.

A service that lacks a key: ask the owner for a grant (`agent-broker-admin apply --group ...`); never read or copy a key.

- **Group**: the secrets of one thing that owns secrets (a service such as `assistant`, a program such as `omp`). Values live in the broker, never in a file.
- **Grant**: who may get which key. Three kinds: `unit` (one systemd user unit: key files, or env, in its runtime
  folder; a key can be optional), `root` (setup scripts run as root: read the `keys`, store the `write` keys), `omp`
  (OMP processes, found by cgroup and binary folder). Only the owner changes groups and grants;
  `agent-broker-admin list` shows names and grants, never values.

### Install scripts and secrets

An install script writes no secret to a file. For a key the owner has to supply, it prints the line
`agent-broker-admin set-group <group> <KEY>` (hidden input) for the owner to run. For a value the script generates, it
pipes the value into the root write: `printf '%s\n' "$value" | agent-broker-admin set-group <group> <KEY>`. A script run
as root reads a key back with `agent-broker-admin get <group> <KEY>`. Both need a root grant on the group: `get` serves
its `keys`, `set-group` stores its `write` keys (root may store no other key). The script also names the grant the
owner adds: `agent-broker-admin apply --group <group> --grant-root <READ_KEY> --grant-root-write <WRITE_KEY>`.

## Owner: Linux commands (your own terminal, in order)

Each `agent-broker-admin` call asks your password.

1. Install or update (rerun after `git pull`):
   `sudo ~/git/agent-scripts/skills/agent-broker/broker/install.sh`. It creates `_deployer` (your group + docker),
   `/opt/agent-broker` (own Node, the cloud CLIs), the commands, the sudo rule and the CLI guard. It sets `_deployer`'s
   shell to `/bin/sh` so the other machine's one SSH key can deliver tokens; the account has no password.
2. AppArmor, once, so bwrap may run:
   `sudo install -m 644 /opt/agent-broker/apparmor/bwrap /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap`.
   Side effect: every user of the machine, agents included, may then use bwrap. Undo: `sudo apparmor_parser -R /etc/apparmor.d/bwrap && sudo rm /etc/apparmor.d/bwrap`.
3. A compose stack's secrets:
   `agent-broker-admin apply --stack demo --new-stack` (once, a stack with no cloud tokens); in the stack folder
   `agent-broker init --stack demo --here --no-agents-md`; then `agent-broker-admin import <name> .env KEY1 KEY2`
   (moves the secret lines out; Compose quoting is read; a value with a `$` Compose would expand is refused: use
   `agent-broker-admin set <name> KEY`), and `chmod 640 .env`.
4. Key files into a group: `agent-broker-admin import-files <group> KEY=<file> ...` (one password; the files stay, delete
   them once the service works). Add the grant with `apply --group <group> --grant-file <unit>:<file>=KEY` (or
   `--grant-env`, `--grant-root`, `--grant-root-write`, `--grant-omp`).
5. OMP's literal provider keys. First prove one key line on a test key: add a throwaway group and a `models.yml` line
   that calls `agent-broker key <group> <KEY>`, and make one real OMP request with it. Then
   `agent-broker-admin omp-move --exe <OMP binary folder> --name omp` (`--name` is required: the bare name OMP processes
   start under; look at their command lines first, one `--name` per name). It backs up `models.yml` to `models.yml.pre-broker`, stores the keys in
   group `omp`, and rewrites each line to a key line. Shred the backup once OMP works.
6. Health check every 15 minutes: copy `broker/systemd/agent-broker-health.service` and `.timer` to
   `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now agent-broker-health.timer`.
   The control-room status writer is set in the service file: `AGENT_BROKER_STATUS_WRITER` and
   `AGENT_BROKER_STATUS_DIR` (commented lines there; put them in a drop-in with `systemctl --user edit agent-broker-health.service`).
7. Copy cloud tokens from a sending machine (the Mac) to a receiving one (this machine). Host key first, from the
   receiving machine, so nothing is trusted on first use:
   1. Receiver: `cat /etc/ssh/ssh_host_ed25519_key.pub`.
   2. Sender: `agent-broker-admin sync-setup --to <receiver address> --host-key '<that line>'` (`--user`, `--port`
      optional); it opens no connection and prints the sender's public key line. On a Mac, rerun the install first
      (wizard menu 7): it adds the job that retries waiting copies every 10 minutes.
   3. Receiver: `agent-broker-admin trust-mac '<that public key line>' --from <sender address> --stacks <a,b>`. The
      sender may copy only into the stacks named there (never `global`); a rerun replaces the list, and `list` shows it.
   4. Sender: `agent-broker-admin share-stack <stack>`; from then on each `set-stack`/`unset-stack` copies at once, and
      `agent-broker-admin sync-push --all` resends everything. The receiver holds the stack as `followsMac`: changes
      there are refused. `unshare-stack` stops future copies; the receiver keeps what it has until
      `agent-broker-admin remove-stack <stack> --stop-following` runs on it.

## Known gaps

- **Folder rule = accident prevention**, not a wall: an agent can `cd` into another project's folder.
- **Touch ID for sudo** is on (Mac): an unexpected sudo prompt is an agent asking; deny it.
- **GitHub secrets** (`apify-analytics`, `FitUp`): a pushed script could print a secret in an Actions log. Fix: a
  GitHub bot account for agents (write, no admin), `main` protected with owner approval, secrets in an environment
  limited to `main`.
- **Apify actor runs** get a run token; actor code can print it.
- **Netlify** tokens open the whole account; edge-function bundling during a deploy may run project code with the
  token present (no project uses edge functions yet). CLIs run in a sandbox (macOS sandbox-exec, Linux bwrap) that
  cannot read the broker's token files, so a path in `netlify.toml` (or any project config) cannot point a deploy at them.
- **Tokens agents saw before the broker** (2026-10) stay valid until rotated (wizard → 2).
- **Linux, guard not wall**: the secret guard stops an agent that runs `run`, `key` or `get`; root can read the broker's
  files anyway, and the `get` / root-write checks are an interface for scripts. The program check for `key` reads a
  process's command line, so a process started with an OMP binary's path (or a bare name the grant lists) imitates OMP.
  A unit name can be imitated by the user's own systemd (an own unit with the same name gets that unit's keys). The
  `run` check trusts the caller's cgroup, and any process of the user can join one.
- **Linux, unproven**: the env file for `env` grants (written by the pre-start step, read by `EnvironmentFile=`; a file
  grant has no quoting question, so prefer file grants); that the bwrap sandbox hides the broker's folders in a live run
  (waits for the AppArmor file); that the cloud CLIs work with an empty home folder inside the sandbox.
- **Linux: `agent-broker compose` and the `docker` group are a guard on any host, not a wall.** The Docker daemon is root:
  whoever can start containers from a file an agent wrote can reach the host. Taking the agent user out of `docker` does
  not change that while `compose` is offered, because the broker's own Docker calls run as the broker user. What the
  broker refuses: any command or flag not in the table (below); `run -v` and mounts that reach the broker's home, the
  Docker socket or `/`; `privileged`, `pid`/`network_mode`/`userns_mode: host`, `container:` forms of
  `network_mode`/`pid`/`ipc`, `devices`, `device_cgroup_rules`, `cap_add`, `security_opt` other than
  `no-new-privileges`, and a volume `device` that is not a bind (an `o` that is exactly `bind` or `rbind`) passing the
  checks; every host path the client reads or writes (secrets, configs, `env_file`, `label_file`, build context,
  absolute or climbing `dockerfile`, `ssh`, `type=local` cache) when it is in the broker's home. Compose files: `-f`
  must be a file inside the project, never `-` (stdin) or a remote reference; a plain `COMPOSE_FILE` line (stored
  values or the folder's `.env`) gets the same rule, and `COMPOSE_ENV_FILES` is refused. Because Compose reads `.env`
  in more forms than the broker does, the guarantee is this instead: only `exec` gets the caller's stdin, so a compose
  file "from stdin" is empty for every command that starts containers, and compose files from git or a registry are
  switched off. What it does not stop: a compose file or `.env` rewritten between the check and the
  real call (the real call reads the files again; running it on the checked JSON was not done because it cannot be
  proven here that Compose then keeps every container unchanged), a path swapped after the check, a socket under
  another name, a top-level `name:` or `COMPOSE_PROJECT_NAME` that points at another project's containers (the owner has
  not decided whether the broker pins the project name), `docker exec` into a running container, and `docker`/`lxc`
  run by the agent itself. The secret guard has its own rules for those direct calls (a guard as well).
