#!/bin/bash
# Installs or updates the agent broker. Mac: usually run by the wizard (../scripts/wizard.sh). By hand, in your own
# terminal (it needs your password):  sudo ./install.sh
# Creates the hidden _deployer user (home /Users/_deployer on a Mac, /home/_deployer on Linux; only it can read it),
# installs the broker with its own Node in /opt/agent-broker (root-owned, agents cannot change it), the commands
# agent-broker and agent-broker-admin in /usr/local/bin, and the sudo rule /etc/sudoers.d/agent-broker.
# Also the cloud CLIs (netlify, vercel, supabase, apify) and their guard (macOS sandbox; on Linux bwrap, see apparmor/bwrap).
# Linux: _deployer joins the owner's group (to read the project folders) and the docker group (Docker Compose).
# Safe to run again after editing the files here: it updates the installed copy. Guide: ../SKILL.md
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo ./install.sh" >&2; exit 1; }
OWNER=${SUDO_USER:-}
[ -n "$OWNER" ] && [ "$OWNER" != root ] || { echo "run it with sudo from your own account" >&2; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)
ROOT=/opt/agent-broker
case "$(uname -s)" in
  Darwin) OS=mac HOME_D=/Users/_deployer HOME_GROUP=staff ROOT_GROUP=wheel OWNER_HOME=/Users/$OWNER ;;
  Linux) OS=linux HOME_D=/home/_deployer HOME_GROUP=_deployer ROOT_GROUP=root OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6) ;;
  *) echo "unsupported system: $(uname -s)" >&2; exit 1 ;;
esac

