---
name: agent-broker
description: "Use for Netlify, Vercel, Supabase or Apify work (deploys, logs, SQL, migrations, actors), API tokens or .env secrets, or adding a project/account."
---

# Agent broker

The owner has several accounts per service and runs many agents in parallel. Tokens live only in the **broker**, under
the macOS user `_deployer`, which agents cannot read. Agents name a **project**; the broker picks its account, runs
one allow-listed action, and returns output with secrets removed. Nothing falls back to a global login (they are
logged out). `gh` is the exception: one GitHub account, logged in normally.

## Use it

```sh
agent-broker help        # every action and option
agent-broker projects    # projects, services, stored key names (never values)
agent-broker <service> <action> <project> [options]
```

- **Deploy**: build as yourself first (no token needed), then deploy the built files. Netlify:
  `agent-broker netlify deploy <p> --message "..."` makes a draft; `--prod` only when the owner asks (credits).
  Vercel: `mkdir -p .vercel && agent-broker vercel settings <p> > .vercel/project.json`, `vercel build`,
  `agent-broker vercel deploy <p>`.
- **Supabase**: `query` = read-only SQL; `migrate [--dry-run]` applies `supabase/migrations`; any other write is
  `admin-query`, which waits: ask the owner to run `agent-broker-admin approve <id>`, then `agent-broker result <id>`.
- **Apify**: `push --dir <actor-folder>`, `info`, `builds`, `runs`, `logs`, `call`, `pull <p> <actor> | tar -x`.
- **Scripts that need a token while running** (nightly jobs, backups) run on GitHub Actions with GitHub secrets;
  start them with `gh workflow run`. A token never goes into a file, an argument, a log or your reply.
- **Tokens stay unread**: `.env` secrets, token files, CLI configs and the owner's vault (`~/Secrets/*.kdbx`).
- **Missing project, token or action**: stop and ask the owner to run the wizard (below). You never handle a value.
- **`agent-broker-admin`** is the owner's command. Calling it makes a Touch ID / password prompt appear on the owner's
  screen, so run it only when the owner asked you to, and say so first.

## Project instructions

Every project folder that uses the broker carries a block in its `AGENTS.md` (or `CLAUDE.md`) naming its project and
commands. Print or refresh it with `scripts/snippet.sh <project> [--write <file>]` (services come from
`agent-broker projects`; running it again replaces the old block).

## Owner: setup and new projects

Run in your own Terminal (it asks for your Mac password / Touch ID; tokens are typed hidden straight into the broker):

```sh
~/git/agent-scripts/skills/agent-broker/scripts/wizard.sh               # first time: vault, install, projects, log out
~/git/agent-scripts/skills/agent-broker/scripts/wizard.sh add-project   # later: one more project or account
```

The wizard: KeePassXC vault in `~/Secrets/`, `broker/install.sh` (user `_deployer`, `/opt/agent-broker` with its own
Node and CLIs, `/usr/local/bin/agent-broker{,-admin}`, `/etc/sudoers.d/agent-broker`, sudo password every time),
then per project: folder and services, moving `.env` secrets in, account tokens, the project block above.
Manual commands: `agent-broker-admin help` (`project`, `set`, `import`, `list`, `pending`, `approve`, `log`).

Changing the broker: edit `broker/`, run `cd broker && npm test`, then re-run `sudo ./install.sh` (the wizard does both).

## Known gaps

- **Touch ID for sudo** is on (`/etc/pam.d/sudo`): a sudo prompt nobody expected is an agent asking; deny it.
- **GitHub secrets** (repos `apify-analytics`, `FitUp`): agents push as the owner, so a pushed script could print a
  secret in an Actions log. Closing it needs a GitHub bot account for agents (write, no admin), `main` protected with
  the owner's approval, and secrets in a GitHub environment limited to `main`; do it for every repo that gets secrets.
- **Apify actor runs** get a run token from Apify; actor code can print it.
- **Netlify** tokens open the whole account; edge-function bundling during a deploy may run project code while the
  token is in the environment (no project uses edge functions yet).
- **Tokens agents saw before the broker** (2026-10) stay valid until the owner rotates them.
