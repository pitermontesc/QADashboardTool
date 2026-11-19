#!/bin/bash
# macOS launcher: double-click to install (the first time), build and open the app.
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org (version 20 or later)."
  read -r -p "Press Enter to close..."
  exit 1
fi
[ -d node_modules ] || npm install || exit 1
exec npm start
