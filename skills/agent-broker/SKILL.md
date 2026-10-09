---
name: agent-broker
description: "Use for Netlify, Vercel, Supabase or Apify work (deploys, logs, SQL, migrations, actors), API tokens or .env secrets, or adding a project/account."
---

# Agent broker

The owner has several logins per service. Tokens live only in the **broker** (macOS user `_deployer`, unreadable to
agents). Two layers:

- **Account stack**: one login per service (e.g. stack `thedoor` = theDoor's Netlify + Supabase; stack `global` = default fallback for general projects). Tokens stored once.
- **Project**: a folder, its stack, and the one site / database it may touch (pinned).

**The folder picks the project.** Run `agent-broker` from inside the project folder. Never name an account, site id or
project ref. `gh` is separate (one GitHub account, logged in normally, never touched or logged out by the broker).
## Use it

```sh
agent-broker whoami      # this folder's project, stack, site, database
agent-broker help        # every action
agent-broker <service> <action> [options]
```

- **Deploy**: build as yourself first, then `agent-broker netlify deploy --message "..."` (a draft). Add `--prod`
  only when the owner asks (credits). Vercel: `mkdir -p .vercel && agent-broker vercel settings > .vercel/project.json`,
  `vercel build`, `agent-broker vercel deploy`.
- **Supabase**: `query "select ..."` is read-only; `migrate [--dry-run]` applies `supabase/migrations`; any other
  write is `admin-query "..."`, which waits: ask the owner to run `agent-broker-admin approve <id>`, then
  `agent-broker result <id>`.
- **Apify**: `push`, `info|builds|runs <actor>`, `logs <run-id>`, `call <actor> --input-file F`, `pull <actor> | tar -x`.
- **Plain CLIs** (`netlify`, `supabase`, `apify`, `vercel`) do local work only (`netlify dev`, `supabase start`,
  `vercel build`); account commands stop with a pointer here. For owner manual CLI work with personal global logins,
  pass `--global` (e.g. `netlify deploy --global`) or set `export AGENT_BROKER_BYPASS=1`.
- **Scripts that need a token while running** (nightly jobs, backups) run on GitHub Actions: `gh workflow run ...`.
- **Tokens stay unread**: `.env` secrets, token files, CLI configs, `~/Secrets/*.kdbx`. Never put one in a file,
  argument, log or reply.
- **Errors** "no ... token" or a missing action: stop and ask the owner to run the wizard. `--project NAME` exists
  only for a folder that holds two projects (the error names them).
- **`agent-broker-admin`** is the owner's: it makes a Touch ID prompt on their screen. Run it only when asked.

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

## Known gaps

- **Folder rule = accident prevention**, not a wall: an agent can `cd` into another project's folder.
- **Touch ID for sudo** is on: an unexpected sudo prompt is an agent asking; deny it.
- **GitHub secrets** (`apify-analytics`, `FitUp`): a pushed script could print a secret in an Actions log. Fix: a
  GitHub bot account for agents (write, no admin), `main` protected with owner approval, secrets in an environment
  limited to `main`.
- **Apify actor runs** get a run token; actor code can print it.
- **Netlify** tokens open the whole account; edge-function bundling during a deploy may run project code with the
  token present (no project uses edge functions yet).
- **Tokens agents saw before the broker** (2026-10) stay valid until rotated (wizard → 2).
