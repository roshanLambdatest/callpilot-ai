#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/.callpilot-logs"
mkdir -p "$LOG_DIR"
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is required."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Node.js/npm is required."; exit 1; }
[ -d "$ROOT/backend/.venv" ] || python3 -m venv "$ROOT/backend/.venv"
"$ROOT/backend/.venv/bin/python" -m pip install -q -r "$ROOT/backend/requirements.txt"
(cd "$ROOT/native-overlay" && npm install --silent)
"$ROOT/AUTOSTART-CALLPILOT.command"
echo "✓ CallPilot is running. Use the CallPilot icon in the macOS menu bar → Start Call."
echo "No Chrome extension is used."
sleep 3
