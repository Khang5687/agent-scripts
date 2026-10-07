#!/bin/bash
# Installs or updates the agent broker. Usually run by the wizard (../scripts/wizard.sh); by hand, in your own
# Terminal (it needs your Mac password):  sudo ./install.sh
# Creates the hidden _deployer user (home /Users/_deployer, only it can read it), installs the broker with its own
# Node and CLIs in /opt/agent-broker (root-owned, agents cannot change it), the commands agent-broker and
# agent-broker-admin in /usr/local/bin, and the sudo rule /etc/sudoers.d/agent-broker.
# Safe to run again after editing the files here: it updates the installed copy. Guide: ../SKILL.md
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo ./install.sh" >&2; exit 1; }
OWNER=${SUDO_USER:-}
[ -n "$OWNER" ] && [ "$OWNER" != root ] || { echo "run it with sudo from your own account" >&2; exit 1; }
SRC=$(cd "$(dirname "$0")" && pwd)
ROOT=/opt/agent-broker
HOME_D=/Users/_deployer

# The owner's Node (newest nvm version unless NODE_DIR is given); the broker gets its own copy.
NODE_DIR=${NODE_DIR:-$(ls -d /Users/"$OWNER"/.nvm/versions/node/v* 2>/dev/null | tail -1)}
[ -x "$NODE_DIR/bin/node" ] && [ -d "$NODE_DIR/lib/node_modules/npm" ] || { echo "no Node found; set NODE_DIR=/path/to/node/version" >&2; exit 1; }

echo "1/5 user _deployer"
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
mkdir -p "$HOME_D"
chown _deployer:staff "$HOME_D"
chmod 700 "$HOME_D"

echo "2/5 broker and its own Node in $ROOT"
mkdir -p "$ROOT/bin" "$ROOT/node/bin" "$ROOT/node/lib/node_modules"
cp "$NODE_DIR/bin/node" "$ROOT/node/bin/node"
rm -rf "$ROOT/node/lib/node_modules/npm"
cp -R "$NODE_DIR/lib/node_modules/npm" "$ROOT/node/lib/node_modules/npm"
ln -sf ../lib/node_modules/npm/bin/npm-cli.js "$ROOT/node/bin/npm"
cp "$SRC/package.json" "$ROOT/package.json"
rm -f "$ROOT"/bin/*
cp "$SRC"/bin/*.mjs "$SRC/bin/supabase-ca.pem" "$ROOT/bin/"

echo "3/5 CLIs (netlify, vercel, supabase, apify) in $ROOT/node_modules"
(cd "$ROOT" && PATH="$ROOT/node/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME=/var/root npm install --omit=dev --no-fund --no-audit --loglevel=error)
chown -R root:wheel "$ROOT"
chmod -R go-w "$ROOT"
chmod 755 "$ROOT/bin/agent-broker.mjs" "$ROOT/bin/agent-broker-admin.mjs"

echo "4/5 commands in /usr/local/bin"
mkdir -p /usr/local/bin
install -m 755 -o root -g wheel "$SRC/wrappers/agent-broker" /usr/local/bin/agent-broker
install -m 755 -o root -g wheel "$SRC/wrappers/agent-broker-admin" /usr/local/bin/agent-broker-admin

echo "5/5 sudo rule"
grep -qE '^#includedir /(private/)?etc/sudoers.d' /etc/sudoers || { echo "/etc/sudoers does not include /etc/sudoers.d" >&2; exit 1; }
tmp=$(mktemp)
sed "s/__USER__/$OWNER/g" "$SRC/sudoers" > "$tmp"
visudo -cf "$tmp" >/dev/null
install -m 440 -o root -g wheel "$tmp" /etc/sudoers.d/agent-broker
rm -f "$tmp"

sudo -u _deployer "$ROOT/bin/agent-broker.mjs" projects >/dev/null
echo "Installed. Check as yourself:  agent-broker help"
