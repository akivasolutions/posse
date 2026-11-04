#!/bin/bash
# Bullpen launcher for macOS. Double-click to start (first time: right-click > Open).
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do [ -x "$d/node" ] && export PATH="$d:$PATH"; done
fi
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Get it from https://nodejs.org and try again."; read -r; exit 1; }
exec node server.js --open
