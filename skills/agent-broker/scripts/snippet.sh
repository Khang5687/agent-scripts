#!/usr/bin/env bash
# Prints the agent-broker block for a project's AGENTS.md / CLAUDE.md (project, stack and services come from
# `agent-broker projects`).
#   snippet.sh <project>                  print the block
#   snippet.sh <project> --write <file>   insert or replace the block in <file> (created if missing)
# The block sits between <!-- agent-broker:start --> and <!-- agent-broker:end -->; running it again replaces it.
set -euo pipefail

usage() { echo "usage: snippet.sh <project> [--write FILE]" >&2; exit 2; }
[[ $# -eq 1 || ($# -eq 3 && "$2" == --write) ]] || usage
P=$1
file=${3:-}
[[ "$P" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || usage
command -v agent-broker >/dev/null || { echo "agent-broker is not installed" >&2; exit 1; }

# One line per fact: stack, then "service<TAB>label" for each service the project uses.
facts=$(agent-broker projects | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const p = JSON.parse(s).find((x) => x.project === process.argv[1]);
    if (!p) process.exit(3);
    console.log(p.stack ?? "");
    const label = { netlify: (c) => c.site_name ?? c.site_id, supabase: (c) => c.name ?? c.project_ref, vercel: (c) => c.name ?? c.project_id, apify: () => "actors" };
    for (const [svc, c] of Object.entries(p.services)) console.log(`${svc}\t${label[svc](c)}`);
  })' "$P") || { echo "the broker has no project $P (owner: run the wizard -> Add a project)" >&2; exit 1; }

stack=$(printf '%s\n' "$facts" | head -1)
services=$(printf '%s\n' "$facts" | tail -n +2)
has() { printf '%s\n' "$services" | grep -q "^$1	"; }
uses=$(printf '%s\n' "$services" | awk -F'\t' 'NF == 2 { printf "%s%s %s", (n++ ? ", " : ""), $1, $2 }')

block() {
  echo '<!-- agent-broker:start -->'
  echo '## Accounts (agent broker)'
  echo
  echo "This folder is broker project \`$P\`${stack:+ on account stack \`$stack\`}${uses:+ ($uses)}."
  echo 'Use `agent-broker` from inside this folder: the folder picks the account. Never name an account, site id or'
  echo 'project ref; never read tokens or `.env` secrets. The plain `netlify`/`supabase`/`apify`/`vercel` commands do local'
  echo 'work only.'
  echo
  echo '- Check: `agent-broker whoami`. All actions: `agent-broker help`.'
  if has netlify; then echo '- Deploy: build, then `agent-broker netlify deploy --message "..."` (draft). `--prod` only when the owner asks.'; fi
  if has vercel; then echo '- Deploy: `agent-broker vercel settings > .vercel/project.json`, `vercel build`, `agent-broker vercel deploy`.'; fi
  if has supabase; then echo '- Database: `agent-broker supabase query "select ..."` (read-only). Changes: `agent-broker supabase migrate --dry-run`, then without; anything else: `agent-broker supabase admin-query "..."` (the owner approves).'; fi
  if has apify; then echo '- Apify: `agent-broker apify push`, `runs <actor>`, `logs <run-id>`.'; fi
  echo '- Error "not inside a registered project" or a missing token: stop and ask the owner to run the agent-broker wizard.'
  echo '<!-- agent-broker:end -->'
}

if [[ -z "$file" ]]; then
  block
  exit 0
fi

new=$(block)
if [[ -f "$file" ]] && grep -q '<!-- agent-broker:start -->' "$file"; then
  BLOCK="$new" node -e '
    const fs = require("fs"); const f = process.argv[1]; const t = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, t.replace(/<!-- agent-broker:start -->[\s\S]*?<!-- agent-broker:end -->/, () => process.env.BLOCK));' "$file"
else
  { [[ -s "$file" ]] && printf '\n'; printf '%s\n' "$new"; } >>"$file"
fi
echo "agent-broker block written to $file"