# The owner's Node (newest nvm version, else newest mise version, unless NODE_DIR is given); the broker gets its own copy.
newest() {
  local d found=""
  for d in "$@"; do [ -x "$d/bin/node" ] && [ -d "$d/lib/node_modules/npm" ] && found=$d; done
  echo "$found"
}
NODE_DIR=${NODE_DIR:-$(newest "$OWNER_HOME"/.nvm/versions/node/v*)}
NODE_DIR=${NODE_DIR:-$(newest "$OWNER_HOME"/.local/share/mise/installs/node/*)}
[ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/bin/node" ] || { echo "no Node found; set NODE_DIR=/path/to/node/version" >&2; exit 1; }

echo "1/6 user _deployer"
if [ "$OS" = mac ]; then
  if ! dscl . -read /Users/_deployer >/dev/null 2>&1; then
    uid=480
    while [ -n "$(dscl . -search /Users UniqueID "$uid")" ]; do uid=$((uid + 1)); done
    dscl . -create /Users/_deployer
    dscl . -create /Users/_deployer UniqueID "$uid"
    dscl . -create /Users/_deployer PrimaryGroupID 20 # staff: may read the owner's project folders, nothing private
    dscl . -create /Users/_deployer UserShell /usr/bin/false
    dscl . -create /Users/_deployer RealName "Agent broker"
    dscl . -create /Users/_deployer NFSHomeDirectory "$HOME_D"
    dscl . -create /Users/_deployer Password '*'
    dscl . -create /Users/_deployer IsHidden 1
  fi
else
  id _deployer >/dev/null 2>&1 \
    || useradd --system --user-group --home-dir "$HOME_D" --no-create-home --shell /usr/sbin/nologin --comment "Agent broker" _deployer
  # The owner's group: reads the project folders (Ubuntu homes are 750), as staff does on a Mac. docker: runs compose.
  usermod -aG "$(id -gn "$OWNER")" _deployer
  if getent group docker >/dev/null; then usermod -aG docker _deployer; else echo "  note: no docker group yet; rerun after installing Docker" >&2; fi
fi
mkdir -p "$HOME_D"
chown _deployer:"$HOME_GROUP" "$HOME_D"
chmod 700 "$HOME_D"

echo "2/6 broker and its own Node in $ROOT"
mkdir -p "$ROOT/bin" "$ROOT/node/bin" "$ROOT/node/lib/node_modules"
cp "$NODE_DIR/bin/node" "$ROOT/node/bin/node"
rm -rf "$ROOT/node/lib/node_modules/npm"
cp -R "$NODE_DIR/lib/node_modules/npm" "$ROOT/node/lib/node_modules/npm"
ln -sf ../lib/node_modules/npm/bin/npm-cli.js "$ROOT/node/bin/npm"
cp "$SRC/package.json" "$ROOT/package.json"
rm -f "$ROOT"/bin/*
cp "$SRC"/bin/*.mjs "$SRC/bin/supabase-ca.pem" "$ROOT/bin/"

echo "3/6 CLIs (netlify, vercel, supabase, apify) in $ROOT/node_modules"
[ "$OS" = mac ] && NPM_HOME=/var/root || NPM_HOME=/root
(cd "$ROOT" && PATH="$ROOT/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$NPM_HOME" npm install --omit=dev --no-fund --no-audit --loglevel=error)
rm -rf "$ROOT/apparmor"
if [ "$OS" = linux ]; then
  # Only a copy for the owner to install himself (see the file's header): the CLI sandbox (bwrap) needs it on Ubuntu.
  mkdir -p "$ROOT/apparmor"
  cp "$SRC/apparmor/bwrap" "$ROOT/apparmor/bwrap"
fi
chown -R root:"$ROOT_GROUP" "$ROOT"
chmod -R go-w "$ROOT"
chmod 755 "$ROOT/bin/agent-broker.mjs" "$ROOT/bin/agent-broker-admin.mjs"

echo "4/6 commands in /usr/local/bin"
mkdir -p /usr/local/bin
install -m 755 -o root -g "$ROOT_GROUP" "$SRC/wrappers/agent-broker" /usr/local/bin/agent-broker
install -m 755 -o root -g "$ROOT_GROUP" "$SRC/wrappers/agent-broker-admin" /usr/local/bin/agent-broker-admin

rm -rf "$ROOT/guard"
echo "5/6 CLI guard: netlify / supabase / apify / vercel point account commands to agent-broker"
mkdir -p "$ROOT/guard"
install -m 755 -o root -g "$ROOT_GROUP" "$SRC/guard/cli-guard" "$ROOT/guard/cli-guard"
for cli in netlify supabase apify vercel; do ln -sf cli-guard "$ROOT/guard/$cli"; done
if [ "$OS" = mac ]; then
  # First in PATH for every zsh (agents run zsh -l -c / zsh -c; nvm in .zshrc would otherwise come first).
  GUARD_LINE='[ -d /opt/agent-broker/guard ] && path=(/opt/agent-broker/guard $path) # agent-broker CLI guard'
  for rc in "/Users/$OWNER/.zshenv" "/Users/$OWNER/.zshrc"; do
    [ -f "$rc" ] || { touch "$rc"; chown "$OWNER":staff "$rc"; }
    grep -qF '# agent-broker CLI guard' "$rc" || printf '\n%s\n' "$GUARD_LINE" >>"$rc"
  done
else
  # First in PATH for the owner's bash: login shells (.profile, and .bash_profile when there is one) and .bashrc. The
  # .bashrc line goes on TOP: Ubuntu's .bashrc returns early for non-interactive shells, so a line at the end is never read.
  # A shell that reads none of these files (plain `bash -c` with no BASH_ENV) is not covered. Rerun-safe: marker comment.
  GUARD_LINE='[ -d /opt/agent-broker/guard ] && PATH=/opt/agent-broker/guard:$PATH # agent-broker CLI guard'
  OWNER_GROUP=$(id -gn "$OWNER")
  rcs=("$OWNER_HOME/.profile" "$OWNER_HOME/.bashrc")
  [ -f "$OWNER_HOME/.bash_profile" ] && rcs+=("$OWNER_HOME/.bash_profile")
  for rc in "${rcs[@]}"; do
    [ -f "$rc" ] || { touch "$rc"; chown "$OWNER":"$OWNER_GROUP" "$rc"; }
    grep -qF '# agent-broker CLI guard' "$rc" && continue
    if [ "$rc" = "$OWNER_HOME/.bashrc" ]; then
      tmp=$(mktemp)
      { printf '%s\n' "$GUARD_LINE"; cat "$rc"; } >"$tmp"
      cat "$tmp" >"$rc" # same file: owner and mode stay
      rm -f "$tmp"
    else
      printf '\n%s\n' "$GUARD_LINE" >>"$rc"
    fi
  done
fi

echo "6/6 sudo rule"
grep -qE '^[#@]includedir /(private/)?etc/sudoers.d' /etc/sudoers || { echo "/etc/sudoers does not include /etc/sudoers.d" >&2; exit 1; }
tmp=$(mktemp)
sed "s/__USER__/$OWNER/g" "$SRC/sudoers" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -m 440 -o root -g "$ROOT_GROUP" "$tmp" /etc/sudoers.d/agent-broker
rm -f "$tmp"

(cd / && sudo -u _deployer "$ROOT/bin/agent-broker.mjs" projects >/dev/null)
echo "Installed. Check as yourself:  agent-broker help"
if [ "$OS" = linux ]; then
  echo "Linux: the cloud CLIs run in a bwrap sandbox, which Ubuntu allows only with one AppArmor file. Install it yourself, once:"
  echo "  sudo install -m 644 $ROOT/apparmor/bwrap /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap"
fi
