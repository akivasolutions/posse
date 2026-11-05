#!/bin/bash
# Posse for macOS. Double-click to start (the first time: right-click > Open).
# update.command runs this with --update.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do [ -x "$d/node" ] && export PATH="$d:$PATH"; done
fi
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get it from https://nodejs.org and try again."; read -r; exit 1; }
[ "$1" = "--update" ] && exec node update.js --open
# An update that was interrupted is finished before starting.
[ -f .update/journal.json ] && exec node update.js --finish --open
exec node server.js --open
