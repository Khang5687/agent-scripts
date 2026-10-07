#!/usr/bin/env bash
# Prints the agent-broker block for a project's AGENTS.md / CLAUDE.md, with only that project's services.
#   snippet.sh <project> [netlify|vercel|supabase|apify ...]   services default to what `agent-broker projects` lists
#   snippet.sh <project> --write <file>                         insert or replace the block in <file> (created if missing)
# The block sits between <!-- agent-broker:start --> and <!-- agent-broker:end -->, so running it again replaces it.
set -euo pipefail

usage() { echo "usage: snippet.sh <project> [service...] [--write FILE]" >&2; exit 2; }
[[ $# -ge 1 ]] || usage
P=$1
shift
[[ "$P" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || usage
services=()
file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --write) file=${2:-}; [[ -n "$file" ]] || usage; shift 2 ;;
    netlify | vercel | supabase | apify) services+=("$1"); shift ;;
    *) usage ;;
  esac
done
if [[ ${#services[@]} -eq 0 ]]; then
  command -v agent-broker >/dev/null || { echo "agent-broker is not installed: name the services, e.g. snippet.sh $P netlify" >&2; exit 1; }
  list=$(agent-broker projects | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const p = JSON.parse(s).find((x) => x.project === process.argv[1]); if (!p) process.exit(3); console.log(p.services.join(" ")) })' "$P") ||
    { echo "the broker has no project $P (owner: wizard.sh add-project)" >&2; exit 1; }
  read -r -a services <<<"$list"
fi
has() { [[ " ${services[*]-} " == *" $1 "* ]]; }

block() {
  cat <<EOF
<!-- agent-broker:start -->
## Accounts and tokens (agent broker)

This project's service accounts are reached only through \`agent-broker\`, project name \`$P\`. Its tokens live in
the broker, not in this folder: leave \`.env\` secrets, token files and CLI logins unread, and never paste a token
anywhere. All actions: \`agent-broker help\`. A missing token or action: ask the owner (see the agent-broker skill).

EOF
  if has netlify; then cat <<EOF
- **Netlify**: build first, then \`agent-broker netlify deploy $P --message "..."\` (draft). Add \`--prod\` only when
  the owner asks: each production deploy costs credits. Also \`status\`, \`deploys\`, \`logs $P [--since 1h]\`,
  \`blobs-list\` / \`blobs-get\` / \`blobs-meta $P <store> ...\`.
EOF
  fi
  if has vercel; then cat <<EOF
- **Vercel**: \`mkdir -p .vercel && agent-broker vercel settings $P > .vercel/project.json\`, then \`vercel build\`, then
  \`agent-broker vercel deploy $P\` (add \`--prod\` only when the owner asks). Also \`deploys\`, \`logs $P <url>\`.
EOF
  fi
  if has supabase; then cat <<EOF
- **Supabase**: read-only SQL \`agent-broker supabase query $P "select ..."\`; migrations
  \`agent-broker supabase migrate $P --dry-run\`, then without \`--dry-run\`. Any other write:
  \`agent-broker supabase admin-query $P "..."\`, ask the owner to run \`agent-broker-admin approve <id>\`, then
  \`agent-broker result <id>\`.
EOF
  fi
  if has apify; then cat <<EOF
- **Apify**: \`agent-broker apify push $P --dir <actor-folder>\`; \`info\`, \`builds\`, \`runs $P <actor>\`;
  \`logs $P <run-id>\`; \`call $P <actor> --input-file <file>\`; \`pull $P <actor> | tar -x -C <dir>\`.
EOF
  fi
  cat <<EOF
- Scripts that need a token while they run belong in GitHub Actions (\`gh workflow run ...\`), not on this Mac.
<!-- agent-broker:end -->
EOF
}

if [[ -z "$file" ]]; then
  block
  exit 0
fi

# Insert or replace the block in $file, keeping everything else.
new=$(block)
if [[ -f "$file" ]] && grep -q '<!-- agent-broker:start -->' "$file"; then
  BLOCK="$new" node -e '
    const fs = require("fs"); const f = process.argv[1]; const t = fs.readFileSync(f, "utf8");
    fs.writeFileSync(f, t.replace(/<!-- agent-broker:start -->[\s\S]*?<!-- agent-broker:end -->/, () => process.env.BLOCK));' "$file"
else
  { [[ -s "$file" ]] && printf '\n'; printf '%s\n' "$new"; } >>"$file"
fi
echo "agent-broker block written to $file"
